// ============================================================
// All In One (Abc Authentic) - Mouza map engine (separate
// engine: land-mouza-map, 2026-11-04). The customer picks an
// area + survey + mouza and gets that mouza's map SHEETS as
// preview images — the portal's own free search-card images
// (DLRMS public channel, guest token only; proven live
// 2026-11-04: /public/map-mouzas/jl-numbers →
// /public/maps?JL_NUMBER_ID= → /public/maps/image-view-file/).
//
// SEPARATE from land-khatian on purpose (Pankaj, 2026-11-04):
// its own page, its own services row, its own fee — never a
// button inside the khatian page. The fee is the services
// table price (migration 048 seeds 0; Pankaj sets the fee
// himself in Admin → Services) and is charged ONLY when at
// least one sheet is found — "not found" is a ৳0 failed
// order, exactly like land-khatian.
//
// Delivery discipline (same as land-khatian): the preview
// PNGs are served ONLY against the completed order that the
// search created (order_id + sheet id must match that
// order's sheets) — otherwise 403 NOT_DELIVERED_YET. A plain
// sheet id alone never opens an image. Idempotency: a
// repeated idempotency_key replays the stored outcome —
// never a second lookup charge.
//
// Honest limits, shown on the page: these are PREVIEW
// images, NOT the certified sheet (the certified sheet
// stays a paid cart order, govt fee ৳545/sheet, and is NOT
// built here). The sheet list carries NO dag membership —
// a customer picks by sheet number, not by dag.
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireAuth } = require('../auth');
const { safeLog, safeJsonArray } = require('../security');
const db = require('../db');
const serviceCredits = require('../lib/serviceCredits');
const wa = require('../utils/whatsapp');
const push = require('../utils/push');
const { buildReceiptPdf } = require('../lib/receiptPdf');
const { alertMissingPrice } = require('../lib/missingPriceAlert');
const adapter = require('../../engines/land-khatian/adapter');
const client = require('../../engines/land-core/client');

const router = express.Router();
const ENGINE_ID = 'land-mouza-map';
const LABEL = 'মৌজা ম্যাপ';
const UPLOAD_DIR = '/opt/all-in-one-abc-authentic/uploads/orders';

const BN_DIGIT_MAP = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
const toEn = (s) => String(s == null ? '' : s).replace(/[০-৯]/g, (d) => BN_DIGIT_MAP[d]);

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
    safeLog('[land-mouza-map] price error:', e.message);
    res.status(500).json({ error: 'PRICE_CHECK_FAILED' });
  }
});

function cleanArea(body) {
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const area = {
    divisionBbs: toEn(s(body.division_bbs, 10)),
    districtBbs: toEn(s(body.district_bbs, 10)),
    upazilaBbs: toEn(s(body.upazila_bbs, 10)),
    mouzaId: toEn(s(body.mouza_id, 12)),
    division: s(body.division_name, 60),
    district: s(body.district_name, 60),
    upazila: s(body.upazila_name, 60),
    mouza: s(body.mouza_name, 60),
  };
  if (!/^\d+$/.test(area.divisionBbs) || !/^\d+$/.test(area.districtBbs) ||
      !/^\d+$/.test(area.upazilaBbs) || !area.mouzaId) return null;
  return area;
}

async function storePdf(orderId, fn, buffer, originalname) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, fn), buffer);
  const ord = await db.query('SELECT documents FROM orders WHERE id = $1', [orderId]);
  const docs = safeJsonArray(ord.rows[0] && ord.rows[0].documents);
  if (!docs.some((d) => d && d.filename === fn)) {
    docs.push({ type: 'delivery', filename: fn, originalname, uploaded_at: new Date().toISOString(), uploaded_by: 'admin' });
    await db.query('UPDATE orders SET documents = $1 WHERE id = $2', [JSON.stringify(docs), orderId]);
  }
  return '/api/orders/' + orderId + '/documents/' + fn;
}

async function recordOrder(req, serviceId, status, price, idem, data) {
  const ins = await db.query(
    `INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [req.user.id, serviceId, status, JSON.stringify(data), price, idem]
  ).catch((e) => { safeLog('[land-mouza-map] order insert error:', e.message); return null; });
  if (ins && ins.rows.length) return ins.rows[0].id;
  const again = await db.query(
    'SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2', [req.user.id, idem]
  ).catch(() => null);
  return again && again.rows.length ? again.rows[0].id : null;
}

const slug = (idem) => idem.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48);
const nowBn = () => new Date().toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' });

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
  const ref = 'land-mouza-map-' + idem;
  const alreadyPaid = await db.query(
    `SELECT 1 FROM transactions WHERE user_id = $1 AND trxid IN ($2, $3) AND status = 'approved' LIMIT 1`,
    [req.user.id, ref, ref + ':svc']
  );
  if (alreadyPaid.rows.length) return;
  await db.withTransaction((clientTx) => serviceCredits.payForService(clientTx, {
    userId: req.user.id, serviceId, amount: Math.abs(price), ref,
  }));
}

function notifyDone(req, price, failed) {
  if (failed) {
    wa.notifyServiceFailed(db, req.user.id, LABEL, 'এই মৌজায় কোনো ম্যাপ পাওয়া যায়নি',
      'এলাকা ও জরিপ আবার যাচাই করে চেষ্টা করুন। সহায়তা লাগলে সাপোর্টে যোগাযোগ করুন।').catch(() => {});
    push.notifyUser(db, req.user.id, '❌ ' + LABEL,
      'কোনো ম্যাপ পাওয়া যায়নি — কোনো টাকা কাটা হয়নি। ব্যর্থতার রসিদটি ইতিহাসে পাবেন।', '/history.html').catch(() => {});
    push.notifyAdmins(db, '❌ ' + LABEL, 'একটি মৌজা ম্যাপ খোঁজায় কোনো শিট পাওয়া যায়নি — চার্জ ৳০।', '/admin.html').catch(() => {});
  } else {
    wa.notifyServiceCompleted(db, req.user.id, LABEL).catch(() => {});
    push.notifyUser(db, req.user.id, '✅ ' + LABEL,
      'আপনার মৌজা ম্যাপ শিট তৈরি — ইতিহাসে (History) পাবেন।', '/history.html').catch(() => {});
    push.notifyAdmins(db, '✅ ' + LABEL, `একটি মৌজা ম্যাপ খোঁজা সম্পন্ন হয়েছে — চার্জ ৳${price}।`, '/admin.html').catch(() => {});
  }
}

async function replayIfExists(req, res, idem) {
  const prev = await db.query(
    'SELECT id, price, status, data, documents FROM orders WHERE user_id = $1 AND idempotency_key = $2',
    [req.user.id, idem]
  );
  if (!prev.rows.length) return false;
  const row = prev.rows[0];
  let data = {};
  try { data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}); } catch { data = {}; }
  if (row.status === 'failed') {
    res.status(422).json({
      error: 'NOT_FOUND', duplicate: true, charged: 0, orderId: row.id,
      message: 'এই মৌজায় কোনো ম্যাপ পাওয়া যায়নি — কোনো টাকা কাটা হয়নি।',
    });
  } else {
    res.json({
      ok: true, duplicate: true, charged: Number(row.price) || 0, orderId: row.id,
      sheets: data.sheets || [], jlId: data.jlId || null, jlNumber: data.jlNumber || null,
      mouzaName: data.mouzaName || null,
    });
  }
  return true;
}

async function notFound(req, res, chk, idem, area) {
  let orderId = null; let receiptUrl = null;
  if (chk.serviceId) {
    orderId = await recordOrder(req, chk.serviceId, 'failed', 0, idem, { area, found: false });
    if (orderId) {
      notifyDone(req, 0, true);
      try {
        const pdf = await buildReceiptPdf({
          noBrand: true,
          serviceLabel: LABEL, outcome: 'failed',
          reason: 'এই মৌজায় সরকারি পোর্টালে কোনো ম্যাপ শিট পাওয়া যায়নি',
          subjectLabel: 'মৌজা', subjectValue: area.mouza || '—',
          chargeText: '৳০ — কোনো টাকা কাটা হয়নি', ref: idem, when: nowBn(),
          footers: ['শিট না পেলে কোনো চার্জ কাটা হয় না — এটি এই সেবার নিয়ম। এলাকা ও জরিপ যাচাই করে আবার চেষ্টা করুন।'],
        });
        receiptUrl = await storePdf(orderId, 'delivery-land-mouza-map-failed-' + slug(idem) + '.pdf', pdf, 'land-mouza-map-not-found-receipt.pdf');
      } catch (e) { safeLog('[land-mouza-map] failure receipt error:', e.message); }
    }
  }
  return res.status(422).json({
    error: 'NOT_FOUND', charged: 0, orderId, receipt: receiptUrl,
    message: 'এই মৌজায় কোনো ম্যাপ পাওয়া যায়নি — কোনো টাকা কাটা হয়নি।',
  });
}

async function succeed(req, res, chk, idem, area, result) {
  try {
    await chargeOnce(req, chk.price, chk.serviceId, idem);
  } catch (e) {
    if (/INSUFFICIENT_BALANCE/.test(e.message)) {
      return res.status(402).json({ error: 'INSUFFICIENT_BALANCE', message: 'পর্যাপ্ত ব্যালেন্স নেই। অনুগ্রহ করে ওয়ালেট রিচার্জ করুন।' });
    }
    if (!/DUPLICATE_TRANSACTION/.test(e.message)) throw e;
  }
  const payload = {
    area, found: true, sheets: result.sheets,
    jlId: result.jlId, jlNumber: result.jlNumber, mouzaName: result.mouzaName,
  };
  let orderId = null; let receiptUrl = null;
  if (chk.serviceId) {
    orderId = await recordOrder(req, chk.serviceId, 'completed', chk.price, idem, payload);
    if (orderId) {
      notifyDone(req, chk.price, false);
      try {
        const pdf = await buildReceiptPdf({
          noBrand: true,
          serviceLabel: LABEL, outcome: 'completed',
          successLine: `${result.sheets.length}টি মৌজা ম্যাপ শিট পাওয়া গেছে — প্রিভিউ ছবি এই পেজেই দেখুন।`,
          subjectLabel: 'মৌজা', subjectValue: area.mouza || '—',
          chargeText: `৳${chk.price}`, ref: idem, when: nowBn(),
          footers: ['এই ছবিগুলো প্রিভিউ — সার্টিফাইড মৌজা শিট নয়। অফিসিয়াল কাজে সরকারি পোর্টালে যাচাই করে নিন।'],
        });
        receiptUrl = await storePdf(orderId, 'delivery-land-mouza-map-' + slug(idem) + '.pdf', pdf, 'land-mouza-map-receipt.pdf');
      } catch (e) { safeLog('[land-mouza-map] receipt error:', e.message); }
    }
  }
  return res.json({
    ok: true, charged: chk.price, orderId, receipt: receiptUrl,
    sheets: result.sheets, jlId: result.jlId, jlNumber: result.jlNumber, mouzaName: result.mouzaName,
  });
}

function idemOf(body) {
  let idem = String((body && body.idempotency_key) || '').trim().slice(0, 80);
  if (!idem) idem = 'land-mouza-map-' + crypto.randomUUID();
  return idem;
}

// ---------- POST /search ----------
router.post('/search', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const area = cleanArea(body);
    const surveyId = toEn(String(body.survey_id == null ? '' : body.survey_id).trim().slice(0, 20));
    if (!area || !surveyId) {
      return res.status(400).json({ error: 'BAD_INPUT', message: 'এলাকা, জরিপ ও মৌজা লাগবে — ক্যাসকেড থেকে আবার বেছে নিন।' });
    }
    const idem = idemOf(body);
    if (await replayIfExists(req, res, idem)) return;
    const chk = await precheck(req, res);
    if (!chk) return;
    let result;
    try {
      result = await adapter.searchMaps({
        divisionBbs: area.divisionBbs, districtBbs: area.districtBbs, upazilaBbs: area.upazilaBbs,
        surveyId, mouzaId: area.mouzaId,
      });
    } catch (e) {
      if (e.code === 'BAD_AREA' || e.code === 'JL_NOT_FOUND') {
        return res.status(400).json({ error: e.code, message: 'এই মৌজার ম্যাপ পাওয়া যায়নি — এলাকা, জরিপ বা মৌজা ঠিক নয়।' });
      }
      safeLog('[land-mouza-map] portal error:', e.code || '', e.message);
      return res.status(502).json({ error: 'LAND_UNREACHABLE', message: 'ভূমি পোর্টালে সংযোগ করা যাচ্ছে না — কিছুক্ষণ পর আবার চেষ্টা করুন।' });
    }
    if (!result.sheets.length) return notFound(req, res, chk, idem, area);
    return succeed(req, res, chk, idem, area, result);
  } catch (e) {
    safeLog('[land-mouza-map] search error:', e.message);
    res.status(500).json({ error: 'SEARCH_FAILED' });
  }
});

// ---------- GET /preview/:id ----------
// Served ONLY against the completed order that the search
// created: the order must belong to this user, be for this
// engine, be completed, and list this sheet id. Otherwise
// 403 NOT_DELIVERED_YET — a sheet id alone never opens an
// image, and one customer's order never opens another's.
router.get('/preview/:id', requireAuth, async (req, res) => {
  try {
    const id = toEn(String(req.params.id || '').trim().slice(0, 12));
    const orderId = String(req.query.order_id || '').trim().slice(0, 80);
    if (!/^\d+$/.test(id) || !orderId) {
      return res.status(400).json({ error: 'BAD_INPUT', message: 'শিট ও অর্ডার ঠিক নয়।' });
    }
    const chk = await getServicePrice(req.user.id);
    const ord = await db.query(
      'SELECT id, service_id, status, data FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, req.user.id]
    );
    let ok = false;
    if (ord.rows.length) {
      const row = ord.rows[0];
      let data = {};
      try { data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}); } catch { data = {}; }
      ok = row.status === 'completed' &&
        (chk.serviceId === null || row.service_id === chk.serviceId) &&
        Array.isArray(data.sheets) && data.sheets.some((sh) => String(sh.id) === id);
    }
    if (!ok) {
      return res.status(403).json({ error: 'NOT_DELIVERED_YET', message: 'এই শিটের ছবি এখনো আপনার জন্য তৈরি হয়নি — আগে ম্যাপ খুঁজুন।' });
    }
    let img;
    try {
      img = await client.mapPreview(id);
    } catch (e) {
      safeLog('[land-mouza-map] preview error:', e.code || '', e.message);
      return res.status(502).json({ error: 'LAND_UNREACHABLE', message: 'ভূমি পোর্টালে সংযোগ করা যাচ্ছে না — কিছুক্ষণ পর আবার চেষ্টা করুন।' });
    }
    res.set('Content-Type', img.contentType);
    res.set('Cache-Control', 'no-store');
    return res.send(img.buffer);
  } catch (e) {
    safeLog('[land-mouza-map] preview error:', e.message);
    return res.status(500).json({ error: 'MAP_PREVIEW_FAILED' });
  }
});

module.exports = router;
