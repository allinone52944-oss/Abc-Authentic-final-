'use strict';

// ============================================================
// Stored-record shape for the land-khatian collection
// store — the RAW-VERBATIM rule (Pankaj, 2026-11-03):
//
//   Import stores source records EXACTLY as the source
//   site returned them. No field is renamed, dropped,
//   reordered-into-a-new-format, or "arranged" at import
//   time. Presentation/summary mapping happens ONLY at
//   delivery time, when a stored record is served.
//
// Stored record (every new write, every backend):
//   {
//     rawIndex:  {...exact portal index item...},
//     rawDetail: {...exact portal detail item...},
//     halSabek:  [...exact hal-sabek rows...],  // [] if none
//     meta: { source: 'dlrms', collectedAt: <ISO>,
//             jlId, surveyKey, surveyName }
//   }
// `meta` is collection metadata kept SEPARATELY from the
// source payloads — it never rewrites a source field.
// Unit scope (jlId/surveyKey) is also carried by the unit
// itself (file name, PG unit row, index row) and is
// authoritative for delivery mapping.
//
// Delivery mapping (mapStoredToDisplay) is the ONLY place
// source fields are read into presentation shape, and it
// runs at serve time, never at import time. Legacy rows
// written before this rule (display-shaped test fixtures)
// pass through unchanged, so old tests keep working —
// but no new write may use the legacy shape.
//
// Dedupe/count key: the source index ID, read from
// rawIndex.ID (legacy fallback: the row's own id).
// ============================================================

const BN_DIGIT_MAP = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
const toEn = (s) => String(s == null ? '' : s).replace(/[০-৯]/g, (d) => BN_DIGIT_MAP[d]);
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function isRawRecord(r) {
  return !!r && typeof r === 'object' && r.rawIndex !== null && r.rawIndex !== undefined && typeof r.rawIndex === 'object';
}

/** Dedupe/count key for a stored record. */
function storedRecordId(r) {
  if (!r || typeof r !== 'object') return '';
  if (isRawRecord(r)) return String(r.rawIndex.ID != null ? r.rawIndex.ID : '');
  return String(r.id != null ? r.id : '');
}

/** Collection timestamp for a stored record. */
function storedCollectedAt(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.meta && r.meta.collectedAt) return r.meta.collectedAt;
  return r.collectedAt || null;
}

/** Normalise an input record into the stored shape. Raw
 *  payloads are kept by reference-identity of VALUE: the
 *  caller must not mutate them afterwards (stores serialise
 *  them — JSON files, PG JSONB — so the stored bytes are
 *  the payload as given). Any non-payload, non-meta key on
 *  the input is DROPPED, never stored — only rawIndex,
 *  rawDetail, halSabek, and meta survive. Legacy
 *  display-shaped rows pass through untouched. */
function toStoredRecord(input, now) {
  if (!input || typeof input !== 'object') return input;
  if (!isRawRecord(input)) return input; // legacy pass-through
  const stamp = now || new Date().toISOString();
  const metaIn = (input.meta && typeof input.meta === 'object') ? input.meta : {};
  return {
    rawIndex: input.rawIndex,
    rawDetail: input.rawDetail !== undefined ? input.rawDetail : null,
    halSabek: Array.isArray(input.halSabek) ? input.halSabek : [],
    meta: {
      source: metaIn.source || input.source || 'dlrms',
      collectedAt: metaIn.collectedAt || stamp,
      jlId: metaIn.jlId !== undefined ? metaIn.jlId : undefined,
      surveyKey: metaIn.surveyKey !== undefined ? metaIn.surveyKey : undefined,
      surveyName: metaIn.surveyName !== undefined ? metaIn.surveyName : undefined,
    },
  };
}

/** Delivery-time mapping ONLY: stored record + unit
 *  context → the presentation shape the summary card, PDF,
 *  and search API have always served. This function never
 *  runs at import time and never writes back to the store.
 *  Legacy display-shaped rows pass through unchanged. */
function mapStoredToDisplay(stored, unitCtx) {
  if (!stored || typeof stored !== 'object') return stored;
  if (!isRawRecord(stored)) return stored; // legacy pass-through
  const ctx = unitCtx || {};
  const detail = (stored.rawDetail && typeof stored.rawDetail === 'object') ? stored.rawDetail : {};
  const index = stored.rawIndex;
  const meta = (stored.meta && typeof stored.meta === 'object') ? stored.meta : {};
  return {
    id: index.ID,
    khatianNo: detail.KHATIAN_NO !== null && detail.KHATIAN_NO !== undefined && detail.KHATIAN_NO !== ''
      ? detail.KHATIAN_NO : index.KHATIAN_NO,
    owners: detail.OWNERS || '',
    dags: detail.DAGS || '',
    totalLand: detail.TOTAL_LAND !== undefined ? detail.TOTAL_LAND : null,
    surveyKey: ctx.surveyKey !== undefined ? ctx.surveyKey : meta.surveyKey,
    surveyName: ctx.surveyName !== undefined ? ctx.surveyName : meta.surveyName,
    jlId: ctx.jlId !== undefined ? ctx.jlId : meta.jlId,
    halSabek: Array.isArray(stored.halSabek) ? stored.halSabek : [],
  };
}

module.exports = {
  isRawRecord, storedRecordId, storedCollectedAt,
  toStoredRecord, mapStoredToDisplay, toEn, norm,
};
