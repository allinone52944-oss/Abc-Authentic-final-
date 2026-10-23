// Wiring guards for the land services (DLRMS):
//  - the customer page exists and calls the RIGHT api paths
//    (ABC.api() adds '/api' itself — a hard-coded '/api/land'
//    would double-prefix and silently 404)
//  - the dashboard links to the page (desktop + mobile cards)
//  - the admin engine dropdowns offer the three land engines
//  - migration 040 seeds the three services
//  - server.js mounts /api/land
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('land.html', () => {
  const html = read('frontend/land.html');
  test('uses ABC.api-relative base, never a hard-coded /api path', () => {
    expect(html).toContain("const API = '/land'");
    expect(html).not.toContain("'/api/land'");
    expect(html).not.toContain('"/api/land"');
  });
  test('has the three modes and calls all three endpoints', () => {
    for (const m of ['search', 'scan', 'verify']) {
      expect(html).toContain('data-mode="' + m + '"');
    }
    expect(html).toContain("API + '/' + MODE");
    expect(html).toContain("API + '/price?mode='");
    expect(html).toContain("API + '/geo/divisions'");
    expect(html).toContain("API + '/geo/mouzas?");
  });
  test('trust line: no record → no charge', () => {
    expect(html).toContain('রেকর্ড না পেলে চার্জ: ৳০');
  });
});

describe('dashboard + admin wiring', () => {
  test('dashboard links to /land.html twice (desktop + mobile)', () => {
    const dash = read('frontend/dashboard.html');
    expect(dash.split("location.href='/land.html'").length - 1).toBe(2);
  });
  test('admin engine dropdowns offer the three land engines', () => {
    const admin = read('frontend/js/admin.js');
    for (const id of ['land-search', 'land-scan', 'land-verify']) {
      expect(admin.split('value="' + id + '"').length - 1).toBeGreaterThanOrEqual(1);
      expect(admin.split('value=\\"' + id + '\\"').length - 1 + admin.split('value="' + id + '"').length - 1).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('backend wiring', () => {
  test('server mounts /api/land', () => {
    expect(read('backend/server.js')).toContain("app.use('/api/land'");
  });
  test('migration 040 seeds the three services idempotently', () => {
    const sql = read('database/migrations/040_land_services.sql');
    for (const id of ['land-search', 'land-scan', 'land-verify']) {
      expect(sql).toContain("'" + id + "'");
      expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = '" + id + "')");
    }
  });
  test('engine manifests exist for the three engines', () => {
    for (const id of ['land-search', 'land-scan', 'land-verify']) {
      const m = JSON.parse(read('engines/' + id + '/engine.json'));
      expect(m.id).toBe(id);
    }
  });
});
