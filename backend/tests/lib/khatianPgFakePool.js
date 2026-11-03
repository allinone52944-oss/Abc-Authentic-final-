'use strict';

// In-memory fake for the `pg` Pool interface, used by the
// khatian PostgreSQL store tests. It implements ONLY the
// SQL shapes pgStore.js emits; any other SQL throws, so a
// drift in pgStore.js fails loudly instead of silently
// passing against a permissive fake. Synthetic data only.
function createFakePool() {
  const units = new Map();
  const records = new Map();
  const unitKey = (jl, survey) => jl + '\n' + survey;
  const recKey = (jl, survey, id) => jl + '\n' + survey + '\n' + id;
  const pool = {
    queries: [],
    units,
    records,
    ended: false,
    async query(sql, params) {
      pool.queries.push(sql);
      const p = params || [];
      if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) return { rows: [] };
      if (sql.includes('SELECT 1 FROM khatian_units')) {
        return { rows: units.has(unitKey(p[0], p[1])) ? [{ '1': 1 }] : [] };
      }
      if (sql.startsWith('SELECT 1')) return { rows: [{ '1': 1 }] };
      if (sql.includes('INSERT INTO khatian_units')) {
        units.set(unitKey(p[0], p[1]), {
          jl_id: p[0], survey_key: p[1], area: p[2], survey_name: p[3],
          mouza_id: p[4], jl_number: p[5], source: p[6], collected_at: p[7],
        });
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM khatian_records')) {
        for (const k of [...records.keys()]) {
          if (k.startsWith(p[0] + '\n' + p[1] + '\n')) records.delete(k);
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO khatian_records')) {
        records.set(recKey(p[0], p[1], p[2]), {
          jl_id: p[0], survey_key: p[1], record_id: p[2], khatian_no: p[3],
          owners: p[4], dags: p[5], total_land: p[6], record: p[7], collected_at: p[8],
        });
        return { rows: [] };
      }
      if (sql.includes('SELECT COUNT(*)::int AS n FROM khatian_records')) {
        let n = 0;
        for (const k of records.keys()) if (k.startsWith(p[0] + '\n' + p[1] + '\n')) n += 1;
        return { rows: [{ n }] };
      }
      if (sql.includes('SELECT COUNT(DISTINCT record_id)::int AS n')) {
        const ids = new Set();
        for (const k of records.keys()) {
          if (k.startsWith(p[0] + '\n' + p[1] + '\n')) ids.add(k.split('\n')[2]);
        }
        return { rows: [{ n: ids.size }] };
      }
      if (sql.includes('SELECT jl_id, survey_key, survey_name, mouza_id FROM khatian_units')) {
        const rows = [...units.values()].filter((u) => {
          if (sql.includes('WHERE jl_id')) return u.jl_id === p[0] && (p.length < 2 || u.survey_key === p[1]);
          return u.mouza_id === p[0] && (p.length < 2 || u.survey_key === p[1]);
        });
        return { rows };
      }
      if (sql.includes('SELECT record FROM khatian_records')) {
        const rows = [...records.values()]
          .filter((r) => r.jl_id === p[0] && r.survey_key === p[1])
          .sort((a, b) => (a.record_id < b.record_id ? -1 : 1))
          .map((r) => ({ record: r.record }));
        return { rows };
      }
      throw new Error('unexpected SQL in fake pool: ' + sql);
    },
    async end() { pool.ended = true; },
  };
  return pool;
}

module.exports = { createFakePool };
