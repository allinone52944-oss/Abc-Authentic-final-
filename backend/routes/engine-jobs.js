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
const push = require('../utils/push');
const { buildReceiptPdf } = require('../lib/receiptPdf');
const { requireAuth, requireAdmin } = require('../auth');
const { safeLog } = require('../security');

const SERVICE_LABELS = { 'bdris-certificate': 'জন্ম সনদ যাচাই', 'death-verify': 'মৃত্যু সনদ যাচাই' };
const SUBJECT_LABELS = { 'bdris-certificate': 'জন্ম নিবন্ধন নম্বর', 'death-verify': 'মৃত্যু নিবন্ধন নম্বর' };

// Bengali rendering of an engine failure — the engine's own
// message may be English or system-flavoured; the customer only
// ever sees one of these mapped lines.
function failureReasonBn(raw) {
  const m = String(raw || '');
  if (/not found|no record|পাওয়া যায়নি|খুঁজে পাওয়া/i.test(m)) return 'কোনো রেকর্ড পাওয়া যায়নি — নম্বর ও তারিখ মিলিয়ে আবার চেষ্টা করুন';
  if (/captcha|ক্যাপচা/i.test(m)) return 'ক্যাপচা যাচাই ব্যর্থ হয়েছে';
  if (/match|মেলেনি|মিলছে না|incorrect|ভুল/i.test(m)) return 'প্রদত্ত তথ্য রেকর্ডের সঙ্গে মেলেনি';
  if (/pdf|সনদ তৈরি/i.test(m)) return 'তথ্য যাচাই হয়েছিল, কিন্তু সনদ তৈরি করা যায়নি';
  return 'যাচাই সম্পন্ন করা যায়নি';
}

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

// POST /api/engine-jobs/failure — record a FAILED verification
// (premium flow, 2026-10-22, mirroring QR + photo verify): a
// 'failed' engine_jobs row whose file is a generated failure
// receipt (→ the customer's History), a WhatsApp notice to the
// customer and a push to the admins. No charge exists on these
// engines; the receipt states ৳০ all the same. Idempotent per
// (user, idempotency_key) — the page keys it to the engine
// session, and a later SUCCESS report with the same session key
// supersedes (deletes) the failure row.
customerEngineJobs.post('/failure', async (req, res) => {
  let fn = null;
  try {
    const engineId = String((req.body && req.body.engine_id) || '').trim();
    if (!ENGINES.includes(engineId)) return res.status(400).json({ error: 'BAD_ENGINE' });
    const refNo = String((req.body && req.body.ref_no) || '').trim().slice(0, 64);
    const name = String((req.body && req.body.name) || '').trim().slice(0, 160);
    const idem = String((req.body && req.body.idempotency_key) || '').trim().slice(0, 80);
    if (!idem) return res.status(400).json({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    const reasonBn = failureReasonBn(req.body && req.body.reason);

    const prev = await db.query(
      'SELECT id FROM engine_jobs WHERE user_id = $1 AND idempotency_key = $2',
      [req.user.id, idem]
    );
    if (prev.rows.length) {
      return res.json({
        ok: true, duplicate: true, id: prev.rows[0].id,
        receipt: '/api/engine-jobs/' + prev.rows[0].id + '/file',
      });
    }

    fn = 'engine-fail-' + idem.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 60) + '.pdf';
    const pdf = await buildReceiptPdf({
      serviceLabel: SERVICE_LABELS[engineId], outcome: 'failed', reason: reasonBn,
      subjectLabel: SUBJECT_LABELS[engineId], subjectValue: refNo,
      chargeText: '৳০ — কোনো টাকা কাটা হয়নি', ref: idem,
      when: new Date().toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' }),
      footers: [
        'এই রসিদটি স্বয়ংক্রিয়ভাবে তৈরি।',
        'ব্যর্থ যাচাইয়ে কোনো চার্জ কাটা হয়নি — তথ্য মিলিয়ে আবার চেষ্টা করুন।',
      ],
    });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, fn), pdf);

    const r = await db.query(
      `INSERT INTO engine_jobs (user_id, engine_id, ref_no, subject_name, filename, originalname, idempotency_key, outcome, reason)
       VALUES ($1, $2, $3, $4, $5, 'verification-failed-receipt.pdf', $6, 'failed', $7)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [req.user.id, engineId, refNo, name, fn, idem, reasonBn]
    );
    if (!r.rows.length) {
      // Lost an insert race — drop our file copy, return the stored row.
      try { fs.unlinkSync(path.join(UPLOAD_DIR, fn)); } catch (_) {}
      const again = await db.query(
        'SELECT id FROM engine_jobs WHERE user_id = $1 AND idempotency_key = $2',
        [req.user.id, idem]
      );
      if (again.rows.length) {
        return res.json({
          ok: true, duplicate: true, id: again.rows[0].id,
          receipt: '/api/engine-jobs/' + again.rows[0].id + '/file',
        });
      }
      return res.status(500).json({ error: 'FAILED' });
    }

    wa.notifyServiceFailed(db, req.user.id, SERVICE_LABELS[engineId], reasonBn).catch(() => {});
    push.notifyAdmins(db, '❌ ' + SERVICE_LABELS[engineId] + ' ব্যর্থ',
      'একটি ' + SERVICE_LABELS[engineId] + ' ব্যর্থ হয়েছে — কোনো চার্জ কাটা হয়নি।', '/admin.html').catch(() => {});
    res.status(201).json({
      ok: true, id: r.rows[0].id,
      receipt: '/api/engine-jobs/' + r.rows[0].id + '/file',
    });
  } catch (e) {
    if (fn) { try { fs.unlinkSync(path.join(UPLOAD_DIR, fn)); } catch (_) {} }
    safeLog('[engine-jobs] failure report error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

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
      // A success in the same engine session supersedes a failure
      // recorded earlier in that session (e.g. a captcha typo that
      // was reported, then corrected): remove the failure row +
      // its receipt file so History never shows a "failed" record
      // for an attempt that ultimately succeeded.
      const sessSuffix = idem.startsWith(engineId + '-') ? idem.slice(engineId.length + 1) : '';
      if (sessSuffix) {
        const del = await db.query(
          `DELETE FROM engine_jobs
           WHERE user_id = $1 AND engine_id = $2 AND outcome = 'failed' AND idempotency_key = $3
           RETURNING filename`,
          [req.user.id, engineId, engineId + '-fail-' + sessSuffix]
        ).catch(() => null);
        if (del) {
          for (const row of del.rows) {
            try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(row.filename))); } catch (_) {}
          }
        }
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
              j.outcome, j.reason,
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
