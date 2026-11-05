// Audit #23 — TrxID comparisons must be case-folded, in code and
// in the schema. No live DB is available in tests, so the schema
// half is pinned statically (the migration file's contents), and
// the code half is pinned on the real SQL text.
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

test('user.js DUP check folds case', () => {
  const src = read('backend/routes/user.js');
  expect(src).toContain('WHERE UPPER(trxid) = UPPER($1) LIMIT 1');
});

test('sms.js duplicate-SMS guard folds case', () => {
  const src = read('backend/routes/sms.js');
  expect(src).toContain('WHERE UPPER(trxid) = UPPER($1) AND matched_recharge_id IS NOT NULL');
});

describe('migration 049_tx_trxid_unique_casefold.sql', () => {
  const mig = read('database/migrations/049_tx_trxid_unique_casefold.sql');

  test('creates the case-insensitive unique index', () => {
    expect(mig).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_user_trxid_unique_ci');
    expect(mig).toContain('ON transactions(user_id, UPPER(trxid)) WHERE trxid IS NOT NULL');
  });

  test('drops the old case-sensitive index after the new one', () => {
    expect(mig).toContain('DROP INDEX IF EXISTS idx_tx_user_trxid_unique');
    expect(mig.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_user_trxid_unique_ci'))
      .toBeLessThan(mig.indexOf('DROP INDEX IF EXISTS idx_tx_user_trxid_unique'));
  });

  test('redefines wallet_apply with the case-folded double-credit guard', () => {
    expect(mig).toContain('CREATE OR REPLACE FUNCTION wallet_apply(');
    expect(mig).toContain('WHERE user_id = p_user AND UPPER(trxid) = UPPER(p_ref)');
  });

  test('it is the next migration number (runs after 048)', () => {
    const files = fs.readdirSync(path.join(repoRoot, 'database', 'migrations'))
      .filter((f) => f.endsWith('.sql')).sort();
    // Pin the position in the sequence, not "is last" — later
    // migrations (050, 051) broke the old last-file assertion.
    expect(files.indexOf('049_tx_trxid_unique_casefold.sql'))
      .toBe(files.indexOf('048_land_mouza_map.sql') + 1);
  });
});
