// Wiring guards for the NID Smart Card engine:
//  - the customer page exists at EXACTLY <engine_id>.html (the
//    service-detail rule builds '/' + engine_id + '.html' — the
//    land "logout" bug of 2026-10-23 came from missing pages)
//  - the page calls the right API paths (ABC.api() adds '/api'
//    itself — a hard-coded '/api/...' would double-prefix)
//  - single-step build like nid-replica: ONE Create click returns
//    the card PDF in the same response (build first, charge after
//    success); no /create + /pdf split, no client idempotency key
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
  test('has extract + build flow endpoints (no /create + /pdf split)', () => {
    expect(html).toContain("API + '/price'");
    expect(html).toContain("API + '/extract'");
    expect(html).toContain("API + '/build'");
    expect(html).not.toContain("API + '/create'");
    expect(html).not.toContain("API + '/pdf?'");
    expect(html).not.toContain('idempotency_key');
    expect(html).toContain('id="pdfFile"');
  });
  test('ONE Create click returns the PDF (iframe + download link, like nid-replica)', () => {
    expect(html).toContain('id="cardFrame"');
    expect(html).toContain('id="b4"');
    expect(html).toContain('সফল হলে টাকা কাটবে');
    expect(html).not.toContain('id="optionBox"');
    expect(html).not.toContain('id="dlBtn"');
    expect(html).not.toContain('এক চার্জে একটি কার্ড PDF');
    expect(html).not.toContain('ব্যর্থ হলে চার্জ: ৳০');
    expect(html).not.toContain('dlV1Btn');
    expect(html).not.toContain('dlV2Btn');
  });
  test('trust lines: charge only on success, no charge on failure', () => {
    expect(html).toContain('সফল হলে টাকা কাটবে');
    expect(html).toContain('কোনো টাকা কাটা হয়নি');
    expect(html).not.toContain('ব্যর্থ হলে চার্জ: ৳০');
  });
  test('PDF arrives via authenticated fetch -> blob into the iframe (never a plain link)', () => {
    expect(html).toContain('r.blob()');
    expect(html).toContain("getElementById('cardFrame')");
    expect(html).toContain("getElementById('b4')");
    expect(html).not.toContain("window.open('', '_blank')");
  });
  test('wizard structure like nid-replica: w1/w3/w4, no step bar, no dead editFields', () => {
    expect(html).toContain('id="w1"');
    expect(html).toContain('id="w3"');
    expect(html).toContain('id="w4"');
    expect(html).not.toContain('id="w2"');
    expect(html).not.toContain('<div class="steps">');
    expect(html).not.toContain('id="editFields"');
  });
  test('review step: fields + photo AND signature slots (like nid-replica)', () => {
    expect(html).toContain('id="fieldForm"');
    expect(html).toContain('id="imgPrev"');
    expect(html).toContain('renderImagesUI');
    expect(html).toContain('sign.png');
    expect(html).toContain('স্বাক্ষর বদলান');
    expect(html).toContain('ছবি বদলান');
  });
  test('build sends photo+sign images in one call, no engine-jobs report', () => {
    expect(html).toContain('images:imgs');
    expect(html).toContain('S.sign');
    expect(html).not.toContain('reportEngineJob');
    expect(html).not.toContain('S.idem');
    expect(html).not.toContain('newIdem');
  });
  test('issue date is visible + editable in review (fix #5: today default shown)', () => {
    expect(html).toContain('প্রদানের তারিখ:');
    expect(html).toContain('আজকের তারিখ আগে থেকে বসানো আছে');
  });
  test('no Voter No field (fix #2: it never stands in for the National ID)', () => {
    expect(html).not.toContain("key: 'Voter No'");
    expect(html).not.toContain('ভোটার নম্বর');
    // the replica's label must NOT come back with the alignment
    expect(html).not.toContain('এনআইডি / ভোটার আইডি নম্বর');
    expect(html).toContain("label: 'এনআইডি নম্বর'");
  });
});

describe('dashboard + admin + service-detail wiring', () => {
  test('dashboard links to /nid-smart-card.html (one ENGINE_CARDS entry, both grids)', () => {
    const dash = read('frontend/dashboard.html');
    expect(dash.split("href: '/nid-smart-card.html'").length - 1).toBe(1);
    expect(dash).toContain("engineId: 'nid-smart-card'");
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
