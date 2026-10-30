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

describe('service-detail routing (the logout bug)', () => {
  // service-detail.html sends every automated service to
  // '/' + engine_id + '.html'. The land engines share land.html,
  // so WITHOUT explicit overrides the buttons pointed at
  // non-existent /land-search.html etc. — unknown .html paths
  // fall back to the login page (looked like a forced logout).
  const sd = read('frontend/service-detail.html');
  test('each land engine maps to land.html with its mode', () => {
    expect(sd).toContain("s.engine_id === 'land-search') { engineUrl = '/land.html?mode=search'");
    expect(sd).toContain("s.engine_id === 'land-scan') { engineUrl = '/land.html?mode=scan'");
    expect(sd).toContain("s.engine_id === 'land-verify') { engineUrl = '/land.html?mode=verify'");
  });
  test('land.html honours the ?mode= preselect', () => {
    const html = read('frontend/land.html');
    expect(html).toContain("new URLSearchParams(location.search).get('mode')");
  });
});

describe('downloads go through the login (the NO_TOKEN bug)', () => {
  // Delivery files are owner-only: a plain <a href> sends no
  // login header and the server answers {"error":"NO_TOKEN"}.
  // History downloads via ABC.api → blob; land.html must too.
  const html = read('frontend/land.html');
  test('receipt/report downloads use an authenticated blob fetch', () => {
    expect(html).toContain('async function dlPdf(');
    expect(html).toContain('URL.createObjectURL(blob)');
    expect(html).toContain("dlPdf(\\'");
  });
  test('no raw receipt href remains', () => {
    expect(html).not.toContain('href="\' + esc(r.receipt)');
  });
});

describe('catalog shows land ONCE (the duplicate complaint)', () => {
  const svcs = read('frontend/services.html');
  test('services page collapses the three land engines into one card', () => {
    expect(svcs).toContain('function groupLand(');
    expect(svcs).toContain("LAND_ENGINES = ['land-search', 'land-scan', 'land-verify']");
    expect(svcs).toContain('ALL_SERVICES = groupLand(services || [])');
    expect(svcs).toContain("_landGroup: true");
  });
  test('the group card opens the single land page', () => {
    expect(svcs).toContain("if (s._landGroup)");
    expect(svcs).toContain("location.href=\\'/land.html\\'");
  });
});

describe('back navigation (owner: "back button nai")', () => {
  test('land page carries the app-standard back-nav to the services list', () => {
    const html = read('frontend/land.html');
    expect(html).toContain('class="back-nav"');
    expect(html).toContain("location.href='/services.html'\">← সকল সেবায় ফিরুন");
  });
});

describe('mobile + PC layout', () => {
  const html = read('frontend/land.html');
  test('phones get compact side-by-side mode cards, not a tall stack', () => {
    expect(html).not.toContain('.modes { grid-template-columns:1fr; }');
    expect(html).toContain('.mode-card .d { display:none; }');
  });
  test('fields are 16px so iOS does not auto-zoom on focus', () => {
    expect(html).toContain('font-size:16px; font-family:inherit');
  });
  test('long record values wrap instead of overflowing', () => {
    expect(html).toContain('.rec .r span { min-width:0; overflow-wrap:anywhere; }');
  });
  test('the form card is centred on wide PC screens', () => {
    expect(html).toContain('margin:0 auto 20px; max-width:680px');
  });
});

describe('verify runs on address + khatian number alone', () => {
  const html = read('frontend/land.html');
  test('no forced-claim stop remains on the page', () => {
    expect(html).not.toContain('অন্তত একটি দাবি বসান');
  });
  test('the claim section is optional and collapsed', () => {
    expect(html).toContain('id="claimToggle"');
    expect(html).toContain('id="claimBox" style="display:none"');
    expect(html).toContain('বিক্রেতার দাবিও মিলিয়ে দেখুন (ঐচ্ছিক)');
  });
  test('backend no longer requires a claim either', () => {
    const route = read('backend/routes/land.js');
    expect(route).not.toContain('অন্তত একটি দাবি');
    expect(route).toContain('কোনো দাবি দেওয়া হয়নি');
  });
});

describe('mouza-value mode (land-mouza-value)', () => {
  test('land.html has the mouza card, pane, setMode entry and price loading', () => {
    const html = read('frontend/land.html');
    expect(html).toContain('data-mode="mouza"');
    expect(html).toContain('মৌজা মূল্য');
    expect(html).toContain('id="pane-mouza"');
    expect(html).toContain("'search', 'scan', 'verify', 'mouza'");
    expect(html).toContain("loadPrice('mouza')");
    expect(html).toContain("API + '/' + MODE");
  });
  test('service-detail maps land-mouza-value to the shared land page (no separate page)', () => {
    const sd = read('frontend/service-detail.html');
    expect(sd).toContain("s.engine_id === 'land-mouza-value') { engineUrl = '/land.html?mode=mouza'");
    expect(sd).not.toContain('/land-mouza-value.html');
  });
  test('engine manifest exists for land-mouza-value', () => {
    const m = JSON.parse(read('engines/land-mouza-value/engine.json'));
    expect(m.id).toBe('land-mouza-value');
    expect(m.name_bn).toBe('মৌজা মূল্য রিপোর্ট');
  });
  test('backend route + PDF carry the mouza mode and the honesty lines, with no source branding', () => {
    const route = read('backend/routes/land.js');
    expect(route).toContain("mouza: { engineId: 'land-mouza-value'");
    expect(route).toContain("router.post('/mouza'");
    expect(route).toContain('সার্টিফাইড কপি নয়');
    const pdf = read('backend/lib/landReportPdf.js');
    expect(pdf).toContain("mouza: 'মৌজা মূল্য রিপোর্ট'");
    expect(pdf).toContain('মালিকানা / স্বত্ব / দখলের প্রমাণ নয়');
    for (const f of [route, pdf, read('frontend/land.html')]) {
      expect(f).not.toContain('jomibaba');
      expect(f).not.toContain('amarvumi');
    }
  });
  test('mouza lookup proof: office/mouza/class selects + read-only rate + lookup endpoint call', () => {
    const html = read('frontend/land.html');
    expect(html).toContain('id="mLookOffice"');
    expect(html).toContain('id="mLookMouza"');
    expect(html).toContain('id="mLookClass"');
    expect(html).toContain('id="mLookBtn"');
    expect(html).toContain('id="mLookRate" readonly');
    expect(html).toContain("API + '/mouza-rate?");
    expect(html).toContain('তালিকার হার (শতাংশপ্রতি)');
    // The lookup rate is read-only: the line form must not let a
    // hand edit ride along as a lookup line.
    expect(html).toContain('MOUZA_LOOKUP');
    expect(html).toContain("source: MOUZA_LOOKUP ? 'lookup' : 'manual'");
    // Lookup lines are labelled in the preview and the result.
    expect(html).toContain('(তালিকার হার)');
  });
  test('mouza lookup route exists and verifies lookup lines server-side', () => {
    const route = read('backend/routes/land.js');
    expect(route).toContain("router.get('/mouza-rate'");
    expect(route).toContain('LOOKUP_RATE_MISMATCH');
    expect(route).toContain('lookupMouzaRate');
    const rates = read('engines/land-mouza-value/rates.js');
    expect(rates).toContain('boalkhali');
    expect(rates).toContain('কধুরখীল');
    expect(rates).toContain('2025-2026');
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
  test('migration 042 seeds the mouza-value service idempotently', () => {
    const sql = read('database/migrations/042_land_mouza_value.sql');
    expect(sql).toContain("'land-mouza-value'");
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'land-mouza-value')");
    expect(sql).toContain("'active'");
  });
  test('engine manifests exist for the three engines', () => {
    for (const id of ['land-search', 'land-scan', 'land-verify']) {
      const m = JSON.parse(read('engines/' + id + '/engine.json'));
      expect(m.id).toBe(id);
    }
  });
});
