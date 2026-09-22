import express from 'express';
import path from 'path';
import multer from 'multer';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { db } from './server/db/database';
import { UniversalIngestionEngine } from './server/ingestion/engine';
import { InvestigatorAIAgent } from './server/ai/investigator_agent';

dotenv.config();

const app = express();
const PORT = 3000;

// Setup Multer memory storage for spreadsheet uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Request logging & Audit Header
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/api') && req.path !== '/api/health') {
      console.log(`[${req.method}] ${req.path} -> ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// ==============================================================================
// 1. HEALTH, READINESS & SYSTEM DIAGNOSTICS
// ==============================================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'INVESTIGATOR AI Backend',
    timestamp: new Date().toISOString(),
    database: 'healthy',
    postgis_support: 'active',
  });
});

app.get('/api/ready', (req, res) => {
  res.json({ ready: true, version: '1.0.0-prod' });
});

app.get('/api/system/status', (req, res) => {
  res.json({
    gemini_api_configured: Boolean(process.env.GEMINI_API_KEY),
    google_maps_configured: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    cloud_sql_connected: Boolean(process.env.DATABASE_URL),
    cloud_storage_bucket: process.env.GCS_BUCKET || 'internal-evidence-vault',
    runtime_environment: process.env.NODE_ENV || 'development',
    server_time: new Date().toISOString(),
    security_mode: 'STRICT_AUDIT_ENABLED',
  });
});

// ==============================================================================
// 2. CASE MANAGEMENT
// ==============================================================================
app.get('/api/cases', (req, res) => {
  const cases = db.getCases();
  res.json(cases);
});

app.get('/api/cases/:id', (req, res) => {
  const c = db.getCaseById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  res.json(c);
});

app.post('/api/cases', (req, res) => {
  const { case_number, title, description, classification, created_by, retention_policy } = req.body;
  if (!title || !case_number) {
    return res.status(400).json({ error: 'عنوان القضية ورقم القضية مطلوبان' });
  }
  const created = db.createCase({
    case_number,
    title,
    description: description || '',
    status: 'Active',
    classification: classification || 'Confidential',
    created_by: created_by || 'المحقق المناوب',
    assigned_users: [created_by || 'المحقق المناوب'],
    retention_policy: retention_policy || 'Standard 10-Year',
  });
  res.status(201).json(created);
});

app.put('/api/cases/:id', (req, res) => {
  const updated = db.updateCase(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Case not found' });
  res.json(updated);
});

// ==============================================================================
// 3. DASHBOARD ANALYTICS & STATS
// ==============================================================================
app.get('/api/cases/:id/dashboard', (req, res) => {
  const stats = db.getDashboardStats(req.params.id);
  res.json(stats);
});

// ==============================================================================
// 4. FILE UPLOADER & HETEROGENEOUS SCHEMA MAPPING
// ==============================================================================
app.get('/api/cases/:id/files', (req, res) => {
  const files = db.getSourceFiles(req.params.id);
  res.json(files);
});

// Upload and inspect spreadsheet without committing
app.post('/api/cases/:id/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم إرسال أي ملف' });
    }
    const filename = req.file.originalname;
    const buffer = req.file.buffer;

    const { sheets, totalRows, fileHash } = UniversalIngestionEngine.inspectWorkbook(buffer, filename);

    // Check for duplicate file hash in case
    const existingFiles = db.getSourceFiles(req.params.id);
    const isDuplicate = existingFiles.some((f) => f.file_hash === fileHash);

    const tempFileId = `file-${Date.now()}`;
    const sourceFile = {
      id: tempFileId,
      case_id: req.params.id,
      filename,
      file_size: req.file.size,
      file_hash: fileHash,
      mime_type: req.file.mimetype || 'application/vnd.ms-excel',
      total_sheets: sheets.length,
      total_rows: totalRows,
      imported_rows: 0,
      rejected_rows: 0,
      status: 'MAPPING' as const,
      uploaded_at: new Date().toISOString(),
      uploader: (req.headers['x-user-name'] as string) || 'المحقق المسؤول',
      data_origin: 'SOURCE' as const,
      sheets,
      is_duplicate_warning: isDuplicate,
    };

    // Store in global memory cache for immediate mapping confirmation
    (global as any).__UPLOAD_CACHE = (global as any).__UPLOAD_CACHE || new Map();
    (global as any).__UPLOAD_CACHE.set(tempFileId, {
      meta: sourceFile,
      buffer,
    });

    res.json(sourceFile);
  } catch (err: any) {
    console.error('[Upload Error]', err);
    res.status(500).json({ error: `تعذر فحص ملف الجداول: ${err.message}` });
  }
});

// Confirm schema mappings and execute full batch ingestion
app.post('/api/cases/:id/import-confirm', (req, res) => {
  try {
    const { file_id, sheet_mappings, create_as_separate_case, case_title, case_number } = req.body;
    const cached = (global as any).__UPLOAD_CACHE?.get(file_id);

    if (!cached) {
      return res.status(400).json({ error: 'انتهت صلاحية جلسة رفع الملف، يرجى إعادة المحاولة' });
    }

    let targetCaseId = req.params.id;
    let createdNewCase = null;

    if (create_as_separate_case) {
      const cleanName = cached.meta.filename.replace(/\.[^/.]+$/, '');
      const newNum = case_number || `ق-م-${Math.floor(1000 + Math.random() * 9000)}/2026`;
      const newTitle = case_title || `ملف مستقل: ${cleanName}`;
      createdNewCase = db.createCase({
        case_number: newNum,
        title: newTitle,
        description: `قضية مستقلة مخصصة للملف المرفوع (${cached.meta.filename})`,
        status: 'Active',
        classification: 'Confidential',
        created_by: cached.meta.uploader || 'مقدم/ خالد سليم',
        assigned_users: [cached.meta.uploader || 'مقدم/ خالد سليم'],
        retention_policy: 'Standard 10-Year',
      });
      targetCaseId = createdNewCase.id;
    }

    const { records, issues, importedCount, rejectedCount } = UniversalIngestionEngine.processWorkbookRows(
      cached.buffer,
      { id: file_id, filename: cached.meta.filename, case_id: targetCaseId },
      sheet_mappings
    );

    // Insert into DB
    db.insertCallsBatch(records);

    // Save final source file record
    const finalFile = {
      ...cached.meta,
      case_id: targetCaseId,
      imported_rows: importedCount,
      rejected_rows: rejectedCount,
      status: 'COMPLETED' as const,
    };
    db.addSourceFile(finalFile);

    // Log in Audit
    db.logAudit({
      case_id: targetCaseId,
      user: cached.meta.uploader,
      action: 'SPREADSHEET_INGESTION_COMPLETED',
      target: cached.meta.filename,
      result: 'SUCCESS',
      ip_address: req.ip || '127.0.0.1',
      details: { imported: importedCount, rejected: rejectedCount, separate_case: Boolean(createdNewCase) },
    });

    // Cleanup cache
    (global as any).__UPLOAD_CACHE.delete(file_id);

    res.json({
      success: true,
      file: finalFile,
      imported_count: importedCount,
      rejected_count: rejectedCount,
      issues_count: issues.length,
      new_case: createdNewCase,
    });
  } catch (err: any) {
    console.error('[Import Error]', err);
    res.status(500).json({ error: `فشل استيراد السجلات: ${err.message}` });
  }
});

// Dropdown Cases with All Files
app.get('/api/all-cases-files', (req, res) => {
  try {
    const list = db.getAllCasesWithFiles();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Make a specific file into its own separate case
app.post('/api/files/:fileId/make-separate-case', (req, res) => {
  try {
    const { case_title, case_number, created_by } = req.body;
    const newCase = db.makeFileSeparateCase(req.params.fileId, case_title, case_number, created_by);
    if (!newCase) {
      return res.status(404).json({ error: 'لم يتم العثور على الملف المحدد' });
    }
    res.json({ success: true, case: newCase });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get comprehensive details for a specific sheet of a file
app.get('/api/cases/:id/files/:fileId/sheet-details', (req, res) => {
  try {
    const { sheet_name } = req.query;
    const details = db.getSheetDetails(req.params.id, req.params.fileId, sheet_name as string);
    if (!details) {
      return res.status(404).json({ error: 'لم يتم العثور على تفاصيل الشيت' });
    }
    res.json(details);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================================
// 5. STRUCTURED INVESTIGATIVE SEARCH
// ==============================================================================
app.get('/api/cases/:id/search', (req, res) => {
  const {
    number,
    source_number,
    destination_number,
    cell_id,
    imei,
    imsi,
    start_date,
    end_date,
    min_duration,
    direction,
    limit,
    offset,
  } = req.query;

  const results = db.searchCalls({
    case_id: req.params.id,
    number: number as string,
    source_number: source_number as string,
    destination_number: destination_number as string,
    cell_id: cell_id as string,
    imei: imei as string,
    imsi: imsi as string,
    start_date: start_date as string,
    end_date: end_date as string,
    min_duration: min_duration ? parseInt(min_duration as string, 10) : undefined,
    direction: direction as string,
    limit: limit ? parseInt(limit as string, 10) : 50,
    offset: offset ? parseInt(offset as string, 10) : 0,
  });

  res.json(results);
});

// ==============================================================================
// 6. GEOSPATIAL MAP ENGINE & HEATMAP
// ==============================================================================
app.get('/api/cases/:id/heatmap', (req, res) => {
  const { number, start_date, end_date } = req.query;
  const points = db.getHeatmapPoints(req.params.id, number as string, start_date as string, end_date as string);
  res.json(points);
});

app.get('/api/cases/:id/proximity', (req, res) => {
  const { number_a, number_b, distance_meters, time_minutes } = req.query;
  if (!number_a || !number_b) {
    return res.status(400).json({ error: 'رقم الهاتف الأول والثاني مطلوبان للتحليل المكاني' });
  }
  const result = db.getSpatialProximity(
    req.params.id,
    number_a as string,
    number_b as string,
    distance_meters ? parseInt(distance_meters as string, 10) : 800,
    time_minutes ? parseInt(time_minutes as string, 10) : 30
  );
  res.json(result);
});

app.get('/api/cases/:id/common-cells', (req, res) => {
  const { number_a, number_b } = req.query;
  if (!number_a || !number_b) {
    return res.status(400).json({ error: 'الرقمين مطلوبان لاستخراج الخلايا المشتركة' });
  }
  const result = db.getCommonCells(req.params.id, number_a as string, number_b as string);
  res.json(result);
});

// ==============================================================================
// 7. TIMELINE PLAYBACK DATA
// ==============================================================================
app.get('/api/cases/:id/timeline', (req, res) => {
  const { number } = req.query;
  const events = db.getTimelineEvents(req.params.id, number as string);
  res.json(events);
});

// ==============================================================================
// 8. INTERACTIVE RELATIONSHIP GRAPH
// ==============================================================================
app.get('/api/cases/:id/graph', (req, res) => {
  const graph = db.getRelationshipGraph(req.params.id, req.query.focus as string);
  res.json(graph);
});

// ==============================================================================
// 9. ENTITY PROFILES & DIRECTORIES
// ==============================================================================
app.get('/api/cases/:id/towers', (req, res) => {
  const towers = db.getCellTowers(req.params.id);
  res.json(towers);
});

app.get('/api/cases/:id/towers/:cellId', (req, res) => {
  const profile = db.getCellTowerProfile(req.params.id, req.params.cellId);
  res.json(profile);
});

app.get('/api/cases/:id/phones', (req, res) => {
  const phones = db.getPhoneNumbers(req.params.id);
  res.json(phones);
});

app.get('/api/cases/:id/phones/:number', (req, res) => {
  const profile = db.getNumberProfile(req.params.id, req.params.number);
  res.json(profile);
});

app.get('/api/cases/:id/devices', (req, res) => {
  const devices = db.getDevices(req.params.id);
  res.json(devices);
});

app.get('/api/cases/:id/persons', (req, res) => {
  const persons = db.getPersons(req.params.id);
  res.json(persons);
});

app.get('/api/cases/:id/national-ids', (req, res) => {
  const nids = db.getNationalIds(req.params.id);
  res.json(nids);
});

app.post('/api/national-ids/:id/reveal', (req, res) => {
  const user = (req.body.user as string) || 'المحقق المصرح له';
  const revealed = db.revealNationalId(req.params.id, user);
  if (!revealed) return res.status(404).json({ error: 'الرقم القومي غير موجود' });
  res.json({ full_national_id: revealed });
});

// ==============================================================================
// 10. FINDINGS, DATA QUALITY & AUDIT
// ==============================================================================
app.get('/api/cases/:id/findings', (req, res) => {
  const findings = db.getAnalyticalFindings(req.params.id);
  res.json(findings);
});

app.post('/api/cases/:id/findings', (req, res) => {
  const created = db.addAnalyticalFinding({
    case_id: req.params.id,
    ...req.body,
  });
  res.status(201).json(created);
});

app.get('/api/cases/:id/data-quality', (req, res) => {
  const issues = db.getDataQualityIssues(req.params.id);
  res.json(issues);
});

app.get('/api/cases/:id/audit-logs', (req, res) => {
  const logs = db.getAuditLogs(req.params.id);
  res.json(logs);
});

// ==============================================================================
// 11. AI INVESTIGATIVE ASSISTANT
// ==============================================================================
app.post('/api/cases/:id/ai/query', async (req, res) => {
  try {
    const { prompt, user } = req.body;
    if (!prompt) return res.status(400).json({ error: 'يرجى كتابة سؤال التحقيق' });

    const answer = await InvestigatorAIAgent.query(
      req.params.id,
      prompt,
      user || 'المحقق الجنائي'
    );
    res.json(answer);
  } catch (err: any) {
    console.error('[AI Query Error]', err);
    res.status(500).json({ error: `تعذر معالجة استفسار الذكاء الاصطناعي: ${err.message}` });
  }
});

// ==============================================================================
// 12. VITE MIDDLEWARE & SERVER STARTUP
// ==============================================================================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`  INVESTIGATOR AI Backend running on port ${PORT}`);
    console.log(`  Target Architecture: Cloud SQL + PostGIS + Gemini AI`);
    console.log(`=======================================================`);
  });
}

startServer();
