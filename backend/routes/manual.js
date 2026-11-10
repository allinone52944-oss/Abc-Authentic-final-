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
    // P2 (2026-11-03): admin_note is internal only — never in a
    // customer payload. Admin delivery files list only once the
    // submission is completed (same visibility rule as orders);
    // the customer's own uploads always list.
    const r = await db.query(
      `SELECT m.id, m.status, m.created_at, m.documents,
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
        .filter(d => d && d.filename &&
          (d.uploaded_by !== 'admin' || m.status === 'completed'))
        .map(d => ({ filename: d.filename, originalname: d.originalname || d.filename, uploaded_by: d.uploaded_by || 'customer' })),
    }));
    res.json({ list });
  } catch (e) { safeLog('[manual] mine error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// GET /api/manual/:id/documents/:filename — customer download (owner only).
// Serves both the customer's own uploads and admin delivery files.
// P2 (2026-11-03): an admin delivery file downloads only once the
// submission is completed; the customer's own uploads always do.
customerManual.get('/:id/documents/:filename', async (req, res) => {
  try {
    const fn = path.basename(req.params.filename);
    const r = await db.query('SELECT status, documents FROM manual_submissions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const doc = parseDocs(r.rows[0].documents).find(d => d && path.basename(d.filename) === fn);
    if (!doc) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });
    if (doc.uploaded_by === 'admin' && r.rows[0].status !== 'completed') {
      return res.status(403).json({ error: 'NOT_DELIVERED_YET' });
    }
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
      // Admin-order fix (2026-11-03): a manual submission is the
      // payment-free track, so it may only name a manual-type
      // service. The old code accepted ANY service_id (including
      // priced automated services) with no lookup at all — a free
      // intake path for paid services. Null service_id keeps the
      // old behaviour (unlinked submission).
      if (serviceId) {
        const sr = await db.query('SELECT type FROM services WHERE id = $1', [serviceId]);
        if (!sr.rows.length || sr.rows[0].type !== 'manual') {
          for (const f of (req.files || [])) { try { fs.unlinkSync(f.path); } catch (_) {} }
          return res.status(400).json({ error: sr.rows.length ? 'NOT_MANUAL_SERVICE' : 'SERVICE_NOT_FOUND' });
        }
      }
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
// P2 (2026-11-03): q filter (name/phone/number) + total, mirroring
// the BDRIS/engine queue searches from the orders-page split.
adminManual.get('/', async (req, res) => {
  try {
    const status = req.query.status;
    const conds = [];
    const params = [];
    let i = 1;
    if (status && ['new', 'processing', 'completed', 'rejected'].includes(status)) {
      conds.push(`m.status = $${i++}`); params.push(status);
    }
    const q = (req.query.q || '').trim();
    if (q) {
      conds.push(`(u.name ILIKE $${i} OR u.phone ILIKE $${i} OR CAST(m.id AS TEXT) ILIKE $${i} OR (m.parsed_data->'flat'->>'নাম (বাংলা)') ILIKE $${i})`);
      params.push('%' + q + '%'); i++;
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const [r, t] = await Promise.all([
      db.query(
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
      ),
      db.query(
        `SELECT COUNT(*) FROM manual_submissions m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN services s ON s.id = m.service_id
         ${where}`,
        params
      ),
    ]);
    res.json({ list: r.rows, total: parseInt(t.rows[0].count, 10) });
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
// On a TRANSITION into completed/rejected the customer is told:
// completed → WhatsApp + push, rejected → WhatsApp + push (P2:
// rejected previously pushed only). A re-save with the same
// status (e.g. an admin_note edit) never re-notifies.
// Admin-order fix (2026-11-03): manual submissions had NO transition
// map — completed → new backwards was accepted. Same shape as the
// order map, but for the manual vocabulary (new/processing/completed/
// rejected). Same-status re-saves stay allowed (note edits) and never
// re-notify (the existing guard below).
const MANUAL_TRANSITIONS = {
  new: ['processing', 'completed', 'rejected'],
  processing: ['completed', 'rejected'],
  completed: [],
  rejected: [],
};

adminManual.put('/:id', async (req, res) => {
  try {
    const { status, admin_note } = req.body || {};
    const statusValid = status && ['new', 'processing', 'completed', 'rejected'].includes(status);
    if (!statusValid && admin_note === undefined) {
      return res.status(400).json({ error: 'NOTHING_TO_UPDATE' });
    }
    // B2 (2026-11-03): the whole PUT runs inside ONE transaction,
    // on a row locked with SELECT ... FOR UPDATE — the order PUT
    // pattern. The old code read-then-wrote in separate queries
    // with no status guard, so two concurrent PUTs could both
    // read the old status and both notify. Now the second PUT
    // waits on the lock, then reads the NEW status: a repeat of
    // the same transition becomes a silent same-status save and
    // an onward jump from the new state hits INVALID_TRANSITION —
    // either way it never notifies twice. Notifications fire only
    // AFTER commit, and only on a real transition.
    const note = (admin_note === undefined)
      ? null : String(admin_note || '').slice(0, 2000);
    let result;
    try {
      result = await db.withTransaction(async (client) => {
        const before = await client.query(
          'SELECT user_id, service_id, status, documents, admin_note FROM manual_submissions WHERE id = $1 FOR UPDATE',
          [req.params.id]
        );
        if (!before.rows.length) {
          const e = new Error('NOT_FOUND'); e.statusCode = 404; throw e;
        }
        const prev = before.rows[0];
        if (statusValid && status !== prev.status &&
            !(MANUAL_TRANSITIONS[prev.status] || []).includes(status)) {
          const e = new Error('INVALID_TRANSITION');
          e.statusCode = 400; e.from = prev.status;
          e.allowed = MANUAL_TRANSITIONS[prev.status] || [];
          throw e;
        }
        if (!statusValid || status === prev.status) {
          // Same status: a note edit may change admin_note, but
          // nothing else moves — no UPDATE at all when there is
          // no new note (or the note is unchanged), no history
          // row, and NO notification (a note save must never
          // re-notify). An invalid status string is ignored here
          // exactly as the old code ignored it.
          if (note === null || note === prev.admin_note) {
            return { row: { id: req.params.id, status: prev.status }, prev, changed: false };
          }
          const upd = await client.query(
            `UPDATE manual_submissions SET admin_note = $1, updated_at = NOW()
             WHERE id = $2 AND status = $3 RETURNING id, status`,
            [note, req.params.id, prev.status]
          );
          if (upd.rows.length !== 1) {
            const e = new Error('STALE_WRITE'); e.statusCode = 409; throw e;
          }
          return { row: upd.rows[0], prev, changed: false };
        }
        const upd = await client.query(
          `UPDATE manual_submissions SET status = $1, admin_note = COALESCE($2, admin_note), updated_at = NOW()
           WHERE id = $3 AND status = $4 RETURNING id, status`,
          [status, note, req.params.id, prev.status]
        );
        if (upd.rows.length !== 1) {
          const e = new Error('STALE_WRITE'); e.statusCode = 409; throw e;
        }
        return { row: upd.rows[0], prev, changed: true, to: status };
      });
    } catch (e) {
      if (e.statusCode) {
        const body = { error: e.message };
        if (e.from !== undefined) { body.from = e.from; body.allowed = e.allowed; }
        return res.status(e.statusCode).json(body);
      }
      throw e;
    }
    const prev = result.prev;
    if (result.changed && (result.to === 'completed' || result.to === 'rejected')) {
      if (result.to === 'completed') {
        let label = 'ম্যানুয়াল সেবা';
        try {
          const sv = await db.query('SELECT name_bn, name FROM services WHERE id = $1', [prev.service_id]);
          if (sv.rows.length) label = sv.rows[0].name_bn || sv.rows[0].name || label;
        } catch (_) {}
        // Admin-order fix (2026-11-03): the file sentence goes out
        // ONLY when an admin delivery file actually exists on the
        // submission — completed-without-a-file used to promise one.
        const hasDelivery = parseDocs(prev.documents)
          .some((d) => d && d.uploaded_by === 'admin');
        wa.notifyServiceCompleted(db, prev.user_id, label, { hasDeliveryFile: hasDelivery }).catch(() => {});
        push.notifyUser(db, prev.user_id, '✅ আপনার সেবা সম্পন্ন!',
          hasDelivery
            ? 'আপনার ' + label + ' সম্পন্ন হয়েছে — ডেলিভারি ফাইলটি ইতিহাসে পাবেন।'
            : 'আপনার ' + label + ' সম্পন্ন হয়েছে।',
          '/history.html').catch(() => {});
      } else {
        // P2 (2026-11-03): rejected now notifies on WhatsApp too,
        // in the completed pattern (template first via dispatch,
        // free-text fallback when no template is mapped) + push.
        let label = 'ম্যানুয়াল সেবা';
        try {
          const sv = await db.query('SELECT name_bn, name FROM services WHERE id = $1', [prev.service_id]);
          if (sv.rows.length) label = sv.rows[0].name_bn || sv.rows[0].name || label;
        } catch (_) {}
        wa.notifyServiceRejected(db, prev.user_id, label).catch(() => {});
        push.notifyUser(db, prev.user_id, '❌ সেবার অনুরোধ সম্পন্ন হয়নি',
          'দুঃখিত — আপনার ম্যানুয়াল সেবার অনুরোধটি সম্পন্ন করা যায়নি। সহায়তার জন্য সাপোর্টে যোগাযোগ করুন।', '/history.html').catch(() => {});
      }
    }
    res.json({ ok: true, ...result.row });
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
      // Lost-update fix: lock the submission row while appending, so two
      // uploads at once both land (the later one used to erase the earlier).
      const out = await db.withTransaction(async (client) => {
        const r = await client.query('SELECT user_id, service_id, status, documents FROM manual_submissions WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!r.rows.length) return { code: 404, error: 'NOT_FOUND' };
        // B3 (2026-11-03): a rejected submission must not receive new files.
        if (r.rows[0].status === 'rejected') return { code: 400, error: 'INVALID_STATUS', status: 'rejected' };
        const list = parseDocs(r.rows[0].documents);
        list.push({
          filename: req.file.filename,
          originalname: req.file.originalname,
          size: req.file.size,
          mimetype: req.file.mimetype,
          uploaded_by: 'admin',
          type: 'delivery',
        });
        await client.query('UPDATE manual_submissions SET documents = $1, updated_at = NOW() WHERE id = $2',
          [JSON.stringify(list), req.params.id]);
        return { row: r.rows[0] };
      });
      if (out.error) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        const body = { error: out.error };
        if (out.status) body.status = out.status;
        return res.status(out.code).json(body);
      }
      const r = { rows: [out.row] };
      const wasCompleted = r.rows[0].status === 'completed';
      // A file added to an ALREADY-completed submission must tell
      // the customer — otherwise they never look again (the order
      // delivered late-file branch). Files added while the
      // submission is still new/processing stay silent: the
      // completion transition notifies afterwards, and the file
      // is not even visible to the customer until then.
      // Notify failures never fail the upload itself.
      if (wasCompleted) {
        if (typeof wa.notifyDeliveryFileAdded === 'function') {
          wa.notifyDeliveryFileAdded(db,
            { id: req.params.id, user_id: r.rows[0].user_id, service_id: r.rows[0].service_id }).catch(() => {});
        }
        push.notifyUser(db, r.rows[0].user_id, '📎 নতুন ডেলিভারি ফাইল যোগ হয়েছে',
          'আপনার সম্পন্ন ম্যানুয়াল সেবায় একটি নতুন ডেলিভারি ফাইল যোগ করা হয়েছে — ইতিহাস থেকে ডাউনলোড করতে পারবেন।',
          '/history.html').catch(() => {});
      }
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
