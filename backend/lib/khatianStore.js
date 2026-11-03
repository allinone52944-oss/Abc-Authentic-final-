'use strict';

// ============================================================
// Khatian collection store client — the SEPARATE store for
// the land-khatian engine (see engines/land-khatian/STORE.md).
//
// Production Postgres (abc_authentic_new) holds ONLY the
// index/metadata table land_khatian_index — NEVER bulk
// records. Bulk records live in a separate store, reached
// through this client. The store is NEVER a hard dependency:
// if it is down, live DLRMS still works; the store is only
// consulted when live DLRMS has already failed (the route
// enforces that resolution order, not this client).
//
// Two implementations, chosen by env (no new dependencies):
//   (a) HTTP remote client when LAND_KHATIAN_STORE_URL is set
//       (a second small server running
//       engines/land-khatian/store-server/server.js, or any
//       server implementing the same contract). Auth header
//       X-Store-Key comes from LAND_KHATIAN_STORE_KEY only —
//       never logged, never in the repo.
//   (b) Local file store when no URL is set: one JSON file
//       per (jl_id, survey_key) under LAND_KHATIAN_STORE_DIR
//       (default: a tmp dir — NOT inside the repo —
//       documented as ephemeral, for local dev only).
//       Writes are atomic (tmp file + rename).
//
// Every failure to reach the store becomes a typed
// STORE_UNREACHABLE error — never a raw error to the
// customer. The route turns that into the same 502 it
// already returns for a dead portal.
//
// Record shape (same as adapter.search items, plus
// collectedAt): { id, khatianNo, owners, dags, totalLand,
//   surveyKey, surveyName, jlId, halSabek, collectedAt }.
// The source field carries 'dlrms' only. No eporcha.tech
// anywhere in this client.
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');

const TIMEOUT_MS = 10000;

function typed(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const BN_DIGIT_MAP = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
const toEn = (s) => String(s == null ? '' : s).replace(/[০-৯]/g, (d) => BN_DIGIT_MAP[d]);
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined &&
  String(a) !== '' && String(a) === String(b);

/** Local filtering shared by both implementations' contract:
 *  khatian exact, owner substring, dag substring on DAGS. */
function filterRecords(records, q) {
  const khatianNo = q.khatianNo ? toEn(q.khatianNo) : '';
  const ownerName = q.ownerName ? norm(q.ownerName) : '';
  const dagNo = q.dagNo ? toEn(q.dagNo) : '';
  return (records || []).filter((r) => {
    if (khatianNo && toEn(r.khatianNo) !== khatianNo) return false;
    if (ownerName && !norm(r.owners).includes(ownerName)) return false;
    if (dagNo && !String(r.dags || '').includes(dagNo)) return false;
    return true;
  });
}

function maxCollectedAt(records) {
  let best = null;
  for (const r of records || []) {
    if (r && r.collectedAt && (!best || String(r.collectedAt) > String(best))) best = r.collectedAt;
  }
  return best;
}

function scopeMatches(file, q) {
  // jlId wins when given; mouzaId is the fallback (the
  // frontend sends mouza_id only, never jl_id — so a store
  // fallback keyed on jl_id alone would never fire).
  if (q.jlId !== null && q.jlId !== undefined && String(q.jlId) !== '') {
    if (!sameId(file.jlId, q.jlId)) return false;
  } else if (q.mouzaId !== null && q.mouzaId !== undefined && String(q.mouzaId) !== '') {
    const fm = (file.area && file.area.mouzaId) || file.mouzaId;
    if (!sameId(fm, q.mouzaId)) return false;
  } else {
    return false;
  }
  if (q.surveyKey && q.surveyKey !== 'all' && file.surveyKey !== q.surveyKey) return false;
  return true;
}

// ---------- local file store ----------
function fileName(jlId, surveyKey) {
  const safe = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return safe(jlId) + '__' + safe(surveyKey) + '.json';
}

function readLocalFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); } catch (_) { /* skip corrupt file */ }
  }
  return out;
}

function createLocalStore(dir) {
  return {
    kind: 'local',
    async upsert({ area, surveyKey, surveyName, jlId, mouzaId, jlNumber, records, source, merge }) {
      const now = new Date().toISOString();
      const stamped = (records || []).map((r) => ({
        ...r, surveyKey, surveyName, jlId, collectedAt: r.collectedAt || now,
      }));
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, fileName(jlId, surveyKey));
      const existed = fs.existsSync(target);
      // merge: true → server-side merge by record id (a live
      // search returns only the searched subset, and a plain
      // replace would destroy a previously imported full
      // unit). Without merge, the record set is replaced.
      let finalRecords = stamped;
      if (merge && existed) {
        try {
          const prev = JSON.parse(fs.readFileSync(target, 'utf8'));
          const byId = new Map();
          for (const r of prev.records || []) byId.set(String(r.id), r);
          for (const r of stamped) byId.set(String(r.id), r);
          finalRecords = [...byId.values()];
        } catch (_) { finalRecords = stamped; }
      }
      const file = {
        area: area || null, surveyKey, surveyName, jlId, mouzaId: mouzaId || (area && area.mouzaId) || null,
        jlNumber: jlNumber || null, records: finalRecords, collectedAt: now, source: source || 'dlrms',
      };
      const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(file));
      fs.renameSync(tmp, target);
      return { upserted: stamped.length, updated: existed, total: finalRecords.length };
    },
    async search(q) {
      const files = readLocalFiles(dir).filter((f) => scopeMatches(f, q || {}));
      // A stored file for the scope counts as collected even
      // when its record list is empty (a mouza genuinely
      // holding 0 khatians in this survey, collected by
      // import) — otherwise a collected-but-empty mouza
      // would be misreported as "no stored data yet".
      const mouzaCollected = files.length > 0;
      const all = files.flatMap((f) => f.records || []);
      const records = filterRecords(all, q || {});
      return { records, collectedAt: maxCollectedAt(records), totalMatches: records.length, mouzaCollected };
    },
    // Distinct stored records for ONE unit (jlId ×
    // surveyKey), counted from the store itself — never a
    // running increment. This is what the index row's
    // collected_count must always equal.
    async countForUnit({ jlId, surveyKey }) {
      if (!jlId || !surveyKey) return { count: 0 };
      const files = readLocalFiles(dir).filter((f) => sameId(f.jlId, jlId) && f.surveyKey === surveyKey);
      const ids = new Set();
      for (const f of files) for (const r of f.records || []) if (r && r.id !== undefined) ids.add(r.id);
      return { count: ids.size };
    },
    async ping() { return { ok: true }; },
  };
}

// ---------- HTTP remote store ----------
function createHttpStore(baseUrl, storeKey, fetchImpl) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const fetchFn = fetchImpl || fetch;
  async function call(method, pathname, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (storeKey) headers['X-Store-Key'] = storeKey;
    let res;
    try {
      res = await fetchFn(base + pathname, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw typed('STORE_UNREACHABLE', 'khatian store unreachable');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw typed('STORE_UNREACHABLE', 'khatian store unreachable');
    return data || {};
  }
  return {
    kind: 'http',
    async upsert(args) {
      return call('POST', '/v1/records/upsert', {
        area: args.area || null, surveyKey: args.surveyKey, surveyName: args.surveyName,
        jlId: args.jlId, mouzaId: args.mouzaId || (args.area && args.area.mouzaId) || null,
        jlNumber: args.jlNumber || null, records: args.records || [], source: args.source || 'dlrms',
        merge: !!args.merge,
      });
    },
    async search(q) {
      const p = new URLSearchParams();
      if (q.jlId) p.set('jl_id', String(q.jlId));
      if (q.mouzaId) p.set('mouza_id', String(q.mouzaId));
      if (q.surveyKey) p.set('survey_key', String(q.surveyKey));
      if (q.khatianNo) p.set('khatian_no', String(q.khatianNo));
      if (q.ownerName) p.set('owner_name', String(q.ownerName));
      if (q.dagNo) p.set('dag_no', String(q.dagNo));
      const data = await call('GET', '/v1/records/search?' + p.toString());
      return {
        records: data.records || [], collectedAt: data.collectedAt || null,
        totalMatches: data.totalMatches != null ? data.totalMatches : (data.records || []).length,
        mouzaCollected: !!data.mouzaCollected,
      };
    },
    async countForUnit({ jlId, surveyKey }) {
      if (!jlId || !surveyKey) return { count: 0 };
      const p = new URLSearchParams({ jl_id: String(jlId), survey_key: String(surveyKey) });
      const data = await call('GET', '/v1/records/count?' + p.toString());
      return { count: data.count || 0 };
    },
    async ping() { return call('GET', '/v1/health'); },
  };
}

/** options (tests / explicit wiring only): { storeUrl,
 *  storeKey, storeDir, fetchImpl }. Defaults come from env. */
function createStoreClient(options) {
  const o = options || {};
  const url = o.storeUrl !== undefined ? o.storeUrl : process.env.LAND_KHATIAN_STORE_URL;
  if (url) {
    const key = o.storeKey !== undefined ? o.storeKey : process.env.LAND_KHATIAN_STORE_KEY;
    return createHttpStore(url, key, o.fetchImpl);
  }
  const dir = o.storeDir || process.env.LAND_KHATIAN_STORE_DIR ||
    path.join(os.tmpdir(), 'land-khatian-store');
  return createLocalStore(dir);
}

let cached = null;
function getStoreClient() {
  if (!cached) cached = createStoreClient();
  return cached;
}

module.exports = {
  createStoreClient, getStoreClient, filterRecords,
  STORE_TIMEOUT_MS: TIMEOUT_MS,
};
