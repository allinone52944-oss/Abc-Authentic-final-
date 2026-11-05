// Audit #14 — gate IDs are the directory names (birth-final /
// death-final). The rename must hold end to end: gate mounts,
// charge rules, admin dropdowns, pages, and the services-table
// migration — otherwise a price row under the old ID silently
// runs the service free (the item-17 trap).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

describe('audit #14 — gate IDs are the directory names', () => {
  test('the gates mount the engines under their directory names', () => {
    const server = read('backend/server.js');
    expect(server).toContain("chargeGate('birth-final', 'birth', '/api/bdris-engine')");
    expect(server).toContain("chargeGate('death-final', 'death', '/api/death-engine')");
    expect(server).not.toContain("chargeGate('bdris-certificate'");
    expect(server).not.toContain("chargeGate('death-verify'");
  });

  test('the customer pages live under the new names; the old pages are gone', () => {
    expect(exists('frontend/birth-final.html')).toBe(true);
    expect(exists('frontend/death-final.html')).toBe(true);
    expect(exists('frontend/bdris-certificate.html')).toBe(false);
    expect(exists('frontend/death-verify.html')).toBe(false);
    // The generic service-detail rule ('/' + engine_id + '.html')
    // resolves to the new pages, so no override is needed.
    const sd = read('frontend/service-detail.html');
    expect(sd).toContain("s.engine_id === 'birth-final'");
    expect(sd).toContain("s.engine_id === 'death-final'");
    const dash = read('frontend/dashboard.html');
    expect(dash.split("location.href='/birth-final.html'").length - 1).toBe(2);
    expect(dash.split("location.href='/death-final.html'").length - 1).toBe(2);
  });

  test('the charge-rule map keys the new IDs (11-engine closed set)', () => {
    const rules = read('backend/lib/chargeRule.js');
    expect(rules).toContain("'birth-final': ['success', 'যাচাই সফল হলেই']");
    expect(rules).toContain("'death-final': ['success', 'যাচাই সফল হলেই']");
    expect(rules).not.toContain('bdris-certificate');
    expect(rules).not.toContain('death-verify');
    expect(rules).not.toContain('land-search');
  });

  test('the admin dropdowns offer the new IDs (and the stale Port 3000 label is gone)', () => {
    const admin = read('frontend/js/admin.js');
    for (const id of ['birth-final', 'death-final']) {
      expect(admin).toContain('<option value="' + id + '"');
    }
    expect(admin).not.toContain('bdris-certificate');
    expect(admin).not.toContain('death-verify');
    expect(admin).not.toContain('Port 3000');
    expect(admin).not.toContain('land-search');
    // land-mouza-map keeps its proper entry in both dropdowns.
    expect(admin.split('<option value="land-mouza-map"').length - 1).toBe(2);
  });

  test('migration 052 renames the services + engine_jobs rows in the same change', () => {
    const mig = read('database/migrations/052_engine_ids_birth_death_final.sql');
    expect(mig).toContain("UPDATE services SET engine_id = 'birth-final'");
    expect(mig).toContain("WHERE engine_id = 'bdris-certificate'");
    expect(mig).toContain("UPDATE services SET engine_id = 'death-final'");
    expect(mig).toContain("WHERE engine_id = 'death-verify'");
    expect(mig).toContain("UPDATE engine_jobs SET engine_id = 'birth-final'");
    expect(mig).toContain("UPDATE engine_jobs SET engine_id = 'death-final'");
  });

  test('the engine-jobs allow-list + labels use the new IDs', () => {
    const jobs = read('backend/routes/engine-jobs.js');
    expect(jobs).toContain("const ENGINES = ['birth-final', 'death-final'];");
    expect(jobs).toContain("'birth-final': 'জন্ম সনদ যাচাই'");
    expect(jobs).toContain("'death-final': 'মৃত্যু সনদ যাচাই'");
    expect(jobs).not.toContain('bdris-certificate');
    expect(jobs).not.toContain('death-verify');
  });
});
