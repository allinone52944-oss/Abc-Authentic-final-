// 2026-10-15 production incident regression:
// migrate.js applies database/schema.sql on EVERY deploy. Databases created
// before 2026-10-15 have an `orders` table WITHOUT `idempotency_key`
// (added to schema.sql by the M-2/M-15 fix). CREATE TABLE IF NOT EXISTS is a
// no-op there, so `CREATE UNIQUE INDEX idx_orders_user_idem ON
// orders(user_id, idempotency_key)` failed with
// 'column "idempotency_key" does not exist' -> migrate FAILED -> deploy.sh
// refused to restart -> every deploy wedged, new code never went live.
//
// This test simulates the OLD production schema and walks schema.sql in
// execution order, failing if any statement references a column the old DB
// does not have (unless the statement itself adds the column first, or it
// sits inside a runtime-guarded DO block like the category_id guard).
const fs = require('fs');
const path = require('path');

const schema = fs.readFileSync(
  path.join(__dirname, '../../../database/schema.sql'),
  'utf8'
);

// Columns added to EXISTING tables on/after 2026-10-15 (from git history of
// schema.sql). Old production DBs lack exactly these.
const MISSING_IN_OLD_DB = {
  orders: new Set(['idempotency_key']),
  users: new Set(['token_version']),
  refresh_tokens: new Set(['last_activity']),
};

function tableColumns(table) {
  const m = schema.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i')
  );
  const cols = new Set();
  if (m) {
    for (const line of m[1].split('\n')) {
      const cm = line.trim().match(/^([a-z_][a-z0-9_]*)\s/i);
      if (cm && !/^(primary|foreign|unique|check|constraint)$/i.test(cm[1])) cols.add(cm[1].toLowerCase());
    }
  }
  for (const c of MISSING_IN_OLD_DB[table] || []) cols.delete(c);
  return cols;
}

describe('2026-10-15: schema.sql re-applies cleanly on pre-2026-10-15 databases', () => {
  // Strip runtime-guarded DO blocks (e.g. the category_id index guard) —
  // those check column existence at runtime and are safe by construction.
  const stripped = schema.replace(/DO \$\$[\s\S]*?END \$\$;/gi, '');

  test('every CREATE INDEX references only columns the old DB has (or that an earlier ALTER adds)', () => {
    const known = {};
    const failures = [];
    // Collect ALTER ... ADD COLUMN statements in order with their positions.
    const alters = [];
    const alterRe = /ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/gi;
    let am;
    while ((am = alterRe.exec(stripped))) {
      alters.push({ table: am[1].toLowerCase(), col: am[2].toLowerCase(), pos: am.index });
    }
    const indexRe = /CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+(\w+)\s*\(([^)]+)\)([^;]*);/gi;
    let im;
    while ((im = indexRe.exec(stripped))) {
      const table = im[2].toLowerCase();
      const cols = im[3].split(',').map((c) => c.trim().toLowerCase().split(/\s+/)[0]);
      const where = im[4] || '';
      const wm = where.match(/WHERE\s+(\w+)/i);
      if (wm) cols.push(wm[1].toLowerCase());
      if (!known[table]) known[table] = tableColumns(table);
      // Apply any ALTERs positioned before this index.
      for (const a of alters) {
        if (a.table === table && a.pos < im.index) known[table].add(a.col);
      }
      for (const c of cols) {
        if (!known[table].has(c)) {
          failures.push(`${table}.${c} (index at offset ${im.index})`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
