// ============================================================
// Stored delivery copies of standalone engine results
// (birth-certificate / death-verify PDFs).
// Those engines stream the PDF straight to the browser and keep
// no record, so the finished work could never appear in the
// customer's History (delivery files only). After a successful
// PDF download the engine page reports a copy here.
// Customer: POST /api/engine-jobs (PDF copy, idempotent)
//           GET  /api/engine-jobs/:id/file (own download)
// Admin:    GET  /api/admin/engine-jobs
//           DELETE /api/admin/engine-jobs/:id (record + file)
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const wa = require('../utils/whatsapp');
const { requireAuth, requireAdmin } = require('../auth');
const { safeLog } = require('../security');

const UPLOAD_DIR = '/opt/all-in-one-abc-authentic/uploads/engine-jobs';
const ENGINES = ['bdris-certificate', 'death-verify'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, 'engine-' + Date.now().toString(36) + '-' + crypto.randomBytes(8).toString('hex') + '.pdf');
  },
});
const uploadPdf = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (ext !== 'pdf') return cb(new Error('FILE_TYPE_NOT_ALLOWED'));
    cb(null, true);
  },
}).single('file');

// ============================================================
// CUSTOMER router — mounted at /api/engine-jobs (requireAuth)
// ============================================================
const customerEngineJobs = express.Router();
customerEngineJobs.use(requireAuth);

// POST /api/engine-jobs — store a delivery copy of an engine PDF.
// Idempotent per (user, idempotency_key): re-downloads of the same
// document do not create duplicate History entries or files.
customerEngineJobs.post('/', (req, res) => {
  uploadPdf(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'UPLOAD_FAILED' });
    const cleanup = () => { if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} } };
    try {
      if (!req.file) return res.status(400).json({ error: 'NO_FILE' });
      const engineId = String((req.body && req.body.engine_id) || '').trim();
      if (!ENGINES.includes(engineId)) { cleanup(); return res.status(400).json({ error: 'BAD_ENGINE' }); }
      const refNo = String((req.body && req.body.ref_no) || '').trim().slice(0, 64);
      const name = String((req.body && req.body.name) || '').trim().slice(0, 160);
      let idem = String((req.body && req.body.idempotency_key) || '').trim().slice(0, 80);
      if (!idem) idem = engineId + '-' + (refNo || req.file.filename);
      const r = await db.query(
        `INSERT INTO engine_jobs (user_id, engine_id, ref_no, subject_name, filename, originalname, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [req.user.id, engineId, refNo, name, req.file.filename, req.file.originalname || 'document.pdf', idem]
      );
      if (!r.rows.length) {
        // Duplicate report — drop the extra file copy, keep the first.
        cleanup();
        return res.json({ ok: true, duplicate: true });
      }
      // First stored copy of this document → WhatsApp confirmation.
      wa.notifyServiceCompleted(db, req.user.id,
        engineId === 'death-verify' ? 'মৃত্যু সনদ' : 'জন্ম সনদ (সার্টিফিকেট)').catch(() => {});
      res.status(201).json({ ok: true, id: r.rows[0].id });
    } catch (e) {
      cleanup();
      safeLog('[engine-jobs] report error:', e.message);
      res.status(500).json({ error: 'FAILED' });
    }
  });
});

// GET /api/engine-jobs/:id/file — download own stored engine PDF
customerEngineJobs.get('/:id/file', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT filename, originalname FROM engine_jobs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const fn = path.basename(r.rows[0].filename);
    const fp = path.join(UPLOAD_DIR, fn);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'FILE_MISSING' });
    res.download(fp, r.rows[0].originalname || fn);
  } catch (e) { safeLog('[engine-jobs] download error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// ============================================================
// ADMIN router — mounted at /api/admin/engine-jobs
// ============================================================
const adminEngineJobs = express.Router();
adminEngineJobs.use(requireAuth, requireAdmin);

// GET /api/admin/engine-jobs — latest engine deliveries, all customers
adminEngineJobs.get('/', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT j.id, j.engine_id, j.ref_no, j.subject_name, j.originalname, j.created_at,
              u.name AS user_name, u.phone AS user_phone
       FROM engine_jobs j JOIN users u ON u.id = j.user_id
       ORDER BY j.created_at DESC LIMIT 100`
    );
    res.json({ jobs: r.rows });
  } catch (e) { safeLog('[engine-jobs] admin list error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// DELETE /api/admin/engine-jobs/:id — record first, file second (an
// unlink failure then leaves only a harmless orphan file).
adminEngineJobs.delete('/:id', async (req, res) => {
  try {
    const r = await db.query('DELETE FROM engine_jobs WHERE id = $1 RETURNING filename', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(r.rows[0].filename))); } catch (_) {}
    res.json({ ok: true });
  } catch (e) { safeLog('[engine-jobs] admin delete error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

module.exports = { customerEngineJobs, adminEngineJobs };
