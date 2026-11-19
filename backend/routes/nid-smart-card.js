'use strict';
/**
 * backend/routes/nid-smart-card.js — NID Smart Card engine route.
 * NID form PDF → new smart card PDF (front+back, one Letter page,
 * MRZ + PDF417 barcode). "Sign to Smart Card Pdf".
 *
 * Flow (same pattern as passport / nid-server-report):
 *   POST /extract — upload the NID form PDF, extract fields.
 *   POST /create  — charge ONCE (idempotency key) + record the order.
 *   POST /pdf     — verify the paid order, build the card, return the
 *                   PDF. NEVER charges. A retry reuses the same key.
 *   GET  /price   — service price + balance.
 *
 * Login gate + rate limit; mounted in server.js.
 * The card's barcode is PDF417 (not a QR) — the QR fallback logic
 * is untouched by this engine.
 */

const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../auth');
const db = require('../db');
const { safeLog, uploadMiddleware } = require('../security');
const adapter = require('../../engines/nid-smart-card/adapter');
const { alertMissingPrice } = require('../lib/missingPriceAlert');
const serviceCredits = require('../lib/serviceCredits');
const wa = require('../utils/whatsapp');
const push = require('../utils/push');

const router = express.Router();

const ENGINE_ID = 'nid-smart-card';
const LABEL = 'স্মার্ট কার্ড পিডিএফ';
const PAGE = '/nid-smart-card.html';

const upload = uploadMiddleware(() => ({ allowed: ['pdf'], max_mb: 20 }));
const pdfOnly = upload.single('pdf');

function multerError(err, req, res, next) {
  if (err) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'PDF_TOO_LARGE'
      : err.message === 'FILE_TYPE_NOT_ALLOWED' ? 'NOT_A_PDF'
      : 'UPLOAD_FAILED';
    return res.status(400).json({ error: code });
  }
  next();
}

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

function idemOf(body) {
  let idem = String((body && body.idempotency_key) || '').trim().slice(0, 80);
  if (!idem) idem = 'nidsc-' + crypto.randomUUID();
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
  const ref = 'nidsc-' + idem;
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
  ).catch((e) => { safeLog('[nid-smart-card] order insert error:', e.message); return null; });
  if (ins && ins.rows.length) return ins.rows[0].id;
  const again = await db.query(
    'SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2', [req.user.id, idem]
  ).catch(() => null);
  return again && again.rows.length ? again.rows[0].id : null;
}

function notifyDone(req, price) {
  wa.notifyServiceCompleted(db, req.user.id, LABEL).catch(() => {});
  push.notifyUser(db, req.user.id, '✅ ' + LABEL,
    'আপনার স্মার্ট কার্ড তৈরি হয়েছে — ডাউনলোড দেখুন। অর্ডারটি ইতিহাসে (History) পাবেন।', '/history.html').catch(() => {});
  push.notifyAdmins(db, '✅ ' + LABEL, `একটি স্মার্ট কার্ড তৈরি হয়েছে — চার্জ ৳${price}।`, '/admin.html').catch(() => {});
}

function dataUrlToBuffer(photo) {
  if (typeof photo !== 'string') return { ok: false };
  const m = photo.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!m || m[2].length > 14 * 1024 * 1024) return { ok: false };
  try {
    return { ok: true, buffer: Buffer.from(m[2], 'base64') };
  } catch (_) {
    return { ok: false };
  }
}

// ---------- GET /price ----------
router.get('/price', requireAuth, async (req, res) => {
  try {
    const { allowed, price, serviceId } = await getServicePrice(req.user.id);
    const u = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    res.json({ ok: true, engineId: ENGINE_ID, allowed, price, serviceId, balance: u.rows[0] ? Number(u.rows[0].balance) : 0 });
  } catch (e) {
    safeLog('[nid-smart-card] price error:', e.message);
    res.status(500).json({ error: 'PRICE_CHECK_FAILED' });
  }
});

// ---------- POST /extract ----------
router.post('/extract', requireAuth, pdfOnly, multerError, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'NO_FILE' });
    }
    const r = await adapter.extractFields(req.file.buffer, req.user.id);
    if (!r.ok) {
      // No charge exists at this stage and the customer is looking
      // at the error on the page — a WhatsApp for every bad scan
      // would spam retries. The admins get a push so a pattern of
      // extract failures (engine trouble) is visible.
      push.notifyAdmins(db, '⚠️ স্মার্ট কার্ড তথ্য তোলা ব্যর্থ',
        'একটি NID PDF থেকে তথ্য তোলা যায়নি (' + String(r.error || 'EXTRACT_ERROR') + ')।', '/admin.html').catch(() => {});
      // Blank-data gate: tell the customer the real reason, not a
      // generic failure — no core data was found in the PDF.
      const body = { error: r.error };
      if (r.error === 'NO_CORE_DATA') body.message = adapter.NO_CORE_DATA_MESSAGE;
      return res.status(422).json(body);
    }
    res.json({ ok: true, jobId: r.jobId, fields: r.fields, images: r.images });
  } catch (e) {
    safeLog('[nid-smart-card] extract route error:', e.message);
    res.status(500).json({ error: 'EXTRACT_FAILED' });
  }
});

// ---------- POST /create ----------
// Charges ONCE for the single card PDF and records the order.
// The PDF itself is built by POST /pdf afterwards (same key).
router.post('/create', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const { jobId, fields } = body;
    if (!jobId || !fields || typeof fields !== 'object') {
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    }
    // Dead/foreign job or blanked-out fields must never reach the
    // charge step.
    const job = await adapter.validateJob(jobId, req.user.id);
    if (!job.ok) {
      const status = job.error === 'JOB_NOT_FOUND' ? 404 : job.error === 'NOT_YOUR_JOB' ? 403 : 422;
      return res.status(status).json({ error: job.error, message: job.error === 'JOB_NOT_FOUND' ? 'সেশন শেষ — আবার আপলোড করুন।' : undefined });
    }
    if (!adapter.hasCoreData(fields)) {
      return res.status(422).json({ error: 'NO_CORE_DATA', message: adapter.NO_CORE_DATA_MESSAGE });
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
    const base = adapter.outputBase(fields);
    const filename = base + '.pdf';
    const nid = String(fields['ID NO:'] || fields['Pin'] || '').trim();
    let orderId = null;
    if (chk.serviceId) {
      orderId = await recordOrder(req, chk.serviceId, 'completed', chk.price, idem,
        { nid, filename, engine: ENGINE_ID });
      if (orderId) notifyDone(req, chk.price);
    }
    const u2 = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    return res.json({
      ok: true, charged: chk.price, orderId, filename,
      balance: u2.rows[0] ? Number(u2.rows[0].balance) : null,
    });
  } catch (e) {
    safeLog('[nid-smart-card] create error:', e.message);
    res.status(500).json({ error: 'CREATE_FAILED' });
  }
});

// ---------- POST /pdf ----------
// Builds the single card PDF and returns it. This route NEVER
// charges and NEVER creates an order — it only verifies the paid
// order for the idempotency key (POST /create already charged and
// recorded it). A retry of a failed build reuses the same key, so
// it never charges twice. A build failure is a clear 422/500 and
// the frontend downloads NOTHING (no HTML fallback).
router.post('/pdf', requireAuth, async (req, res) => {
  try {
    const idem = String(req.query.idempotency_key || '').trim().slice(0, 80);
    if (!idem) {
      return res.status(400).json({ error: 'BAD_INPUT', message: 'আইডেমপোটেন্সি কি লাগবে।' });
    }
    const body = req.body || {};
    const { jobId, fields, photo } = body;
    if (!jobId || !fields || typeof fields !== 'object') {
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    }
    // Paid-order gate: the Create for this idempotency key must
    // have completed. Without it there is no charge and no PDF —
    // the PDF can never be used to bypass payment.
    const ord = await db.query(
      'SELECT id, price, status FROM orders WHERE user_id = $1 AND idempotency_key = $2',
      [req.user.id, idem]
    );
    if (!ord.rows.length || ord.rows[0].status !== 'completed') {
      return res.status(402).json({ error: 'NOT_PAID', message: 'আগে Create করে চার্জ সম্পন্ন করুন, তারপর PDF ডাউনলোড হবে।' });
    }
    // Photo override: data URL = uploaded photo, null = no photo,
    // absent = keep the extracted photo. A missing photo makes the
    // build FAIL loudly (fix #3) — the template's sample photo is
    // never kept in a customer's card.
    let images;
    if (photo === null) images = [];
    else if (typeof photo === 'string') {
      const dec = dataUrlToBuffer(photo);
      if (!dec.ok) {
        return res.status(400).json({ error: 'INVALID_PHOTO', message: 'ছবিটি পড়া যায়নি — অন্য ছবি দিয়ে আবার চেষ্টা করুন।' });
      }
      images = [{ name: 'photo.png', dataUrl: photo }];
    }
    const built = await adapter.buildCard(jobId, fields, images, req.user.id);
    if (!built.ok) {
      const status = built.error === 'JOB_NOT_FOUND' ? 404 : built.error === 'NOT_YOUR_JOB' ? 403 : 422;
      if (status === 422) {
        wa.notifyServiceFailed(db, req.user.id, LABEL,
          'তৈরি করা যায়নি',
          'কিছুক্ষণ পর আবার চেষ্টা করুন। সহায়তা লাগলে আমাদের সাপোর্টে যোগাযোগ করুন।').catch(() => {});
        push.notifyUser(db, req.user.id, '❌ ' + LABEL + ' তৈরি ব্যর্থ',
          'আপনার স্মার্ট কার্ডটি তৈরি করা যায়নি — আবার চেষ্টা করুন।', PAGE).catch(() => {});
        push.notifyAdmins(db, '❌ ' + LABEL + ' তৈরি ব্যর্থ',
          'একটি স্মার্ট কার্ড তৈরি করা যায়নি (' + String(built.error || 'BUILD_ERROR') + ')।', '/admin.html').catch(() => {});
      }
      const out = { error: built.error };
      if (built.error === 'NO_CORE_DATA') out.message = adapter.NO_CORE_DATA_MESSAGE;
      if (built.error === 'JOB_NOT_FOUND') out.message = 'সেশন শেষ — আবার আপলোড করুন।';
      // The build's own Bengali error (e.g. photo/barcode replace
      // failure) is the real reason — show it, not a generic code.
      if (built.detail) out.message = built.detail;
      return res.status(status).json(out);
    }
    const buf = built.pdfBuffer;
    const filename = adapter.outputBase(fields) + '.pdf';
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.set('Content-Length', String(buf.length));
    return res.send(buf);
  } catch (e) {
    safeLog('[nid-smart-card] pdf error:', e.message);
    return res.status(500).json({ error: 'PDF_FAILED', message: 'PDF তৈরি করা যায়নি — আবার চেষ্টা করুন।' });
  }
});

module.exports = router;
