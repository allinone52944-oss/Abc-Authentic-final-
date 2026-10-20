// ============================================================
// All In One (Abc Authentic) - BDRIS Apply engine routes
// Mounted at /api/bdris-apply (JWT auth + rate limit at mount).
//
// Wallet charging (admin-configurable, no hardcoded prices):
//   POST /api/bdris-apply/charge/submit → deducts service price
//       (from `services` table where engine_id='bdris-apply').
//       Called by frontend shim BEFORE emitting SUBMIT_S4_OTP.
//   POST /api/bdris-apply/charge/pdf → deducts PDF download price
//       (from settings key 'bdris_apply.pdf_price', default 0).
//       Called by frontend shim BEFORE emitting FETCH_ORIGINAL.
//   Both return 402 { error: 'INSUFFICIENT_BALANCE' } when short.
//
// Everything else under /api/bdris-apply/* is reverse-proxied to the
// engine subprocess (see engines/bdris-apply/index.js).
// ============================================================
const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../auth');
const { safeLog } = require('../security');
const db = require('../db');

const router = express.Router();

// ---- helpers -------------------------------------------------

// C-1 fix (2026-10-15): charge receipt token — engine SUBMIT_S4_OTP /
// FETCH_ORIGINAL handler-এ HMAC দিয়ে যাচাই করে। Stateless, 30 মিনিট মেয়াদ।
const CHARGE_SECRET = process.env.JWT_SECRET || '';
function mintChargeToken(userId, kind, ref) {
  const ts = Date.now();
  const body = ['v1', String(userId), kind, String(ref), String(ts)].join('.');
  const mac = crypto.createHmac('sha256', CHARGE_SECRET).update(body).digest('hex');
  return body + '.' + mac;
}

// Get the bdris-apply service price (admin sets via Admin → Services).
async function getSubmitPrice() {
  const r = await db.query(
    `SELECT price FROM services WHERE engine_id = 'bdris-apply' AND status = 'active' LIMIT 1`
  );
  if (!r.rows.length) return null;
  return Number(r.rows[0].price) || 0;
}

// Get the PDF download price (admin sets via Admin → Settings).
async function getPdfPrice() {
  const r = await db.query(
    `SELECT value FROM settings WHERE key = 'bdris_apply.pdf_price' LIMIT 1`
  );
  if (!r.rows.length) return 0;
  const v = r.rows[0].value;
  const n = Number(typeof v === 'string' ? JSON.parse(v) : v);
  return isNaN(n) ? 0 : Math.max(0, n);
}

// Deduct amount for the bdris-apply service. Service-locked credit
// for THIS service is consumed first, the rest from the wallet
// balance (lib/serviceCredits). Throws INSUFFICIENT_BALANCE.
const serviceCredits = require('../lib/serviceCredits');
async function getBdrisServiceId() {
  const r = await db.query(
    `SELECT id FROM services WHERE engine_id = 'bdris-apply' AND status = 'active' LIMIT 1`);
  return r.rows.length ? r.rows[0].id : null;
}
async function chargeWallet(userId, amount, ref) {
  if (!amount || amount <= 0) return { charged: 0 };
  const serviceId = await getBdrisServiceId();
  const out = await db.withTransaction((client) =>
    serviceCredits.payForService(client, {
      userId, serviceId, amount: Math.abs(amount), ref,
    }));
  return { charged: amount, newBalance: out.newBalance };
}

// ---- charge endpoints (JWT required) -------------------------

// POST /api/bdris-apply/charge/submit
// Deduct service price before the final OTP submit.
router.post('/charge/submit', requireAuth, async (req, res) => {
  try {
    const price = await getSubmitPrice();
    if (price === null) {
      return res.status(404).json({ error: 'SERVICE_NOT_FOUND' });
    }
    if (price <= 0) {
      return res.json({ ok: true, charged: 0, message: 'ফ্রি সেবা', chargeToken: mintChargeToken(req.user.id, 'submit', 'free') });
    }
    const clientKey = (req.body && req.body.idempotency_key) ? String(req.body.idempotency_key).slice(0, 64) : Date.now();
    const ref = 'bdris-apply-submit-' + clientKey + '-' + req.user.id;
    const r = await chargeWallet(req.user.id, price, ref);
    safeLog('[bdris-apply] submit charged', price, 'for user', req.user.id);
    res.json({ ok: true, charged: r.charged, newBalance: r.newBalance, chargeToken: mintChargeToken(req.user.id, 'submit', ref) });
  } catch (e) {
    safeLog('[bdris-apply] submit charge error:', e.message);
    if (/INSUFFICIENT_BALANCE/.test(e.message)) {
      return res.status(402).json({
        error: 'INSUFFICIENT_BALANCE',
        message: 'ব্যালেন্স অপর্যাপ্ত — রিচার্জ করুন',
      });
    }
    res.status(500).json({ error: 'CHARGE_FAILED' });
  }
});

// POST /api/bdris-apply/charge/pdf
// Deduct PDF download price before FETCH_ORIGINAL.
router.post('/charge/pdf', requireAuth, async (req, res) => {
  try {
    const price = await getPdfPrice();
    if (price <= 0) {
      return res.json({ ok: true, charged: 0, message: 'ফ্রি ডাউনলোড', chargeToken: mintChargeToken(req.user.id, 'pdf', 'free') });
    }
    const clientKey = (req.body && req.body.idempotency_key) ? String(req.body.idempotency_key).slice(0, 64) : Date.now();
    const ref = 'bdris-apply-pdf-' + clientKey + '-' + req.user.id;
    const r = await chargeWallet(req.user.id, price, ref);
    safeLog('[bdris-apply] pdf charged', price, 'for user', req.user.id);
    res.json({ ok: true, charged: r.charged, newBalance: r.newBalance, chargeToken: mintChargeToken(req.user.id, 'pdf', ref) });
  } catch (e) {
    safeLog('[bdris-apply] pdf charge error:', e.message);
    if (/INSUFFICIENT_BALANCE/.test(e.message)) {
      return res.status(402).json({
        error: 'INSUFFICIENT_BALANCE',
        message: 'ব্যালেন্স অপর্যাপ্ত — রিচার্জ করুন',
      });
    }
    res.status(500).json({ error: 'CHARGE_FAILED' });
  }
});

// GET /api/bdris-apply/prices — for frontend display (no charge)
router.get('/prices', requireAuth, async (req, res) => {
  try {
    const submit = await getSubmitPrice();
    const pdf = await getPdfPrice();
    res.json({ ok: true, submitPrice: submit === null ? null : submit, pdfPrice: pdf });
  } catch (e) {
    res.status(500).json({ error: 'PRICE_FETCH_FAILED' });
  }
});

module.exports = router;
