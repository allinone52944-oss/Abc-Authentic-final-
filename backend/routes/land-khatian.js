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
const { requireAuth, requireAdmin } = require('../auth');
const { safeLog, safeJsonArray } = require('../security');
const db = require('../db');
const serviceCredits = require('../lib/serviceCredits');
const wa = require('../utils/whatsapp');
const push = require('../utils/push');
const { buildReceiptPdf } = require('../lib/receiptPdf');
const { buildKhatianSummaryPdf } = require('../lib/khatianSummaryPdf');
const { getStoreClient } = require('../lib/khatianStore');
const adapter = require('../../engines/land-khatian/adapter');
const client = require('../../engines/land-core/client');

// ---------- collection store: resolution order ----------
// (full design: engines/land-khatian/STORE.md)
//   1. Live DLRMS is PRIMARY and always tried first.
//   2. A live SUCCESS — even 0 items — is truth: the store
//      is never consulted, never served.
//   3. ONLY a live failure (the 502 path below) may consult
//      the store. A store hit flows through succeed() with
//      source 'store' + stale flags, charged exactly like a
//      normal found result (see STORE.md for that decision —
//      Pankaj may overrule it to free).
//   4. Store empty for the mouza → 502 + storeEmpty, an
//      honest "live unreachable AND nothing stored yet",
//      never a definitive not-found.
//   5. Store itself unreachable → 502 as before.
// Store writes after a live success are best-effort and
// must NEVER break the search, charge, or PDF.

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
      source: data.source || 'live', stale: data.source === 'store',
      collectedAt: data.collectedAt || null,
      surveysPresent: data.surveysPresent || null,
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

async function succeed(req, res, chk, idem, area, result, meta) {
  const source = (meta && meta.source) || 'live';
  const collectedAt = (meta && meta.collectedAt) || null;
  // Store-hit honesty: the survey keys actually present in
  // the stored records for this JL — never imply uncollected
  // surveys are covered.
  const surveysPresent = (meta && meta.surveysPresent) || null;
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
    source, collectedAt, surveysPresent,
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
          source, collectedAt,
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
    source, stale: source === 'store', collectedAt, surveysPresent,
  });
}

// ---------- collection store: index writes ----------
// Unit = one (jl_id × survey_key). Status rules (STORE.md):
// 'complete' ONLY when collected == expected AND zero
// failed details AND zero unparseable records; anything
// else → 'partial' with issues kept OPEN. A single stored
// record proves loading works, never completeness.
// collected_count ALWAYS equals the store's countForUnit
// for the unit — never a running increment.
const ISSUE_CAP = 200;
function capIssues(issues) {
  const list = issues || [];
  if (list.length <= ISSUE_CAP) return list;
  return [...list.slice(0, ISSUE_CAP),
    { truncated: true, totalIssues: list.length, note: 'issues truncated at ' + ISSUE_CAP + ' entries' }];
}

// Import write: full reconciliation row (status + issues
// are written by the importer, which owns completeness).
async function indexUpsert(area, unit) {
  await db.query(
    `INSERT INTO land_khatian_index
       (division_bbs, district_bbs, upazila_bbs, division_name, district_name, upazila_name,
        mouza_id, mouza_name, jl_number, jl_id, survey_key, survey_name,
        record_count, expected_count, collected_count, status, issues,
        source, first_collected_at, last_collected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'dlrms',NOW(),NOW())
     ON CONFLICT (jl_id, survey_key, source) DO UPDATE SET
       record_count = EXCLUDED.record_count,
       expected_count = EXCLUDED.expected_count,
       collected_count = EXCLUDED.collected_count,
       status = EXCLUDED.status, issues = EXCLUDED.issues,
       last_collected_at = EXCLUDED.last_collected_at,
       division_name = EXCLUDED.division_name, district_name = EXCLUDED.district_name,
       upazila_name = EXCLUDED.upazila_name, mouza_name = EXCLUDED.mouza_name,
       updated_at = NOW()`,
    [area.divisionBbs, area.districtBbs, area.upazilaBbs, area.division, area.district, area.upazila,
     area.mouzaId || String(unit.mouzaId || ''), area.mouza, area.jl || String(unit.jlNumber || ''),
     String(unit.jlId), unit.surveyKey, unit.surveyName, unit.collected,
     unit.expected, unit.collected, unit.status, JSON.stringify(unit.issues || [])]
  );
}

// Live-search write: refresh counts/dates ONLY. It NEVER
// sets a unit 'complete' and NEVER downgrades a 'complete'
// unit to 'partial' — status, expected_count, and issues
// are untouched on conflict. A brand-new row (live search
// only, full import never run) starts 'partial' with an
// issue saying exactly that, so it is never mistaken for
// a verified-complete unit.
async function indexUpsertLive(area, group, storedCount) {
  const liveIssue = JSON.stringify([
    { reason: 'LIVE_SEARCH_ONLY', note: 'live-search collection only — full import not run; completeness unknown' },
  ]);
  await db.query(
    `INSERT INTO land_khatian_index
       (division_bbs, district_bbs, upazila_bbs, division_name, district_name, upazila_name,
        mouza_id, mouza_name, jl_number, jl_id, survey_key, survey_name,
        record_count, collected_count, status, issues,
        source, first_collected_at, last_collected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'partial',$15,'dlrms',NOW(),NOW())
     ON CONFLICT (jl_id, survey_key, source) DO UPDATE SET
       record_count = EXCLUDED.record_count,
       collected_count = EXCLUDED.collected_count,
       last_collected_at = EXCLUDED.last_collected_at,
       division_name = EXCLUDED.division_name, district_name = EXCLUDED.district_name,
       upazila_name = EXCLUDED.upazila_name, mouza_name = EXCLUDED.mouza_name,
       updated_at = NOW()`,
    [area.divisionBbs, area.districtBbs, area.upazilaBbs, area.division, area.district, area.upazila,
     area.mouzaId || String(group.mouzaId || ''), area.mouza, area.jl || String(group.jlNumber || ''),
     String(group.jlId), group.surveyKey, group.surveyName, storedCount, storedCount, liveIssue]
  );
}

// After a LIVE success only. MERGE, never replace: a live
// search returns only the searched records, and replacing
// the unit's stored set with that subset would destroy a
// previously imported full unit. Any failure here is logged
// and swallowed — it must never break the search, charge,
// or PDF.
async function collectLiveResult(area, result) {
  try {
    const store = getStoreClient();
    const groups = new Map();
    for (const item of result.items || []) {
      const key = String(item.jlId) + '::' + item.surveyKey;
      if (!groups.has(key)) {
        groups.set(key, { jlId: item.jlId, surveyKey: item.surveyKey, surveyName: item.surveyName, records: [] });
      }
      groups.get(key).records.push(item);
    }
    for (const group of groups.values()) {
      try {
        // merge: true → the store merges by record id, so
        // this live subset never destroys a previously
        // imported full unit — and the live path never
        // CALLS store.search: a live success never consults
        // the store for its answer.
        const up = await store.upsert({
          area, surveyKey: group.surveyKey, surveyName: group.surveyName,
          jlId: group.jlId, mouzaId: area.mouzaId, jlNumber: area.jl,
          records: group.records, source: 'dlrms', merge: true,
        });
        const storedCount = up && up.total != null ? up.total : group.records.length;
        await indexUpsertLive(area, group, storedCount);
      } catch (e) { safeLog('[land-khatian] live collect failed:', e.message); }
    }
  } catch (e) { safeLog('[land-khatian] collect failed:', e.message); }
}

// ---------- coverage ----------
// Percent definition, used EVERYWHERE (admin + public):
//   percentComplete = completeUnits / totalUnits * 100.
// Partial units are shown separately and NEVER counted as
// complete. The denominator (totalUnits) is ALWAYS the
// portal's own lists (offered surveys × jlNumbers, distinct
// mouza per survey — the portal presents one JL per mouza
// per survey), never invented. If any portal call fails,
// totalUnits/percent are null (unavailable) and only the
// index counts are reported. No timeline is estimated
// anywhere: the method is to measure the first district
// batch's actual rate (mouzas/hour, records/sec) and
// extrapolate from that measurement — see STORE.md.
const COVERAGE_NOTE = 'সংগৃহীত তথ্য শুধু যা ইতিমধ্যে সংগ্রহ হয়েছে তাই — উৎস বন্ধ থাকলে শুধু সংগৃহীত এলাকাই চলবে; সব-বাংলাদেশ অফলাইন সেবা সংগ্রহ শেষ হলেই সম্ভব, প্রথম দিনের নিশ্চয়তা নয়।';
const LAUNCH_GATE_NOTE = 'সংরক্ষিত (অফলাইন) সেবা এখনো সংগ্রহের পর্যায়ে — পূর্ণ কভারেজ (১০০%) না হলে, অথবা জেলার সুস্পষ্ট তালিকা প্রকাশ না করে, একে সারা-বাংলাদেশ সেবা হিসেবে বাজারজাত/বিক্রি করা যাবে না।';
const OPEN_UNITS_CAP = 100;

async function portalTotalPairs(districtBbs, upazilaBbs) {
  if (upazilaBbs) {
    const offered = await adapter.offeredSurveys(districtBbs, upazilaBbs);
    let total = 0;
    for (const sv of offered) {
      const rows = await client.jlNumbers(districtBbs, upazilaBbs, sv.id);
      total += new Set((rows || []).map((r) => r.MOUZA_ID)).size;
    }
    return total;
  }
  const ups = await client.upazilas(districtBbs);
  let total = 0;
  for (const u of ups || []) {
    const ub = u.UPAZILA_BBS_CODE || u.bbs;
    if (!ub) continue;
    total += await portalTotalPairs(districtBbs, String(ub));
  }
  return total;
}

async function indexRowsForScope(districtBbs, upazilaBbs) {
  const params = upazilaBbs ? [districtBbs, upazilaBbs] : [districtBbs];
  const where = upazilaBbs ? 'district_bbs = $1 AND upazila_bbs = $2' : 'district_bbs = $1';
  const r = await db.query(
    `SELECT division_bbs, district_bbs, upazila_bbs, division_name, district_name, upazila_name,
            mouza_id, mouza_name, jl_number, jl_id, survey_key, survey_name,
            record_count, expected_count, collected_count, status, issues,
            first_collected_at, last_collected_at
     FROM land_khatian_index WHERE ${where}
     ORDER BY upazila_name, mouza_name, survey_key`,
    params
  );
  return r.rows || [];
}

function toOpenUnit(row) {
  let issues = [];
  try { issues = typeof row.issues === 'string' ? JSON.parse(row.issues) : (row.issues || []); } catch { issues = []; }
  return {
    mouzaId: row.mouza_id, mouzaName: row.mouza_name, jlNumber: row.jl_number, jlId: row.jl_id,
    surveyKey: row.survey_key, surveyName: row.survey_name,
    expectedCount: row.expected_count, collectedCount: row.collected_count,
    status: row.status, issues,
  };
}

async function coverageForScope(districtBbs, upazilaBbs) {
  const rows = await indexRowsForScope(districtBbs, upazilaBbs);
  const completeUnits = rows.filter((r) => r.status === 'complete').length;
  const partialUnits = rows.filter((r) => r.status !== 'complete').length;
  const partialRows = rows.filter((r) => r.status !== 'complete');
  let totalUnits = null;
  try { totalUnits = await portalTotalPairs(districtBbs, upazilaBbs || null); }
  catch (e) { safeLog('[land-khatian] coverage portal walk failed:', e.message); totalUnits = null; }
  const coverageAvailable = totalUnits !== null && totalUnits > 0;
  return {
    totalUnits, completeUnits, partialUnits,
    notStartedUnits: coverageAvailable ? Math.max(0, totalUnits - completeUnits - partialUnits) : null,
    percentComplete: coverageAvailable ? Math.round((completeUnits / totalUnits) * 1000) / 10 : null,
    coverageAvailable,
    importedPairs: completeUnits + partialUnits, totalPairs: totalUnits,
    openUnits: partialRows.slice(0, OPEN_UNITS_CAP).map(toOpenUnit),
    openUnitsTotal: partialRows.length, openUnitsTruncated: partialRows.length > OPEN_UNITS_CAP,
  };
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
      // Live failed — ONLY now may the store be consulted.
      try {
        const store = getStoreClient();
        const found = await store.search({
          jlId: area.jlId || undefined, mouzaId: area.mouzaId || undefined,
          surveyKey: surveyKey || 'all',
          khatianNo: khatianNo || undefined, ownerName: ownerName || undefined, dagNo: dagNo || undefined,
        });
        if (found.records && found.records.length) {
          const surveysTried = [...new Set(found.records.map((r) => r.surveyKey).filter(Boolean))];
          return succeed(req, res, chk, idem, area, {
            items: found.records, totalMatches: found.totalMatches,
            totalCandidates: found.totalMatches, capped: false,
            surveysTried, mutationAttempted: false, mutationUnsupported: false,
          }, { source: 'store', collectedAt: found.collectedAt || null, surveysPresent: surveysTried });
        }
        if (!found.mouzaCollected) {
          return res.status(502).json({
            error: 'LAND_UNREACHABLE', storeEmpty: true,
            message: 'লাইভ পোর্টালে সংযোগ করা যাচ্ছে না এবং এই মৌজার কোনো সংরক্ষিত তথ্যও এখনো নেই — কিছুক্ষণ পর আবার চেষ্টা করুন।',
          });
        }
        // Stored data exists for the mouza but this query
        // matched nothing: still a 502, never a definitive
        // not-found from partial stored data, and no charge.
        return res.status(502).json({
          error: 'LAND_UNREACHABLE', storeEmpty: false,
          message: 'লাইভ পোর্টালে সংযোগ করা যাচ্ছে না এবং সংরক্ষিত তথ্যে এই অনুসন্ধানের কোনো মিল পাওয়া যায়নি — কিছুক্ষণ পর আবার চেষ্টা করুন।',
        });
      } catch (se) {
        safeLog('[land-khatian] store fallback failed:', se.message);
        return res.status(502).json({ error: 'LAND_UNREACHABLE', message: 'ভূমি পোর্টালে সংযোগ করা যাচ্ছে না — কিছুক্ষণ পর আবার চেষ্টা করুন।' });
      }
    }
    if (!result.items.length) return notFound(req, res, chk, idem, area);
    // Live success is truth: collect it best-effort, then
    // deliver. A collect failure never breaks the delivery.
    await collectLiveResult(area, result);
    return succeed(req, res, chk, idem, area, result, { source: 'live' });
  } catch (e) {
    safeLog('[land-khatian] search error:', e.message);
    res.status(500).json({ error: 'SEARCH_FAILED' });
  }
});

// ---------- admin: batch import + coverage ----------
// Admin-only (requireAuth + requireAdmin, mirroring the
// admin router's guard). No whole-country scope exists:
// an import call covers ONE upazila, ONE survey per call,
// up to 5 mouzas (or 3000 records — a mouza already in
// progress always finishes whole; the cap stops STARTING
// new mouzas). District-wide import = repeated upazila
// calls; continuation is via nextCursor (opaque base64url
// JSON {s: surveyIndex, m: mouzaOffset} within the
// portal's offered-survey list). Per-mouza failures are
// counted in failedMouzas and never abort the call.
// Mouzas with no JL entry in the survey are skipped
// (neither imported nor failed) and the cursor advances
// past them.
const IMPORT_MOUZA_CAP = 5;
const IMPORT_RECORD_CAP = 3000;

function encodeCursor(c) {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}
function decodeCursor(raw) {
  if (!raw) return { s: 0, m: 0 };
  const c = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  if (!Number.isInteger(c.s) || !Number.isInteger(c.m) || c.s < 0 || c.m < 0) throw new Error('BAD_CURSOR');
  return c;
}

router.post('/admin/import', requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const divisionBbs = toEn(String(body.division_bbs || '').trim());
    const districtBbs = toEn(String(body.district_bbs || '').trim());
    const upazilaBbs = toEn(String(body.upazila_bbs || '').trim());
    if (!/^\d+$/.test(divisionBbs) || !/^\d+$/.test(districtBbs) || !/^\d+$/.test(upazilaBbs)) {
      return res.status(400).json({ error: 'BAD_INPUT', message: 'বিভাগ, জেলা ও উপজেলা (BBS কোড) লাগবে — পুরো দেশের স্কোপ নেই।' });
    }
    const surveyIdRaw = String(body.survey_id == null ? 'all' : body.survey_id).trim() || 'all';
    if (surveyIdRaw !== 'all' && !/^\d+$/.test(surveyIdRaw)) {
      return res.status(400).json({ error: 'BAD_INPUT', message: 'survey_id হতে হবে একটি জরিপ আইডি বা "all"।' });
    }
    let cursor;
    try { cursor = decodeCursor(body.cursor); }
    catch (_) { return res.status(400).json({ error: 'BAD_CURSOR', message: 'কার্সর ঠিক নয় — নতুন করে শুরু করুন।' }); }
    let offered;
    try { offered = await adapter.offeredSurveys(districtBbs, upazilaBbs); }
    catch (e) {
      safeLog('[land-khatian] import portal error:', e.message);
      return res.status(502).json({ error: 'LAND_UNREACHABLE', message: 'ভূমি পোর্টালে সংযোগ করা যাচ্ছে না — কিছুক্ষণ পর আবার চেষ্টা করুন।' });
    }
    if (!offered || !offered.length) {
      return res.status(400).json({ error: 'SURVEY_NOT_OFFERED', message: 'এই উপজেলায় কোনো জরিপ দেওয়া হয় না।' });
    }
    let surveys;
    if (surveyIdRaw !== 'all') {
      const one = offered.find((s) => s.id === Number(surveyIdRaw));
      if (!one) return res.status(400).json({ error: 'SURVEY_NOT_OFFERED', message: 'ওই জরিপ এই উপজেলায় দেওয়া হয় না।' });
      if (cursor.s !== 0) return res.status(400).json({ error: 'BAD_CURSOR', message: 'একক জরিপের কার্সরে survey index 0 হতে হবে।' });
      surveys = [one];
    } else {
      surveys = offered;
    }
    if (cursor.s >= surveys.length) {
      return res.json({
        ok: true, done: true, importedMouzas: 0, totalMouzasInScope: 0,
        recordsUpserted: 0, failedMouzas: [], skippedMouzas: [], nextCursor: null,
        batchStatus: 'complete', batch: emptyBatch(), reconciliation: [],
        dataset: await datasetTotals(districtBbs, upazilaBbs),
        coverage: { upazila: await coverageForScope(districtBbs, upazilaBbs), district: await coverageForScope(districtBbs, null) },
        coverageNote: COVERAGE_NOTE, launchGateNote: LAUNCH_GATE_NOTE,
      });
    }
    const sv = surveys[cursor.s];
    const singleMouza = !!(body.mouza_id || body.jl_id);
    let mouzaList;
    if (singleMouza) {
      mouzaList = [{ mouzaId: body.mouza_id || null, jlId: body.jl_id || null }];
    } else {
      let jlRows;
      try { jlRows = await client.jlNumbers(districtBbs, upazilaBbs, sv.id); }
      catch (e) {
        safeLog('[land-khatian] import jl error:', e.message);
        return res.status(502).json({ error: 'LAND_UNREACHABLE', message: 'ভূমি পোর্টালে সংযোগ করা যাচ্ছে না — কিছুক্ষণ পর আবার চেষ্টা করুন।' });
      }
      const seen = new Set();
      mouzaList = [];
      for (const r of jlRows || []) {
        if (seen.has(r.MOUZA_ID)) continue;
        seen.add(r.MOUZA_ID);
        mouzaList.push({ mouzaId: r.MOUZA_ID, jlId: r.ID, jlNumber: r.JL_NUMBER, mouzaName: r.MOUZA_NAME });
      }
    }
    const totalMouzasInScope = mouzaList.length;
    const start = singleMouza ? 0 : cursor.m;
    const batch = singleMouza ? mouzaList : mouzaList.slice(start, start + IMPORT_MOUZA_CAP);
    const store = getStoreClient();
    let importedMouzas = 0; let recordsUpserted = 0; let attempted = 0;
    let completed = 0; let partial = 0; let failed = 0; let skipped = 0;
    let khatiansExpected = 0; let khatiansCollected = 0; let dagsCollected = 0;
    const failedMouzas = []; const skippedMouzas = []; const reconciliation = [];
    const areaNames = {
      division: String(body.division_name || '').trim().slice(0, 60),
      district: String(body.district_name || '').trim().slice(0, 60),
      upazila: String(body.upazila_name || '').trim().slice(0, 60),
    };
    for (const mz of batch) {
      if (!singleMouza && recordsUpserted >= IMPORT_RECORD_CAP) break;
      attempted += 1;
      const mzId = mz.mouzaId != null ? String(mz.mouzaId) : null;
      const mzJl = mz.jlId != null ? String(mz.jlId) : null;
      try {
        const imp = await adapter.importMouza({
          divisionBbs, districtBbs, upazilaBbs, surveyId: sv.id, jlId: mz.jlId, mouzaId: mz.mouzaId,
        });
        if (!imp.jlId) {
          skipped += 1;
          skippedMouzas.push(mzId);
          reconciliation.push({ mouzaId: mzId, jlId: mzJl, surveyKey: sv.key, expected: null, collected: 0, status: 'skipped', dagsCollected: 0, issues: [{ reason: 'NO_JL_ENTRY' }] });
          continue;
        }
        const area = {
          divisionBbs, districtBbs, upazilaBbs,
          mouzaId: String(imp.mouzaId != null ? imp.mouzaId : (mz.mouzaId || '')),
          division: areaNames.division, district: areaNames.district, upazila: areaNames.upazila,
          mouza: mz.mouzaName || '', jl: imp.jlNumber != null ? String(imp.jlNumber) : '',
        };
        // Dag reconciliation (collected details only — the
        // index carries no dag count, so no expected dag
        // total exists; an unparseable DAGS string flags the
        // record and forces partial, never a guessed count).
        const dagIssues = [];
        let unitDags = 0;
        for (const rec of imp.records) {
          const dc = adapter.countDags(rec.dags);
          if (dc.unparseable) dagIssues.push({ khatianNo: rec.khatianNo, indexId: rec.id, reason: 'DAGS_UNPARSEABLE' });
          else unitDags += dc.count;
        }
        // Merge-prune against the store: keep previously
        // stored rows still in this run's index (a transient
        // detail failure must not delete good data), overlay
        // this run's collected rows, prune rows the portal
        // no longer lists. A later re-run re-fetches the
        // fresh expected count and reopens on any gap.
        const indexIds = new Set((imp.indexItems || []).map((i) => String(i.id)));
        let existing = [];
        try {
          const prev = await store.search({ jlId: imp.jlId, surveyKey: imp.surveyKey });
          existing = prev.records || [];
        } catch (_) { existing = []; }
        const byId = new Map();
        for (const r of existing) if (indexIds.has(String(r.id))) byId.set(String(r.id), r);
        for (const r of imp.records) byId.set(String(r.id), r);
        const merged = [...byId.values()];
        await store.upsert({
          area, surveyKey: imp.surveyKey, surveyName: imp.surveyName,
          jlId: imp.jlId, mouzaId: imp.mouzaId, jlNumber: imp.jlNumber,
          records: merged, source: 'dlrms',
        });
        let storedCount = merged.length;
        try { storedCount = (await store.countForUnit({ jlId: imp.jlId, surveyKey: imp.surveyKey })).count; }
        catch (e) { safeLog('[land-khatian] countForUnit failed:', e.message); }
        const missing = (imp.indexItems || []).filter((i) => !byId.has(String(i.id)));
        const issues = capIssues([
          ...(imp.failedDetails || []).map((f) => ({ khatianNo: f.khatianNo, indexId: f.indexId, reason: f.reason })),
          ...missing.filter((m) => !(imp.failedDetails || []).some((f) => String(f.indexId) === String(m.id)))
            .map((m) => ({ khatianNo: m.khatianNo, indexId: m.id, reason: 'MISSING_AFTER_MERGE' })),
          ...dagIssues,
          ...(storedCount !== merged.length ? [{ reason: 'STORE_COUNT_MISMATCH', expected: merged.length, counted: storedCount }] : []),
        ]);
        const status = (imp.failedDetails || []).length === 0 && dagIssues.length === 0 &&
          missing.length === 0 && storedCount === imp.expected ? 'complete' : 'partial';
        await indexUpsert(area, {
          jlId: imp.jlId, surveyKey: imp.surveyKey, surveyName: imp.surveyName,
          mouzaId: imp.mouzaId, jlNumber: imp.jlNumber,
          expected: imp.expected, collected: storedCount, status, issues,
        });
        if (status === 'complete') completed += 1; else partial += 1;
        importedMouzas += 1;
        recordsUpserted += imp.records.length;
        khatiansExpected += imp.expected;
        khatiansCollected += imp.records.length;
        dagsCollected += unitDags;
        reconciliation.push({
          mouzaId: area.mouzaId, jlId: String(imp.jlId), jlNumber: imp.jlNumber != null ? String(imp.jlNumber) : null,
          mouzaName: mz.mouzaName || null, surveyKey: imp.surveyKey, surveyName: imp.surveyName,
          expected: imp.expected, collected: storedCount, status, dagsCollected: unitDags,
          failedDetails: imp.failedDetails || [], issues,
        });
      } catch (e) {
        failed += 1;
        failedMouzas.push({ mouzaId: mzId, jlId: mzJl, error: e.code || 'FAILED' });
        reconciliation.push({ mouzaId: mzId, jlId: mzJl, surveyKey: sv.key, expected: null, collected: 0, status: 'failed', dagsCollected: 0, issues: [{ reason: e.code || 'FAILED' }] });
      }
    }
    let nextCursor = null; let done = false;
    if (singleMouza) {
      done = true;
    } else {
      const nextM = start + attempted;
      if (nextM < mouzaList.length) nextCursor = encodeCursor({ s: cursor.s, m: nextM });
      else if (cursor.s + 1 < surveys.length) nextCursor = encodeCursor({ s: cursor.s + 1, m: 0 });
      else done = true;
    }
    // A batch that is partially complete stays flagged
    // partial — never reported as complete.
    const batchStatus = (attempted > 0 && failed === 0 && partial === 0 && skipped === 0 && completed === attempted)
      ? 'complete' : 'partial';
    const upazilaCoverage = await coverageForScope(districtBbs, upazilaBbs);
    return res.json({
      ok: true, done, importedMouzas, totalMouzasInScope,
      recordsUpserted, failedMouzas, skippedMouzas, nextCursor,
      surveyKey: sv.key, surveyName: sv.name,
      surveyIndex: cursor.s, totalSurveys: surveys.length,
      batchStatus,
      batch: {
        mouzasAttempted: attempted, mouzasCompleted: completed, mouzasPartial: partial,
        mouzasFailed: failed, mouzasSkipped: skipped,
        khatiansExpected, khatiansCollected, dagsCollected,
      },
      reconciliation,
      dataset: await datasetTotals(districtBbs, upazilaBbs),
      openUnits: upazilaCoverage.openUnits, openUnitsTotal: upazilaCoverage.openUnitsTotal,
      coverage: { upazila: upazilaCoverage, district: await coverageForScope(districtBbs, null) },
      coverageNote: COVERAGE_NOTE, launchGateNote: LAUNCH_GATE_NOTE,
    });
  } catch (e) {
    safeLog('[land-khatian] import error:', e.message);
    res.status(500).json({ error: 'IMPORT_FAILED' });
  }
});

// Dataset-level totals for one upazila scope (so per-unit
// errors that offset each other still surface: the batch
// report carries these beside the per-mouza lines).
async function datasetTotals(districtBbs, upazilaBbs) {
  const rows = await indexRowsForScope(districtBbs, upazilaBbs);
  let totalExpected = 0; let totalCollected = 0;
  for (const r of rows) {
    totalExpected += Number(r.expected_count) || 0;
    totalCollected += Number(r.collected_count) || 0;
  }
  return {
    totalUnits: rows.length,
    completeUnits: rows.filter((r) => r.status === 'complete').length,
    partialUnits: rows.filter((r) => r.status !== 'complete').length,
    totalExpected, totalCollected,
  };
}

function emptyBatch() {
  return {
    mouzasAttempted: 0, mouzasCompleted: 0, mouzasPartial: 0,
    mouzasFailed: 0, mouzasSkipped: 0,
    khatiansExpected: 0, khatiansCollected: 0, dagsCollected: 0,
  };
}

router.get('/admin/coverage', requireAuth, requireAdmin, async (req, res) => {
  try {
    const districtBbs = toEn(String(req.query.district_bbs || '').trim());
    const upazilaBbs = toEn(String(req.query.upazila_bbs || '').trim());
    if (!/^\d+$/.test(districtBbs) || (upazilaBbs && !/^\d+$/.test(upazilaBbs))) {
      return res.status(400).json({ error: 'BAD_INPUT', message: 'district_bbs লাগবে (upazila_bbs ঐচ্ছিক)।' });
    }
    const rows = (await indexRowsForScope(districtBbs, upazilaBbs || null)).map((row) => ({
      divisionBbs: row.division_bbs, districtBbs: row.district_bbs, upazilaBbs: row.upazila_bbs,
      divisionName: row.division_name, districtName: row.district_name, upazilaName: row.upazila_name,
      mouzaId: row.mouza_id, mouzaName: row.mouza_name, jlNumber: row.jl_number, jlId: row.jl_id,
      surveyKey: row.survey_key, surveyName: row.survey_name,
      recordCount: row.record_count, expectedCount: row.expected_count, collectedCount: row.collected_count,
      status: row.status, issues: row.issues, source: row.source,
      firstCollectedAt: row.first_collected_at, lastCollectedAt: row.last_collected_at,
    }));
    return res.json({
      ok: true,
      scope: { districtBbs, upazilaBbs: upazilaBbs || null },
      rows,
      coverage: {
        upazila: upazilaBbs ? await coverageForScope(districtBbs, upazilaBbs) : null,
        district: await coverageForScope(districtBbs, null),
      },
      coverageNote: COVERAGE_NOTE, launchGateNote: LAUNCH_GATE_NOTE,
    });
  } catch (e) {
    safeLog('[land-khatian] coverage error:', e.message);
    res.status(500).json({ error: 'COVERAGE_FAILED' });
  }
});

// ---------- public coverage (NOT admin-only) ----------
// GET /api/land-khatian/coverage — requireAuth only.
// Without scope params it is deliberately CHEAP: index
// rows only, grouped by district — no portal walk, so the
// denominator is not known here and percentComplete is
// null/unavailable (never invented). With district_bbs
// (+ optional upazila_bbs) it returns the full scoped
// coverage (same definition as the admin endpoint,
// including the portal-walk denominator). Either way the
// response states plainly that the stored service is in
// its collection phase and is NOT an all-BD service.
router.get('/coverage', requireAuth, async (req, res) => {
  try {
    const districtBbs = toEn(String(req.query.district_bbs || '').trim());
    const upazilaBbs = toEn(String(req.query.upazila_bbs || '').trim());
    if (districtBbs || upazilaBbs) {
      if (!/^\d+$/.test(districtBbs) || (upazilaBbs && !/^\d+$/.test(upazilaBbs))) {
        return res.status(400).json({ error: 'BAD_INPUT', message: 'district_bbs লাগবে (upazila_bbs ঐচ্ছিক)।' });
      }
      return res.json({
        ok: true, scope: { districtBbs, upazilaBbs: upazilaBbs || null },
        coverage: await coverageForScope(districtBbs, upazilaBbs || null),
        collectionPhase: true, isAllBd: false,
        coverageNote: COVERAGE_NOTE, launchGateNote: LAUNCH_GATE_NOTE,
      });
    }
    const r = await db.query(
      `SELECT district_bbs, district_name, status,
              COUNT(*) AS units, COALESCE(SUM(collected_count), 0) AS records,
              MAX(last_collected_at) AS last_collected_at
       FROM land_khatian_index GROUP BY district_bbs, district_name, status
       ORDER BY district_name`
    );
    const byDistrict = new Map();
    for (const row of r.rows || []) {
      const key = row.district_bbs;
      if (!byDistrict.has(key)) {
        byDistrict.set(key, {
          districtBbs: row.district_bbs, districtName: row.district_name,
          completeUnits: 0, partialUnits: 0, recordCount: 0, lastCollectedAt: null,
        });
      }
      const d = byDistrict.get(key);
      if (row.status === 'complete') d.completeUnits += parseInt(row.units, 10) || 0;
      else d.partialUnits += parseInt(row.units, 10) || 0;
      d.recordCount += parseInt(row.records, 10) || 0;
      if (row.last_collected_at && (!d.lastCollectedAt || String(row.last_collected_at) > String(d.lastCollectedAt))) {
        d.lastCollectedAt = row.last_collected_at;
      }
    }
    const districts = [...byDistrict.values()];
    return res.json({
      ok: true, districts,
      totalCompleteUnits: districts.reduce((a, d) => a + d.completeUnits, 0),
      totalPartialUnits: districts.reduce((a, d) => a + d.partialUnits, 0),
      totalRecords: districts.reduce((a, d) => a + d.recordCount, 0),
      // Cheap endpoint: no portal walk, so no denominator —
      // percent is unavailable here by design, never guessed.
      // (Scoped queries above, and the admin endpoint, do
      // the portal walk and report percentComplete.)
      totalUnits: null, percentComplete: null, coverageAvailable: false,
      percentNote: 'শতাংশের হর (মোট মৌজা×জরিপ) পোর্টালের তালিকা থেকে আসে — এই সস্তা তালিকায় পোর্টালে যাওয়া হয় না, তাই শতাংশ এখানে নেই; শতাংশ দেখতে জেলা/উপজেলা দিয়ে কোয়েরি করুন বা অ্যাডমিন coverage দেখুন।',
      collectionPhase: true, isAllBd: false,
      coverageNote: COVERAGE_NOTE, launchGateNote: LAUNCH_GATE_NOTE,
    });
  } catch (e) {
    safeLog('[land-khatian] public coverage error:', e.message);
    res.status(500).json({ error: 'COVERAGE_FAILED' });
  }
});

module.exports = router;
