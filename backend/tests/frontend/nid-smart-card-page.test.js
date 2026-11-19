// Wiring guards for the NID Smart Card engine:
//  - the customer page exists at EXACTLY <engine_id>.html (the
//    service-detail rule builds '/' + engine_id + '.html' — the
//    land "logout" bug of 2026-10-23 came from missing pages)
//  - the page calls the right API paths (ABC.api() adds '/api'
//    itself — a hard-coded '/api/...' would double-prefix)
//  - ONE download option after Create (single card PDF), one charge
//  - dashboard cards (desktop + mobile) link to the page and the
//    charge labels refresh from the services list
//  - admin engine dropdowns offer the engine; migration 061 seeds
//    the service; server.js mounts the route
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('nid-smart-card.html', () => {
  const html = read('frontend/nid-smart-card.html');
  test('uses ABC.api-relative base, never a hard-coded /api path', () => {
    expect(html).toContain("const API = '/nid-smart-card'");
    expect(html).not.toContain("'/api/nid-smart-card'");
    expect(html).not.toContain('"/api/nid-smart-card"');
  });
  test('has extract + create + pdf flow endpoints', () => {
    expect(html).toContain("API + '/price'");
    expect(html).toContain("API + '/extract'");
    expect(html).toContain("API + '/create'");
    expect(html).toContain("API + '/pdf?'");
    expect(html).toContain('id="pdfFile"');
  });
  test('ONE download option after Create (single card PDF), one charge', () => {
    expect(html).toContain('id="optionBox"');
    expect(html).toContain('id="dlBtn"');
    expect(html).toContain('এক চার্জে একটি কার্ড PDF');
    expect(html).not.toContain('dlV1Btn');
    expect(html).not.toContain('dlV2Btn');
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
  test('download sends photo override + reports the card to engine-jobs', () => {
    expect(html).toContain('INVALID_PHOTO');
    expect(html).toContain("reportEngineJob('nid-smart-card'");
    expect(html).toContain('S.idem');
  });
  test('issue date is visible + editable in review (fix #5: today default shown)', () => {
    expect(html).toContain('প্রদানের তারিখ:');
    expect(html).toContain('আজকের তারিখ আগে থেকে বসানো আছে');
  });
  test('no Voter No field (fix #2: it never stands in for the National ID)', () => {
    expect(html).not.toContain("key: 'Voter No'");
    expect(html).not.toContain('ভোটার নম্বর');
  });
  test('no applicant-signature slot (the authority signature comes from shakkhor/)', () => {
    expect(html).not.toContain('sign.png');
    expect(html).not.toContain('স্বাক্ষর বদলান');
  });
});

describe('dashboard + admin + service-detail wiring', () => {
  test('dashboard links to /nid-smart-card.html (one ENGINE_CARDS entry, both grids)', () => {
    const dash = read('frontend/dashboard.html');
    expect(dash.split("href: '/nid-smart-card.html'").length - 1).toBe(1);
    expect(dash).toContain("s.engine_id === 'nid-smart-card'");
    expect(dash).toContain("chargeId: 'engChargeNidSmart'");
    // Audit #82 — the mobile id is derived ('m' + capitalised
    // chargeId), not a second hardcoded span.
    expect(dash).toContain("'m' + c.chargeId[0].toUpperCase()");
  });
  test('admin engine dropdowns offer nid-smart-card (create + edit)', () => {
    const admin = read('frontend/js/admin.js');
    expect(admin.split('nid-smart-card').length - 1).toBeGreaterThanOrEqual(3);
  });
  test('service-detail label override exists (generic URL rule already lands on the real page)', () => {
    const sd = read('frontend/service-detail.html');
    expect(sd).toContain("s.engine_id === 'nid-smart-card'");
    expect(fs.existsSync(path.join(ROOT, 'frontend', 'nid-smart-card.html'))).toBe(true);
  });
});

describe('backend wiring', () => {
  test('server.js mounts /api/nid-smart-card', () => {
    const srv = read('backend/server.js');
    expect(srv).toContain("app.use('/api/nid-smart-card'");
    expect(srv).toContain("require('./routes/nid-smart-card')");
  });
  test('migration 061 seeds the service at 0, idempotent, serial 17', () => {
    const mig = read('database/migrations/061_nid_smart_card_service.sql');
    expect(mig).toContain("'nid-smart-card'");
    expect(mig).toContain('WHERE NOT EXISTS');
    expect(mig).toContain(', 17,');
  });
  test('engine manifest id matches the page + route names', () => {
    const manifest = JSON.parse(read('engines/nid-smart-card/engine.json'));
    expect(manifest.id).toBe('nid-smart-card');
  });
  test('engine-jobs accepts the engine for delivery copies', () => {
    const ej = read('backend/routes/engine-jobs.js');
    expect(ej).toContain("'nid-smart-card'");
  });
});
