// ============================================================
// All In One (Abc Authentic) - Passport engine (integrated
// service, 2026-11-13).
// Mounted at /api/passport (JWT auth + rate limit at mount,
// same as /api/land-khatian).
//
//   GET  /api/passport/price
//   POST /api/passport/create  { passport_no, idempotency_key? }
//
// The page used to be a standalone offline tool (CSP
// connect-src 'none', no backend, Create → download as a
// local blob, free for anyone with the URL). It is now a
// site service like the other engines: the frontend calls
// POST /create BEFORE the download, and the download happens
// only after this call succeeds.
//
// Money discipline (same as backend/routes/land-khatian.js
// and backend/lib/engineChargeGate.js): price comes ONLY
// from the `services` table (engine_id 'passport', serial
// 13) with the per-user user_services override (access
// disabled -> 403, custom price wins). Price 0 -> free, but
// the order is still recorded, so charging starts
// automatically once the admin sets a price in Admin ->
// Services. The wallet is charged ONLY on a successful
// Create; a failure (402 insufficient balance, 500) creates
// NO order and the frontend blocks the download, so no
// passport is produced unpaid. Idempotency: a repeated
// idempotency_key replays the stored outcome — never a
// second charge. The passport file itself is generated
// client-side (the page holds the scan artwork); there is
// no server-side deliverable to store on the order, so the
// order carries the passport number + filename in `data`
// and History shows the creation + charge.
// ============================================================
const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../auth');
const { safeLog } = require('../security');
const db = require('../db');
const serviceCredits = require('../lib/serviceCredits');
const wa = require('../utils/whatsapp');
const push = require('../utils/push');
const { alertMissingPrice } = require('../lib/missingPriceAlert');

const router = express.Router();
const ENGINE_ID = 'passport';
const LABEL = 'পাসপোর্ট ইঞ্জিন';

// ---------- pricing (per engine, same rules as land-khatian) ----------
async function getServicePrice(userId) {
  const r = await db.query(
    `SELECT id, price FROM services WHERE engine_id = $1 AND status = 'active' LIMIT 1`, [ENGINE_ID]
  );
  if (!r.rows.length) {
    // Audit #17 — no active price row: the service runs free.
    // Price 0 is the design decision, so the gate stays open;
    // the admin is alerted (throttled, once per engine per hour).
    alertMissingPrice(db, ENGINE_ID);
    return { allowed: true, price: 0, serviceId: null };
  }
  const serviceId = r.rows[0].id;
  const basePrice = Number(r.rows[0].price) || 0;
  const ov = await db.query(
    `SELECT custom_price, access_enabled FROM user_services WHERE user_id = $1 AND service_id = $2 LIMIT 1`,
    [userId, serviceId]
  );
  if (ov.rows.length) {
    if (ov.rows[0].access_enabled === false) return { allowed: false, price: 0, serviceId };
    const cp = ov.rows[0].custom_price;
    return { allowed: true, price: cp !== null && cp !== undefined ? Number(cp) : basePrice, serviceId };
  }
  return { allowed: true, price: basePrice, serviceId };
}

router.get('/price', requireAuth, async (req, res) => {
  try {
    const { allowed, price, serviceId } = await getServicePrice(req.user.id);
    const u = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    res.json({ ok: true, engineId: ENGINE_ID, allowed, price, serviceId, balance: u.rows[0] ? Number(u.rows[0].balance) : 0 });
  } catch (e) {
    safeLog('[passport] price error:', e.message);
    res.status(500).json({ error: 'PRICE_CHECK_FAILED' });
  }
});

// ---------- money + order plumbing (land-khatian discipline) ----------
function idemOf(body) {
  let idem = String((body && body.idempotency_key) || '').trim().slice(0, 80);
  if (!idem) idem = 'passport-' + crypto.randomUUID();
  return idem;
}

async function replayIfExists(req, res, idem) {
  const prev = await db.query(
    'SELECT id, price, status FROM orders WHERE user_id = $1 AND idempotency_key = $2',
    [req.user.id, idem]
  );
  if (!prev.rows.length) return false;
  const row = prev.rows[0];
  const u = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
  res.json({
    ok: true, duplicate: true, charged: Number(row.price) || 0, orderId: row.id,
    balance: u.rows[0] ? Number(u.rows[0].balance) : null,
  });
  return true;
}

async function precheck(req, res) {
  const { allowed, price, serviceId } = await getServicePrice(req.user.id);
  if (!allowed) {
    res.status(403).json({ error: 'SERVICE_ACCESS_DISABLED', message: 'এই সেবায় আপনার প্রবেশাধিকার স্থগিত রয়েছে।' });
    return null;
  }
  if (price > 0) {
    const u = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const balance = u.rows[0] ? Number(u.rows[0].balance) : 0;
    const lockedCredit = await serviceCredits.availableFor(db, req.user.id, serviceId);
    if (balance + lockedCredit < price) {
      res.status(402).json({
        error: 'INSUFFICIENT_BALANCE',
        message: `পর্যাপ্ত ব্যালেন্স নেই। সেবাটির মূল্য ৳${price}, বর্তমান ব্যালেন্স ৳${balance}।`,
        required: price, balance,
      });
      return null;
    }
  }
  return { price, serviceId };
}

async function chargeOnce(req, price, serviceId, idem) {
  if (price <= 0) return;
  const ref = 'passport-' + idem;
  const alreadyPaid = await db.query(
    `SELECT 1 FROM transactions WHERE user_id = $1 AND trxid IN ($2, $3) AND status = 'approved' LIMIT 1`,
    [req.user.id, ref, ref + ':svc']
  );
  if (alreadyPaid.rows.length) return;
  await db.withTransaction((clientTx) => serviceCredits.payForService(clientTx, {
    userId: req.user.id, serviceId, amount: Math.abs(price), ref,
  }));
}

async function recordOrder(req, serviceId, status, price, idem, data) {
  const ins = await db.query(
    `INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [req.user.id, serviceId, status, JSON.stringify(data), price, idem]
  ).catch((e) => { safeLog('[passport] order insert error:', e.message); return null; });
  if (ins && ins.rows.length) return ins.rows[0].id;
  const again = await db.query(
    'SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2', [req.user.id, idem]
  ).catch(() => null);
  return again && again.rows.length ? again.rows[0].id : null;
}

function notifyDone(req, price) {
  wa.notifyServiceCompleted(db, req.user.id, LABEL).catch(() => {});
  push.notifyUser(db, req.user.id, '✅ ' + LABEL,
    'আপনার পাসপোর্ট তৈরি হয়েছে — ডাউনলোড দেখুন। অর্ডারটি ইতিহাসে (History) পাবেন।', '/history.html').catch(() => {});
  push.notifyAdmins(db, '✅ ' + LABEL, `একটি পাসপোর্ট তৈরি হয়েছে — চার্জ ৳${price}।`, '/admin.html').catch(() => {});
}

// ---------- POST /create ----------
router.post('/create', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const passportNo = String(body.passport_no || '').trim().slice(0, 20);
    if (!passportNo) {
      return res.status(400).json({ error: 'BAD_INPUT', message: 'পাসপোর্ট নম্বর লাগবে।' });
    }
    const idem = idemOf(body);
    if (await replayIfExists(req, res, idem)) return;
    const chk = await precheck(req, res);
    if (!chk) return;
    try {
      await chargeOnce(req, chk.price, chk.serviceId, idem);
    } catch (e) {
      if (/INSUFFICIENT_BALANCE/.test(e.message)) {
        return res.status(402).json({ error: 'INSUFFICIENT_BALANCE', message: 'পর্যাপ্ত ব্যালেন্স নেই। অনুগ্রহ করে ওয়ালেট রিচার্জ করুন।' });
      }
      if (!/DUPLICATE_TRANSACTION/.test(e.message)) throw e;
      // Already paid under this ref (concurrent retry) — continue
      // to the order; the charge is not applied twice.
    }
    const filename = 'Passport-' + passportNo.replace(/[^A-Z0-9]/gi, '').toUpperCase() + '.html';
    let orderId = null;
    if (chk.serviceId) {
      orderId = await recordOrder(req, chk.serviceId, 'completed', chk.price, idem,
        { passport_no: passportNo, filename, engine: ENGINE_ID });
      if (orderId) notifyDone(req, chk.price);
    }
    const u2 = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    return res.json({
      ok: true, charged: chk.price, orderId,
      balance: u2.rows[0] ? Number(u2.rows[0].balance) : null,
    });
  } catch (e) {
    safeLog('[passport] create error:', e.message);
    res.status(500).json({ error: 'CREATE_FAILED' });
  }
});

module.exports = router;
