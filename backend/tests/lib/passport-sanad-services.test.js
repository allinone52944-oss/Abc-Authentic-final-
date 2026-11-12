// Service rows + links for the Passport and Sanad engines
// (migration 058): the two engine pages moved into frontend/
// static serving in 592f4e2, and this migration publishes
// them as services. Price is deliberately 0 — the admin
// sets the fee in Admin → Services (same convention as
// migration 048 for land-mouza-map). No live DB; the
// migration text is the contract.
const fs = require('fs');
const path = require('path');

const mig = fs.readFileSync(
  path.join(__dirname, '../../../database/migrations/058_passport_sanad_services.sql'),
  'utf8',
);

describe('migration 058_passport_sanad_services.sql', () => {
  test('inserts the Passport Engine service row (price 0, active, serial 13)', () => {
    expect(mig).toContain("'Passport Engine', 'পাসপোর্ট ইঞ্জিন', 'automated', 0, 13,");
    expect(mig).toContain("'passport', 'active'");
  });

  test('inserts the Sanad & Certificate Engine service row (price 0, active, serial 14)', () => {
    expect(mig).toContain("'BD Sanad & Certificate Engine', 'সনদ ও সার্টিফিকেট ইঞ্জিন', 'automated', 0, 14,");
    expect(mig).toContain("'sanad', 'active'");
  });

  test('both inserts are idempotent (WHERE NOT EXISTS on engine_id)', () => {
    expect(mig).toContain("WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'passport')");
    expect(mig).toContain("WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'sanad')");
  });

  test('price is deliberately 0 — the admin sets it (same convention as 048)', () => {
    expect(mig).toMatch(/PRICE IS DELIBERATELY 0/);
    // No non-zero price anywhere in the two INSERTs.
    expect(mig).not.toMatch(/'automated', [1-9]/);
  });
});
