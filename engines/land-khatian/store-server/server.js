'use strict';

// ============================================================
// Khatian collection store — reference server. This is what
// a second small server runs so the production app server
// never holds bulk khatian records (see ../STORE.md).
//
// Backends (same HTTP contract, so the app-side client in
// backend/lib/khatianStore.js needs NO change):
//   file (default, dev): one JSON file per (jl_id,
//     survey_key) under STORE_DATA_DIR (default ./data).
//   postgres: a SEPARATE PostgreSQL database (never the
//     production database abc_authentic_new), via
//     engines/land-khatian/store-server/pgStore.js.
//     Select with STORE_BACKEND=postgres + one of:
//       STORE_PG_CONNECTION_STRING, or
//       STORE_PG_HOST/STORE_PG_PORT/STORE_PG_DATABASE/
//       STORE_PG_USER/STORE_PG_PASSWORD (+ optional
//       STORE_PG_POOL_MAX, STORE_PG_SSL).
//     Connection values come from env ONLY — they are
//     never logged and never committed.
//
//   STORE_API_KEY   when set, every request must carry
//                   header X-Store-Key with this value
//   PORT            listen port (default 3101)
//
// Data layout (file backend): one JSON file per (jl_id,
// survey_key), the same file format
// backend/lib/khatianStore.js uses for its local store,
// so the two are interchangeable. Writes are atomic
// (tmp file + rename).
//
// This server holds BULK records. Production Postgres holds
// only the index/metadata table land_khatian_index — never
// these records. The source field carries 'dlrms' only: no
// eporcha.tech endpoint, import, or data anywhere here.
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STORE_DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT) || 3101;

const BN_DIGIT_MAP = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
const toEn = (s) => String(s == null ? '' : s).replace(/[০-৯]/g, (d) => BN_DIGIT_MAP[d]);
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined &&
  String(a) !== '' && String(a) === String(b);

function fileName(jlId, surveyKey) {
  const safe = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return safe(jlId) + '__' + safe(surveyKey) + '.json';
}

function readFiles() {
  if (!fs.existsSync(DATA_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (!name.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'))); } catch (_) { /* skip corrupt */ }
  }
  return out;
}

function scopeMatches(file, q) {
  if (q.jl_id) {
    if (!sameId(file.jlId, q.jl_id)) return false;
  } else if (q.mouza_id) {
    const fm = (file.area && file.area.mouzaId) || file.mouzaId;
    if (!sameId(fm, q.mouza_id)) return false;
  } else {
    return false;
  }
  if (q.survey_key && q.survey_key !== 'all' && file.surveyKey !== q.survey_key) return false;
  return true;
}

function filterRecords(records, q) {
  return (records || []).filter((r) => {
    if (q.khatian_no && toEn(r.khatianNo) !== toEn(q.khatian_no)) return false;
    if (q.owner_name && !norm(r.owners).includes(norm(q.owner_name))) return false;
    if (q.dag_no && !String(r.dags || '').includes(toEn(q.dag_no))) return false;
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

// ---------- file backend (default) ----------
function createFileBackend() {
  return {
    kind: 'file',
    async upsert({ area, surveyKey, surveyName, jlId, mouzaId, jlNumber, records, source, merge }) {
      const now = new Date().toISOString();
      const stamped = (records || []).map((r) => ({
        ...r, surveyKey, surveyName, jlId, collectedAt: r.collectedAt || now,
      }));
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const target = path.join(DATA_DIR, fileName(jlId, surveyKey));
      const existed = fs.existsSync(target);
      // merge: true → merge by record id with the existing
      // file (live-search upserts must not destroy a
      // previously imported full unit). Otherwise replace.
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
        area: area || null, surveyKey, surveyName,
        jlId, mouzaId: mouzaId || (area && area.mouzaId) || null,
        jlNumber: jlNumber || null, records: finalRecords, collectedAt: now,
        source: source || 'dlrms',
      };
      const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(file));
      fs.renameSync(tmp, target);
      return { upserted: stamped.length, updated: existed, total: finalRecords.length };
    },
    async search(q) {
      const files = readFiles().filter((f) => scopeMatches(f, q || {}));
      const mouzaCollected = files.length > 0;
      const records = filterRecords(files.flatMap((f) => f.records || []), q || {});
      return {
        records, collectedAt: maxCollectedAt(records),
        totalMatches: records.length, mouzaCollected,
      };
    },
    async countForUnit({ jlId, surveyKey }) {
      if (!jlId || !surveyKey) return { count: 0 };
      const files = readFiles().filter((f) => sameId(f.jlId, jlId) && f.surveyKey === surveyKey);
      const ids = new Set();
      for (const f of files) for (const r of f.records || []) if (r && r.id !== undefined) ids.add(r.id);
      return { count: ids.size };
    },
    async ping() { return { ok: true }; },
  };
}

// ---------- backend selection ----------
function resolveBackendName(env) {
  const name = String((env || process.env).STORE_BACKEND || 'file').toLowerCase();
  if (name !== 'file' && name !== 'postgres') {
    throw new Error('Unknown khatian store backend: set STORE_BACKEND to file or postgres');
  }
  return name;
}

function createBackend(env) {
  const e = env || process.env;
  if (resolveBackendName(e) === 'postgres') {
    // eslint-disable-next-line global-require
    const { createPgBackend, createPgPoolFromEnv } = require('./pgStore');
    return createPgBackend(createPgPoolFromEnv(e));
  }
  return createFileBackend();
}

// ---------- HTTP server (contract shared by backends) ----------
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function createServer(backend) {
  const store = backend || createBackend();
  const apiKey = process.env.STORE_API_KEY || '';
  return http.createServer(async (req, res) => {
    try {
      if (apiKey && req.headers['x-store-key'] !== apiKey) {
        return send(res, 401, { error: 'UNAUTHORIZED' });
      }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/v1/records/upsert') {
        const body = await readBody(req);
        if (!body.jlId || !body.surveyKey || !Array.isArray(body.records)) {
          return send(res, 400, { error: 'BAD_INPUT' });
        }
        const out = await store.upsert({
          area: body.area || null, surveyKey: body.surveyKey, surveyName: body.surveyName,
          jlId: body.jlId, mouzaId: body.mouzaId || (body.area && body.area.mouzaId) || null,
          jlNumber: body.jlNumber || null, records: body.records,
          source: body.source || 'dlrms', merge: !!body.merge,
        });
        return send(res, 200, out);
      }
      if (req.method === 'GET' && url.pathname === '/v1/records/count') {
        const q = Object.fromEntries(url.searchParams.entries());
        if (!q.jl_id || !q.survey_key) return send(res, 400, { error: 'BAD_INPUT' });
        const out = await store.countForUnit({ jlId: q.jl_id, surveyKey: q.survey_key });
        return send(res, 200, out);
      }
      if (req.method === 'GET' && url.pathname === '/v1/records/search') {
        const q = Object.fromEntries(url.searchParams.entries());
        const out = await store.search(q);
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      // Never leak backend detail (paths, SQL, connection
      // errors) to the caller — the app client turns any
      // non-2xx into STORE_UNREACHABLE anyway.
      return send(res, 500, { error: 'FAILED' });
    }
  });
}

const server = createServer();

if (require.main === module) {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log('[khatian-store] listening on port ' + PORT
      + (resolveBackendName() === 'postgres' ? ', postgres backend' : ', data dir ' + DATA_DIR));
  });
}

module.exports = { server, createServer, createBackend, resolveBackendName };
