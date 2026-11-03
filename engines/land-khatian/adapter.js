'use strict';

// ============================================================
// Land Khatian search adapter (SPEC Phase 1: login-free
// search + summary only). Thin wrapper over
// engines/land-core/client.js — it does NOT re-implement any
// HTTP/token logic; all portal calls go through the client.
//
// Proven portal facts (DLRMS re-verification, 2026-11-03,
// from this VM — no login, guest cookies only):
//   - GET /public/surveys → 8 rows: CS=1, RS=2, SA=3, BS=4,
//     DIARA=5, PETY=6, BRS=7, BDS=8. NO mutation key in it.
//   - Index key MUTATION is accepted (HTTP 200) but returned
//     0 items for the Mirpur RS sample, with and without
//     KHATIAN_NO=8; NAMJARI / MUTATION_SURVEY / HAL_SABEK
//     return 400 'Survey Is Not Valid'. jl-numbers rows carry
//     MUTATION_SURVEY_ID = null. Mutation is therefore a
//     CONDITIONAL passthrough attempt, never a proven lookup:
//     search() tries it only when surveyId === 'mutation',
//     returns whatever the portal returns, and an empty
//     result means not-found (no charge) — never a claim
//     that mutation lookup works.
//   - KHATIAN_NO filters server-side (1 item for khatian 8);
//     OWNER_NAME is ignored server-side (a bogus name still
//     returns the whole mouza list) — so owner-name filtering
//     MUST happen locally (client.ownerMatches), as here.
//   - Hal-sabek returns 200 + EMPTY list for the sample with
//     the full parameter set; a populated hal-sabek response
//     is UNPROVEN. It is best-effort only: failure or empty
//     never fails the search.
//   - The upazilas endpoint mixes revenue circles
//     (IS_CIRCLE=1) and real upazilas (IS_CIRCLE=0); e.g.
//     Mirpur is UPAZILA_BBS_CODE 48 (Mirpur Revenue Circle).
//     Nothing here filters circles out — the caller passes
//     whatever BBS code the cascade returned.
//
// Survey keys come ONLY from the portal's surveys /
// upazilaSurveys lists (offeredSurveys below). A client-
// supplied surveyKey is accepted as a hint but never trusted:
// the portal-derived key wins, and a surveyId/surveyKey the
// portal does not offer for this upazila is rejected with
// SURVEY_NOT_OFFERED. No survey list is hardcoded here.
// Likewise a client-supplied jlId is validated against the
// realtime jlNumbers list for that area + survey — a jlId
// absent from that list is rejected with JL_NOT_FOUND.
//
// No eporcha.tech, no login, no payment, no cart, no copy
// application anywhere in this adapter.
// ============================================================

const client = require('../land-core/client');

const DETAIL_CAP = 50;
const MUTATION_KEY = 'MUTATION';
const MUTATION_NAME = 'নামজারি / মিউটেশন';

function typed(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const BN_DIGIT_MAP = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
const toEn = (s) => String(s == null ? '' : s).replace(/[০-৯]/g, (d) => BN_DIGIT_MAP[d]);

/** Surveys the portal actually offers in this upazila, with
 *  their index keys from the master surveys list — the same
 *  merge backend/routes/land.js uses for /api/land/geo. */
async function offeredSurveys(districtBbs, upazilaBbs) {
  const [offered, all] = await Promise.all([
    client.upazilaSurveys(districtBbs, upazilaBbs),
    client.surveys(),
  ]);
  const keyById = new Map((all || []).map((s) => [Number(s.ID), s.KEY]));
  return (offered || [])
    .map((o) => ({ id: Number(o.SURVEY_ID), key: keyById.get(Number(o.SURVEY_ID)), name: o.LOCAL_NAME }))
    .filter((s) => s.key);
}

/** JL entry for one mouza in one survey, from the realtime
 *  jlNumbers list. jlId wins when given; mouzaId is the
 *  fallback. A jlId that is not in the list, or a jlId whose
 *  entry belongs to a different mouza than mouzaId, is a
 *  rejection — never a blind pass-through. Returns null when
 *  the mouza simply has no JL entry in this survey. */
async function jlEntry(districtBbs, upazilaBbs, surveyId, jlId, mouzaId) {
  const rows = await client.jlNumbers(districtBbs, upazilaBbs, surveyId);
  let entry = null;
  if (jlId !== null && jlId !== undefined && String(jlId) !== '') {
    entry = (rows || []).find((j) => Number(j.ID) === Number(jlId)) || null;
    if (entry && mouzaId !== null && mouzaId !== undefined && String(mouzaId) !== '' &&
        Number(entry.MOUZA_ID) !== Number(mouzaId)) {
      throw typed('JL_NOT_FOUND', 'JL entry does not belong to the given mouza');
    }
    return entry;
  }
  if (mouzaId !== null && mouzaId !== undefined && String(mouzaId) !== '') {
    return (rows || []).find((j) => Number(j.MOUZA_ID) === Number(mouzaId)) || null;
  }
  return null;
}

function normalize(detail, surveyKey, surveyName, jlId) {
  return {
    id: detail.ID,
    khatianNo: detail.KHATIAN_NO,
    owners: detail.OWNERS || '',
    dags: detail.DAGS || '',
    totalLand: detail.TOTAL_LAND || null,
    surveyKey,
    surveyName,
    jlId,
    halSabek: [],
  };
}

/** Best-effort hal-sabek for one item: failure or empty
 *  leaves halSabek as [] and never fails the search. */
async function attachHalSabek(item, area) {
  try {
    const rows = await client.halSabek({
      divisionBbs: area.divisionBbs,
      districtBbs: area.districtBbs,
      upazilaBbs: area.upazilaBbs,
      surveyKey: item.surveyKey,
      jlId: item.jlId,
      khatianNo: item.khatianNo,
    });
    if (Array.isArray(rows)) item.halSabek = rows;
  } catch (_) {
    item.halSabek = [];
  }
  return item;
}

/**
 * search({ divisionBbs, districtBbs, upazilaBbs, surveyId,
 *   surveyKey, jlId, mouzaId, khatianNo, ownerName, dagNo })
 *
 * surveyId: numeric survey id | 'all' (every survey the
 *   portal offers in this upazila) | 'mutation' (passthrough
 *   MUTATION-key attempt — conditional/unproven, see header).
 *   surveyKey alone (no surveyId) resolves through the
 *   offered list as well.
 *
 * At least one of khatianNo / ownerName / dagNo is required.
 *
 * Returns { items, totalMatches, totalCandidates, capped,
 *   surveysTried, mutationAttempted, mutationUnsupported }:
 *   items — normalized, detail-fetched records (max 50);
 *   totalMatches — delivered items after all filters;
 *   totalCandidates — index-level matches before the detail
 *     cap (owner filter applied at index level; a dag filter
 *     applies after detail, so with a dag filter the
 *     pre-dag candidate count is what this reports);
 *   capped — true when candidates exceeded the detail cap,
 *     so the delivered list may be incomplete;
 *   surveysTried — survey keys actually attempted;
 *   mutationAttempted / mutationUnsupported — mutation
 *     bookkeeping (unsupported = the portal answered
 *     'Survey Is Not Valid' for every JL tried).
 *
 * Throws typed errors: BAD_AREA, NO_SEARCH_CRITERION,
 * JL_NOT_FOUND, SURVEY_NOT_OFFERED, JL_REQUIRED, plus the
 * client's LAND_UNREACHABLE / LAND_API_ERROR on portal
 * failure (the route turns those into 502, no charge).
 */
async function search(args) {
  const a = args || {};
  const divisionBbs = toEn(String(a.divisionBbs || '').trim());
  const districtBbs = toEn(String(a.districtBbs || '').trim());
  const upazilaBbs = toEn(String(a.upazilaBbs || '').trim());
  if (!/^\d+$/.test(divisionBbs) || !/^\d+$/.test(districtBbs) || !/^\d+$/.test(upazilaBbs)) {
    throw typed('BAD_AREA', 'division/district/upazila BBS codes must be digits');
  }
  const khatianNo = toEn(String(a.khatianNo || '').trim());
  const ownerName = String(a.ownerName || '').trim();
  const dagNo = toEn(String(a.dagNo || '').trim());
  if (!khatianNo && !ownerName && !dagNo) {
    throw typed('NO_SEARCH_CRITERION', 'at least one of khatianNo, ownerName, dagNo is required');
  }
  const jlId = a.jlId !== null && a.jlId !== undefined && String(a.jlId) !== '' ? a.jlId : null;
  const mouzaId = a.mouzaId !== null && a.mouzaId !== undefined && String(a.mouzaId) !== '' ? a.mouzaId : null;
  if (jlId === null && mouzaId === null) {
    throw typed('JL_REQUIRED', 'jlId or mouzaId is required to resolve the JL entry');
  }

  const offered = await offeredSurveys(districtBbs, upazilaBbs);
  const surveyIdRaw = a.surveyId !== null && a.surveyId !== undefined ? String(a.surveyId).trim() : '';
  const surveyKeyHint = a.surveyKey ? String(a.surveyKey).trim() : '';
  const mutationAttempted = surveyIdRaw === 'mutation';

  // Resolve the survey attempts — portal keys only.
  let attempts = [];
  if (mutationAttempted) {
    // Passthrough: same JL entries the offered surveys
    // resolve, but the index key is MUTATION throughout.
    // (Verified 2026-11-03: 200 + 0 items for the Mirpur
    // sample; other areas may answer 400 'Survey Is Not
    // Valid' — handled per-attempt below.)
    attempts = offered.map((s) => ({ id: s.id, key: MUTATION_KEY, name: MUTATION_NAME }));
  } else if (surveyIdRaw === 'all' || surveyIdRaw === '') {
    attempts = offered.slice();
  } else if (/^\d+$/.test(surveyIdRaw)) {
    const one = offered.find((s) => s.id === Number(surveyIdRaw));
    if (!one) throw typed('SURVEY_NOT_OFFERED', 'survey is not offered in this upazila');
    attempts = [one];
  } else if (surveyKeyHint) {
    const one = offered.find((s) => s.key === surveyKeyHint);
    if (!one) throw typed('SURVEY_NOT_OFFERED', 'survey key is not offered in this upazila');
    attempts = [one];
  } else {
    throw typed('SURVEY_NOT_OFFERED', 'surveyId must be a number, "all", or "mutation"');
  }
  // A bare surveyKey hint must never override the portal
  // key for a numeric surveyId: the portal key already won
  // above (attempts carry portal keys only).
  if (!attempts.length) {
    throw typed('SURVEY_NOT_OFFERED', 'portal offers no survey in this upazila');
  }

  const area = { divisionBbs, districtBbs, upazilaBbs };
  const surveysTried = [];
  let mutationUnsupportedCount = 0;
  let mutationAttemptsWithJl = 0;

  if (khatianNo) {
    // First survey with a hit wins (same semantics as
    // land.js findKhatian).
    for (const sv of attempts) {
      const jl = await jlEntry(districtBbs, upazilaBbs, sv.id, jlId, mouzaId);
      if (!jl) continue;
      surveysTried.push(sv.key);
      let hits;
      try {
        hits = await client.indexByKhatianNo(sv.key, jl.ID, khatianNo);
      } catch (e) {
        if (mutationAttempted && /Survey Is Not Valid/.test(e.message)) {
          mutationUnsupportedCount += 1;
          continue;
        }
        throw e;
      }
      if (mutationAttempted) mutationAttemptsWithJl += 1;
      if (hits && hits.length) {
        const items = [];
        for (const hit of hits.slice(0, DETAIL_CAP)) {
          const det = await client.detail(sv.key, hit.ID);
          items.push(normalize(det, sv.key, sv.name, jl.ID));
        }
        for (const item of items) await attachHalSabek(item, area);
        return {
          items, totalMatches: items.length, totalCandidates: hits.length,
          capped: hits.length > DETAIL_CAP, surveysTried,
          mutationAttempted, mutationUnsupported: mutationAttempted && mutationUnsupportedCount > 0 && mutationAttemptsWithJl === 0,
        };
      }
    }
    // No JL entry anywhere, or no hit anywhere: distinguish
    // bad input (JL unresolvable) from genuine not-found.
    if (!surveysTried.length && !mutationAttempted) {
      throw typed('JL_NOT_FOUND', 'no JL entry for this mouza in the offered surveys');
    }
    if (mutationAttempted && mutationAttemptsWithJl === 0 && mutationUnsupportedCount > 0) {
      return { items: [], totalMatches: 0, totalCandidates: 0, capped: false, surveysTried, mutationAttempted: true, mutationUnsupported: true };
    }
    if (mutationAttempted && mutationAttemptsWithJl === 0 && !surveysTried.length) {
      throw typed('JL_NOT_FOUND', 'no JL entry for this mouza in the offered surveys');
    }
    return { items: [], totalMatches: 0, totalCandidates: 0, capped: false, surveysTried, mutationAttempted, mutationUnsupported: false };
  }

  // Owner-name and/or dag-number path: whole-mouza index,
  // local filters (OWNER_NAME is ignored server-side).
  const items = [];
  let totalCandidates = 0;
  let jlResolved = false;
  for (const sv of attempts) {
    const jl = await jlEntry(districtBbs, upazilaBbs, sv.id, jlId, mouzaId);
    if (!jl) continue;
    jlResolved = true;
    surveysTried.push(sv.key);
    let list;
    try {
      list = await client.indexList(sv.key, jl.ID);
    } catch (e) {
      if (mutationAttempted && /Survey Is Not Valid/.test(e.message)) {
        mutationUnsupportedCount += 1;
        continue;
      }
      throw e;
    }
    if (mutationAttempted) mutationAttemptsWithJl += 1;
    const candidates = (list || []).filter((r) => !ownerName || client.ownerMatches(r.OWNERS, ownerName));
    totalCandidates += candidates.length;
    for (const hit of candidates) {
      if (items.length >= DETAIL_CAP) break;
      const det = await client.detail(sv.key, hit.ID);
      // Dag filter applies on the detail record: the index
      // rows carry owners, not dags.
      if (dagNo && !String(det.DAGS || '').includes(dagNo)) continue;
      items.push(normalize(det, sv.key, sv.name, jl.ID));
    }
    if (items.length >= DETAIL_CAP) break;
  }
  if (!jlResolved) {
    throw typed('JL_NOT_FOUND', 'no JL entry for this mouza in the offered surveys');
  }
  const capped = totalCandidates > DETAIL_CAP;
  for (const item of items) await attachHalSabek(item, area);
  return {
    items, totalMatches: items.length, totalCandidates, capped, surveysTried,
    mutationAttempted,
    mutationUnsupported: mutationAttempted && mutationAttemptsWithJl === 0 && mutationUnsupportedCount > 0,
  };
}

module.exports = { search, offeredSurveys, DETAIL_CAP, MUTATION_KEY };
