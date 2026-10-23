// ============================================================
// All In One (Abc Authentic) - Land services (DLRMS) routes
// Mounted at /api/land (JWT auth + rate limit at mount).
//
// Three automated services, all reading the OFFICIAL land
// record through the portal's public guest channel (see
// engines/land-core/client.js — proven live 2026-10-23):
//
//   GET  /api/land/geo/*        realtime cascade for the form
//   GET  /api/land/price?mode=  price + balance for one mode
//   POST /api/land/search       by khatian number (engine land-search)
//   POST /api/land/scan         by owner name, whole mouza,
//                               all survey types (engine land-scan)
//   POST /api/land/verify       claim vs record report
//                               (engine land-verify)
//
// Money discipline (same as QR verify): the wallet is charged
// ONLY when a record is actually found; "not found" records a
// ৳0 failed order with a failure receipt. Every success stores
// a Bengali report PDF on the order → the customer's History.
// Idempotency: a repeated idempotency_key replays the stored
// outcome — never a second lookup charge.
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
const { buildLandReportPdf } = require('../lib/landReportPdf');
const client = require('../../engines/land-core/client');

const router = express.Router();
const UPLOAD_DIR = '/opt/all-in-one-abc-authentic/uploads/orders';

const MODES = {
  search: { engineId: 'land-search', label: 'খতিয়ান খোঁজ' },
  scan: { engineId: 'land-scan', label: 'নামে সম্পত্তি সন্ধান' },
  verify: { engineId: 'land-verify', label: 'জমি যাচাই রিপোর্ট' },
};

// ---------- pricing (per engine, same rules as qr-verify) ----------
async function getServicePrice(engineId, userId) {
  const r = await db.query(
    `SELECT id, price FROM services WHERE engine_id = $1 AND status = 'active' LIMIT 1`, [engineId]
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
    const mode = MODES[req.query.mode] ? req.query.mode : 'search';
    const { allowed, price, serviceId } = await getServicePrice(MODES[mode].engineId, req.user.id);
    const u = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    res.json({ ok: true, mode, allowed, price, serviceId, balance: u.rows[0] ? Number(u.rows[0].balance) : 0 });
  } catch (e) {
    safeLog('[land] price error:', e.message);
    res.status(500).json({ error: 'PRICE_CHECK_FAILED' });
  }
});

// ---------- geo cascade (realtime from DLRMS; short cache) ----------
const _geoCache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = _geoCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = await fn();
  _geoCache.set(key, { at: Date.now(), v });
  return v;
}
function geoFail(res, e) {
  safeLog('[land] geo error:', e.code || '', e.message);
  res.status(502).json({ error: 'LAND_UNREACHABLE', message: 'ভূমি পোর্টালে সংযোগ করা যাচ্ছে না — কিছুক্ষণ পর আবার চেষ্টা করুন।' });
}

router.get('/geo/divisions', requireAuth, async (req, res) => {
  try {
    const rows = await cached('div', 10 * 60 * 1000, () => client.divisions());
    res.json({ ok: true, items: rows.map((d) => ({ bbs: d.BBS_CODE, name: d.NAME })) });
  } catch (e) { geoFail(res, e); }
});
router.get('/geo/districts', requireAuth, async (req, res) => {
  try {
    const div = String(req.query.division || '');
    if (!/^\d+$/.test(div)) return res.status(400).json({ error: 'BAD_DIVISION' });
    const rows = await cached('dist:' + div, 10 * 60 * 1000, () => client.districts(div));
    res.json({ ok: true, items: rows.map((d) => ({ bbs: d.BBS_CODE, name: d.NAME })) });
  } catch (e) { geoFail(res, e); }
});
router.get('/geo/upazilas', requireAuth, async (req, res) => {
  try {
    const dist = String(req.query.district || '');
    if (!/^\d+$/.test(dist)) return res.status(400).json({ error: 'BAD_DISTRICT' });
    const rows = await cached('upz:' + dist, 10 * 60 * 1000, () => client.upazilas(dist));
    res.json({ ok: true, items: rows.map((d) => ({ bbs: d.BBS_CODE, name: d.NAME })) });
  } catch (e) { geoFail(res, e); }
});
// Surveys actually offered in this upazila, merged with the
// master survey list (for the KEY the index endpoint needs).
async function offeredSurveys(districtBbs, upazilaBbs) {
  const [offered, all] = await Promise.all([
    cached('usv:' + districtBbs + ':' + upazilaBbs, 10 * 60 * 1000,
      () => client.upazilaSurveys(districtBbs, upazilaBbs)),
    cached('surveys', 60 * 60 * 1000, () => client.surveys()),
  ]);
  const keyById = new Map(all.map((s) => [Number(s.ID), s.KEY]));
  return offered
    .map((o) => ({ id: Number(o.SURVEY_ID), key: keyById.get(Number(o.SURVEY_ID)), name: o.LOCAL_NAME }))
    .filter((s) => s.key);
}
router.get('/geo/surveys', requireAuth, async (req, res) => {
  try {
    const dist = String(req.query.district || ''); const upz = String(req.query.upazila || '');
    if (!/^\d+$/.test(dist) || !/^\d+$/.test(upz)) return res.status(400).json({ error: 'BAD_AREA' });
    res.json({ ok: true, items: await offeredSurveys(dist, upz) });
  } catch (e) { geoFail(res, e); }
});
router.get('/geo/mouzas', requireAuth, async (req, res) => {
  try {
    const dist = String(req.query.district || ''); const upz = String(req.query.upazila || '');
    const surveyId = String(req.query.survey_id || '');
    if (!/^\d+$/.test(dist) || !/^\d+$/.test(upz) || !/^\d+$/.test(surveyId)) {
      return res.status(400).json({ error: 'BAD_AREA' });
    }
    const rows = await cached('jl:' + dist + ':' + upz + ':' + surveyId, 10 * 60 * 1000,
      () => client.jlNumbers(dist, upz, surveyId));
    res.json({
      ok: true,
      items: rows.map((j) => ({ jl_id: j.ID, mouza_id: j.MOUZA_ID, name: j.MOUZA_NAME, jl: j.JL_NUMBER })),
    });
  } catch (e) { geoFail(res, e); }
});

// ---------- shared lookup helpers ----------
/** JL entry (for one mouza in one survey) — realtime, cached briefly. */
async function jlEntry(districtBbs, upazilaBbs, surveyId, mouzaId) {
  const rows = await cached('jl:' + districtBbs + ':' + upazilaBbs + ':' + surveyId, 10 * 60 * 1000,
    () => client.jlNumbers(districtBbs, upazilaBbs, surveyId));
  return rows.find((j) => Number(j.MOUZA_ID) === Number(mouzaId)) || null;
}

/** Bengali digits → Latin. Customers naturally type ৮ — the
 *  portal's records are keyed with Latin digits ('8'), so an
 *  un-normalised Bengali number would silently find nothing. */
const BN_DIGIT_MAP = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
const toEn = (s) => String(s == null ? '' : s).replace(/[০-৯]/g, (d) => BN_DIGIT_MAP[d]);

function cleanArea(body) {
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const area = {
    divisionBbs: s(body.division_bbs, 10),
    districtBbs: s(body.district_bbs, 10),
    upazilaBbs: s(body.upazila_bbs, 10),
    mouzaId: s(body.mouza_id, 12),
    division: s(body.division_name, 60),
    district: s(body.district_name, 60),
    upazila: s(body.upazila_name, 60),
    mouza: s(body.mouza_name, 60),
    jl: s(body.jl_no, 12),
  };
  if (!/^\d+$/.test(area.divisionBbs) || !/^\d+$/.test(area.districtBbs) ||
      !/^\d+$/.test(area.upazilaBbs) || !/^\d+$/.test(area.mouzaId)) return null;
  return area;
}

/** Find one khatian (by number) across every survey offered in the upazila. */
async function findKhatian(area, khatianNo) {
  const surveys = await offeredSurveys(area.districtBbs, area.upazilaBbs);
  for (const sv of surveys) {
    const jl = await jlEntry(area.districtBbs, area.upazilaBbs, sv.id, area.mouzaId);
    if (!jl) continue;
    const hits = await client.indexByKhatianNo(sv.key, jl.ID, khatianNo);
    if (hits && hits.length) {
      const det = await client.detail(sv.key, hits[0].ID);
      det._surveyKey = sv.key; det._surveyName = sv.name; det._jlId = jl.ID;
      return det;
    }
  }
  return null;
}

// ---------- money + order plumbing (qr-verify discipline) ----------
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
      verdicts: data.verdicts || null,
    });
  }
  return true;
}

async function precheck(req, res, mode) {
  const { allowed, price, serviceId } = await getServicePrice(MODES[mode].engineId, req.user.id);
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

async function chargeOnce(req, mode, price, serviceId, idem) {
  if (price <= 0) return;
  const ref = 'land-' + mode + '-' + idem;
  const alreadyPaid = await db.query(
    `SELECT 1 FROM transactions WHERE user_id = $1 AND trxid IN ($2, $3) AND status = 'approved' LIMIT 1`,
    [req.user.id, ref, ref + ':svc']
  );
  if (alreadyPaid.rows.length) return;
  await db.withTransaction((clientTx) => serviceCredits.payForService(clientTx, {
    userId: req.user.id, serviceId, amount: Math.abs(price), ref,
  }));
}

async function recordOrder(req, mode, serviceId, status, price, idem, data) {
  const ins = await db.query(
    `INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [req.user.id, serviceId, status, JSON.stringify(data), price, idem]
  ).catch((e) => { safeLog('[land] order insert error:', e.message); return null; });
  if (ins && ins.rows.length) return ins.rows[0].id;
  const again = await db.query(
    'SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2', [req.user.id, idem]
  ).catch(() => null);
  return again && again.rows.length ? again.rows[0].id : null;
}

function notifyDone(req, mode, price, failed) {
  const label = MODES[mode].label;
  if (failed) {
    wa.notifyServiceFailed(db, req.user.id, label, 'সরকারি রেকর্ডে কোনো তথ্য পাওয়া যায়নি',
      'এলাকা ও তথ্য আবার যাচাই করে চেষ্টা করুন। সহায়তা লাগলে সাপোর্টে যোগাযোগ করুন।').catch(() => {});
    push.notifyUser(db, req.user.id, '❌ ' + label,
      'কোনো রেকর্ড পাওয়া যায়নি — কোনো টাকা কাটা হয়নি। ব্যর্থতার রসিদটি ইতিহাসে পাবেন।', '/history.html').catch(() => {});
    push.notifyAdmins(db, '❌ ' + label, 'একটি ভূমি সেবায় কোনো রেকর্ড পাওয়া যায়নি — চার্জ ৳০।', '/admin.html').catch(() => {});
  } else {
    wa.notifyServiceCompleted(db, req.user.id, label).catch(() => {});
    push.notifyUser(db, req.user.id, '✅ ' + label,
      'আপনার রিপোর্ট তৈরি — ইতিহাসে (History) পাবেন।', '/history.html').catch(() => {});
    push.notifyAdmins(db, '✅ ' + label, `একটি ভূমি সেবা সম্পন্ন হয়েছে — চার্জ ৳${price}।`, '/admin.html').catch(() => {});
  }
}

const slug = (idem) => idem.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48);
const nowBn = () => new Date().toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' });

async function notFound(req, res, mode, chk, idem, area) {
  let orderId = null; let receiptUrl = null;
  if (chk.serviceId) {
    orderId = await recordOrder(req, mode, chk.serviceId, 'failed', 0, idem, { area, found: false });
    if (orderId) {
      notifyDone(req, mode, 0, true);
      try {
        const pdf = await buildReceiptPdf({
          noBrand: true,
          serviceLabel: MODES[mode].label, outcome: 'failed',
          reason: 'সরকারি ভূমি রেকর্ডে এই তথ্যে কোনো খতিয়ান পাওয়া যায়নি',
          subjectLabel: 'মৌজা', subjectValue: area.mouza || '—',
          chargeText: '৳০ — কোনো টাকা কাটা হয়নি', ref: idem, when: nowBn(),
          footers: ['তথ্য না পেলে কোনো চার্জ কাটা হয় না — এটি এই সেবার নিয়ম। এলাকা ও নম্বর যাচাই করে আবার চেষ্টা করুন।'],
        });
        receiptUrl = await storePdf(orderId, 'delivery-land-failed-' + slug(idem) + '.pdf', pdf, 'land-not-found-receipt.pdf');
      } catch (e) { safeLog('[land] failure receipt error:', e.message); }
    }
  }
  return res.status(422).json({
    error: 'NOT_FOUND', charged: 0, orderId, receipt: receiptUrl,
    message: 'কোনো রেকর্ড পাওয়া যায়নি — কোনো টাকা কাটা হয়নি।',
  });
}

async function succeed(req, res, mode, chk, idem, area, payload, pdfArgs, pdfName) {
  try {
    await chargeOnce(req, mode, chk.price, chk.serviceId, idem);
  } catch (e) {
    if (/INSUFFICIENT_BALANCE/.test(e.message)) {
      return res.status(402).json({ error: 'INSUFFICIENT_BALANCE', message: 'পর্যাপ্ত ব্যালেন্স নেই। অনুগ্রহ করে ওয়ালেট রিচার্জ করুন।' });
    }
    if (!/DUPLICATE_TRANSACTION/.test(e.message)) throw e;
  }
  let orderId = null; let receiptUrl = null;
  if (chk.serviceId) {
    orderId = await recordOrder(req, mode, chk.serviceId, 'completed', chk.price, idem, { area, found: true, ...payload });
    if (orderId) {
      notifyDone(req, mode, chk.price, false);
      try {
        const pdf = await buildLandReportPdf({ ...pdfArgs, ref: idem, when: nowBn() });
        receiptUrl = await storePdf(orderId, pdfName, pdf, pdfName);
      } catch (e) { safeLog('[land] report pdf error:', e.message); }
    }
  }
  const u2 = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
  return res.json({
    ok: true, charged: chk.price, orderId, receipt: receiptUrl,
    balance: u2.rows[0] ? Number(u2.rows[0].balance) : null,
    records: payload.records || [], totalLand: payload.totalLand || null, verdicts: payload.verdicts || null,
  });
}

function idemOf(body, mode) {
  let idem = String((body && body.idempotency_key) || '').trim().slice(0, 80);
  if (!idem) idem = 'land-' + mode + '-' + crypto.randomUUID();
  return idem;
}

// ---------- POST /search ----------
router.post('/search', requireAuth, async (req, res) => {
  try {
    const area = cleanArea(req.body || {});
    const khatianNo = toEn(String((req.body || {}).khatian_no || '').trim().slice(0, 20));
    if (!area || !khatianNo) {
      return res.status(400).json({ error: 'BAD_INPUT', message: 'এলাকা ও খতিয়ান নম্বর — দুটোই লাগবে।' });
    }
    const idem = idemOf(req.body, 'search');
    if (await replayIfExists(req, res, idem)) return;
    const chk = await precheck(req, res, 'search');
    if (!chk) return;
    let det = null;
    try { det = await findKhatian(area, khatianNo); } catch (e) { return geoFail(res, e); }
    if (!det) return notFound(req, res, 'search', chk, idem, area);
    const record = {
      KHATIAN_NO: det.KHATIAN_NO, OWNERS: det.OWNERS, DAGS: det.DAGS,
      TOTAL_LAND: det.TOTAL_LAND, _surveyName: det._surveyName,
    };
    return succeed(req, res, 'search', chk, idem, area,
      { records: [record] },
      { kind: 'search', area: { ...area }, records: [record] },
      'delivery-land-search-' + slug(idem) + '.pdf');
  } catch (e) {
    safeLog('[land] search error:', e.message);
    res.status(500).json({ error: 'SEARCH_FAILED' });
  }
});

// ---------- POST /scan ----------
const SCAN_DETAIL_CAP = 60;
router.post('/scan', requireAuth, async (req, res) => {
  try {
    const area = cleanArea(req.body || {});
    const name = String((req.body || {}).owner_name || '').trim().slice(0, 80);
    if (!area || !name) {
      return res.status(400).json({ error: 'BAD_INPUT', message: 'এলাকা ও মালিকের নাম — দুটোই লাগবে।' });
    }
    const idem = idemOf(req.body, 'scan');
    if (await replayIfExists(req, res, idem)) return;
    const chk = await precheck(req, res, 'scan');
    if (!chk) return;
    let records = [];
    try {
      const surveys = await offeredSurveys(area.districtBbs, area.upazilaBbs);
      for (const sv of surveys) {
        const jl = await jlEntry(area.districtBbs, area.upazilaBbs, sv.id, area.mouzaId);
        if (!jl) continue;
        const list = await client.indexList(sv.key, jl.ID);
        const hits = (list || []).filter((r) => client.ownerMatches(r.OWNERS, name));
        for (const hit of hits.slice(0, SCAN_DETAIL_CAP)) {
          const det = await client.detail(sv.key, hit.ID);
          records.push({
            KHATIAN_NO: det.KHATIAN_NO, OWNERS: det.OWNERS, DAGS: det.DAGS,
            TOTAL_LAND: det.TOTAL_LAND, _surveyName: sv.name,
          });
          if (records.length >= SCAN_DETAIL_CAP) break;
        }
        if (records.length >= SCAN_DETAIL_CAP) break;
      }
    } catch (e) { return geoFail(res, e); }
    if (!records.length) return notFound(req, res, 'scan', chk, idem, area);
    const totalLand = client.sumLand(records);
    return succeed(req, res, 'scan', chk, idem, area,
      { records, totalLand },
      { kind: 'scan', area: { ...area }, records, totalLand },
      'delivery-land-scan-' + slug(idem) + '.pdf');
  } catch (e) {
    safeLog('[land] scan error:', e.message);
    res.status(500).json({ error: 'SCAN_FAILED' });
  }
});

// ---------- POST /verify ----------
router.post('/verify', requireAuth, async (req, res) => {
  try {
    const area = cleanArea(req.body || {});
    const khatianNo = toEn(String((req.body || {}).khatian_no || '').trim().slice(0, 20));
    const claim = (req.body || {}).claim || {};
    const cOwner = String(claim.owner || '').trim().slice(0, 80);
    const cDag = toEn(String(claim.dag || '').trim().slice(0, 20));
    const cLand = toEn(String(claim.total_land || '').trim().slice(0, 20));
    // Address + khatian number is the whole requirement (owner,
    // 2026-10-23): the claim comparison is optional — no claim
    // simply means the report carries the record alone.
    if (!area || !khatianNo) {
      return res.status(400).json({ error: 'BAD_INPUT', message: 'ঠিকানা ও খতিয়ান নম্বর লাগবে।' });
    }
    const idem = idemOf(req.body, 'verify');
    if (await replayIfExists(req, res, idem)) return;
    const chk = await precheck(req, res, 'verify');
    if (!chk) return;
    let det = null;
    try { det = await findKhatian(area, khatianNo); } catch (e) { return geoFail(res, e); }
    if (!det) return notFound(req, res, 'verify', chk, idem, area);
    const verdicts = [];
    if (cOwner) {
      verdicts.push({ label: 'মালিকের নাম', claim: cOwner, record: det.OWNERS || '—', match: client.ownerMatches(det.OWNERS, cOwner) });
    }
    if (cDag) {
      const dags = String(det.DAGS || '').split(',').map((s) => s.trim().replace('...', ''));
      verdicts.push({ label: 'দাগ নম্বর', claim: cDag, record: det.DAGS || '—', match: dags.includes(cDag) });
    }
    if (cLand) {
      const want = parseFloat(cLand); const got = parseFloat(det.TOTAL_LAND);
      verdicts.push({
        label: 'জমির পরিমাণ (একর)', claim: cLand, record: det.TOTAL_LAND || '—',
        match: Number.isFinite(want) && Number.isFinite(got) && Math.abs(want - got) < 0.001,
      });
    }
    const record = {
      KHATIAN_NO: det.KHATIAN_NO, OWNERS: det.OWNERS, DAGS: det.DAGS,
      TOTAL_LAND: det.TOTAL_LAND, _surveyName: det._surveyName,
    };
    const matched = verdicts.filter((v) => v.match).length;
    return succeed(req, res, 'verify', chk, idem, area,
      { records: [record], verdicts },
      {
        kind: 'verify', area: { ...area }, records: [record], verdicts,
        claimNote: verdicts.length
          ? 'মোট ' + verdicts.length + 'টি দাবির মধ্যে ' + matched + 'টি সরকারি রেকর্ডের সঙ্গে মিলেছে।'
          : 'কোনো দাবি দেওয়া হয়নি — এই রিপোর্টে সরকারি রেকর্ডের পূর্ণ বিবরণ দেওয়া হলো।',
      },
      'delivery-land-verify-' + slug(idem) + '.pdf');
  } catch (e) {
    safeLog('[land] verify error:', e.message);
    res.status(500).json({ error: 'VERIFY_FAILED' });
  }
});

module.exports = router;
