// Audit #64 — the 16MB rates.js was parsed on every backend start
// (routes are required at boot) even though a request touches one
// office. The table is now split by office into rates/<id>.json and
// rates.js loads an office's shard only when it is read. Same API,
// same results (verified: 471,984 lookups/cards compared against
// the old module, 0 mismatches).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const RATES = require(path.join(ROOT, 'engines/land-mouza-value/rates.js'));

describe('rates split by office (audit #64)', () => {
  test('rates.js is a small loader, not the 16MB table', () => {
    const bytes = fs.statSync(path.join(ROOT, 'engines/land-mouza-value/rates.js')).size;
    expect(bytes).toBeLessThan(50000);
    const src = fs.readFileSync(path.join(ROOT, 'engines/land-mouza-value/rates.js'), 'utf8');
    expect(src).toContain('Audit #64');
    expect(src).not.toContain('const OFFICES = {');
  });

  test('one shard per office (488), each a valid office record', () => {
    const dir = path.join(ROOT, 'engines/land-mouza-value/rates');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(488);
    const one = JSON.parse(fs.readFileSync(path.join(dir, 'boalkhali.json'), 'utf8'));
    expect(one.name).toBe('বোয়ালখালী');
    expect(one.period).toBe('2025-2026');
    expect(Object.keys(one.mouzas).length).toBe(30);
  });

  test('requiring the module parses no rate data (fast boot)', () => {
    const out = execSync(
      `node -e "const s=Date.now();require('./engines/land-mouza-value/rates.js');console.log(Date.now()-s)"`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    expect(Number(out)).toBeLessThan(500);
  });

  test('lookups return the known rates (spot values from the old table)', () => {
    expect(RATES.lookupMouzaRate('boalkhali', 'কধুরখীল', 'নাল')).toMatchObject({
      office: 'boalkhali', rate: 121425, period: '2025-2026',
    });
    expect(RATES.lookupMouzaRate('chandgaon', 'বাকলিয়া', 'নাল')).toMatchObject({
      ambiguous: true, options: ['চান্দগাঁও', 'বদর', 'পাঁচলাইশ'],
    });
    expect(RATES.lookupMouzaRate('nope', 'x', 'নাল')).toBeNull();
    expect(RATES.OFFICES.nope).toBeUndefined();
    expect(Object.keys(RATES.OFFICES)).toHaveLength(488);
    expect(RATES.listLookupOffices()).toHaveLength(488);
    expect(RATES.listLookupClasses('boalkhali', 'কধুরখীল').sort()).toEqual(
      ['নাল', 'পুকুর', 'বাগান', 'বাড়ী', 'ভিটা']);
  });
});
