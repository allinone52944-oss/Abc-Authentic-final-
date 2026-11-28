// ============================================================
// All In One (Abc Authentic) - E-Passport engine (integrated
// service, 2026-11-17).
// Mounted at /api/epassport (JWT auth + rate limit at mount,
// same as /api/land-khatian).
//
//   GET  /api/epassport/price
//   POST /api/epassport/create  { passport_no, idempotency_key? }
//   POST /api/epassport/pdf     ?passport_no=&idempotency_key=  (text/html body)
//
// The page used to be a standalone offline tool (CSP
// connect-src 'none', no backend, Create → download as a
// local blob, free for anyone with the URL). It is now a
// site service like the other engines: the frontend calls
// POST /create BEFORE the download, and the download happens
// only after this call succeeds.
//
// Direct real-PDF download (2026-11-14): Create downloads a
// REAL PDF, not HTML. The client POSTs the document-only HTML
// (snapshotHTML) to POST /pdf and the server renders it to a
// genuine 1-page A4 PDF (headless Chromium, backend/lib/
// epassportPdf.js) and returns the bytes. POST /pdf NEVER
// charges and NEVER creates an order — it only verifies the
// paid order for the idempotency key and renders. A retry of
// a failed PDF export reuses the same key, so it never
// charges twice. A render failure is a clear 500 and the
// frontend downloads NOTHING (no HTML fallback).
//
// The HTML is sent as text/html (not JSON): the document is
// ~9MB and user photos can push it past the global 10MB JSON
// limit, while the global parser ignores non-JSON bodies —
// so a route-level text parser with a 20MB bound is used
// instead. No server.js change, no new global surface.
//
// Money discipline (same as backend/routes/land-khatian.js
// and backend/lib/engineChargeGate.js): price comes ONLY
// from the `services` table (engine_id 'epassport', serial
// 15) with the per-user user_services override (access
// disabled -> 403, custom price wins). Price 0 -> free, but
// the order is still recorded, so charging starts
// automatically once the admin sets a price in Admin ->
// Services. The wallet is charged ONLY on a successful
// Create; a failure (402 insufficient balance, 500) creates
// NO order and the frontend blocks the download, so no
// e-passport is produced unpaid. Idempotency: a repeated
// idempotency_key replays the stored outcome — never a
// second charge. The PDF itself is rendered server-side
// (POST /pdf, headless Chromium) from the document-only HTML
// the client sends; the order carries the passport number +
// PDF filename in `data` and History shows the creation +
// charge.
// ============================================================
const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../auth');
const { safeLog } = require('../security');
const db = require('../db');
const serviceCredits = require('../lib/serviceCredits');
const { renderEpassportPdf } = require('../lib/epassportPdf');
const push = require('../utils/push');
const { alertMissingPrice } = require('../lib/missingPriceAlert');
const telegramNotify = require('../lib/telegramNotify'); // group notifications (2026-11-28)

// Telegram group notification for a completed e-passport
// (2026-11-28). Fire-and-forget: runs after the order commits and
// can never fail the build (all errors swallowed inside).
async function telegramSuccessNotify(userId, serviceLabel, fee, orderId) {
  try {
    const u = await db.query('SELECT name, phone FROM users WHERE id = $1', [userId]);
    const user = u.rows[0];
    if (!user) return;
    await telegramNotify.notifySuccess({
      userName: user.name, userPhone: user.phone,
      serviceLabel, fee: Number(fee) || 0, orderId: String(orderId),
    });
  } catch (_) { /* Telegram never fails a build */ }
}

const router = express.Router();
const ENGINE_ID = 'epassport';
const LABEL = 'ই-পাসপোর্ট ইঞ্জিন';

// ---------- pricing (per engine, same rules as land-khatian) ----------
async function getServicePrice(userId, client = db) {
  const r = await client.query(
    `SELECT id, price, status FROM services WHERE engine_id = $1 ORDER BY (status = 'active') DESC LIMIT 1`, [ENGINE_ID]
  );
  if (!r.rows.length) {
    alertMissingPrice(db, ENGINE_ID, { unavailable: true });
    return { allowed: false, price: 0, serviceId: null };
  }
  if (r.rows[0].status !== 'active') return { allowed: false, price: 0, serviceId: null };
  const serviceId = r.rows[0].id;
  const basePrice = Number(r.rows[0].price) || 0;
  const ov = await client.query(
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
    safeLog('[epassport] price error:', e.message);
    res.status(500).json({ error: 'PRICE_CHECK_FAILED' });
  }
});

// ---------- money + order plumbing (land-khatian discipline) ----------
function idemOf(body) {
  let idem = String((body && body.idempotency_key) || '').trim().slice(0, 80);
  if (!idem) idem = 'epassport-' + crypto.randomUUID();
  return idem;
}

function normalizePassportNo(value) {
  return String(value || '').toUpperCase().replace(/\s/g, '');
}

async function findOrder(client, userId, idem) {
  const result = await client.query(
    `SELECT id, price, status, data->>'engine' AS engine, data->>'passport_no' AS passport_no
       FROM orders WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idem]
  );
  return result.rows[0];
}

function matchesOrder(order, passportNo) {
  return order && order.status === 'completed' && order.engine === ENGINE_ID &&
    normalizePassportNo(order.passport_no) === passportNo;
}

// ---------- POST /create ----------
router.post('/create', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const passportNo = normalizePassportNo(body.passport_no);
    if (!/^[A-Z0-9]{1,9}$/.test(passportNo)) {
      return res.status(400).json({ error: 'BAD_INPUT', message: 'পাসপোর্ট নম্বরে ১ থেকে ৯টি ইংরেজি অক্ষর বা সংখ্যা দিন।' });
    }
    const idem = idemOf(body);
    const userId = req.user.id;
    const result = await db.withTransaction(async (client) => {
      const locked = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!locked.rows.length) throw new Error('USER_NOT_FOUND');
      let balance = Number(locked.rows[0].balance);
      const order = await findOrder(client, userId, idem);
      if (order) {
        if (!matchesOrder(order, passportNo)) return { conflict: true };
        return { ok: true, duplicate: true, charged: Number(order.price), orderId: order.id, balance };
      }
      const { allowed, price, serviceId } = await getServicePrice(userId, client);
      if (!allowed) return { unavailable: !serviceId, disabled: Boolean(serviceId) };

      // Earlier releases could commit the debit without saving the order.
      // Recover that order at its original price before trying another debit.
      const ref = ENGINE_ID + '-' + idem;
      const prior = await client.query(
        `SELECT amount FROM transactions WHERE user_id = $1 AND trxid IN ($2, $3) AND status = 'approved'`,
        [userId, ref, ref + ':svc']
      );
      const charged = prior.rows.length
        ? Math.round(prior.rows.reduce((sum, payment) => sum + Math.abs(Number(payment.amount)), 0) * 100) / 100
        : price;
      if (charged > 0 && !prior.rows.length) {
        const payment = await serviceCredits.payForService(client, { userId, serviceId, amount: charged, ref });
        balance = payment.newBalance;
      }

      const data = { passport_no: passportNo, filename: 'E-Passport-' + passportNo + '.pdf', engine: ENGINE_ID, charge_ref: ref };
      const inserted = await client.query(
        'INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [userId, serviceId, 'completed', JSON.stringify(data), charged, idem]
      );
      if (!inserted.rows.length) throw new Error('ORDER_NOT_SAVED');
      return { ok: true, charged, orderId: inserted.rows[0].id, balance };
    });
    if (result.conflict) {
      return res.status(409).json({ error: 'ORDER_MISMATCH', message: 'এই অর্ডারের সঙ্গে পাসপোর্ট নম্বর বা সেবা মিলছে না।' });
    }
    if (result.unavailable || result.disabled) {
      return res.status(403).json({
        error: result.unavailable ? 'SERVICE_UNAVAILABLE' : 'SERVICE_ACCESS_DISABLED',
        message: result.unavailable ? 'ই-পাসপোর্ট সেবা এখন বন্ধ আছে।' : 'এই সেবায় আপনার প্রবেশাধিকার স্থগিত রয়েছে।',
      });
    }
    if (!result.duplicate) {
      push.notifyAdmins(db, LABEL, `ই-পাসপোর্ট অর্ডার সেভ হয়েছে। চার্জ ৳${result.charged}।`, '/admin.html').catch(() => {});
      // Telegram: same event to the group (async, non-blocking).
      telegramSuccessNotify(req.user.id, LABEL, result.charged, result.orderId).catch(() => {});
    }
    return res.json({ ...result, idempotencyKey: idem });
  } catch (e) {
    if (/INSUFFICIENT_BALANCE/.test(e.message)) {
      return res.status(402).json({ error: 'INSUFFICIENT_BALANCE', message: 'পর্যাপ্ত ব্যালেন্স নেই। অনুগ্রহ করে ওয়ালেট রিচার্জ করুন।' });
    }
    safeLog('[epassport] create error:', e.message);
    res.status(500).json({ error: 'CREATE_FAILED' });
  }
});

// ---------- POST /pdf ----------
// Direct real-PDF download from Create (2026-11-14). The client
// POSTs the document-only HTML (snapshotHTML) as text/html and
// gets real PDF bytes back. This route NEVER charges and NEVER
// creates an order — it only verifies the paid order for the
// idempotency key (POST /create already charged and recorded
// it) and renders. A retry of a failed PDF export reuses the
// same key, so it never charges twice. A render failure is a
// clear 500 and the frontend downloads NOTHING (no HTML
// fallback). The HTML arrives as text/html so the global 10MB
// JSON limit (which the ~9MB document + user photos can exceed)
// never applies; the route-level text parser matches the live
// reverse proxy's 20MB limit.
router.post('/pdf',
  requireAuth,
  express.text({ type: 'text/html', limit: '20mb' }),
  async (req, res) => {
    try {
      const passportNo = normalizePassportNo(req.query.passport_no);
      const idem = String(req.query.idempotency_key || '').trim().slice(0, 80);
      const html = req.body;
      if (!/^[A-Z0-9]{1,9}$/.test(passportNo)) {
        return res.status(400).json({ error: 'BAD_INPUT', message: 'পাসপোর্ট নম্বরে ১ থেকে ৯টি ইংরেজি অক্ষর বা সংখ্যা দিন।' });
      }
      if (!idem) {
        return res.status(400).json({ error: 'BAD_INPUT', message: 'আইডেমপোটেন্সি কি লাগবে।' });
      }
      if (!html || typeof html !== 'string' || html.length < 100 || html.indexOf('<') < 0) {
        return res.status(400).json({ error: 'BAD_INPUT', message: 'পাসপোর্ট ডকুমেন্ট পাওয়া যায়নি — আবার Create করুন।' });
      }
      // Paid-order gate: the Create for this idempotency key must
      // have completed. Without it there is no charge and no PDF —
      // the PDF can never be used to bypass payment.
      const order = await findOrder(db, req.user.id, idem);
      if (!matchesOrder(order, passportNo)) {
        return res.status(402).json({ error: 'NOT_PAID', message: 'আগে Create করে চার্জ সম্পন্ন করুন, তারপর PDF ডাউনলোড হবে।' });
      }
      let pdf;
      try {
        pdf = await renderEpassportPdf(html);
      } catch (e) {
        safeLog('[epassport] pdf render error:', e.message);
        return res.status(500).json({ error: 'PDF_FAILED', message: 'PDF তৈরি করা যায়নি — আবার চেষ্টা করুন।' });
      }
      const filename = 'E-Passport-' + passportNo + '.pdf';
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="' + filename + '"');
      res.set('Content-Length', String(pdf.length));
      return res.send(pdf);
    } catch (e) {
      safeLog('[epassport] pdf error:', e.message);
      return res.status(500).json({ error: 'PDF_FAILED', message: 'PDF তৈরি করা যায়নি — আবার চেষ্টা করুন।' });
    }
  });

// Oversize PDF payload (photos too large) → a clear Bengali 413
// instead of the default HTML error page.
router.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PDF_TOO_LARGE', message: 'ছবি অনেক বড় — ছোট ছবি দিয়ে আবার চেষ্টা করুন।' });
  }
  return next(err);
});

module.exports = router;
