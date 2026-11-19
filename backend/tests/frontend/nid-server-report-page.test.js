// Wiring guards for the NID Server Copy Report engine:
//  - the customer page exists at EXACTLY <engine_id>.html (the
//    service-detail rule builds '/' + engine_id + '.html' — the
//    land "logout" bug of 2026-10-23 came from missing pages)
//  - the page calls the right API paths (ABC.api() adds '/api'
//    itself — a hard-coded '/api/...' would double-prefix)
//  - two download options after Create (v1 + v2), one charge
//  - dashboard cards (desktop + mobile) link to the page and the
//    charge labels refresh from the services list
//  - admin engine dropdowns offer the engine; migration 060 seeds
//    the service; server.js mounts the route
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('nid-server-report.html', () => {
  const html = read('frontend/nid-server-report.html');
  test('uses ABC.api-relative base, never a hard-coded /api path', () => {
    expect(html).toContain("const API = '/nid-server-report'");
    expect(html).not.toContain("'/api/nid-server-report'");
    expect(html).not.toContain('"/api/nid-server-report"');
  });
  test('has extract + create + pdf flow endpoints', () => {
    expect(html).toContain("API + '/price'");
    expect(html).toContain("API + '/extract'");
    expect(html).toContain("API + '/create'");
    expect(html).toContain("API + '/pdf?'");
    expect(html).toContain('id="pdfFile"');
  });
  test('two download options after Create (v1 + v2), one charge', () => {
    expect(html).toContain('id="optionBox"');
    expect(html).toContain('id="dlV1Btn"');
    expect(html).toContain('id="dlV2Btn"');
    expect(html).toContain("download('v1')");
    expect(html).toContain("download('v2')");
    expect(html).toContain('এক চার্জে দুটো ফাইল');
    expect(html).toContain('এক চার্জে দুটো PDF');
  });
  test('trust lines: no charge on failure', () => {
    expect(html).toContain('ব্যর্থ হলে চার্জ: ৳০');
    expect(html).toContain('কোনো টাকা কাটা হয়নি');
  });
  test('PDF arrives via authenticated fetch -> blob (never a plain link)', () => {
    expect(html).toContain("ct.includes('application/pdf')");
    expect(html).toContain('r.blob()');
  });
  test('finished PDF OPENS in a new tab, not only saved (2026-10-24 video bug)', () => {
    expect(html).toContain("window.open('', '_blank')");
    expect(html).toContain('viewer.location = url');
    expect(html).toContain('নতুন ট্যাবে ফর্মটি খুলেছে');
  });
  test('success/error message scrolls into view (boxes sit above the panels)', () => {
    expect(html).toContain('function scrollBoxIntoView()');
    expect(html).toContain('scrollIntoView');
    expect(html).toContain('নতুন ট্যাবে ফর্মটি খুলেছে');
  });
  test('edit form: review step + fields + photo slot', () => {
    expect(html).toContain('id="editFields"');
    expect(html).toContain('id="fieldForm"');
    expect(html).toContain('id="imgPrev"');
    expect(html).toContain('সব তথ্য এডিট করা যাবে');
    expect(html).toContain('PHOTO_STATE');
  });
  test('download sends photo override + reports both files to engine-jobs', () => {
    expect(html).toContain('INVALID_PHOTO');
    expect(html).toContain("reportEngineJob('nid-server-report'");
    expect(html).toContain("S.idem + '-' + kind");
  });
  test('review renders address sections (present + permanent)', () => {
    expect(html).toContain('Present Address');
    expect(html).toContain('Permanent Address');
    expect(html).toContain('বর্তমান ঠিকানা');
    expect(html).toContain('স্থায়ী ঠিকানা');
  });
});

describe('dashboard + admin + service-detail wiring', () => {
  test('dashboard links to /nid-server-report.html (one ENGINE_CARDS entry, both grids)', () => {
    const dash = read('frontend/dashboard.html');
    expect(dash.split("href: '/nid-server-report.html'").length - 1).toBe(1);
    expect(dash).toContain("s.engine_id === 'nid-server-report'");
    expect(dash).toContain("chargeId: 'engChargeNidSr'");
    // Audit #82 — the mobile id is derived ('m' + capitalised
    // chargeId), not a second hardcoded span.
    expect(dash).toContain("'m' + c.chargeId[0].toUpperCase()");
  });
  test('admin engine dropdowns offer nid-server-report (create + edit)', () => {
    const admin = read('frontend/js/admin.js');
    expect(admin.split('nid-server-report').length - 1).toBeGreaterThanOrEqual(3);
  });
  test('service-detail label override exists (generic URL rule already lands on the real page)', () => {
    const sd = read('frontend/service-detail.html');
    expect(sd).toContain("s.engine_id === 'nid-server-report'");
    expect(fs.existsSync(path.join(ROOT, 'frontend', 'nid-server-report.html'))).toBe(true);
  });
});

describe('backend wiring', () => {
  test('server.js mounts /api/nid-server-report', () => {
    const srv = read('backend/server.js');
    expect(srv).toContain("app.use('/api/nid-server-report'");
    expect(srv).toContain("require('./routes/nid-server-report')");
  });
  test('migration 060 seeds the service at 0, idempotent, serial 16', () => {
    const mig = read('database/migrations/060_nid_server_report_service.sql');
    expect(mig).toContain("'nid-server-report'");
    expect(mig).toContain('WHERE NOT EXISTS');
    expect(mig).toContain(', 16,');
  });
  test('engine manifest id matches the page + route names', () => {
    const manifest = JSON.parse(read('engines/nid-server-report/engine.json'));
    expect(manifest.id).toBe('nid-server-report');
  });
  test('engine-jobs accepts the engine for delivery copies', () => {
    const ej = read('backend/routes/engine-jobs.js');
    expect(ej).toContain("'nid-server-report'");
  });
});
