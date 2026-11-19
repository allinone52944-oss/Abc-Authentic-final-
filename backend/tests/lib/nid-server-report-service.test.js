// Service row + link for the NID Server Copy Report engine
// (migration 060): the new engine page lives in
// frontend/nid-server-report.html and is published as a service.
// Price is deliberately 0 — the admin sets the fee in Admin →
// Services (same convention as migration 048 for land-mouza-map
// and 058/059 for passport/sanad/e-passport). No live DB; the
// migration text is the contract.
const fs = require('fs');
const path = require('path');

const mig = fs.readFileSync(
  path.join(__dirname, '../../../database/migrations/060_nid_server_report_service.sql'),
  'utf8',
);

describe('migration 060_nid_server_report_service.sql', () => {
  test('inserts the NID Server Copy Report service row (price 0, active, serial 16)', () => {
    expect(mig).toContain("'NID Server Copy Report', 'এনআইডি সার্ভার কপি রিপোর্ট', 'automated', 0, 16,");
    expect(mig).toContain("'nid-server-report', 'active'");
  });

  test('the insert is idempotent (WHERE NOT EXISTS on engine_id)', () => {
    expect(mig).toContain("WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'nid-server-report')");
  });

  test('price is deliberately 0 — the admin sets it (same convention as 048/058/059)', () => {
    expect(mig).toMatch(/PRICE IS DELIBERATELY 0/);
    // No non-zero price anywhere in the INSERT.
    expect(mig).not.toMatch(/'automated', [1-9]/);
  });

  test('serial 16 follows e-passport (15) — no serial clash', () => {
    expect(mig).not.toContain(', 15,');
    expect(mig).not.toContain(', 14,');
    expect(mig).not.toContain(', 13,');
  });
});
