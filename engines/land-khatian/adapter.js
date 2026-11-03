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

/** Best-effort hal-sabek rows for one record: failure or
 *  empty leaves [] and never fails the search/import. The
 *  rows are returned VERBATIM (source data) — the caller
 *  stores them as-is and maps them only at delivery. */
async function fetchHalSabekRows(area, surveyKey, jlId, khatianNo) {
  try {
    const rows = await client.halSabek({
      divisionBbs: area.divisionBbs,
      districtBbs: area.districtBbs,
      upazilaBbs: area.upazilaBbs,
      surveyKey,
      jlId,
      khatianNo,
    });
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    return [];
  }
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
        const rawItems = [];
        for (const hit of hits.slice(0, DETAIL_CAP)) {
          const det = await client.detail(sv.key, hit.ID);
          items.push(normalize(det, sv.key, sv.name, jl.ID));
          // Raw payload, stored verbatim on collect — the
          // display item above is delivery mapping only
          // and must NEVER be what the store keeps.
          rawItems.push({
            rawIndex: hit, rawDetail: det, halSabek: [],
            meta: { source: 'dlrms', jlId: jl.ID, surveyKey: sv.key, surveyName: sv.name },
          });
        }
        for (let i = 0; i < items.length; i += 1) {
          const rows = await fetchHalSabekRows(area, sv.key, jl.ID, items[i].khatianNo);
          items[i].halSabek = rows;
          rawItems[i].halSabek = rows;
        }
        return {
          items, rawItems, totalMatches: items.length, totalCandidates: hits.length,
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
      return { items: [], rawItems: [], totalMatches: 0, totalCandidates: 0, capped: false, surveysTried, mutationAttempted: true, mutationUnsupported: true };
    }
    if (mutationAttempted && mutationAttemptsWithJl === 0 && !surveysTried.length) {
      throw typed('JL_NOT_FOUND', 'no JL entry for this mouza in the offered surveys');
    }
    return { items: [], rawItems: [], totalMatches: 0, totalCandidates: 0, capped: false, surveysTried, mutationAttempted, mutationUnsupported: false };
  }

  // Owner-name and/or dag-number path: whole-mouza index,
  // local filters (OWNER_NAME is ignored server-side).
  const items = [];
  const rawItems = [];
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
      rawItems.push({
        rawIndex: hit, rawDetail: det, halSabek: [],
        meta: { source: 'dlrms', jlId: jl.ID, surveyKey: sv.key, surveyName: sv.name },
      });
    }
    if (items.length >= DETAIL_CAP) break;
  }
  if (!jlResolved) {
    throw typed('JL_NOT_FOUND', 'no JL entry for this mouza in the offered surveys');
  }
  const capped = totalCandidates > DETAIL_CAP;
  for (let i = 0; i < items.length; i += 1) {
    const rows = await fetchHalSabekRows(area, items[i].surveyKey, items[i].jlId, items[i].khatianNo);
    items[i].halSabek = rows;
    rawItems[i].halSabek = rows;
  }
  return {
    items, rawItems, totalMatches: items.length, totalCandidates, capped, surveysTried,
    mutationAttempted,
    mutationUnsupported: mutationAttempted && mutationAttemptsWithJl === 0 && mutationUnsupportedCount > 0,
  };
}

/**
 * countDags(dags) — dag-token count for one detail DAGS
 * string, with the exact splitting method (STORE.md):
 * Bengali digits → Latin, split on ',' or ';', trim each
 * token, drop empties. A token counts ONLY if it matches
 * /^\d+$/ (a plain dag number). Returns { count } or
 * { unparseable: true } — an unparseable token is NEVER
 * guessed: the caller flags the record in issues and the
 * unit goes partial. An empty/missing DAGS string counts
 * as 0 (no dags listed), not unparseable.
 */
function countDags(dags) {
  if (dags === null || dags === undefined || String(dags).trim() === '') return { count: 0 };
  const tokens = toEn(String(dags)).split(/[,;]/).map((t) => t.trim()).filter((t) => t !== '');
  for (const t of tokens) {
    if (!/^\d+$/.test(t)) return { unparseable: true };
  }
  return { count: tokens.length };
}

/**
 * importMouza({ divisionBbs, districtBbs, upazilaBbs,
 *   surveyId, jlId, mouzaId }) — batch-collection import of
 *   ONE unit (mouza JL × survey), for the collection store.
 *
 * Serial order, exactly as the collection inventory
 * (~/workspace/land-service/khatian-collection-inventory.md)
 * requires: cascade (offered surveys + jlNumbers) → FULL
 * index list → detail per record → hal-sabek (best-effort
 * only, never required for completeness) → map/PDF is NOT
 * in this build (needs live proof first — see STORE.md).
 *
 * Reconciliation, per step, in this exact order:
 *   1. The FULL index list is fetched FIRST and its length
 *      recorded as `expected` BEFORE any detail is loaded.
 *   2. Details are then fetched per index item. A detail
 *      failure does NOT abort the unit: the item lands in
 *      `failedDetails` (index id + khatian number + reason)
 *      and the unit goes partial — the missing items stay
 *      OPEN in the index row's issues, never synthesized,
 *      never silently skipped.
 *   3. `records` holds only successfully collected details;
 *      `indexItems` holds the full source list so the caller
 *      can reconcile (stored vs expected) and reopen a unit
 *      on a later re-run that finds a gap.
 *
 * A mouza with no JL entry in this survey returns
 * { records: [], jlId: null, ... } — the caller counts it
 * as skipped, not failed. A survey the portal does not
 * offer throws SURVEY_NOT_OFFERED. No DETAIL_CAP here: the
 * import caller enforces its own per-call cap (5 mouzas /
 * 3000 records).
 */
async function importMouza(args) {
  const a = args || {};
  const divisionBbs = toEn(String(a.divisionBbs || '').trim());
  const districtBbs = toEn(String(a.districtBbs || '').trim());
  const upazilaBbs = toEn(String(a.upazilaBbs || '').trim());
  if (!/^\d+$/.test(divisionBbs) || !/^\d+$/.test(districtBbs) || !/^\d+$/.test(upazilaBbs)) {
    throw typed('BAD_AREA', 'division/district/upazila BBS codes must be digits');
  }
  const surveyIdRaw = a.surveyId !== null && a.surveyId !== undefined ? String(a.surveyId).trim() : '';
  if (!/^\d+$/.test(surveyIdRaw)) {
    throw typed('SURVEY_NOT_OFFERED', 'import needs one numeric survey id');
  }
  const offered = await offeredSurveys(districtBbs, upazilaBbs);
  const sv = offered.find((s) => s.id === Number(surveyIdRaw));
  if (!sv) throw typed('SURVEY_NOT_OFFERED', 'survey is not offered in this upazila');
  const jlId = a.jlId !== null && a.jlId !== undefined && String(a.jlId) !== '' ? a.jlId : null;
  const mouzaId = a.mouzaId !== null && a.mouzaId !== undefined && String(a.mouzaId) !== '' ? a.mouzaId : null;
  if (jlId === null && mouzaId === null) {
    throw typed('JL_REQUIRED', 'jlId or mouzaId is required');
  }
  const jl = await jlEntry(districtBbs, upazilaBbs, sv.id, jlId, mouzaId);
  if (!jl) {
    return {
      records: [], expected: 0, indexItems: [], failedDetails: [],
      surveyKey: sv.key, surveyName: sv.name, jlId: null,
      mouzaId: mouzaId !== null ? Number(mouzaId) : null, jlNumber: null,
    };
  }
  // Step 1: FULL index list first; its length IS the source
  // count, recorded before any detail is loaded.
  const list = await client.indexList(sv.key, jl.ID);
  const indexItems = (list || []).map((hit) => ({ id: hit.ID, khatianNo: hit.KHATIAN_NO }));
  const expected = indexItems.length;
  // Step 2: details per item; failures stay open, never abort.
  // Records are stored RAW (see the header rule): the exact
  // index item + exact detail item, plus verbatim hal-sabek
  // rows and separate collection metadata. NOTHING here is
  // renamed, dropped, or reformatted — presentation mapping
  // happens only at delivery time (storeMapping.js).
  const records = [];
  const failedDetails = [];
  for (const hit of list || []) {
    try {
      const det = await client.detail(sv.key, hit.ID);
      if (!det || det.KHATIAN_NO === null || det.KHATIAN_NO === undefined || String(det.KHATIAN_NO) === '') {
        throw typed('UNREADABLE_DETAIL', 'detail returned no khatian number');
      }
      records.push({
        rawIndex: hit, rawDetail: det, halSabek: [],
        meta: { source: 'dlrms', jlId: jl.ID, surveyKey: sv.key, surveyName: sv.name },
      });
    } catch (e) {
      failedDetails.push({ indexId: hit.ID, khatianNo: hit.KHATIAN_NO, reason: e.code || 'DETAIL_FAILED' });
    }
  }
  // Step 3: hal-sabek, best-effort only (a populated
  // hal-sabek response is UNPROVEN — the sample returns
  // 200 + EMPTY — so it never affects completeness).
  const area = { divisionBbs, districtBbs, upazilaBbs };
  for (const rec of records) {
    rec.halSabek = await fetchHalSabekRows(
      area, sv.key, jl.ID,
      rec.rawDetail && rec.rawDetail.KHATIAN_NO,
    );
  }
  return {
    records, expected, indexItems, failedDetails,
    surveyKey: sv.key, surveyName: sv.name, jlId: jl.ID,
    mouzaId: jl.MOUZA_ID, jlNumber: jl.JL_NUMBER,
  };
}

module.exports = { search, offeredSurveys, importMouza, countDags, DETAIL_CAP, MUTATION_KEY };
