// Service row + link for the E-Passport engine (migration
// 059): the new engine page lives in frontend/epassport.html
// and is published as a service. Price is deliberately 0 —
// the admin sets the fee in Admin → Services (same
// convention as migration 048 for land-mouza-map and 058
// for passport/sanad). No live DB; the migration text is
// the contract.
const fs = require('fs');
const path = require('path');

const mig = fs.readFileSync(
  path.join(__dirname, '../../../database/migrations/059_epassport_service.sql'),
  'utf8',
);

describe('migration 059_epassport_service.sql', () => {
  test('inserts the E-Passport Engine service row (price 0, active, serial 15)', () => {
    expect(mig).toContain("'E-Passport Engine', 'ই-পাসপোর্ট ইঞ্জিন', 'automated', 0, 15,");
    expect(mig).toContain("'epassport', 'active'");
  });

  test('the insert is idempotent (WHERE NOT EXISTS on engine_id)', () => {
    expect(mig).toContain("WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'epassport')");
  });

  test('price is deliberately 0 — the admin sets it (same convention as 048/058)', () => {
    expect(mig).toMatch(/PRICE IS DELIBERATELY 0/);
    // No non-zero price anywhere in the INSERT.
    expect(mig).not.toMatch(/'automated', [1-9]/);
  });

  test('serial 15 follows passport (13) and sanad (14) — no serial clash', () => {
    expect(mig).not.toContain(', 13,');
    expect(mig).not.toContain(', 14,');
  });
});
