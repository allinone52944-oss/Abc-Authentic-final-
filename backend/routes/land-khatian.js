// ============================================================
// All In One (Abc Authentic) - Land khatian search (SPEC
// Phase 1: login-free search + summary only).
// Mounted at /api/land-khatian (JWT auth + rate limit at
// mount, same as /api/land).
//
//   GET  /api/land-khatian/price  price + balance
//   POST /api/land-khatian/search  by khatian number and/or
//        owner name and/or dag number, across the surveys
//        the portal offers in the upazila (surveyId 'all'),
//        one survey, or the conditional MUTATION passthrough
//        (surveyId 'mutation' — see engines/land-khatian/
//        adapter.js: accepted by the portal but 0 items on
//        the verified sample, so empty means not-found).
//
// Cascade: the frontend calls the EXISTING /api/land/geo/*
// endpoints (realtime, proven) — no geo routes are
// duplicated here.
//
// Money discipline (same as backend/routes/land.js and
// qr-verify.js): the wallet is charged ONLY when at least
// one record is found; "not found" records a ৳0 failed
// order with a failure receipt. Every success stores a
// clean Bengali summary PDF on the order → the customer's
// History (same /api/orders/:id/documents/:filename
// delivery land.js uses). Idempotency: a repeated
// idempotency_key replays the stored outcome — never a
// second lookup charge. A portal failure is 502
// LAND_UNREACHABLE with NO charge and NO order.
//
// No cart, no copy application, no mutation application,
// no login, no eporcha.tech anywhere on this route.
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
const { buildKhatianSummaryPdf } = require('../lib/khatianSummaryPdf');
const adapter = require('../../engines/land-khatian/adapter');
const client = require('../../engines/land-core/client');

const router = express.Router();
const ENGINE_ID = 'land-khatian';
const LABEL = 'খতিয়ান অনুসন্ধান';
const UPLOAD_DIR = '/opt/all-in-one-abc-authentic/uploads/orders';

// ---------- pricing (per engine, same rules as land.js) ----------
async function getServicePrice(userId) {
  const r = await db.query(
    `SELECT id, price FROM services WHERE engine_id = $1 AND status = 'active' LIMIT 1`, [ENGINE_ID]
  );
  if (!r.rows.length) return { allowed: true, price: 0, serviceId: null };
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
    safeLog('[land-khatian] price error:', e.message);
    res.status(500).json({ error: 'PRICE_CHECK_FAILED' });
  }
});

// ---------- input ----------
/** Bengali digits → Latin (land.js does the same for
 *  khatian/dag numbers; area codes get it too so a
 *  Bengali-typed BBS code does not fail the digit check). */
const BN_DIGIT_MAP = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
const toEn = (s) => String(s == null ? '' : s).replace(/[০-৯]/g, (d) => BN_DIGIT_MAP[d]);

function cleanArea(body) {
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const area = {
    divisionBbs: toEn(s(body.division_bbs, 10)),
    districtBbs: toEn(s(body.district_bbs, 10)),
    upazilaBbs: toEn(s(body.upazila_bbs, 10)),
    mouzaId: toEn(s(body.mouza_id, 12)),
    jlId: toEn(s(body.jl_id, 12)),
    division: s(body.division_name, 60),
    district: s(body.district_name, 60),
    upazila: s(body.upazila_name, 60),
    mouza: s(body.mouza_name, 60),
    jl: toEn(s(body.jl_no, 12)),
  };
  if (!/^\d+$/.test(area.divisionBbs) || !/^\d+$/.test(area.districtBbs) ||
      !/^\d+$/.test(area.upazilaBbs)) return null;
  if (!area.mouzaId && !area.jlId) return null;
  return area;
}

// ---------- money + order plumbing (land.js discipline) ----------
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

async function replayIfExists(req, res, idem) {
  const prev = await db.query(
    'SELECT id, price, status, data, documents FROM orders WHERE user_id = $1 AND idempotency_key = $2',
    [req.user.id, idem]
  );
  if (!prev.rows.length) return false;
  const row = prev.rows[0];
  const docs = safeJsonArray(row.documents);
  const receipt = docs.find((d) => d && d.type === 'delivery');
  const receiptUrl = receipt ? '/api/orders/' + row.id + '/documents/' + receipt.filename : null;
  let data = {};
  try { data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}); } catch { data = {}; }
  if (row.status === 'failed') {
    res.status(422).json({
      error: 'NOT_FOUND', duplicate: true, charged: 0, orderId: row.id, receipt: receiptUrl,
      message: 'কোনো রেকর্ড পাওয়া যায়নি — কোনো টাকা কাটা হয়নি।',
    });
  } else {
    res.json({
      ok: true, duplicate: true, charged: Number(row.price) || 0, orderId: row.id,
      receipt: receiptUrl, records: data.records || [], totalLand: data.totalLand || null,
      totalMatches: data.totalMatches || null, totalCandidates: data.totalCandidates || null,
      capped: data.capped || false, mutationAttempted: data.mutationAttempted || false,
      mutationUnsupported: data.mutationUnsupported || false,
    });
  }
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
  const ref = 'land-khatian-' + idem;
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
  ).catch((e) => { safeLog('[land-khatian] order insert error:', e.message); return null; });
  if (ins && ins.rows.length) return ins.rows[0].id;
  const again = await db.query(
    'SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2', [req.user.id, idem]
  ).catch(() => null);
  return again && again.rows.length ? again.rows[0].id : null;
}

function notifyDone(req, price, failed) {
  if (failed) {
    wa.notifyServiceFailed(db, req.user.id, LABEL, 'সরকারি রেকর্ডে কোনো তথ্য পাওয়া যায়নি',
      'এলাকা ও তথ্য আবার যাচাই করে চেষ্টা করুন। সহায়তা লাগলে সাপোর্টে যোগাযোগ করুন।').catch(() => {});
    push.notifyUser(db, req.user.id, '❌ ' + LABEL,
      'কোনো রেকর্ড পাওয়া যায়নি — কোনো টাকা কাটা হয়নি। ব্যর্থতার রসিদটি ইতিহাসে পাবেন।', '/history.html').catch(() => {});
    push.notifyAdmins(db, '❌ ' + LABEL, 'একটি খতিয়ান অনুসন্ধানে কোনো রেকর্ড পাওয়া যায়নি — চার্জ ৳০।', '/admin.html').catch(() => {});
  } else {
    wa.notifyServiceCompleted(db, req.user.id, LABEL).catch(() => {});
    push.notifyUser(db, req.user.id, '✅ ' + LABEL,
      'আপনার সারাংশ রিপোর্ট তৈরি — ইতিহাসে (History) পাবেন।', '/history.html').catch(() => {});
    push.notifyAdmins(db, '✅ ' + LABEL, `একটি খতিয়ান অনুসন্ধান সম্পন্ন হয়েছে — চার্জ ৳${price}।`, '/admin.html').catch(() => {});
  }
}

const slug = (idem) => idem.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48);
const nowBn = () => new Date().toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' });

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
          reason: 'সরকারি ভূমি রেকর্ডে এই তথ্যে কোনো খতিয়ান পাওয়া যায়নি',
          subjectLabel: 'মৌজা', subjectValue: area.mouza || '—',
          chargeText: '৳০ — কোনো টাকা কাটা হয়নি', ref: idem, when: nowBn(),
          footers: ['তথ্য না পেলে কোনো চার্জ কাটা হয় না — এটি এই সেবার নিয়ম। এলাকা ও নম্বর যাচাই করে আবার চেষ্টা করুন।'],
        });
        receiptUrl = await storePdf(orderId, 'delivery-land-khatian-failed-' + slug(idem) + '.pdf', pdf, 'land-khatian-not-found-receipt.pdf');
      } catch (e) { safeLog('[land-khatian] failure receipt error:', e.message); }
    }
  }
  return res.status(422).json({
    error: 'NOT_FOUND', charged: 0, orderId, receipt: receiptUrl,
    message: 'কোনো রেকর্ড পাওয়া যায়নি — কোনো টাকা কাটা হয়নি।',
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
  const records = result.items;
  const totalLand = client.sumLand(result.items);
  const payload = {
    area, found: true, records, totalLand,
    totalMatches: result.totalMatches, totalCandidates: result.totalCandidates,
    capped: result.capped, surveysTried: result.surveysTried,
    mutationAttempted: result.mutationAttempted, mutationUnsupported: result.mutationUnsupported,
  };
  let orderId = null; let receiptUrl = null;
  if (chk.serviceId) {
    orderId = await recordOrder(req, chk.serviceId, 'completed', chk.price, idem, payload);
    if (orderId) {
      notifyDone(req, chk.price, false);
      try {
        const pdf = await buildKhatianSummaryPdf({
          ref: idem, when: nowBn(), area, items: records, totalLand,
          totalMatches: result.totalCandidates, capped: result.capped,
        });
        receiptUrl = await storePdf(orderId, 'delivery-land-khatian-' + slug(idem) + '.pdf', pdf, 'land-khatian-summary.pdf');
      } catch (e) { safeLog('[land-khatian] summary pdf error:', e.message); }
    }
  }
  const u2 = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
  return res.json({
    ok: true, charged: chk.price, orderId, receipt: receiptUrl,
    balance: u2.rows[0] ? Number(u2.rows[0].balance) : null,
    records, totalLand,
    totalMatches: result.totalMatches, totalCandidates: result.totalCandidates,
    capped: result.capped, surveysTried: result.surveysTried,
    mutationAttempted: result.mutationAttempted, mutationUnsupported: result.mutationUnsupported,
  });
}

function idemOf(body) {
  let idem = String((body && body.idempotency_key) || '').trim().slice(0, 80);
  if (!idem) idem = 'land-khatian-' + crypto.randomUUID();
  return idem;
}

// ---------- POST /search ----------
router.post('/search', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const area = cleanArea(body);
    const khatianNo = toEn(String(body.khatian_no || '').trim().slice(0, 20));
    const ownerName = String(body.owner_name || '').trim().slice(0, 80);
    const dagNo = toEn(String(body.dag_no || '').trim().slice(0, 20));
    if (!area || (!khatianNo && !ownerName && !dagNo)) {
      return res.status(400).json({ error: 'BAD_INPUT', message: 'এলাকা ও অন্তত একটি অনুসন্ধান তথ্য (খতিয়ান নম্বর / মালিকের নাম / দাগ নম্বর) লাগবে।' });
    }
    const surveyId = String(body.survey_id == null ? 'all' : body.survey_id).trim().slice(0, 20) || 'all';
    const surveyKey = String(body.survey_key || '').trim().slice(0, 20);
    const idem = idemOf(body);
    if (await replayIfExists(req, res, idem)) return;
    const chk = await precheck(req, res);
    if (!chk) return;
    let result;
    try {
      result = await adapter.search({
        divisionBbs: area.divisionBbs, districtBbs: area.districtBbs, upazilaBbs: area.upazilaBbs,
        surveyId, surveyKey: surveyKey || undefined,
        jlId: area.jlId || undefined, mouzaId: area.mouzaId || undefined,
        khatianNo: khatianNo || undefined, ownerName: ownerName || undefined, dagNo: dagNo || undefined,
      });
    } catch (e) {
      if (e.code === 'BAD_AREA' || e.code === 'NO_SEARCH_CRITERION' ||
          e.code === 'JL_NOT_FOUND' || e.code === 'JL_REQUIRED' || e.code === 'SURVEY_NOT_OFFERED') {
        return res.status(400).json({ error: e.code, message: 'এলাকা, জরিপ বা মৌজা ঠিক নয় — ক্যাসকেড থেকে আবার বেছে নিন।' });
      }
      safeLog('[land-khatian] portal error:', e.code || '', e.message);
      return res.status(502).json({ error: 'LAND_UNREACHABLE', message: 'ভূমি পোর্টালে সংযোগ করা যাচ্ছে না — কিছুক্ষণ পর আবার চেষ্টা করুন।' });
    }
    if (!result.items.length) return notFound(req, res, chk, idem, area);
    return succeed(req, res, chk, idem, area, result);
  } catch (e) {
    safeLog('[land-khatian] search error:', e.message);
    res.status(500).json({ error: 'SEARCH_FAILED' });
  }
});

module.exports = router;
