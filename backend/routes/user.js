// ============================================================
// All In One (Abc Authentic) - User routes (Phase 2)
// Mounted at /api with requireAuth. All user-scoped: users can
// only see/touch their own data. Wallet ops use wallet_apply()
// (atomic, no negative, idempotent).
// ============================================================
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../auth');
const { safeLog, uploadMiddleware, orderDocUpload } = require('../security');
const path = require('path');
const fs = require('fs');

// Order document uploads: settings-driven via orderDocUpload(db, 'order') (H-12).
// Filenames stay random (C-2: never embed req.params.id).
const push = require('../utils/push');
const wa = require('../utils/whatsapp');
const { tryAutoMatchRecharge } = require('./sms');
const serviceCredits = require('../lib/serviceCredits');

// Fraud alerts (duplicate TrxID / amount mismatch at submit) notify
// the attempter + admins at most once per user+trxid per hour, so a
// scripted repeat cannot flood WhatsApp or the admin push channel.
const fraudAlertSeen = new Map();
function fraudAlertOnce(key) {
  const now = Date.now();
  const last = fraudAlertSeen.get(key);
  if (last && now - last < 3600e3) return false;
  fraudAlertSeen.set(key, now);
  if (fraudAlertSeen.size > 500) fraudAlertSeen.clear();
  return true;
}

const router = express.Router();
router.use(requireAuth);

function safeJsonArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const p = JSON.parse(val);
      if (Array.isArray(p)) return p;
    } catch (_) {}
  }
  return [];
}

function pageParams(req) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10) || 10));
  return { page, limit, offset: (page - 1) * limit };
}

// ---- effective price for a user+service -----------------------
async function effectivePrice(userId, service) {
  const r = await db.query(
    'SELECT custom_price, access_enabled FROM user_services WHERE user_id = $1 AND service_id = $2',
    [userId, service.id]
  );
  if (r.rows.length) {
    if (r.rows[0].access_enabled === false) return { allowed: false };
    const p = r.rows[0].custom_price;
    return { allowed: true, price: p === null ? Number(service.price) : Number(p) };
  }
  return { allowed: true, price: Number(service.price) };
}

// ---- service schedule check -----------------------------------
// M-11 fix (2026-10-15): evaluated in Asia/Dhaka (was server-local TZ).
// schedule.days uses JS numbering: 0=Sunday … 6=Saturday.
function serviceOpen(schedule) {
  if (!schedule || (!schedule.open && !schedule.close)) return true;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka', weekday: 'short', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')];
    if (Array.isArray(schedule.days) && schedule.days.length && !schedule.days.includes(wd)) {
      return false;
    }
    const hhmm = get('hour') + ':' + get('minute');
    if (schedule.open && hhmm < schedule.open) return false;
    if (schedule.close && hhmm > schedule.close) return false;
    return true;
  } catch (e) { return true; }
}

// ============================================================
// SERVICES
// ============================================================

// GET /api/services — active, serial order, with per-user price/access
router.get('/services', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT s.*, sc.id AS cat_id, sc.name AS cat_name, sc.name_bn AS cat_name_bn,
              sc.icon AS cat_icon, sc.serial AS cat_serial
       FROM services s
       LEFT JOIN service_categories sc ON sc.id = s.category_id AND sc.status = 'active'
       WHERE s.status = 'active' ORDER BY s.serial ASC, s.created_at ASC`);
    const out = [];
    for (const s of rows.rows) {
      const eff = await effectivePrice(req.user.id, s);
      if (!eff.allowed) continue;
      out.push({
        id: s.id, name: s.name, name_bn: s.name_bn, type: s.type,
        price: eff.price, serial: s.serial,
        // category (null when uncategorized or category disabled -> grouped under অন্যান্য)
        category_id: s.cat_id || null,
        category_name: s.cat_name || null,
        category_name_bn: s.cat_name_bn || null,
        category_icon: s.cat_icon || null,
        category_serial: s.cat_serial == null ? null : Number(s.cat_serial),
        documents_required: safeJsonArray(s.documents_required),
        fields_required: safeJsonArray(s.fields_required),
        schedule: s.schedule, rules_text: s.rules_text,
        engine_id: s.engine_id, open: serviceOpen(s.schedule),
        manual_instructions: s.manual_instructions || null,
        manual_sample: s.manual_sample || null,
        manual_doc_count: s.manual_doc_count || 1,
      });
    }
    res.json({ services: out });
  } catch (e) {
    safeLog('[user] services error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

router.get('/services/:id', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT s.*, sc.id AS cat_id, sc.name AS cat_name, sc.name_bn AS cat_name_bn, sc.icon AS cat_icon
       FROM services s
       LEFT JOIN service_categories sc ON sc.id = s.category_id AND sc.status = 'active'
       WHERE s.id = $1 AND s.status = 'active'`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const s = r.rows[0];
    const eff = await effectivePrice(req.user.id, s);
    if (!eff.allowed) return res.status(403).json({ error: 'NO_ACCESS' });
    res.json({
      service: {
        id: s.id, name: s.name, name_bn: s.name_bn, type: s.type,
        price: eff.price, documents_required: safeJsonArray(s.documents_required),
        fields_required: safeJsonArray(s.fields_required), schedule: s.schedule,
        rules_text: s.rules_text, engine_id: s.engine_id,
        open: serviceOpen(s.schedule),
        category_id: s.cat_id || null,
        category_name: s.cat_name || null,
        category_name_bn: s.cat_name_bn || null,
        category_icon: s.cat_icon || null,
        manual_instructions: s.manual_instructions || null,
        manual_sample: s.manual_sample || null,
        manual_doc_count: s.manual_doc_count || 1,
      },
    });
  } catch (e) {
    safeLog('[user] service detail error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// ============================================================
// ORDERS
// ============================================================

// POST /api/orders — create order, debit wallet atomically
router.post('/orders', async (req, res) => {
  const clientKey = (req.body && req.body.idempotency_key)
    ? String(req.body.idempotency_key).slice(0, 64)
    : String(Date.now());
  try {
    const { service_id, data, notes } = req.body || {};
    if (!service_id) return res.status(400).json({ error: 'MISSING_SERVICE' });

    const sr = await db.query(
      `SELECT * FROM services WHERE id = $1 AND status = 'active'`, [service_id]);
    if (!sr.rows.length) return res.status(404).json({ error: 'SERVICE_NOT_FOUND' });
    const service = sr.rows[0];

    const eff = await effectivePrice(req.user.id, service);
    if (!eff.allowed) return res.status(403).json({ error: 'NO_ACCESS' });
    if (!serviceOpen(service.schedule)) {
      return res.status(403).json({ error: 'SERVICE_CLOSED', schedule: service.schedule });
    }

    // Validate required documents for manual services
    const docs = (req.body.documents || []);
    const required = safeJsonArray(service.documents_required);
    const missing = required.filter((d) => !docs.some((x) => x && x.type === d));
    if (missing.length) {
      return res.status(400).json({ error: 'MISSING_DOCUMENTS', missing });
    }

    // M-15: idempotency key resolved at handler entry so catch block can access it
    const order = await db.withTransaction(async (client) => {
      // Pay for the service: service-locked credit for THIS service
      // is consumed first, the rest comes from the wallet balance
      // (lib/serviceCredits). Raises INSUFFICIENT_BALANCE if the two
      // together cannot cover the price; the payment ref dedupes
      // double submits exactly like wallet_apply did.
      await serviceCredits.payForService(client, {
        userId: req.user.id, serviceId: service_id,
        amount: Math.abs(eff.price), ref: 'order-' + clientKey + '-' + req.user.id,
      });
      const ins = await client.query(
        `INSERT INTO orders (user_id, service_id, status, data, documents, notes, price, idempotency_key)
         VALUES ($1, $2, 'new', $3, $4, $5, $6, $7) RETURNING *`,
        [req.user.id, service_id,
         JSON.stringify(data || {}), JSON.stringify(docs),
         notes || null, eff.price, clientKey]
      );
      return ins.rows[0];
    });

    // Web Push: notify admins of new order (async, non-blocking)
    push.notifyNewOrder(db, order, service.name_bn || service.name, req.user.id).catch(() => {});

    res.status(201).json({ order });
  } catch (e) {
    safeLog('[user] order create error:', e.message);
    if (/INSUFFICIENT_BALANCE/.test(e.message)) {
      return res.status(402).json({ error: 'INSUFFICIENT_BALANCE' });
    }
    // M-2: duplicate submit → return the already-created order instead of 500
    // (the client can never recover the first order from ORDER_FAILED).
    if (/DUPLICATE_TRANSACTION/.test(e.message)) {
      try {
        const ex = await db.query(
          `SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2
           ORDER BY created_at DESC LIMIT 1`,
          [req.user.id, String(clientKey)]
        );
        if (ex.rows.length) return res.json({ order: ex.rows[0], duplicate: true });
      } catch (e2) { safeLog('[user] duplicate-order lookup skipped:', e2.message); }
    }
    res.status(500).json({ error: 'ORDER_FAILED' });
  }
});

// GET /api/orders — own orders, paginated (no endless scroll)
router.get('/orders', async (req, res) => {
  try {
    const { page, limit, offset } = pageParams(req);
    const conds = ['o.user_id = $1'];
    const params = [req.user.id];
    let i = 2;
    if (req.query.status) { conds.push(`o.status = $${i++}`); params.push(req.query.status); }
    const where = 'WHERE ' + conds.join(' AND ');
    const total = await db.query(`SELECT COUNT(*) FROM orders o ${where}`, params);
    const rows = await db.query(
      `SELECT o.*, s.name AS service_name, s.name_bn AS service_name_bn
       FROM orders o JOIN services s ON s.id = o.service_id
       ${where} ORDER BY o.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]);
    res.json({ orders: rows.rows, total: parseInt(total.rows[0].count, 10), page, limit });
  } catch (e) {
    safeLog('[user] orders error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/order-counts — dashboard stats, server-side counts (no row scan,
// no limit-cap skew). Semantics match the old client-side counting exactly.
router.get('/order-counts', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status IN ('completed','delivered')) AS done,
              COUNT(*) FILTER (WHERE status IN ('new','pending','processing')) AS active
       FROM orders WHERE user_id = $1`,
      [req.user.id]);
    const c = r.rows[0];
    res.json({ total: Number(c.total), done: Number(c.done), active: Number(c.active) });
  } catch (e) {
    safeLog('[user] order-counts error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/orders/:id — own order + timeline
router.get('/orders/:id', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT o.*, s.name AS service_name, s.name_bn AS service_name_bn
       FROM orders o JOIN services s ON s.id = o.service_id
       WHERE o.id = $1 AND o.user_id = $2`,
      [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ order: r.rows[0] });
  } catch (e) {
    safeLog('[user] order detail error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/orders/:id/history — status timeline for the order owner (H-1)
router.get('/orders/:id/history', async (req, res) => {
  try {
    const own = await db.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const r = await db.query(
      `SELECT from_status, to_status, note, created_at FROM order_status_history
       WHERE order_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ history: r.rows });
  } catch (e) {
    safeLog('[user] order history error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// ============================================================
// CHAT (contextual: order complaints / reviews — order page only)
// ============================================================

router.get('/orders/:id/chat', async (req, res) => {
  try {
    const own = await db.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const rows = await db.query(
      `SELECT id, sender, message, created_at FROM chat_messages
       WHERE order_id = $1 ORDER BY created_at ASC LIMIT 200`, [req.params.id]);
    res.json({ messages: rows.rows });
  } catch (e) {
    safeLog('[user] chat list error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

router.post('/orders/:id/chat', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || String(message).trim().length < 1 || String(message).trim().length > 2000) {
      return res.status(400).json({ error: 'INVALID_MESSAGE' });
    }
    const own = await db.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const r = await db.query(
      `INSERT INTO chat_messages (order_id, user_id, sender, message)
       VALUES ($1, $2, 'user', $3) RETURNING id, sender, message, created_at`,
      [req.params.id, req.user.id, String(message).trim()]);
    // M-14: admin push notification on user chat message (with name)
    push.notifyNewChatMessage(db, req.params.id, req.user.id, String(message).trim()).catch(() => {});
    res.status(201).json({ message: r.rows[0] });
  } catch (e) {
    safeLog('[user] chat send error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/orders/:id/messages — admin support messages for own order (Phase 3)
router.get('/orders/:id/messages', async (req, res) => {
  try {
    const own = await db.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const rows = await db.query(
      `SELECT m.id, m.template_key, m.message, m.created_at, u.name AS admin_name
       FROM order_support_messages m
       LEFT JOIN users u ON u.id = m.admin_id
       WHERE m.order_id = $1 ORDER BY m.created_at DESC LIMIT 20`,
      [req.params.id]);
    res.json({ messages: rows.rows });
  } catch (e) {
    safeLog('[user] support messages error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// ============================================================
// WALLET
// ============================================================

// Upload document for an order (customer uploads required docs)
router.post('/orders/:id/documents', orderDocUpload(db, 'order'), async (req, res) => {
  try {
    const orderId = req.params.id;
    const docType = req.body.doc_type || 'document';
    // Verify order belongs to user
    const ord = await db.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [orderId, req.user.id]);
    if (!ord.rows.length) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
    if (!req.file) return res.status(400).json({ error: 'NO_FILE' });
    const order = ord.rows[0];
    const docs = safeJsonArray(order.documents);
    docs.push({
      type: docType,
      filename: req.file.filename,
      originalname: req.file.originalname,
      path: req.file.path,
      uploaded_at: new Date().toISOString(),
      uploaded_by: 'customer'
    });
    await db.query('UPDATE orders SET documents=$1 WHERE id=$2', [JSON.stringify(docs), orderId]);
    res.json({ ok: true, filename: req.file.filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/orders/:id/documents/:filename — download order document (owner only).
// Validates: order belongs to user AND filename is in order.documents (no path traversal).
router.get('/orders/:id/documents/:filename', async (req, res) => {
  try {
    const orderId = req.params.id;
    const fn = require('path').basename(req.params.filename);
    const ord = await db.query('SELECT documents FROM orders WHERE id=$1 AND user_id=$2', [orderId, req.user.id]);
    if (!ord.rows.length) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
    const docs = safeJsonArray(ord.rows[0].documents);
    const doc = docs.find(d => d && require('path').basename(d.filename) === fn);
    if (!doc) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });
    const fp = require('path').join('/opt/all-in-one-abc-authentic/uploads/orders', fn);
    const fs = require('fs');
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'FILE_MISSING' });
    res.download(fp, doc.originalname || fn);
  } catch (e) {
    safeLog('[user] order document download error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/history — delivery files only. Per the owner's design call
// (2026-10-21) History keeps NO work details at all: just the files the
// customer received as deliveries — admin-uploaded files on orders and
// manual submissions, NID card PDFs stored on their orders, and stored
// certificate / death-verify engine PDFs — so a delivered file can
// always be found and re-downloaded from one place, whatever
// phone/browser they use. (BDRIS applications stay out by his call.)
router.get('/history', async (req, res) => {
  try {
    const uid = req.user.id;
    const [orders, manual, engineJobs] = await Promise.all([
      db.query(
        `SELECT o.id, o.documents, o.created_at,
                s.name AS service_name, s.name_bn AS service_name_bn
         FROM orders o LEFT JOIN services s ON s.id = o.service_id
         WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [uid]),
      db.query(
        `SELECT m.id, m.documents, m.created_at,
                s.name AS service_name, s.name_bn AS service_name_bn
         FROM manual_submissions m LEFT JOIN services s ON s.id = m.service_id
         WHERE m.user_id = $1 ORDER BY m.created_at DESC LIMIT 100`, [uid]),
      db.query(
        `SELECT id, engine_id, subject_name, filename, originalname, created_at, outcome
         FROM engine_jobs
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [uid]),
    ]);
    const deliveryDocs = (raw, base) => safeJsonArray(raw)
      .filter(d => d && d.filename && d.uploaded_by === 'admin')
      .map(d => ({
        filename: d.filename,
        originalname: d.originalname || d.filename,
        url: base + encodeURIComponent(d.filename),
      }));
    const items = [];
    for (const o of orders.rows) {
      const documents = deliveryDocs(o.documents, '/orders/' + o.id + '/documents/');
      if (!documents.length) continue;
      items.push({
        kind: 'order', id: o.id,
        title: o.service_name_bn || o.service_name || 'সেবা অর্ডার',
        created_at: o.created_at, documents,
      });
    }
    for (const m of manual.rows) {
      const documents = deliveryDocs(m.documents, '/manual/' + m.id + '/documents/');
      if (!documents.length) continue;
      items.push({
        kind: 'manual', id: m.id,
        title: m.service_name_bn || m.service_name || 'ম্যানুয়াল সেবা',
        created_at: m.created_at, documents,
      });
    }
    for (const j of engineJobs.rows) {
      items.push({
        kind: 'engine', id: j.id,
        title: (j.engine_id === 'death-verify' ? 'মৃত্যু সনদ' : 'জন্ম সনদ (সার্টিফিকেট)') +
          (j.subject_name ? ' — ' + j.subject_name : '') +
          (j.outcome === 'failed' ? ' — ব্যর্থ' : ''),
        created_at: j.created_at,
        documents: [{
          filename: j.filename,
          originalname: j.originalname || j.filename,
          url: '/engine-jobs/' + j.id + '/file',
        }],
      });
    }
    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ ok: true, items: items.slice(0, 200) });
  } catch (e) {
    safeLog('[user] history error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

router.get('/wallet', async (req, res) => {
  try {
    const u = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const { page, limit, offset } = pageParams(req);
    const total = await db.query('SELECT COUNT(*) FROM transactions WHERE user_id = $1', [req.user.id]);
    const rows = await db.query(
      `SELECT id, type, amount, method, sender_no, trxid, status, created_at,
              (SELECT json_build_object('id', c.id, 'code', c.code, 'status', c.status, 'amount', c.amount)
               FROM coupons c WHERE c.recharge_id = transactions.id LIMIT 1) AS coupon
       FROM transactions WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]);

    let cashback = { enabled: false, percent: 0 };
    try {
      const cbSetting = await db.query("SELECT value FROM settings WHERE key = 'cashback' LIMIT 1");
      if (cbSetting.rows && cbSetting.rows[0] && cbSetting.rows[0].value) {
        const val = typeof cbSetting.rows[0].value === 'string'
          ? JSON.parse(cbSetting.rows[0].value)
          : cbSetting.rows[0].value;
        cashback = {
          enabled: val.enabled === true,
          percent: Number(val.percent) || 0,
        };
      }
    } catch (_) {}

    let svcCredits = [];
    try {
      const sc = await db.query(
        `SELECT sc.service_id, COALESCE(s.name_bn, s.name) AS service_name,
                SUM(sc.remaining) AS amount
           FROM service_credits sc
           JOIN services s ON s.id = sc.service_id
          WHERE sc.user_id = $1 AND sc.remaining > 0
            AND (sc.expires_at IS NULL OR sc.expires_at > NOW())
          GROUP BY sc.service_id, s.name_bn, s.name`, [req.user.id]);
      svcCredits = sc.rows.map((r) => ({
        service_id: r.service_id, service_name: r.service_name, amount: Number(r.amount),
      }));
    } catch (_) { /* table arrives with migration 032; wallet must not fail without it */ }

    res.json({
      balance: Number(u.rows[0].balance),
      transactions: rows.rows,
      service_credits: svcCredits,
      cashback,
      total: parseInt(total.rows[0].count, 10), page, limit,
    });
  } catch (e) {
    safeLog('[user] wallet error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// POST /api/wallet/recharge — bkash/nagad/rocket request (pending → admin approves)
router.post('/wallet/recharge', async (req, res) => {
  try {
    const { method, sender_no, trxid, amount, screenshot } = req.body || {};
    const methods = ['bkash_payment', 'bkash_personal', 'nagad', 'rocket'];
    if (!methods.includes(method)) return res.status(400).json({ error: 'INVALID_METHOD' });
    if (!/^01[3-9]\d{8}$/.test(String(sender_no || '').trim())) {
      return res.status(400).json({ error: 'INVALID_SENDER' });
    }
    const amt = Number(amount);
    if (!amt || amt < 10 || amt > 100000) {
      return res.status(400).json({ error: 'INVALID_AMOUNT' });
    }
    if (!trxid || String(trxid).trim().length < 4) {
      return res.status(400).json({ error: 'INVALID_TRXID' });
    }
    // Guards: max 3 pending, duplicate trxid
    const pending = await db.query(
      `SELECT COUNT(*) FROM transactions
       WHERE user_id = $1 AND type = 'recharge' AND status = 'pending'`, [req.user.id]);
    if (parseInt(pending.rows[0].count, 10) >= 3) {
      return res.status(400).json({ error: 'TOO_MANY_PENDING' });
    }
    const dup = await db.query(
      'SELECT id FROM transactions WHERE trxid = $1 LIMIT 1', [String(trxid).trim()]);
    if (dup.rows.length) {
      // Fraud attempt: warn the attempter (WhatsApp) + alert admins
      // (push), throttled per user+trxid. The attempt itself is blocked.
      if (fraudAlertOnce('dup:' + req.user.id + ':' + String(trxid).trim().toUpperCase())) {
        wa.notifyDuplicateTrxid(db, req.user.id, { trxid: String(trxid).trim(), amount: amt }).catch(() => {});
        push.notifyUser(db, req.user.id, '⚠️ সতর্কবার্তা',
          'এই TrxID দিয়ে আগেই একটি রিচার্জ সম্পন্ন হয়ে গেছে — একই TrxID দিয়ে দ্বিতীয়বার টাকা যোগ করা যায়নি।', '/wallet.html').catch(() => {});
        push.notifyDuplicateTrxid(db, { trxid: String(trxid).trim(), amount: amt }, req.user.id).catch(() => {});
      }
      return res.status(409).json({ error: 'DUP_TRXID' });
    }

    // Fraud guard: if an SMS with this TrxID already arrived, the reported
    // amount must equal it — tell the user immediately instead of at approval.
    const smsArrived = await db.query(
      `SELECT amount FROM incoming_sms
       WHERE trxid IS NOT NULL AND UPPER(trxid) = UPPER($1) AND amount IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [String(trxid).trim()]
    );
    if (smsArrived.rows.length) {
      const smsAmt = Number(smsArrived.rows[0].amount);
      if (Math.abs(smsAmt - amt) >= 0.005) {
        // Same fraud family: tell the user on WhatsApp and the admins
        // by push, throttled per user+trxid.
        if (fraudAlertOnce('mm:' + req.user.id + ':' + String(trxid).trim().toUpperCase())) {
          const attempt = { user_id: req.user.id, amount: amt, trxid: String(trxid).trim() };
          wa.notifyRechargeMismatch(db, attempt, smsAmt).catch(() => {});
          push.notifyUser(db, req.user.id, '⚠️ রিচার্জে পরিমাণের অমিল',
            'আপনার লেখা পরিমাণের সঙ্গে প্রাপ্ত SMS-এর পরিমাণ মেলেনি — টাকা যোগ হয়নি। সঠিক পরিমাণ লিখে আবার চেষ্টা করুন।', '/wallet.html').catch(() => {});
          push.notifyAmountMismatch(db, attempt, smsAmt).catch(() => {});
        }
        return res.status(409).json({ error: 'TRXID_AMOUNT_MISMATCH', sms_amount: smsAmt });
      }
    }

    const r = await db.query(
      `INSERT INTO transactions (user_id, type, amount, method, sender_no, trxid, screenshot, status)
       VALUES ($1, 'recharge', $2, $3, $4, $5, $6, 'pending') RETURNING *`,
      [req.user.id, amt, method, String(sender_no).trim(), String(trxid).trim(), screenshot || null]);

    let tx = r.rows[0];

    // Auto-match check: if SMS arrived before user submitted form
    try {
      const matched = await tryAutoMatchRecharge(tx);
      if (matched) tx = matched;
    } catch (err) {
      safeLog('[user] auto-match error:', err.message);
    }

    if (tx.status === 'pending') {
      // Web Push: notify admins of new recharge request (async, non-blocking)
      push.notifyNewRecharge(db, tx, req.user.id).catch(() => {});
    }

    res.status(201).json({ transaction: tx });
  } catch (e) {
    safeLog('[user] recharge error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// POST /api/wallet/coupon — redeem coupon code → wallet credit
router.post('/wallet/coupon', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'MISSING_CODE' });
    const codeN = String(code).trim().toUpperCase();
    if (codeN.length > 40) return res.status(400).json({ error: 'CODE_TOO_LONG' });

    await db.withTransaction(async (client) => {
      const c = await client.query(
        `SELECT * FROM coupons WHERE code = $1 AND status = 'active' LIMIT 1 FOR UPDATE`, [codeN]);
      const coupon = c.rows[0];
      if (!coupon) {
        const err = new Error('INVALID_CODE');
        err.statusCode = 404;
        throw err;
      }
      if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
        const err = new Error('EXPIRED_CODE');
        err.statusCode = 400;
        throw err;
      }
      if (coupon.user_id && coupon.user_id !== req.user.id) {
        const err = new Error('NOT_YOUR_CODE');
        err.statusCode = 403;
        throw err;
      }
      // Service scoping (owner rule, strict form, 2026-10-21): a
      // service-scoped coupon no longer credits the spend-anywhere
      // balance at all — its value becomes a service-locked credit
      // (service_credits), spendable only on that one service. The
      // old H-2 "must already have ordered the service" gate is
      // retired: the lock is now structural, so the coupon stays
      // usable for the customer's NEXT order of that service.

      const credit = Number(coupon.amount) > 0 ? Number(coupon.amount) : 0;
      let finalCredit = credit;
      // Dynamic percentage credit applies only when fixed amount is not set (e.g. promo coupons with amount=0).
      // Pre-calculated recharge coupons or fixed-amount coupons credit the exact coupon.amount.
      if (finalCredit <= 0 && Number(coupon.percent) > 0) {
        let spent;
        if (coupon.service_id) {
          // Service-scoped percent: base = ওই service-এ ব্যবহারকারীর মোট খরচ
          spent = await client.query(
            `SELECT COALESCE(SUM(price),0) AS s FROM orders
             WHERE user_id = $1 AND service_id = $2 AND status NOT IN ('cancelled','refunded')`,
            [req.user.id, coupon.service_id]);
        } else {
          spent = await client.query(
            `SELECT COALESCE(SUM(ABS(amount)),0) AS s FROM transactions
             WHERE user_id = $1 AND type = 'debit' AND status = 'approved'`, [req.user.id]);
        }
        finalCredit = Math.round(Number(spent.rows[0].s) * Number(coupon.percent) / 100 * 100) / 100;
      }
      if (finalCredit <= 0) {
        const err = new Error('ZERO_VALUE');
        err.statusCode = 400;
        throw err;
      }

      let lockedServiceName = null;
      if (coupon.service_id) {
        const inserted = await serviceCredits.addServiceCredit(client, {
          userId: req.user.id, serviceId: coupon.service_id,
          amount: finalCredit, source: coupon.type, ref: 'coupon-' + coupon.id,
          expiresAt: coupon.expires_at || null,
        });
        if (!inserted) {
          const err = new Error('ALREADY_REDEEMED');
          err.statusCode = 409;
          throw err;
        }
        const sn = await client.query('SELECT name_bn, name FROM services WHERE id = $1', [coupon.service_id]);
        if (sn.rows.length) lockedServiceName = sn.rows[0].name_bn || sn.rows[0].name;
      } else {
        await client.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
          req.user.id, finalCredit, coupon.type, 'coupon-' + coupon.id,
        ]);
      }
      await client.query(`UPDATE coupons SET status = 'redeemed' WHERE id = $1`, [coupon.id]);

      const bal = await client.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
      res.json({
        ok: true, credited: finalCredit, balance: Number(bal.rows[0].balance),
        service_locked: !!coupon.service_id,
        service_name: lockedServiceName,
      });
    });
  } catch (e) {
    safeLog('[user] coupon redeem error:', e.message);
    if (/DUPLICATE_TRANSACTION/.test(e.message)) {
      return res.status(409).json({ error: 'ALREADY_REDEEMED' });
    }
    if (e.statusCode) {
      return res.status(e.statusCode).json({ error: e.message });
    }
    res.status(500).json({ error: 'FAILED' });
  }
});

// ============================================================
// NOTICES + BANNERS (user-facing)
// ============================================================

router.get('/notices', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT id, title, message, created_at FROM notices
       WHERE user_id IS NULL OR user_id = $1
       ORDER BY created_at DESC LIMIT 20`, [req.user.id]);
    res.json({ notices: rows.rows });
  } catch (e) {
    safeLog('[user] notices error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/recharge-numbers — admin's receiving numbers for manual recharge
// (bKash Payment, bKash Personal, Nagad, Rocket). Set via Admin → Settings.
router.get('/recharge-numbers', async (req, res) => {
  try {
    const r = await db.query("SELECT value FROM settings WHERE key = 'recharge_numbers'");
    const nums = r.rows.length ? r.rows[0].value : {};
    res.json({
      numbers: {
        bkash_payment: nums.bkash_payment || '',
        bkash_personal: nums.bkash_personal || '',
        nagad: nums.nagad || '',
        rocket: nums.rocket || '',
      },
    });
  } catch (e) {
    safeLog('[user] recharge-numbers error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

router.get('/banners', async (req, res) => {
  try {
    const type = req.query.type;
    const params = [];
    let where = 'WHERE active = TRUE';
    if (type && ['banner', 'ad', 'popup'].includes(type)) {
      where += ' AND type = $1'; params.push(type);
    }
    const rows = await db.query(`SELECT * FROM banners ${where} ORDER BY created_at DESC`, params);
    res.json({ banners: rows.rows });
  } catch (e) {
    safeLog('[user] banners error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

module.exports = router;
