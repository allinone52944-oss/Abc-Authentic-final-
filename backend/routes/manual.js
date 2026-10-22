// ============================================================
// Manual service submissions (Phase: manual services)
// Standalone module — does NOT touch orders/engines.
// Customer: POST /api/manual/submit (text + documents)
//           GET  /api/manual/mine
//           GET  /api/manual/template
//           GET  /api/manual/:id/documents/:filename (own download)
// Admin:    GET  /api/admin/manual
//           GET  /api/admin/manual/:id
//           PUT  /api/admin/manual/:id  (status / admin_note)
//           POST /api/admin/manual/:id/delivery-docs (delivery file)
//           DELETE /api/admin/manual/:id (submission + its files)
//           GET  /api/admin/manual/:id/documents/:filename (download)
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { safeLog } = require('../security');
const parser = require('../utils/manual-parser');
const push = require('../utils/push');
const wa = require('../utils/whatsapp');

const UPLOAD_DIR = '/opt/all-in-one-abc-authentic/uploads/manual';

// ---- multer for manual documents (images + pdf) ----------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = ['.pdf', '.jpg', '.jpeg', '.png'].includes(ext) ? ext : '.bin';
    cb(null, 'manual-' + Date.now().toString(36) + '-' + crypto.randomBytes(8).toString('hex') + ok);
  },
});
const uploadDocs = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (!['pdf', 'jpg', 'jpeg', 'png'].includes(ext)) return cb(new Error('FILE_TYPE_NOT_ALLOWED'));
    cb(null, true);
  },
}).array('documents', 6);

// Admin delivery file for a submission (single file, field "file") —
// same storage/filter as customer uploads, lands in the same documents list
// with uploaded_by: 'admin' so the customer can download it back.
const uploadDelivery = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (!['pdf', 'jpg', 'jpeg', 'png'].includes(ext)) return cb(new Error('FILE_TYPE_NOT_ALLOWED'));
    cb(null, true);
  },
}).single('file');

// manual_submissions.documents is JSONB: pg may hand back a parsed array
// or (in mocks / older rows) a JSON string. Normalize to an array.
function parseDocs(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (_) { return []; } }
  return [];
}

// Default sample template (used when admin hasn't saved one)
const DEFAULT_TEMPLATE =
`নাম (বাংলা):
Name (English):
জন্ম তারিখ (Date of Birth):
মোবাইল নম্বর:

[ ঠিকানার বিবরণ / Address Details ]
বিভাগ:
জেলা:
উপজেলা:
ইউনিয়ন/ওয়ার্ড:
গ্রাম:
ডাকঘর:
`;

async function getTemplate() {
  try {
    const r = await db.query("SELECT value FROM settings WHERE key = 'manual_template'");
    if (r.rows.length && r.rows[0].value) {
      const v = r.rows[0].value;
      if (typeof v === 'string') {
        try { const j = JSON.parse(v); return typeof j === 'string' ? j : (j.text || DEFAULT_TEMPLATE); }
        catch (_) { return v; }
      }
      if (v && typeof v.text === 'string') return v.text;
    }
  } catch (e) { safeLog('[manual] template read failed:', e.message); }
  return DEFAULT_TEMPLATE;
}

// ============================================================
// CUSTOMER router — mounted at /api/manual (requireAuth)
// ============================================================
const customerManual = express.Router();
customerManual.use(requireAuth);

// GET /api/manual/template — sample format for customer to copy
customerManual.get('/template', async (req, res) => {
  const serviceId = req.query.service_id;
  if (serviceId) {
    try {
      const sr = await db.query('SELECT manual_sample FROM services WHERE id = $1', [serviceId]);
      if (sr.rows.length && sr.rows[0].manual_sample) {
        return res.json({ template: sr.rows[0].manual_sample, service_specific: true });
      }
    } catch (_) {}
  }
  res.json({ template: await getTemplate() });
});

// GET /api/manual/mine — customer's own submissions (with file list, so the
// customer keeps both their own uploads and admin delivery files)
customerManual.get('/mine', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT m.id, m.status, m.created_at, m.admin_note, m.documents,
              s.name_bn AS service_name_bn, s.name AS service_name,
              jsonb_array_length(m.documents) AS doc_count
       FROM manual_submissions m
       LEFT JOIN services s ON s.id = m.service_id
       WHERE m.user_id = $1 ORDER BY m.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const list = r.rows.map(m => ({
      ...m,
      documents: parseDocs(m.documents)
        .filter(d => d && d.filename)
        .map(d => ({ filename: d.filename, originalname: d.originalname || d.filename, uploaded_by: d.uploaded_by || 'customer' })),
    }));
    res.json({ list });
  } catch (e) { safeLog('[manual] mine error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// GET /api/manual/:id/documents/:filename — customer download (owner only).
// Serves both the customer's own uploads and admin delivery files.
customerManual.get('/:id/documents/:filename', async (req, res) => {
  try {
    const fn = path.basename(req.params.filename);
    const r = await db.query('SELECT documents FROM manual_submissions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const doc = parseDocs(r.rows[0].documents).find(d => d && path.basename(d.filename) === fn);
    if (!doc) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });
    const fp = path.join(UPLOAD_DIR, fn);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'FILE_MISSING' });
    res.download(fp, doc.originalname || fn);
  } catch (e) { safeLog('[manual] customer download error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// POST /api/manual/submit — text + documents
customerManual.post('/submit', (req, res) => {
  uploadDocs(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'UPLOAD_FAILED' });
    try {
      const rawText = String(req.body.raw_text || '').trim();
      if (!rawText) {
        // cleanup uploaded files on validation failure
        for (const f of (req.files || [])) { try { fs.unlinkSync(f.path); } catch (_) {} }
        return res.status(400).json({ error: 'EMPTY_TEXT' });
      }
      const serviceId = req.body.service_id || null;
      const parsed = parser.parseManualText(rawText);
      const docs = (req.files || []).map(f => ({
        filename: f.filename,
        originalname: f.originalname,
        size: f.size,
        mimetype: f.mimetype,
        uploaded_by: 'customer',
      }));
      const ins = await db.query(
        `INSERT INTO manual_submissions (user_id, service_id, raw_text, parsed_data, documents)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, status, created_at`,
        [req.user.id, serviceId, rawText, JSON.stringify(parsed), JSON.stringify(docs)]
      );
      const sub = ins.rows[0];
      // Notify admins: Web Push (async, non-blocking)
      try {
        const uname = req.user.name || req.user.phone || 'গ্রাহক';
        await push.notifyAdmins(db, '📝 নতুন ম্যানুয়াল আবেদন!',
          `${uname} — ম্যানুয়াল সেবার আবেদন পাঠিয়েছেন`, '/admin.html');
      } catch (e) { safeLog('[manual] push failed:', e.message); }
      res.json({ ok: true, id: sub.id });
    } catch (e) {
      safeLog('[manual] submit error:', e.message);
      res.status(500).json({ error: 'FAILED' });
    }
  });
});

// ============================================================
// ADMIN router — mounted at /api/admin/manual (auth + admin)
// ============================================================
const adminManual = express.Router();
adminManual.use(requireAuth, requireAdmin);

// GET /api/admin/manual — list (new first)
adminManual.get('/', async (req, res) => {
  try {
    const status = req.query.status;
    const conds = [];
    const params = [];
    if (status && ['new', 'processing', 'completed', 'rejected'].includes(status)) {
      conds.push('m.status = $1'); params.push(status);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await db.query(
      `SELECT m.id, m.status, m.created_at, m.admin_note,
              u.name AS user_name, u.phone AS user_phone,
              s.name_bn AS service_name_bn, s.name AS service_name,
              jsonb_array_length(m.documents) AS doc_count,
              (m.parsed_data->'flat'->>'নাম (বাংলা)') AS name_bn
       FROM manual_submissions m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN services s ON s.id = m.service_id
       ${where} ORDER BY m.created_at DESC LIMIT 100`,
      params
    );
    res.json({ list: r.rows });
  } catch (e) { safeLog('[manual] admin list error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// GET /api/admin/manual/:id — detail with formatted HTML + clean text
adminManual.get('/:id', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT m.*, u.name AS user_name, u.phone AS user_phone,
              s.name_bn AS service_name_bn, s.name AS service_name
       FROM manual_submissions m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN services s ON s.id = m.service_id
       WHERE m.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const m = r.rows[0];
    let parsed = m.parsed_data;
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch (_) { parsed = null; } }
    if (!parsed || !parsed.sections) parsed = parser.parseManualText(m.raw_text || '');
    res.json({
      id: m.id, status: m.status, created_at: m.created_at,
      admin_note: m.admin_note, user_name: m.user_name, user_phone: m.user_phone,
      service_name_bn: m.service_name_bn, service_name: m.service_name,
      documents: m.documents || [],
      parsed,
      clean_text: parser.toCleanText(parsed),
      html: parser.toHTML(parsed),
    });
  } catch (e) { safeLog('[manual] admin detail error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// PUT /api/admin/manual/:id — update status / admin_note.
// On a TRANSITION into completed/rejected the customer is told
// (this flow previously notified nobody at all): completed →
// WhatsApp + push, rejected → push. A re-save with the same
// status (e.g. an admin_note edit) never re-notifies.
adminManual.put('/:id', async (req, res) => {
  try {
    const { status, admin_note } = req.body || {};
    const before = await db.query(
      'SELECT user_id, service_id, status FROM manual_submissions WHERE id = $1',
      [req.params.id]
    );
    const sets = [];
    const params = [];
    let i = 1;
    if (status && ['new', 'processing', 'completed', 'rejected'].includes(status)) {
      sets.push(`status = $${i++}`); params.push(status);
    }
    if (admin_note !== undefined) {
      sets.push(`admin_note = $${i++}`); params.push(String(admin_note || '').slice(0, 2000));
    }
    if (!sets.length) return res.status(400).json({ error: 'NOTHING_TO_UPDATE' });
    sets.push(`updated_at = NOW()`);
    params.push(req.params.id);
    const r = await db.query(
      `UPDATE manual_submissions SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, status`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const prev = before.rows[0];
    if (prev && status && status !== prev.status && (status === 'completed' || status === 'rejected')) {
      if (status === 'completed') {
        let label = 'ম্যানুয়াল সেবা';
        try {
          const sv = await db.query('SELECT name_bn, name FROM services WHERE id = $1', [prev.service_id]);
          if (sv.rows.length) label = sv.rows[0].name_bn || sv.rows[0].name || label;
        } catch (_) {}
        wa.notifyServiceCompleted(db, prev.user_id, label).catch(() => {});
        push.notifyUser(db, prev.user_id, '✅ আপনার সেবা সম্পন্ন!',
          'আপনার ' + label + ' সম্পন্ন হয়েছে — ডেলিভারি ফাইলটি ইতিহাসে পাবেন।', '/history.html').catch(() => {});
      } else {
        push.notifyUser(db, prev.user_id, '❌ সেবার অনুরোধ সম্পন্ন হয়নি',
          'দুঃখিত — আপনার ম্যানুয়াল সেবার অনুরোধটি সম্পন্ন করা যায়নি। সহায়তার জন্য সাপোর্টে যোগাযোগ করুন।', '/history.html').catch(() => {});
      }
    }
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) { safeLog('[manual] admin update error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// POST /api/admin/manual/:id/delivery-docs — admin attaches the result /
// delivery file to a submission; the customer can then download it from
// their own list (documents entry with uploaded_by: 'admin').
adminManual.post('/:id/delivery-docs', (req, res) => {
  uploadDelivery(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'UPLOAD_FAILED' });
    try {
      if (!req.file) return res.status(400).json({ error: 'NO_FILE' });
      const r = await db.query('SELECT documents FROM manual_submissions WHERE id = $1', [req.params.id]);
      if (!r.rows.length) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(404).json({ error: 'NOT_FOUND' });
      }
      const docs = parseDocs(r.rows[0].documents);
      docs.push({
        filename: req.file.filename,
        originalname: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        uploaded_by: 'admin',
        type: 'delivery',
      });
      await db.query('UPDATE manual_submissions SET documents = $1, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(docs), req.params.id]);
      res.json({ ok: true, filename: req.file.filename });
    } catch (e) { safeLog('[manual] delivery upload error:', e.message); res.status(500).json({ error: 'FAILED' }); }
  });
});

// DELETE /api/admin/manual/:id — remove a submission and its files.
// Row first, files second: if the file cleanup fails only harmless
// orphans remain; the reverse order could leave a live row whose
// documents point at deleted files.
adminManual.delete('/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT documents FROM manual_submissions WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const docs = parseDocs(r.rows[0].documents);
    await db.query('DELETE FROM manual_submissions WHERE id = $1', [req.params.id]);
    for (const d of docs) {
      if (d && d.filename) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(d.filename))); } catch (_) {}
      }
    }
    res.json({ ok: true });
  } catch (e) { safeLog('[manual] admin delete error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// GET /api/admin/manual/:id/documents/:filename — admin download
adminManual.get('/:id/documents/:filename', async (req, res) => {
  try {
    const fn = path.basename(req.params.filename);
    const r = await db.query('SELECT documents FROM manual_submissions WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    let docs = r.rows[0].documents;
    if (typeof docs === 'string') { try { docs = JSON.parse(docs); } catch (_) { docs = []; } }
    const doc = (docs || []).find(d => d && path.basename(d.filename) === fn);
    if (!doc) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });
    const fp = path.join(UPLOAD_DIR, fn);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'FILE_MISSING' });
    res.download(fp, doc.originalname || fn);
  } catch (e) { safeLog('[manual] download error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

module.exports = { customerManual, adminManual };
