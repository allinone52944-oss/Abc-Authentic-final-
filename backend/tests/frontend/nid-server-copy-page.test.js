// Wiring guards for the NID Server Copy engine:
//  - the customer page exists at EXACTLY <engine_id>.html (the
//    service-detail rule builds '/' + engine_id + '.html' — the
//    land "logout" bug of 2026-10-23 came from missing pages)
//  - the page calls the right API paths (ABC.api() adds '/api'
//    itself — a hard-coded '/api/...' would double-prefix)
//  - dashboard cards (desktop + mobile) link to the page and the
//    charge labels refresh from the services list
//  - admin engine dropdowns offer the engine; migration 041 seeds
//    the service; server.js mounts the route; deploy.sh installs
//    the engine's dependencies
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('nid-server-copy.html', () => {
  const html = read('frontend/nid-server-copy.html');
  test('uses ABC.api-relative base, never a hard-coded /api path', () => {
    expect(html).toContain("const API = '/nid-server-copy'");
    expect(html).not.toContain("'/api/nid-server-copy'");
    expect(html).not.toContain('"/api/nid-server-copy"');
  });
  test('has credential + captcha relay flow endpoints', () => {
    expect(html).toContain("API + '/price'");
    expect(html).toContain("API + '/start'");
    expect(html).toContain("API + '/captcha'");
    expect(html).toContain("API + '/deliver'");
    expect(html).toContain('id="captchaImg"');
    expect(html).toContain('type="password"');
  });
  test('two download options after login (card + server copy)', () => {
    expect(html).toContain('id="optionBox"');
    expect(html).toContain('id="dlCardBtn"');
    expect(html).toContain('id="dlServerBtn"');
    expect(html).toContain("deliver('card'");
    expect(html).toContain("deliver('server'");
    expect(html).toContain('প্রতিটি ডাউনলোডে কাটবে');
  });
  test('trust lines: password not stored, no card -> no charge', () => {
    expect(html).toContain('সংরক্ষণ করা হয় না');
    expect(html).toContain('ব্যর্থ হলে চার্জ: ৳০');
  });
  test('PDF arrives via authenticated fetch -> blob (never a plain link)', () => {
    expect(html).toContain("ct.includes('application/pdf')");
    expect(html).toContain('r.blob()');
  });
  test('finished PDF OPENS in a new tab, not only saved (2026-10-24 video bug)', () => {
    // The video showed downloads landing in the tray while no form ever
    // opened on screen: blob <a download> never opens a viewer. deliver()
    // must open the viewer tab inside the tap gesture (async window.open
    // would be popup-blocked) and fall back to forced download only if blocked.
    expect(html).toContain("window.open('', '_blank')");
    expect(html).toContain('viewer.location = url');
    expect(html).toContain('নতুন ট্যাবে ফর্মটি খুলেছে');
    // fallback path kept: same filenames as before
    expect(html).toContain("a.download = kind === 'card' ? 'nid-card.pdf' : 'nid-server-copy.pdf'");
  });
  test('success/error message scrolls into view (boxes sit above the panels)', () => {
    expect(html).toContain('function scrollBoxIntoView()');
    expect(html).toContain('scrollIntoView');
    expect(html).toContain('নতুন ট্যাবে খুলবে');
  });
});

describe('dashboard + admin + service-detail wiring', () => {
  test('dashboard links to /nid-server-copy.html twice (desktop + mobile)', () => {
    const dash = read('frontend/dashboard.html');
    expect(dash.split("location.href='/nid-server-copy.html'").length - 1).toBe(2);
    expect(dash).toContain("s.engine_id === 'nid-server-copy'");
    expect(dash).toContain('engChargeNidSc');
    expect(dash).toContain('mEngChargeNidSc');
  });
  test('admin engine dropdowns offer nid-server-copy (create + edit)', () => {
    const admin = read('frontend/js/admin.js');
    expect(admin.split('nid-server-copy').length - 1).toBeGreaterThanOrEqual(3);
  });
  test('service-detail label override exists (generic URL rule already lands on the real page)', () => {
    const sd = read('frontend/service-detail.html');
    expect(sd).toContain("s.engine_id === 'nid-server-copy')");
    expect(fs.existsSync(path.join(ROOT, 'frontend', 'nid-server-copy.html'))).toBe(true);
  });
});

describe('backend wiring', () => {
  test('server.js mounts /api/nid-server-copy', () => {
    const srv = read('backend/server.js');
    expect(srv).toContain("app.use('/api/nid-server-copy'");
    expect(srv).toContain("require('./routes/nid-server-copy')");
  });
  test('migration 041 seeds the service at 150, idempotent', () => {
    const mig = read('database/migrations/041_nid_server_copy.sql');
    expect(mig).toContain("'nid-server-copy'");
    expect(mig).toContain('150');
    expect(mig).toContain('WHERE NOT EXISTS');
  });
  test('deploy.sh installs nid-server-copy engine deps', () => {
    const deploy = read('deploy.sh');
    expect(deploy).toContain('nid-server-copy');
  });
  test('engine manifest id matches the page + route names', () => {
    const manifest = JSON.parse(read('engines/nid-server-copy/engine.json'));
    expect(manifest.id).toBe('nid-server-copy');
  });
});
