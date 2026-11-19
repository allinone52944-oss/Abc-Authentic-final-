'use strict';
/**
 * backend/routes/nid-smart-card.js — NID Smart Card engine route.
 * NID form PDF → new smart card PDF (front+back, one Letter page,
 * MRZ + PDF417 barcode). "Sign to Smart Card Pdf".
 *
 * Flow — SAME single-step flow as nid-replica (POST /build):
 *   GET  /price   — service price + balance.
 *   POST /extract — upload the NID form PDF, extract fields.
 *   POST /build   — build the card FIRST, charge AFTER a successful
 *                   build, then order record + server-side delivery
 *                   copy, then return the PDF bytes in the same
 *                   response. A build failure NEVER takes money.
 * Charge ref / order key follow the replica's jobId-based pattern
 * (ref 'nid-card-' + jobId, order key 'nid-' + jobId), so a
 * repeated build for the same job never charges twice and the
 * refund reconstruction in lib/serviceCredits.js (nid.js format)
 * applies to this engine too.
 *
 * Login gate + rate limit; mounted in server.js.
 * The card's barcode is PDF417 (not a QR) — the QR fallback logic
 * is untouched by this engine.
 */

const express = require('express');
const { requireAuth } = require('../auth');
const db = require('../db');
const { safeLog, uploadMiddleware, safeJsonArray } = require('../security');
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

// ---------- POST /build ----------
// Single step, like nid-replica: build FIRST, charge AFTER a
// successful build, then order record + server-side delivery copy,
// then the PDF bytes in the same response. A build failure can
// never take money (the charge block below only runs after a
// successful build).
router.post('/build', requireAuth, async (req, res) => {
  try {
    const { jobId, fields, images } = req.body || {};
    if (!jobId || !fields || typeof fields !== 'object') {
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    }

    const { allowed, price, serviceId } = await getServicePrice(req.user.id);
    if (!allowed) {
      return res.status(403).json({
        error: 'SERVICE_ACCESS_DISABLED',
        message: 'এই সেবায় আপনার প্রবেশাধিকার স্থগিত রয়েছে।'
      });
    }

    if (price > 0) {
      const u = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
      const balance = u.rows[0] ? Number(u.rows[0].balance) : 0;
      const lockedCredit = await serviceCredits.availableFor(db, req.user.id, serviceId);
      if (balance + lockedCredit < price) {
        return res.status(402).json({
          error: 'INSUFFICIENT_BALANCE',
          message: `পর্যাপ্ত ব্যালেন্স নেই। স্মার্ট কার্ড তৈরি করতে ৳${price} প্রয়োজন, বর্তমান ব্যালেন্স ৳${balance}।`,
          required: price,
          balance
        });
      }
    }

    const built = await adapter.buildCard(jobId, fields, images, req.user.id);
    if (!built.ok) {
      const status = built.error === 'JOB_NOT_FOUND' ? 404 : built.error === 'NOT_YOUR_JOB' ? 403 : 422;
      // A real build failure (not a stale/foreign job id): the
      // card is built BEFORE any charge, so no money was taken —
      // tell the customer on WhatsApp and push the admins
      // (premium failure flow, like nid-replica).
      if (status === 422) {
        wa.notifyServiceFailed(db, req.user.id, LABEL,
          'তৈরি করা যায়নি',
          'কিছুক্ষণ পর আবার চেষ্টা করুন। সহায়তা লাগলে আমাদের সাপোর্টে যোগাযোগ করুন।').catch(() => {});
        push.notifyUser(db, req.user.id, '❌ ' + LABEL + ' তৈরি ব্যর্থ',
          'আপনার স্মার্ট কার্ডটি তৈরি করা যায়নি — কোনো টাকা কাটা হয়নি।', PAGE).catch(() => {});
        push.notifyAdmins(db, '❌ ' + LABEL + ' তৈরি ব্যর্থ',
          'একটি স্মার্ট কার্ড তৈরি করা যায়নি (' + String(built.error || 'BUILD_ERROR') + ') — কোনো চার্জ কাটা হয়নি।', '/admin.html').catch(() => {});
      }
      // Blank-data gate: the customer sees the real reason in the UI.
      // The build's own Bengali error (e.g. photo/barcode replace
      // failure) is the real reason — show it, not a generic code.
      const body = { error: built.error };
      if (built.error === 'NO_CORE_DATA') body.message = adapter.NO_CORE_DATA_MESSAGE;
      if (built.error === 'JOB_NOT_FOUND') body.message = 'সেশন শেষ — আবার আপলোড করুন।';
      if (built.detail) body.message = built.detail;
      return res.status(status).json(body);
    }

    const downloadName = adapter.outputBase(fields) + '.pdf';

    if (price > 0) {
      const ref = 'nid-card-' + jobId;
      const alreadyPaid = await db.query(
        `SELECT 1 FROM transactions WHERE user_id = $1 AND trxid IN ($2, $3) AND status = 'approved' LIMIT 1`,
        [req.user.id, ref, ref + ':svc']
      );

      if (!alreadyPaid.rows.length) {
        try {
          await db.withTransaction((client) => serviceCredits.payForService(client, {
            userId: req.user.id, serviceId, amount: Math.abs(price), ref,
          }));
          safeLog('[nid-smart-card] charged', price, 'for user', req.user.id, 'job', jobId);
        } catch (e) {
          if (/INSUFFICIENT_BALANCE/.test(e.message)) {
            return res.status(402).json({
              error: 'INSUFFICIENT_BALANCE',
              message: 'পর্যাপ্ত ব্যালেন্স নেই। অনুগ্রহ করে ওয়ালেট রিচার্জ করুন।'
            });
          }
          if (!/DUPLICATE_TRANSACTION/.test(e.message)) {
            throw e;
          }
        }
      }
    }

    if (serviceId) {
      // The orders idempotency index (migration 019) is PARTIAL
      // (WHERE idempotency_key IS NOT NULL), so the conflict target must
      // repeat that predicate — without it PostgreSQL cannot infer the
      // index and the insert errors out ("there is no unique or exclusion
      // constraint matching the ON CONFLICT specification").
      const ins = await db.query(
        `INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key)
         VALUES ($1, $2, 'completed', $3, $4, $5)
         ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [req.user.id, serviceId, JSON.stringify(fields || {}), price, 'nid-' + jobId]
      ).catch(e => { safeLog('[nid-smart-card] order record insert error:', e.message); return null; });
      // First build of this job (a fresh order row) → WhatsApp
      // confirmation. Re-downloads of the same job stay silent.
      // The notification happens ONLY here — after a successful
      // build + first order insert, never before the PDF exists.
      if (ins && ins.rows.length) {
        wa.notifyServiceCompleted(db, req.user.id, LABEL).catch(() => {});
        push.notifyUser(db, req.user.id, '✅ ' + LABEL + ' তৈরি হয়েছে',
          'আপনার স্মার্ট কার্ডটি তৈরি হয়েছে — ইতিহাস থেকে যেকোনো সময় ডাউনলোড করতে পারবেন।', '/history.html').catch(() => {});
        push.notifyAdmins(db, '✅ ' + LABEL,
          `একটি স্মার্ট কার্ড সফলভাবে তৈরি হয়েছে — চার্জ ৳${price}।`, '/admin.html').catch(() => {});
      }
    }

    // ডেলিভারি কপি: তৈরি PDF-টা অর্ডারের ডেলিভারি ফাইল হিসেবে সার্ভারে
    // জমা থাকে — গ্রাহক ইতিহাস থেকে যেকোনো সময় আবার নামাতে পারবেন।
    // জমা ব্যর্থ হলেও মূল PDF পাঠানো আটকায় না।
    if (serviceId) {
      try {
        const ord = await db.query(
          'SELECT id, documents FROM orders WHERE user_id = $1 AND idempotency_key = $2',
          [req.user.id, 'nid-' + jobId]
        );
        if (ord.rows.length) {
          const fn = 'delivery-nid-smart-card-' + String(jobId).replace(/[^a-zA-Z0-9-]/g, '') + '.pdf';
          const docs = safeJsonArray(ord.rows[0].documents);
          if (!docs.some(d => d && d.filename === fn)) {
            const fsx = require('fs');
            const pathx = require('path');
            const dir = '/opt/all-in-one-abc-authentic/uploads/orders';
            fsx.mkdirSync(dir, { recursive: true });
            fsx.writeFileSync(pathx.join(dir, fn), built.pdfBuffer);
            docs.push({
              type: 'delivery', filename: fn, originalname: downloadName,
              uploaded_at: new Date().toISOString(), uploaded_by: 'admin',
            });
            await db.query('UPDATE orders SET documents = $1 WHERE id = $2', [JSON.stringify(docs), ord.rows[0].id]);
          }
        } else {
          // Never skip silently — a missing order row is exactly how the
          // partial-index insert failure hid in production for days.
          safeLog('[nid-smart-card] delivery copy skipped: order row missing for job', jobId);
        }
      } catch (e) { safeLog('[nid-smart-card] delivery copy store error:', e.message); }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', built.pdfBuffer.length);
    res.send(built.pdfBuffer);
  } catch (e) {
    safeLog('[nid-smart-card] build route error:', e.message);
    // Admin-only alert: at this layer the charge state is not
    // certain enough to word a customer message — an operator
    // should look.
    push.notifyAdmins(db, '⚠️ স্মার্ট কার্ড build সার্ভার ত্রুটি',
      'স্মার্ট কার্ড build রাউটে সার্ভার ত্রুটি: ' + String(e.message || '').slice(0, 120), '/admin.html').catch(() => {});
    res.status(500).json({ error: 'BUILD_FAILED' });
  }
});

module.exports = router;
