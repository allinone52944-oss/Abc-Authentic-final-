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
  test('mouza wizard: one plain question at a time, rate card first, never a dead-end miss', () => {
    const html = read('frontend/land.html');
    // Steps + progress + back buttons, in customer order.
    for (const id of ['wzProgress', 'wzStep1', 'wzStepThana', 'wzStep2', 'wzStep3',
      'wzStep4', 'wzStep5', 'wzStepLines', 'wzStepFinish',
      'wzBackThana', 'wzBack2', 'wzBack3', 'wzBack4', 'wzBack5', 'wzBackFinish']) {
      expect(html).toContain('id="' + id + '"');
    }
    for (const q of ['জমি কোথায়?', 'কোন থানা?', 'জমির ধরন কী?', 'কতটুকু জমি?',
      'রিপোর্টে যা থাকবে', 'আরেকটা জমি যোগ করুন']) {
      expect(html).toContain(q);
    }
    // Offices with data are marked; an uncovered office is a
    // plain sentence + the manual path, never an error.
    expect(html).toContain('তালিকার হার আছে');
    expect(html).toContain('অন্য অফিস (তালিকা এখনো যোগ হয়নি)');
    expect(html).toContain('এই অফিসের তালিকা এখনো যোগ হয়নি');
    expect(html).toContain('অন্য মৌজা (হার নিজে বসাবো)');
    // Searchable mouza list + whole-mouza rate card in one call.
    expect(html).toContain('id="wzMouzaSearch"');
    expect(html).toContain('id="wzCardGrid"');
    expect(html).toContain("API + '/mouza-rates?");
    // Structured miss reasons, each with a plain WHY + manual
    // fallback — never the old dead-end message.
    for (const code of ['OFFICE_NOT_COVERED', 'MOUZA_NOT_IN_TABLE', 'CLASS_NO_RATE']) {
      expect(html).toContain(code);
    }
    expect(html).not.toContain('এই মৌজা/শ্রেণির তালিকার হার পাওয়া যায়নি — হার নিজে বসান অথবা তালিকায় থাকা শ্রেণি বাছুন');
    // P-flagged rates in plain words, never a bare "P".
    expect(html).toContain('আগের বছরের হার বহাল আছে');
    expect(html).not.toContain('P চিহ্ন');
    expect(html).not.toContain('· P:');
    // Preview is a sentence with grouped digits, not a raw
    // number string; the finish screen states the charge rule.
    expect(html).toContain('bnGrouped');
    expect(html).toContain('চার্জ ৳৫০ — শুধু বৈধ রিপোর্টেই কাটবে, ভুল লাইনে ৳০।');
    // The report button lives on the finish screen ONLY.
    expect(html).toContain("go.style.display = step === 'finish' ? '' : 'none'");
    // Lines carry a source tag (তালিকা / নিজে বসানো).
    expect(html).toContain('নিজে বসানো');
    // The submit sends office + lines with NO cascade in mouza
    // mode; the server derives the header area from the lines.
    expect(html).toContain("body.office = $('mOffice').value");
    expect(html).toContain('lookupOffice: l.lookupOffice');
    expect(html).toContain('lookupThana: l.lookupThana');
    // The shared DLRMS cascade is hidden in mouza mode ONLY —
    // the other modes still use it.
    expect(html).toContain('id="areaCascade"');
    expect(html).toContain("$('areaCascade').style.display = mode === 'mouza' ? 'none' : ''");
    // The old single-flow form is gone: no per-class lookup
    // fields, no thana popup, no separate line form.
    for (const id of ['mMouza', 'mMouzaManual', 'mClass', 'mAmount', 'mUnit',
      'mRate', 'mRateLabel', 'mRateNote', 'mOldRate', 'mAddLineBtn', 'mLinesBox',
      'mTotalNote', 'mThanaWrap', 'mThana',
      'mLookOffice', 'mLookMouza', 'mLookClass', 'mLookBtn', 'mLookRate',
      'mLineMouza', 'mLineClass', 'mLineRate', 'mLineAmount', 'mLineUnit', 'mLineOldRate']) {
      expect(html).not.toContain('id="' + id + '"');
    }
    expect(html).not.toContain('MOUZA_LOOKUP');
    expect(html).not.toContain('resetMouzaThana');
    // The short honesty note stays on the form (full lines in PDF).
    expect(html).toContain('চার্জ শুধু রিপোর্ট তৈরি হলেই কাটবে; লাইন ভুল হলে কোনো চার্জ নয়।');
  });
  test('mouza route + PDF derive the header area from the lines (no cascade mouza)', () => {
    const route = read('backend/routes/land.js');
    expect(route).toContain('deriveMouzaReportArea');
    expect(route).toContain('MOUZA_OFFICE_GEO');
    expect(route).toContain('boalkhali');
    const pdf = read('backend/lib/landReportPdf.js');
    expect(pdf).toContain('headerMouzaFor');
    expect(pdf).not.toContain('স্বয়ংক্রিয় তালিকা-খোঁজা এখনো তৈরি হয়নি');
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
  test('mouza wizard batch 1: 5 new offices in the form, thana question, pouro note, qualified submit', () => {
    const html = read('frontend/land.html');
    // New offices + a sample mouza name from each batch-1 office.
    for (const id of ['chandgaon', 'sandwip', 'gachbaria', 'rangunia', 'pahartali']) {
      expect(html).toContain('"' + id + '"');
    }
    for (const name of ['বাকলিয়া', 'হরামিয়া', 'জামিরজুরী', 'সৈয়দবাড়ী', 'উত্তর কাট্টলী']) {
      expect(html).toContain(name);
    }
    // Thana question: an ordinary step shown only on an
    // ambiguous card response, re-fetching with the thana.
    expect(html).toContain('id="wzThana"');
    expect(html).toContain('data.ambiguous');
    expect(html).toContain("'&thana=' + encodeURIComponent(WZ.thana)");
    expect(html).toContain('থানা বাছুন');
    // The thana rides the wizard line to the server.
    expect(html).toContain('lookupThana: l.lookupThana');
    expect(html).toContain('lookupThana: WZ.rateIsTable ? (WZ.thana || undefined) : undefined');
    // Sandwip pouro note is displayed under the rate when present.
    expect(html).toContain('pouroNote');
    // Server: qualifier param + qualified verification + geo for
    // the new offices (header area derivation).
    const route = read('backend/routes/land.js');
    expect(route).toContain("req.query.thana");
    expect(route).toContain('lookupThana');
    for (const id of ['chandgaon', 'sandwip', 'gachbaria', 'rangunia', 'pahartali']) {
      expect(route).toContain(id + ': {');
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
