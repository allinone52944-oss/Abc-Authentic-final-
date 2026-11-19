// Service row + link for the NID Smart Card engine
// (migration 061): the new engine page lives in
// frontend/nid-smart-card.html and is published as a service.
// Price is deliberately 0 — the admin sets the fee in Admin →
// Services (same convention as migration 048 for land-mouza-map
// and 058/059/060 for passport/sanad/e-passport/server-report).
// No live DB; the migration text is the contract.
const fs = require('fs');
const path = require('path');

const mig = fs.readFileSync(
  path.join(__dirname, '../../../database/migrations/061_nid_smart_card_service.sql'),
  'utf8',
);

describe('migration 061_nid_smart_card_service.sql', () => {
  test('inserts the NID Smart Card service row (price 0, active, serial 17)', () => {
    expect(mig).toContain("'Sign to Smart Card Pdf', 'স্মার্ট কার্ড পিডিএফ', 'automated', 0, 17,");
    expect(mig).toContain("'nid-smart-card', 'active'");
  });

  test('the insert is idempotent (WHERE NOT EXISTS on engine_id)', () => {
    expect(mig).toContain("WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'nid-smart-card')");
  });

  test('price is deliberately 0 — the admin sets it (same convention as 048/058/059/060)', () => {
    expect(mig).toMatch(/PRICE IS DELIBERATELY 0/);
    // No non-zero price anywhere in the INSERT.
    expect(mig).not.toMatch(/'automated', [1-9]/);
  });

  test('serial 17 follows server-report (16) — no serial clash', () => {
    expect(mig).not.toContain(', 16,');
    expect(mig).not.toContain(', 15,');
    expect(mig).not.toContain(', 14,');
  });
});
