// ============================================================
// All In One (Abc Authentic) - User routes (Phase 2)
// Mounted at /api with requireAuth. All user-scoped: users can
// only see/touch their own data. Wallet ops use wallet_apply()
// (atomic, no negative, idempotent).
// ============================================================
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { safeLog } = require('../security');

const router = express.Router();
router.use(requireAuth);

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
function serviceOpen(schedule) {
  if (!schedule || (!schedule.open && !schedule.close)) return true;
  try {
    const now = new Date();
    const day = now.getDay(); // 0=Sun
    if (Array.isArray(schedule.days) && schedule.days.length && !schedule.days.includes(day)) {
      return false;
    }
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
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
      `SELECT * FROM services WHERE status = 'active' ORDER BY serial ASC, created_at ASC`);
    const out = [];
    for (const s of rows.rows) {
      const eff = await effectivePrice(req.user.id, s);
      if (!eff.allowed) continue;
      out.push({
        id: s.id, name: s.name, name_bn: s.name_bn, type: s.type,
        price: eff.price, serial: s.serial,
        documents_required: s.documents_required,
        fields_required: s.fields_required,
        schedule: s.schedule, rules_text: s.rules_text,
        engine_id: s.engine_id, open: serviceOpen(s.schedule),
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
      `SELECT * FROM services WHERE id = $1 AND status = 'active'`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const s = r.rows[0];
    const eff = await effectivePrice(req.user.id, s);
    if (!eff.allowed) return res.status(403).json({ error: 'NO_ACCESS' });
    res.json({
      service: {
        id: s.id, name: s.name, name_bn: s.name_bn, type: s.type,
        price: eff.price, documents_required: s.documents_required,
        fields_required: s.fields_required, schedule: s.schedule,
        rules_text: s.rules_text, engine_id: s.engine_id,
        open: serviceOpen(s.schedule),
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
    const required = service.documents_required || [];
    const missing = required.filter((d) => !docs.some((x) => x && x.type === d));
    if (missing.length) {
      return res.status(400).json({ error: 'MISSING_DOCUMENTS', missing });
    }

    const order = await db.withTransaction(async (client) => {
      // Debit wallet (raises INSUFFICIENT_BALANCE if not enough)
      await client.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
        req.user.id, -Math.abs(eff.price), 'debit', 'order-' + Date.now() + '-' + req.user.id,
      ]);
      const ins = await client.query(
        `INSERT INTO orders (user_id, service_id, status, data, documents, notes, price)
         VALUES ($1, $2, 'new', $3, $4, $5, $6) RETURNING *`,
        [req.user.id, service_id,
         JSON.stringify(data || {}), JSON.stringify(docs),
         notes || null, eff.price]
      );
      return ins.rows[0];
    });

    res.status(201).json({ order });
  } catch (e) {
    safeLog('[user] order create error:', e.message);
    if (/INSUFFICIENT_BALANCE/.test(e.message)) {
      return res.status(402).json({ error: 'INSUFFICIENT_BALANCE' });
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

router.get('/wallet', async (req, res) => {
  try {
    const u = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const { page, limit, offset } = pageParams(req);
    const total = await db.query('SELECT COUNT(*) FROM transactions WHERE user_id = $1', [req.user.id]);
    const rows = await db.query(
      `SELECT id, type, amount, method, sender_no, trxid, status, created_at
       FROM transactions WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]);
    res.json({
      balance: Number(u.rows[0].balance),
      transactions: rows.rows,
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
    if (dup.rows.length) return res.status(409).json({ error: 'DUP_TRXID' });

    const r = await db.query(
      `INSERT INTO transactions (user_id, type, amount, method, sender_no, trxid, screenshot, status)
       VALUES ($1, 'recharge', $2, $3, $4, $5, $6, 'pending') RETURNING *`,
      [req.user.id, amt, method, String(sender_no).trim(), String(trxid).trim(), screenshot || null]);
    res.status(201).json({ transaction: r.rows[0] });
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

    const c = await db.query(
      `SELECT * FROM coupons WHERE code = $1 AND status = 'active' LIMIT 1`, [codeN]);
    const coupon = c.rows[0];
    if (!coupon) return res.status(404).json({ error: 'INVALID_CODE' });
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      return res.status(400).json({ error: 'EXPIRED_CODE' });
    }
    if (coupon.user_id && coupon.user_id !== req.user.id) {
      return res.status(403).json({ error: 'NOT_YOUR_CODE' });
    }

    const credit = Number(coupon.amount) > 0 ? Number(coupon.amount) : 0;
    // Cashback percent applies to user's lifetime spend
    let finalCredit = credit;
    if (Number(coupon.percent) > 0) {
      const spent = await db.query(
        `SELECT COALESCE(SUM(ABS(amount)),0) AS s FROM transactions
         WHERE user_id = $1 AND type = 'debit' AND status = 'approved'`, [req.user.id]);
      finalCredit = Math.round(Number(spent.rows[0].s) * Number(coupon.percent) / 100 * 100) / 100;
    }
    if (finalCredit <= 0) return res.status(400).json({ error: 'ZERO_VALUE' });

    await db.withTransaction(async (client) => {
      await client.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
        req.user.id, finalCredit, coupon.type, 'coupon-' + coupon.id,
      ]);
      await client.query(`UPDATE coupons SET status = 'redeemed' WHERE id = $1`, [coupon.id]);
    });
    const bal = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    res.json({ ok: true, credited: finalCredit, balance: Number(bal.rows[0].balance) });
  } catch (e) {
    safeLog('[user] coupon redeem error:', e.message);
    if (/DUPLICATE_TRANSACTION/.test(e.message)) {
      return res.status(409).json({ error: 'ALREADY_REDEEMED' });
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
