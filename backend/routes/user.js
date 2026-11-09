// ============================================================
// All In One (Abc Authentic) - User routes (Phase 2)
// Mounted at /api with requireAuth. All user-scoped: users can
// only see/touch their own data. Wallet ops use wallet_apply()
// (atomic, no negative, idempotent).
// ============================================================
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { safeLog, uploadMiddleware, orderDocUpload } = require('../security');
const path = require('path');
const fs = require('fs');

// Order document uploads: settings-driven via orderDocUpload(db, 'order') (H-12).
// Filenames stay random (C-2: never embed req.params.id).
const push = require('../utils/push');
const { chargeRuleFor } = require('../lib/chargeRule'); // audit #49
const wa = require('../utils/whatsapp');
const { tryAutoMatchRecharge, tryAutoMatchBySender } = require('./sms');
const serviceCredits = require('../lib/serviceCredits');
const { bdrisOriginalDoc } = require('../lib/storedOriginal'); // past-applications list (2026-11-07)

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

// Audit #32 — neutral duplicate guidance: the original transaction's
// status, never a fraud warning. A duplicate is usually a confused
// resubmit of the user's own TrxID (e.g. right after an instant
// auto-approve), not fraud. Another user's TrxID stays generic —
// its status must never leak to the attempter.
function duplicateGuidance(orig, sameUser) {
  if (!sameUser) return 'এই TrxID ইতিমধ্যে ব্যবহার করা হয়েছে — একই TrxID দিয়ে দ্বিতীয়বার রিচার্জ করা যায় না।';
  const st = orig.status === 'approved' ? 'অনুমোদিত — টাকা ইতিমধ্যে ব্যালেন্সে যোগ হয়েছে'
    : orig.status === 'rejected' ? 'প্রত্যাখ্যাত' + (orig.cancel_reason ? ' — কারণ: ' + orig.cancel_reason : '')
    : 'পেন্ডিং — SMS মিললে স্বয়ংক্রিয়ভাবে অনুমোদিত হবে, না হলে এডমিন যাচাই করবেন';
  return 'এই TrxID-এর রিচার্জটি ইতিমধ্যে আছে — অবস্থা: ' + st + '। নতুন করে জমা দেওয়ার দরকার নেই; ওয়ালেট হিস্ট্রিতে দেখুন।';
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

// Customer-fix C3 (2026-11-03): was this order ever delivered?
// A refunded order keeps its admin files ONLY if it reached
// completed/delivered first (delivered→refunded goodwill). The
// timeline proves it two ways: a row TO completed/delivered
// (stepwise manual transition), or a refund row FROM
// completed/delivered (an auto order inserted straight into
// completed, then refunded by hand — it never got a TO row).
// A failed/cancelled→refunded row has neither, so its
// never-delivered admin files stay hidden. No history at all
// (pre-timeline rows) also means no proof → hidden: the
// conservative side, since the file was never delivered.
async function orderWasDelivered(orderId) {
  try {
    const r = await db.query(
      `SELECT 1 FROM order_status_history WHERE order_id = $1 AND
        (to_status IN ('completed', 'delivered')
         OR (to_status = 'refunded' AND from_status IN ('completed', 'delivered')))
       LIMIT 1`,
      [orderId]);
    return r.rows.length > 0;
  } catch (_) { return false; }
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
        featured: s.featured === true, show_on_dashboard: s.show_on_dashboard !== false,
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
        charge_rule: chargeRuleFor(s), // audit #49 — when the fee is cut
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
        charge_rule: chargeRuleFor(s), // audit #49 — when the fee is cut
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

    // C1 (2026-11-03): INSERT ... RETURNING * carries admin_note
    // (null at creation, but the column must never leave the server
    // on a customer endpoint — same strip as the list/detail paths).
    delete order.admin_note;
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
        // C1 (2026-11-03): the duplicate path used SELECT *, so the
        // internal admin_note reached the customer — strip it
        // before returning, like every other customer order path.
        if (ex.rows.length) {
          const dup = { ...ex.rows[0] };
          delete dup.admin_note;
          return res.json({ order: dup, duplicate: true });
        }
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
      `SELECT o.*, s.name AS service_name, s.name_bn AS service_name_bn,
              s.type AS service_type
       FROM orders o JOIN services s ON s.id = o.service_id
       ${where} ORDER BY o.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]);
    // P2 (2026-11-03): the internal admin note never reaches a
    // customer endpoint — not even inside a list payload no page
    // currently renders.
    for (const r of rows.rows) {
      delete r.admin_note;
      // Audit #52 — the list's 'ফাইল প্রস্তুত' mark needs the same
      // verdict the detail page uses: a refunded order counts as
      // delivered only when the history says it was delivered first
      // (orderWasDelivered). Only refunded rows need the lookup.
      if (r.status === 'refunded') r.delivered_before_refund = await orderWasDelivered(r.id);
    }
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
    // P2 (2026-11-03): explicit columns, NOT o.* — admin_note must
    // never leave the server on a customer endpoint. Every column
    // the customer pages use is listed; nothing else is added.
    const r = await db.query(
      `SELECT o.id, o.user_id, o.service_id, o.status, o.data, o.documents,
              o.notes, o.price, o.idempotency_key, o.created_at, o.updated_at,
              o.cancel_reason, o.refund_balance, o.refund_credit,
              s.name AS service_name, s.name_bn AS service_name_bn
       FROM orders o JOIN services s ON s.id = o.service_id
       WHERE o.id = $1 AND o.user_id = $2`,
      [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    // Belt-and-braces: even if the column list above ever widens,
    // the internal note is stripped here before responding.
    delete r.rows[0].admin_note;
    // C3 (2026-11-03): the detail page shows admin files for a
    // refunded order ONLY when it was delivered first — the flag
    // carries the history verdict so the page never has to guess
    // from the status alone (status 'refunded' alone proves
    // nothing: failed/cancelled→refunded rows were never delivered).
    r.rows[0].delivered_before_refund = await orderWasDelivered(req.params.id);
    res.json({ order: r.rows[0] });
  } catch (e) {
    safeLog('[user] order detail error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/orders/:id/history — status timeline for the order owner (H-1)
// P2 (2026-11-03): the timeline carries only the system record
// (from/to/time). The note column is NOT returned: every note ever
// written here was a copy of the admin's free-text note, so
// returning it would leak internal notes from old rows too.
router.get('/orders/:id/history', async (req, res) => {
  try {
    const own = await db.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const r = await db.query(
      `SELECT from_status, to_status, created_at FROM order_status_history
       WHERE order_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    // Shape the payload explicitly: only the system record leaves
    // the server, whatever the row carries.
    res.json({ history: r.rows.map(h => ({
      from_status: h.from_status, to_status: h.to_status, created_at: h.created_at,
    })) });
  } catch (e) {
    safeLog('[user] order history error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// POST /api/orders/:id/cancel — the customer cancels their OWN order.
// Audit #48 — only new/pending can be cancelled by the customer (the
// cancel policy itself — until which step — is the owner's call; the
// admin PUT allows more transitions, this endpoint deliberately allows
// only the two pre-work states). Cancelling auto-refunds in the same
// transaction via refundOrderPrice (the same helper the admin PUT
// uses), stores the refund split, and writes the history row.
// Idempotent: cancelling an already-cancelled order returns the order
// with already:true and moves no money (the refund helper +
// wallet_apply DUPLICATE guard make a second credit a no-op, and the
// prior-refund check below skips it outright).
router.post('/orders/:id/cancel', async (req, res) => {
  try {
    const reason = (req.body && typeof req.body.reason === 'string' && req.body.reason.trim() !== '')
      ? req.body.reason.trim().slice(0, 500) : null;
    let result;
    try {
      result = await db.withTransaction(async (client) => {
        const cur = await client.query(
          'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!cur.rows.length || cur.rows[0].user_id !== req.user.id) {
          const e = new Error('NOT_FOUND'); e.statusCode = 404; throw e;
        }
        const order = cur.rows[0];
        if (order.status === 'cancelled') {
          return { order, already: true, refunded: false, refundSplit: null };
        }
        if (!['new', 'pending'].includes(order.status)) {
          const e = new Error('CANNOT_CANCEL');
          e.statusCode = 409; e.status = order.status; throw e;
        }
        const upd = await client.query(
          `UPDATE orders SET status = 'cancelled',
           cancel_reason = COALESCE($1, cancel_reason), updated_at = NOW()
           WHERE id = $2 AND status = $3 RETURNING *`,
          [reason, req.params.id, order.status]);
        if (upd.rows.length !== 1) {
          const e = new Error('STALE_WRITE'); e.statusCode = 409; throw e;
        }
        // Auto-refund, same as the admin PUT: skip when the money
        // already came back (legacy/manual edge).
        let refundSplit = null;
        const prior = await client.query(
          `SELECT 1 FROM transactions
            WHERE user_id = $1 AND trxid = $2 AND status = 'approved' LIMIT 1`,
          [order.user_id, 'refund-' + order.id]);
        if (!prior.rows.length) {
          refundSplit = await serviceCredits.refundOrderPrice(client, upd.rows[0], 'refund');
          if (refundSplit && refundSplit.refunded) {
            await client.query(
              'UPDATE orders SET refund_balance = $1, refund_credit = $2 WHERE id = $3',
              [refundSplit.balancePart || 0, refundSplit.creditPart || 0, req.params.id]);
          }
        }
        await client.query(
          `INSERT INTO order_status_history (order_id, from_status, to_status, admin_id, note)
           VALUES ($1, $2, 'cancelled', $3, NULL)`,
          [req.params.id, order.status, req.user.id]);
        return { order: upd.rows[0], already: false,
          refunded: !!(refundSplit && refundSplit.refunded), refundSplit };
      });
    } catch (e) {
      if (e.statusCode) {
        const body = { error: e.message };
        if (e.status) body.status = e.status;
        return res.status(e.statusCode).json(body);
      }
      throw e;
    }
    // Notifications AFTER commit, fire-and-forget (admin PUT pattern):
    // the admins learn a customer cancelled; the customer gets the
    // refund sentence. No notification on an idempotent re-cancel.
    if (!result.already) {
      const split = result.refundSplit || {};
      const bal = Number(split.balancePart) || 0;
      const cr = Number(split.creditPart) || 0;
      const sentence = result.refunded
        ? (cr > 0 && bal > 0 ? `৳${bal} আপনার ওয়ালেটে এবং ৳${cr} ওই সেবার ক্রেডিটে ফেরত দেওয়া হয়েছে।`
          : cr > 0 ? `৳${cr} ওই সেবার ক্রেডিটে ফেরত দেওয়া হয়েছে।`
          : bal > 0 ? `৳${bal} আপনার ওয়ালেটে ফেরত দেওয়া হয়েছে।` : '')
        : '';
      push.notifyAdmins(db, '🛑 অর্ডার বাতিল',
        'গ্রাহক অর্ডার #' + String(req.params.id).slice(0, 8) + ' বাতিল করেছেন।' + (sentence ? ' ' + sentence : ''),
        '/admin.html').catch(() => {});
      push.notifyUser(db, req.user.id, 'অর্ডার বাতিল হয়েছে',
        'আপনার অর্ডারটি বাতিল করা হয়েছে।' +
        (reason ? ' কারণ: ' + reason : '') + (sentence ? ' ' + sentence : ''),
        '/orders.html').catch(() => {});
      wa.notifyOrderCancelled(db, result.order, {
        creditPart: cr, balancePart: bal,
        refunded: result.refunded, cancelReason: reason,
      }).catch(() => {});
    }
    res.json({ ok: true, order: result.order, already: result.already,
      refunded: result.refunded,
      refund: result.refundSplit ? {
        balancePart: Number(result.refundSplit.balancePart) || 0,
        creditPart: Number(result.refundSplit.creditPart) || 0,
      } : null });
  } catch (e) {
    safeLog('[user] order cancel error:', e.message);
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
  // The multer middleware already wrote the file to disk — rejections
  // below unlink it again (same orphan rule as the manual handlers).
  const unlinkUpload = () => {
    if (req.file) { try { require('fs').unlinkSync(req.file.path); } catch (_) {} }
  };
  try {
    const orderId = req.params.id;
    const docType = req.body.doc_type || 'document';
    // Verify order belongs to user
    const ord = await db.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [orderId, req.user.id]);
    if (!ord.rows.length) {
      unlinkUpload();
      return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
    }
    if (!req.file) return res.status(400).json({ error: 'NO_FILE' });
    const order = ord.rows[0];
    // Admin-order fix (2026-11-03): documents may only be added
    // while the order is still open. The old code appended to
    // completed/delivered/refunded/cancelled/failed orders too,
    // silently changing a finished order's contents.
    if (['completed', 'delivered', 'refunded', 'cancelled', 'failed'].includes(order.status)) {
      unlinkUpload();
      return res.status(400).json({ error: 'INVALID_STATUS', status: order.status });
    }
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
    unlinkUpload();
    res.status(500).json({ error: e.message });
  }
});

// GET /api/orders/:id/documents/:filename — download order document (owner only).
// Validates: order belongs to user AND filename is in order.documents (no path traversal).
// P2 (2026-11-03): an ADMIN-uploaded file downloads only once the
// order reached completed/delivered — or refunded after delivery
// (delivered→refunded goodwill: the file stays). On a
// new/pending/processing order an admin file is not downloadable
// yet. The customer's OWN uploads are always downloadable.
router.get('/orders/:id/documents/:filename', async (req, res) => {
  try {
    const orderId = req.params.id;
    const fn = require('path').basename(req.params.filename);
    const ord = await db.query('SELECT status, documents FROM orders WHERE id=$1 AND user_id=$2', [orderId, req.user.id]);
    if (!ord.rows.length) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
    const docs = safeJsonArray(ord.rows[0].documents);
    const doc = docs.find(d => d && require('path').basename(d.filename) === fn);
    if (!doc) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });
    // C3 (2026-11-03): a refunded order's admin file downloads
    // ONLY if the order was completed/delivered first (goodwill).
    // The old unconditional 'refunded' allowance exposed
    // never-delivered admin files of hand-refunded failed/
    // cancelled rows. Customer uploads are unaffected.
    if (doc.uploaded_by === 'admin') {
      const st = ord.rows[0].status;
      if (st === 'completed' || st === 'delivered') {
        // delivered — allowed
      } else if (st === 'refunded' && await orderWasDelivered(orderId)) {
        // delivered, then refunded — goodwill, allowed
      } else {
        return res.status(403).json({ error: 'NOT_DELIVERED_YET' });
      }
    }
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
// certificate / death-final engine PDFs — so a delivered file can
// always be found and re-downloaded from one place, whatever
// phone/browser they use.
// Audit #39 (2026-11-05) reverses the BDRIS half of that call: a filed
// BDRIS application now appears here with its tracking number and a
// link to the filing page. Past-applications list (2026-11-07): the
// stored original Form-1 PDF is linked as a download when it is
// retrievable on disk — the owner-only endpoint serves the
// already-paid copy with the caller's JWT, no new charge. When the
// copy is not retrievable the row stays as text-only with the
// filing-page link (the filing page can still re-fetch it).
router.get('/history', async (req, res) => {
  try {
    const uid = req.user.id;
    const [orders, manual, engineJobs, bdrisApps] = await Promise.all([
      // P2 (2026-11-03): admin files surface in History only once
      // delivered — completed/delivered, or refunded after delivery
      // (goodwill: the file stays after a delivered→refunded).
      // new/pending/processing orders contribute no admin files.
      // C3 (2026-11-03): 'refunded' alone is NOT enough — the
      // EXISTS check proves delivery from the timeline, so a
      // hand-refunded failed/cancelled row contributes nothing.
      db.query(
        `SELECT o.id, o.documents, o.created_at,
                s.name AS service_name, s.name_bn AS service_name_bn
         FROM orders o LEFT JOIN services s ON s.id = o.service_id
         WHERE o.user_id = $1 AND (o.status IN ('completed', 'delivered')
           OR (o.status = 'refunded' AND EXISTS (
             SELECT 1 FROM order_status_history h WHERE h.order_id = o.id AND
               (h.to_status IN ('completed', 'delivered')
                OR (h.to_status = 'refunded' AND h.from_status IN ('completed', 'delivered'))))))
         ORDER BY o.created_at DESC LIMIT 100`, [uid]),
      // P2: same rule for manual submissions — admin files only
      // once the submission is completed (no delivered state here;
      // rejected hides them like cancelled does for orders).
      db.query(
        `SELECT m.id, m.documents, m.created_at,
                s.name AS service_name, s.name_bn AS service_name_bn
         FROM manual_submissions m LEFT JOIN services s ON s.id = m.service_id
         WHERE m.user_id = $1 AND m.status = 'completed'
         ORDER BY m.created_at DESC LIMIT 100`, [uid]),
      db.query(
        `SELECT id, engine_id, subject_name, filename, originalname, created_at, outcome
         FROM engine_jobs
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [uid]),
      // Audit #39 — filed BDRIS applications, so the tracking number
      // is findable in History too (submitted only; failures stay
      // admin-side, as in the applications list).
      db.query(
        `SELECT id, ack_no, applicant_name, created_at, original_pdf_available
         FROM bdris_applications
         WHERE user_id = $1 AND status = 'submitted'
         ORDER BY created_at DESC LIMIT 100`, [uid]),
    ]);
    // R1 follow-up (2026-11-05): History shows ONLY the deliverable PDF
    // per record. Generated receipt PDFs (success or failure) are stored
    // as order documents with originalname '*-receipt.pdf' — they are the
    // record's receipt, not its deliverable, and get no download link
    // here. The record itself keeps its status informing; backend records
    // and stored files are untouched.
    const isReceiptPdf = (d) => /-receipt\.pdf$/i.test(String((d && d.originalname) || ''));
    const deliveryDocs = (raw, base) => safeJsonArray(raw)
      .filter(d => d && d.filename && d.uploaded_by === 'admin' && !isReceiptPdf(d))
      .map(d => ({
        filename: d.filename,
        originalname: d.originalname || d.filename,
        url: base + encodeURIComponent(d.filename),
      }));
    const items = [];
    // R1 follow-up #2 (2026-11-07, user decision): a completed record
    // with no output stays in History as written text only — the row
    // is pushed with documents: [] and no download link. The SQL
    // gates above (completed/delivered, refunded-after-delivery;
    // manual completed) are what keep in-progress records out, NOT
    // a documents-length skip — so there is no skip here.
    for (const o of orders.rows) {
      const documents = deliveryDocs(o.documents, '/orders/' + o.id + '/documents/');
      items.push({
        kind: 'order', id: o.id,
        title: o.service_name_bn || o.service_name || 'সেবা অর্ডার',
        created_at: o.created_at, documents,
      });
    }
    for (const m of manual.rows) {
      const documents = deliveryDocs(m.documents, '/manual/' + m.id + '/documents/');
      items.push({
        kind: 'manual', id: m.id,
        title: m.service_name_bn || m.service_name || 'ম্যানুয়াল সেবা',
        created_at: m.created_at, documents,
      });
    }
    // Audit #39 — BDRIS filings carry their tracking number and a
    // link to the filing page. Past-applications list (2026-11-07):
    // when the stored original Form-1 PDF is retrievable on disk,
    // the documents array carries its owner-only download link
    // (a re-download of the already-paid copy, no new charge).
    // When the copy is not retrievable the row stays as text-only
    // with the filing-page link (R1 follow-up #2: no fake link).
    for (const a of bdrisApps.rows) {
      const origDoc = a.original_pdf_available ? bdrisOriginalDoc(a.ack_no) : null;
      items.push({
        kind: 'bdris', id: a.id,
        title: 'জন্ম নিবন্ধন আবেদন' +
          (a.applicant_name ? ' — ' + a.applicant_name : '') +
          ' (আবেদন নম্বর: ' + a.ack_no + ')',
        created_at: a.created_at, documents: origDoc ? [origDoc] : [],
        link: '/bdris-apply.html',
        original_pdf_available: !!a.original_pdf_available,
      });
    }
    for (const j of engineJobs.rows) {
      items.push({
        kind: 'engine', id: j.id,
        title: (j.engine_id === 'death-final' ? 'মৃত্যু সনদ' : 'জন্ম সনদ (সার্টিফিকেট)') +
          (j.subject_name ? ' — ' + j.subject_name : '') +
          (j.outcome === 'failed' ? ' — ব্যর্থ' : ''),
        created_at: j.created_at,
        // R1 follow-up (2026-11-05): a failed engine job's file is a
        // generated failure receipt, not a deliverable — the record
        // stays in History (title carries '— ব্যর্থ') but gets no
        // download link. A completed job's certificate keeps its link.
        documents: j.outcome === 'failed' ? [] : [{
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
    // Audit #35 — history filters (type/status, whitelisted) + an
    // SMS-arrived flag on pending recharges, so the row can say
    // whether its SMS came.
    const VALID_TYPES = ['recharge', 'order_payment', 'refund', 'coupon', 'cashback', 'promo', 'debit', 'bonus', 'admin_adjustment'];
    const VALID_STATUSES = ['pending', 'approved', 'rejected'];
    const fType = VALID_TYPES.includes(req.query.type) ? req.query.type : null;
    const fStatus = VALID_STATUSES.includes(req.query.status) ? req.query.status : null;
    const conds = ['user_id = $1'];
    const cparams = [req.user.id];
    if (fType) { conds.push(`type = $${cparams.length + 1}`); cparams.push(fType); }
    if (fStatus) { conds.push(`status = $${cparams.length + 1}`); cparams.push(fStatus); }
    const where = 'WHERE ' + conds.join(' AND ');
    const total = await db.query(`SELECT COUNT(*) FROM transactions ${where}`, cparams);
    const rows = await db.query(
      `SELECT id, type, amount, method, sender_no, trxid, status, created_at, cancel_reason,
              (SELECT json_build_object('id', c.id, 'code', c.code, 'status', c.status, 'amount', c.amount)
               FROM coupons c WHERE c.recharge_id = transactions.id LIMIT 1) AS coupon,
              CASE WHEN type = 'recharge' AND status = 'pending' THEN EXISTS (
                SELECT 1 FROM incoming_sms s
                WHERE (
                  (transactions.trxid IS NOT NULL
                   AND transactions.trxid !~ '^AUTO-[0-9A-F]{12}$'
                   AND UPPER(s.trxid) = UPPER(transactions.trxid))
                  OR (
                    (transactions.trxid IS NULL OR transactions.trxid ~ '^AUTO-[0-9A-F]{12}$')
                    AND s.trxid IS NOT NULL
                    AND s.amount = transactions.amount AND s.sender = transactions.sender_no
                    AND s.method = CASE WHEN transactions.method LIKE 'bkash%' THEN 'bkash' ELSE transactions.method END
                    AND s.created_at >= NOW() - INTERVAL '30 minutes'
                  )
                )
              ) ELSE false END AS sms_arrived
       FROM transactions ${where}
       ORDER BY created_at DESC LIMIT $${cparams.length + 1} OFFSET $${cparams.length + 2}`,
      [...cparams, limit, offset]);

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

// Number-only Auto requests have no TrxID, so their reload/poll path uses
// the immutable transaction ID. The user scope prevents reading another
// customer's recharge even when its ID is known.
router.get('/wallet/recharge/request/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'INVALID_REQUEST_ID' });
    }
    const r = await db.query(
      `SELECT id, type, amount, method, sender_no, trxid, status, created_at, cancel_reason
       FROM transactions
       WHERE user_id = $1 AND type = 'recharge' AND id = $2 LIMIT 1`,
      [req.user.id, id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ transaction: r.rows[0] });
  } catch (e) {
    safeLog('[user] auto recharge lookup error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// Manual recharge lookup by its real TrxID. Own user only; case-insensitive.
router.get('/wallet/recharge/:trxid', async (req, res) => {
  try {
    const trxid = String(req.params.trxid || '').trim();
    if (!trxid) return res.status(400).json({ error: 'INVALID_TRXID' });
    const r = await db.query(
      `SELECT id, type, amount, method, sender_no, trxid, status, created_at, cancel_reason
       FROM transactions
       WHERE user_id = $1 AND type = 'recharge' AND UPPER(trxid) = UPPER($2) LIMIT 1`,
      [req.user.id, trxid]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ transaction: r.rows[0] });
  } catch (e) {
    safeLog('[user] recharge lookup error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// POST /api/wallet/recharge/auto — number-only Auto payment: method,
// sender number and amount, NO TrxID and no invented placeholder. The SMS
// webhook matches by amount + sender (or this call matches an SMS that
// already arrived). A matched SMS supplies the real TrxID; otherwise the
// request waits for admin review with trxid = NULL.
router.post('/wallet/recharge/auto', async (req, res) => {
  try {
    const { method, sender_no, amount } = req.body || {};
    const methods = ['bkash_payment', 'bkash_personal', 'nagad', 'rocket'];
    if (!methods.includes(method)) return res.status(400).json({ error: 'INVALID_METHOD' });
    const sender = String(sender_no || '').trim();
    if (!/^01[3-9]\d{8}$/.test(sender)) return res.status(400).json({ error: 'INVALID_SENDER' });
    const amt = Number(amount);
    if (!amt || amt < 10 || amt > 100000) return res.status(400).json({ error: 'INVALID_AMOUNT' });
    const pending = await db.query(
      `SELECT COUNT(*) FROM transactions
       WHERE user_id = $1 AND type = 'recharge' AND status = 'pending'`, [req.user.id]);
    if (parseInt(pending.rows[0].count, 10) >= 3) {
      return res.status(400).json({ error: 'TOO_MANY_PENDING' });
    }
    const r = await db.query(
      `INSERT INTO transactions (user_id, type, amount, method, sender_no, status)
       VALUES ($1, 'recharge', $2, $3, $4, 'pending') RETURNING *`,
      [req.user.id, amt, method, sender]);
    let tx = r.rows[0];
    try {
      const matched = await tryAutoMatchBySender(tx);
      if (matched) tx = matched;
    } catch (err) { safeLog('[user] auto sender-match error:', err.message); }
    if (tx.status === 'pending') push.notifyNewRecharge(db, tx, req.user.id).catch(() => {});
    res.status(201).json({ transaction: tx, request_id: tx.id });
  } catch (e) {
    safeLog('[user] auto recharge error:', e.message);
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
    const dup = await db.query(
      // Audit #23 — case-folded: 'abc123' must match a stored
      // 'ABC123', or a case change bypasses the DUP check and the
      // same TrxID can be credited twice.
      // Audit #28 — cancel_reason travels with the duplicate, so
      // a rejected original shows WHY it was rejected.
      'SELECT id, user_id, amount, status, created_at, cancel_reason FROM transactions WHERE UPPER(trxid) = UPPER($1) LIMIT 1', [String(trxid).trim()]);
    if (dup.rows.length) {
      const orig = dup.rows[0];
      const sameUser = orig.user_id === req.user.id;
      // Audit #32 — a duplicate is usually a confused resubmit of the
      // user's own TrxID, not fraud: tell the submitter the ORIGINAL's
      // status (neutral guidance), never a block warning. Admins still
      // get the factual alert, throttled per user+trxid.
      if (fraudAlertOnce('dup:' + req.user.id + ':' + String(trxid).trim().toUpperCase())) {
        wa.notifyDuplicateTrxid(db, req.user.id, { trxid: String(trxid).trim(), amount: amt, status: orig.status, sameUser, cancel_reason: orig.cancel_reason }).catch(() => {});
        push.notifyUser(db, req.user.id, 'ℹ️ এই TrxID-র রিচার্জ আগেই আছে',
          duplicateGuidance(orig, sameUser), '/wallet.html').catch(() => {});
        push.notifyDuplicateTrxid(db, { trxid: String(trxid).trim(), amount: amt, status: orig.status }, req.user.id).catch(() => {});
      }
      // Gateway-session premium display (2026-11-04): when the SAME user
      // resubmits their own TrxID, the client shows the ORIGINAL
      // transaction (amount, date, status) instead of a block warning —
      // a confused resubmit after an instant auto-approve is the common
      // case, not fraud. Another user's TrxID stays generic: its details
      // must never leak to the attempter.
      if (orig.user_id === req.user.id) {
        return res.status(409).json({
          error: 'DUP_TRXID',
          existing_tx: {
            amount: orig.amount, status: orig.status,
            created_at: orig.created_at, trxid: String(trxid).trim(),
            cancel_reason: orig.cancel_reason || undefined,
          },
        });
      }
      return res.status(409).json({ error: 'DUP_TRXID' });
    }
    // An SMS already used to credit a recharge (e.g. a number-only
    // Auto request) can never be claimed again by its TrxID.
    const usedSms = await db.query(
      `SELECT 1 FROM public.incoming_sms s
       WHERE s.trxid IS NOT NULL AND UPPER(s.trxid) = UPPER($1)
         AND s.matched_recharge_id IS NOT NULL LIMIT 1`, [String(trxid).trim()]);
    if (usedSms.rows.length) return res.status(409).json({ error: 'DUP_TRXID' });

    // Audit #31 — the cap check runs AFTER the duplicate check: a
    // resubmit of an existing TrxID must answer DUP_TRXID (with the
    // original transaction), never TOO_MANY_PENDING.
    const pending = await db.query(
      `SELECT COUNT(*) FROM transactions
       WHERE user_id = $1 AND type = 'recharge' AND status = 'pending'`, [req.user.id]);
    if (parseInt(pending.rows[0].count, 10) >= 3) {
      return res.status(400).json({ error: 'TOO_MANY_PENDING' });
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
