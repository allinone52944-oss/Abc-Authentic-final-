'use strict';

// ============================================================
// Khatian collection store — PostgreSQL backend for the
// separate store server (see server.js + ../STORE.md).
//
// This backend lives ONLY in the separate store service.
// It NEVER touches the production database
// (abc_authentic_new): it connects to a SEPARATE database,
// configured ONLY through environment variables (names
// below — never log them, never commit their values):
//
//   STORE_BACKEND=postgres            (selects this backend)
//   STORE_PG_CONNECTION_STRING        (full DSN, preferred)
//   — or the component form —
//   STORE_PG_HOST (default 127.0.0.1), STORE_PG_PORT (5432),
//   STORE_PG_DATABASE, STORE_PG_USER, STORE_PG_PASSWORD
//   STORE_PG_POOL_MAX (default 10)
//   STORE_PG_SSL: 'true' (verified TLS) or 'insecure'
//     (dev only: disables certificate verification)
//
// The HTTP contract is identical to the file backend, so
// backend/lib/khatianStore.js (the app-side client) needs
// NO change. Search filtering semantics mirror the file
// backend exactly (Bengali-digit normalisation, owner
// substring, dag substring on DAGS) — filtering happens in
// JS over one unit's rows, so SQL dialect differences
// cannot change a result.
//
// Schema (created idempotently on first use, in the
// SEPARATE database only):
//   khatian_units   one row per (jl_id, survey_key)
//   khatian_records one row per stored record, keyed by
//                   (jl_id, survey_key, record_id)
// The `source` field carries 'dlrms' only. No eporcha.tech
// anywhere here.
// ============================================================

const BN_DIGIT_MAP = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
const toEn = (s) => String(s == null ? '' : s).replace(/[০-৯]/g, (d) => BN_DIGIT_MAP[d]);
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined &&
  String(a) !== '' && String(a) === String(b);

const PG_SCHEMA_SQL = [
  'CREATE TABLE IF NOT EXISTS khatian_units ('
  + 'jl_id TEXT NOT NULL, survey_key TEXT NOT NULL, '
  + 'area JSONB, survey_name TEXT, mouza_id TEXT, jl_number TEXT, '
  + "source TEXT NOT NULL DEFAULT 'dlrms', "
  + 'collected_at TIMESTAMPTZ NOT NULL, '
  + 'PRIMARY KEY (jl_id, survey_key))',
  'CREATE TABLE IF NOT EXISTS khatian_records ('
  + 'jl_id TEXT NOT NULL, survey_key TEXT NOT NULL, '
  + 'record_id TEXT NOT NULL, khatian_no TEXT, owners TEXT, '
  + 'dags TEXT, total_land TEXT, record JSONB NOT NULL, '
  + 'collected_at TIMESTAMPTZ NOT NULL, '
  + 'PRIMARY KEY (jl_id, survey_key, record_id), '
  + 'FOREIGN KEY (jl_id, survey_key) REFERENCES khatian_units (jl_id, survey_key) ON DELETE CASCADE)',
  'CREATE INDEX IF NOT EXISTS khatian_records_unit_idx ON khatian_records (jl_id, survey_key)',
  'CREATE INDEX IF NOT EXISTS khatian_units_mouza_idx ON khatian_units (mouza_id)',
].join(';\n');

function filterRecords(records, q) {
  return (records || []).filter((r) => {
    if (q.khatian_no && toEn(r.khatianNo) !== toEn(q.khatian_no)) return false;
    if (q.owner_name && !norm(r.owners).includes(norm(q.owner_name))) return false;
    if (q.dag_no && !String(r.dags || '').includes(toEn(q.dag_no))) return false;
    return true;
  });
}

// The HTTP server passes snake_case query keys (jl_id,
// mouza_id, ...); direct callers may use camelCase. Accept
// both — the stored data and the filtered result are the
// same either way.
function normalizeQuery(q) {
  const o = q || {};
  return {
    jl_id: o.jl_id !== undefined ? o.jl_id : o.jlId,
    mouza_id: o.mouza_id !== undefined ? o.mouza_id : o.mouzaId,
    survey_key: o.survey_key !== undefined ? o.survey_key : o.surveyKey,
    khatian_no: o.khatian_no !== undefined ? o.khatian_no : o.khatianNo,
    owner_name: o.owner_name !== undefined ? o.owner_name : o.ownerName,
    dag_no: o.dag_no !== undefined ? o.dag_no : o.dagNo,
  };
}

function maxCollectedAt(records) {
  let best = null;
  for (const r of records || []) {
    if (r && r.collectedAt && (!best || String(r.collectedAt) > String(best))) best = r.collectedAt;
  }
  return best;
}

function toRecordRow(unit, r) {
  return {
    jl_id: String(unit.jlId), survey_key: unit.surveyKey,
    record_id: String(r.id),
    khatian_no: r.khatianNo != null ? String(r.khatianNo) : null,
    owners: r.owners != null ? String(r.owners) : null,
    dags: r.dags != null ? String(r.dags) : null,
    total_land: r.totalLand != null ? String(r.totalLand) : null,
    record: r, collected_at: r.collectedAt,
  };
}

/** pool: any object with async query(text, params) -> { rows }.
 *  A real `pg` Pool satisfies this; tests pass a fake. */
function createPgBackend(pool) {
  let schemaPromise = null;
  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = pool.query(PG_SCHEMA_SQL).catch((e) => {
        schemaPromise = null;
        throw e;
      });
    }
    await schemaPromise;
  }

  return {
    kind: 'postgres',

    async upsert({ area, surveyKey, surveyName, jlId, mouzaId, jlNumber, records, source, merge }) {
      await ensureSchema();
      const now = new Date().toISOString();
      const stamped = (records || []).map((r) => ({
        ...r, surveyKey, surveyName, jlId, collectedAt: r.collectedAt || now,
      }));
      const jl = String(jlId);
      const unit = { jlId: jl, surveyKey };
      const existed = await pool.query(
        'SELECT 1 FROM khatian_units WHERE jl_id = $1 AND survey_key = $2 LIMIT 1',
        [jl, surveyKey],
      ).then((res) => res.rows.length > 0);
      await pool.query(
        'INSERT INTO khatian_units '
        + '(jl_id, survey_key, area, survey_name, mouza_id, jl_number, source, collected_at) '
        + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) '
        + 'ON CONFLICT (jl_id, survey_key) DO UPDATE SET '
        + 'area = EXCLUDED.area, survey_name = EXCLUDED.survey_name, '
        + 'mouza_id = EXCLUDED.mouza_id, jl_number = EXCLUDED.jl_number, '
        + 'source = EXCLUDED.source, collected_at = EXCLUDED.collected_at',
        [jl, surveyKey, area || null, surveyName || null,
          mouzaId || (area && area.mouzaId) || null, jlNumber || null,
          source || 'dlrms', now],
      );
      if (!merge) {
        await pool.query(
          'DELETE FROM khatian_records WHERE jl_id = $1 AND survey_key = $2',
          [jl, surveyKey],
        );
      }
      for (const r of stamped) {
        const row = toRecordRow(unit, r);
        await pool.query(
          'INSERT INTO khatian_records '
          + '(jl_id, survey_key, record_id, khatian_no, owners, dags, total_land, record, collected_at) '
          + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) '
          + 'ON CONFLICT (jl_id, survey_key, record_id) DO UPDATE SET '
          + 'khatian_no = EXCLUDED.khatian_no, owners = EXCLUDED.owners, '
          + 'dags = EXCLUDED.dags, total_land = EXCLUDED.total_land, '
          + 'record = EXCLUDED.record, collected_at = EXCLUDED.collected_at',
          [row.jl_id, row.survey_key, row.record_id, row.khatian_no, row.owners,
            row.dags, row.total_land, row.record, row.collected_at],
        );
      }
      const total = await pool.query(
        'SELECT COUNT(*)::int AS n FROM khatian_records WHERE jl_id = $1 AND survey_key = $2',
        [jl, surveyKey],
      ).then((res) => Number((res.rows[0] || {}).n || 0));
      return { upserted: stamped.length, updated: existed, total };
    },

    async search(q) {
      await ensureSchema();
      const query = normalizeQuery(q);
      let units;
      if (query.jl_id) {
        const params = [String(query.jl_id)];
        let sql = 'SELECT jl_id, survey_key, mouza_id FROM khatian_units WHERE jl_id = $1';
        if (query.survey_key && query.survey_key !== 'all') {
          sql += ' AND survey_key = $2';
          params.push(query.survey_key);
        }
        units = await pool.query(sql, params).then((res) => res.rows);
      } else if (query.mouza_id) {
        const params = [String(query.mouza_id)];
        let sql = 'SELECT jl_id, survey_key, mouza_id FROM khatian_units WHERE mouza_id = $1';
        if (query.survey_key && query.survey_key !== 'all') {
          sql += ' AND survey_key = $2';
          params.push(query.survey_key);
        }
        units = await pool.query(sql, params).then((res) => res.rows);
      } else {
        return { records: [], collectedAt: null, totalMatches: 0, mouzaCollected: false };
      }
      // A stored unit counts as collected even when its
      // record list is empty (a mouza genuinely holding 0
      // khatians in this survey) — same rule as the file
      // backend.
      const mouzaCollected = units.length > 0;
      let all = [];
      for (const u of units) {
        const rows = await pool.query(
          'SELECT record FROM khatian_records WHERE jl_id = $1 AND survey_key = $2 ORDER BY record_id',
          [u.jl_id, u.survey_key],
        ).then((res) => res.rows);
        all = all.concat(rows.map((row) => row.record));
      }
      const records = filterRecords(all, query);
      return {
        records, collectedAt: maxCollectedAt(records),
        totalMatches: records.length, mouzaCollected,
      };
    },

    async countForUnit({ jlId, surveyKey }) {
      await ensureSchema();
      if (!jlId || !surveyKey) return { count: 0 };
      const n = await pool.query(
        'SELECT COUNT(DISTINCT record_id)::int AS n FROM khatian_records '
        + 'WHERE jl_id = $1 AND survey_key = $2',
        [String(jlId), surveyKey],
      ).then((res) => Number((res.rows[0] || {}).n || 0));
      return { count: n };
    },

    async ping() {
      await pool.query('SELECT 1');
      return { ok: true };
    },

    async close() {
      if (pool && typeof pool.end === 'function') await pool.end();
    },
  };
}

/** Build a real `pg` Pool from env only. Throws a generic
 *  error (env names only, never values) when nothing is
 *  configured, and a clear install error when `pg` is not
 *  installed in the store server's own node_modules. */
function createPgPoolFromEnv(env) {
  const e = env || process.env;
  const connectionString = e.STORE_PG_CONNECTION_STRING;
  let config;
  if (connectionString) {
    config = { connectionString };
  } else if (e.STORE_PG_DATABASE && e.STORE_PG_USER) {
    config = {
      host: e.STORE_PG_HOST || '127.0.0.1',
      port: Number(e.STORE_PG_PORT) || 5432,
      database: e.STORE_PG_DATABASE,
      user: e.STORE_PG_USER,
      password: e.STORE_PG_PASSWORD || undefined,
    };
  } else {
    throw new Error(
      'PostgreSQL store backend selected but no connection configured: '
      + 'set STORE_PG_CONNECTION_STRING or STORE_PG_HOST/STORE_PG_PORT/'
      + 'STORE_PG_DATABASE/STORE_PG_USER/STORE_PG_PASSWORD',
    );
  }
  if (e.STORE_PG_POOL_MAX) config.max = Number(e.STORE_PG_POOL_MAX) || 10;
  if (e.STORE_PG_SSL === 'true') config.ssl = true;
  if (e.STORE_PG_SSL === 'insecure') config.ssl = { rejectUnauthorized: false }; // dev only
  let Pool;
  try {
    // eslint-disable-next-line global-require
    Pool = require('pg').Pool;
  } catch (_) {
    throw new Error(
      'PostgreSQL store backend selected but the pg module is not installed: '
      + 'run npm install in engines/land-khatian/store-server',
    );
  }
  return new Pool(config);
}

module.exports = { createPgBackend, createPgPoolFromEnv, PG_SCHEMA_SQL };
