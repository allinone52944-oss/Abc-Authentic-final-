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

// Structural check: is the results container a DIRECT CHILD of
// .land-layout? Strips <script> blocks first — their JS strings
// contain '</div>' — and comments, then tracks <div> depth.
function layoutHasResults(html, resultId) {
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const re = /<div\b[^>]*>|<\/div>/gi;
  let depth = 0;
  let layoutDepth = -1;
  let m;
  while ((m = re.exec(clean))) {
    if (m[0].startsWith('</')) {
      if (depth === layoutDepth) layoutDepth = -1;
      depth -= 1;
    } else {
      depth += 1;
      if (m[0].includes('land-layout')) layoutDepth = depth;
      if (layoutDepth !== -1 && depth === layoutDepth + 1 && m[0].includes(resultId)) return true;
    }
  }
  return false;
}

describe('land.html', () => {
  const html = read('frontend/land.html');
  test('uses ABC.api-relative base, never a hard-coded /api path', () => {
    expect(html).toContain("const API = '/land'");
    expect(html).not.toContain("'/api/land'");
    expect(html).not.toContain('"/api/land"');
  });
  test('has the three modes and calls all three endpoints', () => {
    // Audit #6 — the search mode moved to land-khatian.html; the
    // three modes left are scan / verify / mouza.
    for (const m of ['scan', 'verify', 'mouza']) {
      expect(html).toContain('data-mode="' + m + '"');
    }
    expect(html).not.toContain('data-mode="search"');
    expect(html).not.toContain('id="pane-search"');
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
  test('dashboard links to /land-khatian.html (one ENGINE_CARDS entry, both grids)', () => {
    // Audit #6 — the dashboard land card is the khatian-search
    // entry point now. Audit #82 — the card lives once in the
    // ENGINE_CARDS array and renders into both grids.
    const dash = read('frontend/dashboard.html');
    expect(dash.split("href: '/land-khatian.html'").length - 1).toBe(1);
    expect(dash).not.toContain("location.href='/land.html'");
    expect(dash).toContain('id="engineGridDesk"');
    expect(dash).toContain('id="engineGridMob"');
  });
  test('admin engine dropdowns offer the land engines (land-search removed)', () => {
    // Audit #14 — land-search left the dropdowns with its route
    // (audit #6); scan/verify stay, each in both dropdowns.
    const admin = read('frontend/js/admin.js');
    expect(admin).not.toContain('land-search');
    for (const id of ['land-scan', 'land-verify']) {
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
  test('each land engine maps to its page (search lives on land-khatian.html)', () => {
    // Audit #6 — land-search goes to the new page; scan/verify
    // stay on land.html with their mode.
    expect(sd).toContain("s.engine_id === 'land-search') { engineUrl = '/land-khatian.html'");
    expect(sd).toContain("s.engine_id === 'land-scan') { engineUrl = '/land.html?mode=scan'");
    expect(sd).toContain("s.engine_id === 'land-verify') { engineUrl = '/land.html?mode=verify'");
  });
  test('land.html honours the ?mode= preselect', () => {
    const html = read('frontend/land.html');
    expect(html).toContain("new URLSearchParams(location.search).get('mode')");
    // Audit #6 — an old ?mode=search link lands on the new page.
    expect(html).toContain("if (_qm === 'search') { location.replace('/land-khatian.html'); }");
    expect(html).toContain("setMode(['scan', 'verify', 'mouza'].includes(_qm) ? _qm : 'scan')");
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
  test('services page collapses the four land engines into one card', () => {
    expect(svcs).toContain('function groupLand(');
    expect(svcs).toContain("LAND_ENGINES = ['land-search', 'land-scan', 'land-verify', 'land-mouza-value']");
    expect(svcs).toContain('ALL_SERVICES = groupLand(services || [])');
    expect(svcs).toContain("_landGroup: true");
  });
  test('the group card names mouza, and mouza stays searchable', () => {
    // Audit #6 — the group card opens land.html (scan/verify/mouza);
    // the khatian search is its own card now, so it leaves the subtitle.
    expect(svcs).toContain('নামে সন্ধান · জমি যাচাই · মৌজা মূল্য');
    expect(svcs).not.toContain('খতিয়ান খোঁজ · নামে সন্ধান');
    expect(svcs).toContain("_landSearch: 'নামে সন্ধান জমি যাচাই মৌজা মূল্য মৌজা মূল্য রিপোর্ট'");
    expect(svcs).toContain("extra.includes(q)");
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
  test('wide PC gets two-column: wizard left, result right (audit P0 #1)', () => {
    expect(html).toContain('class="land-layout"');
    expect(html).toContain('@media (min-width:1200px)');
    expect(html).toContain('grid-template-columns:minmax(360px,420px) minmax(0,1fr)');
    expect(html).toContain('.land-layout .form-card { max-width:none; margin:0; }');
    // The result leaves the 680px card so the right column can
    // hold it: it must be a sibling of the form card, not inside it.
    const layOpen = html.indexOf('class="land-layout"');
    const resAt = html.indexOf('id="result"', layOpen);
    const formClose = html.indexOf('</form>', layOpen);
    expect(layOpen).toBeGreaterThan(-1);
    expect(resAt).toBeGreaterThan(formClose);
    // Structural proof: #result must be a DIRECT CHILD of
    // .land-layout, not merely somewhere after the form. A naive
    // parser breaks on the JS strings inside <script> blocks, so
    // strip scripts and comments first, then track <div> depth.
    expect(layoutHasResults(html, 'id="result"')).toBe(true);
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
    expect(html).toContain("'scan', 'verify', 'mouza'");
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
    // Audit #13 — the rate source is labelled as the MANUAL table,
    // in the card header and in the picked-rate line.
    expect((html.match(/ম্যানুয়াল তালিকা থেকে/g) || []).length).toBe(2);
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
  test('mouza wizard step 2: unit selector + free rate-card download', () => {
    const html = read('frontend/land.html');
    // Unit buttons above the card; download button on step 2.
    expect(html).toContain('id="wzCardUnitWrap"');
    expect(html).toContain('id="wzCardUnitBtns"');
    expect(html).toContain('id="wzCardDownload"');
    expect(html).toContain('হার কোন এককে দেখবেন?');
    expect(html).toContain('রেট-কার্ড ডাউনলোড');
    // Download hits the card endpoint with office + mouza +
    // thana + picked unit; the button is wired once.
    expect(html).toContain("'/land/mouza-rate-card?office='");
    expect(html).toContain("wzCardDownload').addEventListener('click', wzDownloadCard)");
    // Unit only changes display: the picked table rate for the
    // paid report stays per-shatangsho (see wzPickClass).
    expect(html).toContain('cardUnit');
    expect(html).toContain('MOUZA_FACTORS[unit]');
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
    // Audit #64 — the data moved out of rates.js into per-office
    // shards; the sample office now lives in its shard.
    const shard = read('engines/land-mouza-value/rates/boalkhali.json');
    expect(shard).toContain('কধুরখীল');
    expect(shard).toContain('2025-2026');
  });
  test('mouza wizard batch 1: 5 new offices in the form, thana question, pouro note, qualified submit', () => {
    const html = read('frontend/land.html');
    // Audit #63 — the offices moved out of the HTML into
    // mouza-offices.json; the data assertions read that file now.
    const offices = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'mouza-offices.json'), 'utf8'));
    // New offices + a sample mouza name from each batch-1 office.
    for (const id of ['chandgaon', 'sandwip', 'gachbaria', 'rangunia', 'pahartali']) {
      expect(offices[id]).toBeDefined();
    }
    for (const name of ['বাকলিয়া', 'হরামিয়া', 'জামিরজুরী', 'সৈয়দবাড়ী', 'উত্তর কাট্টলী']) {
      expect(JSON.stringify(offices)).toContain(name);
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

describe('land.html — mobile grids (audit #58)', () => {
  const html = read('frontend/land.html');

  test('the mode cards go 2-column at ≤560px (not 4-across)', () => {
    const mq = html.slice(html.indexOf('@media (max-width:560px){'));
    expect(mq).toContain('.modes { grid-template-columns:repeat(2,1fr);');
    // the desktop rule is still 3 columns (audit #6 removed search)
    expect(html).toContain('.modes { display:grid; grid-template-columns:repeat(3,1fr);');
  });

  test('the rate-card grid is 1 column at ≤560px, via the stylesheet (no inline columns)', () => {
    expect(html).not.toContain('id="wzCardGrid" style=');
    expect(html).toContain('#wzCardGrid { display:grid; grid-template-columns:1fr 1fr;');
    // the 1-column override sits AFTER the base rule, or the base
    // rule (same specificity) would win
    const base = html.indexOf('#wzCardGrid { display:grid;');
    const over = html.indexOf('@media (max-width:560px){ #wzCardGrid { grid-template-columns:1fr; } }');
    expect(over).toBeGreaterThan(base);
  });
});

describe('land.html — mouza data lazy-loaded, not inlined (audit #63)', () => {
  const html = read('frontend/land.html');

  test('no huge inline line remains in the page', () => {
    const longest = Math.max(...html.split('\n').map((l) => l.length));
    expect(longest).toBeLessThan(100000);
    expect(html).not.toContain('const MOUZA_OFFICES = {');
  });

  test('the office list lives in a separate JSON file with the full data', () => {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'mouza-offices.json'), 'utf8'));
    expect(Object.keys(data).length).toBe(488);
    expect(data.boalkhali.name).toBe('বোয়ালখালী');
    expect(Array.isArray(data.boalkhali.mouzas)).toBe(true);
  });

  test('the page fetches the JSON lazily when the mouza mode opens', () => {
    expect(html).toContain("fetch('/mouza-offices.json?v=1')");
    expect(html).toContain('async function loadMouzaOffices()');
    expect(html).toContain('async function wzResetWizard()');
    expect(html).toContain('await loadMouzaOffices();');
    // the data is not fetched at page load — only from the wizard reset
    expect(html.indexOf("fetch('/mouza-offices.json")).toBeGreaterThan(html.indexOf('async function loadMouzaOffices'));
  });

  test('a failed load keeps the wizard usable via the manual path, and says why', () => {
    // Bug-hunt F5 — a failed load must NOT poison the cache with
    // {} (truthy, so the loader would short-circuit forever). The
    // table stays null so the next open retries the fetch.
    expect(html).toContain('MOUZA_OFFICES = null;');
    expect(html).not.toContain('MOUZA_OFFICES = {};');
    expect(html).toContain('অফিসের তালিকা আসেনি');
    expect(html).toContain('"অন্য অফিস" বেছে নিয়ে নাম লিখে এগোনো যাবে');
  });
});
