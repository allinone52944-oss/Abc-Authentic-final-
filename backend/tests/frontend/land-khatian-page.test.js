// Land khatian page + routing — frontend only (text-reading style).
//
// Routing regression pinned here (2026-10-23 logout bug): a new
// engine must have an explicit service-detail map or an
// exactly-named page. land-khatian gets both, and it must NOT
// be collapsed into the land group card in services.html (with
// price 0 the group's "from" price would wrongly show 0).
//
// Dashboard mechanism pinned as actually found, not assumed:
// dashboard.html has NO hardcoded land-khatian engine card —
// its service grid links every service to
// service-detail.html?id=<id>, and service-detail's explicit
// map then sends land-khatian to /land-khatian.html.
//
// Page rules pinned: cascade + price + search URLs verbatim,
// NOT-a-certified-copy disclaimer on the page and by the
// results, no third-party source string, no portal URL, and no
// hardcoded price claim. The official government portal is the
// sole data source; no other source is referenced anywhere.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../../../frontend');
const read = (f) => fs.readFileSync(path.join(FRONTEND, f), 'utf8');

const PAGE = read('land-khatian.html');
const DETAIL = read('service-detail.html');
const SERVICES = read('services.html');
const DASHBOARD = read('dashboard.html');

function inlineScripts(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

describe('service-detail routing map', () => {
  test('explicit land-khatian entry with the exact label and target', () => {
    expect(DETAIL).toContain("s.engine_id === 'land-khatian'");
    expect(DETAIL).toContain("engineUrl = '/land-khatian.html'");
    expect(DETAIL).toContain('⚡ এখনই খতিয়ান অনুসন্ধান করুন →');
    const mapAt = DETAIL.indexOf("s.engine_id === 'land-khatian'");
    const labelAt = DETAIL.indexOf('⚡ এখনই খতিয়ান অনুসন্ধান করুন →', mapAt);
    expect(labelAt).toBeGreaterThan(mapAt);
  });

  test('generic rule still exists as the fallback (page name matches it)', () => {
    expect(DETAIL).toContain("let engineUrl = '/' + s.engine_id + '.html'");
    expect(fs.existsSync(path.join(FRONTEND, 'land-khatian.html'))).toBe(true);
  });
});

describe('dashboard mechanism (as actually built)', () => {
  test('service grid links to service-detail by id, not to an engine page', () => {
    // Raw file escapes the quote (location.href=\'…\') because the
    // link is built inside a JS string literal — match it as written.
    expect(DASHBOARD).toContain("location.href=\\'/service-detail.html?id=' + encodeURIComponent(s.id)");
    expect(DASHBOARD).toContain('function renderServiceGrid');
  });

  test('no hardcoded land-khatian engine card on the dashboard', () => {
    expect(DASHBOARD).not.toContain('land-khatian');
    expect(DASHBOARD).not.toContain('/land-khatian.html');
  });
});

describe('services.html own card (not collapsed)', () => {
  test('LAND_ENGINES does not contain land-khatian', () => {
    const m = SERVICES.match(/const LAND_ENGINES = \[[^\]]*\]/);
    expect(m).not.toBeNull();
    expect(m[0]).not.toContain('land-khatian');
    expect(m[0]).toContain('land-search');
    expect(m[0]).toContain('land-mouza-value');
  });

  test('normal card path renders a service-detail link for any non-group service', () => {
    // Same escaped-quote form as the dashboard grid (see above).
    expect(SERVICES).toContain("location.href=\\'/service-detail.html?id='+s.id");
    expect(SERVICES).toContain('function card(s)');
  });
});

describe('land-khatian page markup', () => {
  const IDS = [
    'divisionSel', 'districtSel', 'upazilaSel', 'mouzaSel',
    'searchType', 'surveySel', 'surveyWrap',
    'khatianNo', 'ownerName', 'dagNo',
    'searchForm', 'searchBtn', 'priceText', 'priceLine', 'balVal',
    'errBox', 'okBox', 'resultsBox', 'resultsList',
    'totalLandLine', 'cappedNote', 'mutationNote',
    'disclaimer', 'resultsDisclaimer',
  ];
  test.each(IDS)('has element id %s', (id) => {
    expect(PAGE).toContain('id="' + id + '"');
  });

  test('type selector offers survey / mutation / all', () => {
    expect(PAGE).toContain('value="all"');
    expect(PAGE).toContain('value="survey"');
    expect(PAGE).toContain('value="mutation"');
    expect(PAGE).toContain('সব জরিপ');
    expect(PAGE).toContain('নামজারি');
  });

  test('upazila list is not filtered (circles stay)', () => {
    // The page must not drop revenue circles from the upazila
    // list: no filter on the upazila items before fillSelect.
    expect(PAGE).not.toMatch(/upazilas\?district=[\s\S]*?\.filter\(/);
    expect(PAGE).toContain('revenue circle');
  });

  test('at-least-one-criterion check is client-side', () => {
    expect(PAGE).toContain('অন্তত একটি দিন');
    expect(PAGE).toContain("if (!khatianNo && !ownerName && !dagNo)");
  });

  test('mutation empty result says plainly no mutation record was found', () => {
    expect(PAGE).toContain('নামজারি রেকর্ড পাওয়া যায়নি');
    expect(PAGE).not.toContain('পোর্টালে নামজারি তথ্য নেই');
    expect(PAGE).not.toContain('মিউটেশন তথ্য নেই');
  });

  test('honest error states for 402 / 403 / 502', () => {
    expect(PAGE).toContain('INSUFFICIENT_BALANCE');
    expect(PAGE).toContain('SERVICE_ACCESS_DISABLED');
    expect(PAGE).toContain('LAND_UNREACHABLE');
    expect(PAGE).toContain('কিছুক্ষণ পর আবার চেষ্টা করুন');
    expect(PAGE).toContain('কোনো টাকা কাটা হয়নি');
  });

  test('busy state on the search button while the request runs', () => {
    expect(PAGE).toContain('btn.disabled = true');
    expect(PAGE).toContain('খোঁজা হচ্ছে');
  });

  test('results render through textContent, never innerHTML with record data', () => {
    expect(PAGE).toContain('resultsList');
    expect(PAGE).toContain('document.createElement');
    expect(PAGE).toContain('textContent');
    // The only innerHTML uses are the busy button label and the
    // select placeholder reset — neither carries record data.
    const innerUses = [...PAGE.matchAll(/\.innerHTML = ([^\n;]+)/g)].map((m) => m[1]);
    for (const u of innerUses) {
      expect(u).not.toMatch(/owners|khatianNo|dags/);
    }
  });
});

describe('land-khatian page API URLs', () => {
  const URLS = [
    '/api/land/geo/divisions',
    '/api/land/geo/districts',
    '/api/land/geo/upazilas',
    '/api/land/geo/surveys',
    '/api/land/geo/mouzas',
    '/api/land-khatian/price',
    '/api/land-khatian/search',
  ];
  test.each(URLS)('calls %s', (u) => {
    expect(PAGE).toContain(u);
  });

  test('price line is dynamic: free wording only when the endpoint returns 0', () => {
    expect(PAGE).toContain('আপাতত বিনামূল্যে');
    expect(PAGE).toContain("Number(d.price) === 0");
    expect(PAGE).toContain('ফলাফল না পেলে চার্জ ৳০');
  });

  test('401 redirects to login', () => {
    expect(PAGE).toContain("location.href = '/login.html'");
  });
});

describe('land-khatian page disclaimer + forbidden content', () => {
  test('NOT-a-certified-copy disclaimer on the page and near results', () => {
    expect(PAGE).toContain('সরকারি সার্টিফাইড কপি নয়');
    expect(PAGE).toContain('মালিকানা / স্বত্ব / দখলের প্রমাণ নয়');
    expect(PAGE).toContain('সরকারি পোর্টালে যাচাই করে নিন');
    const first = PAGE.indexOf('সরকারি সার্টিফাইড কপি নয়');
    const second = PAGE.indexOf('সরকারি সার্টিফাইড কপি নয়', first + 1);
    expect(second).toBeGreaterThan(first);
  });

  test('no third-party source, no portal URL, no branding on the page', () => {
    expect(PAGE).not.toContain('eporcha');
    expect(PAGE).not.toContain('dlrms');
    expect(PAGE).not.toContain('land.gov.bd');
    expect(PAGE).not.toContain('http://');
    expect(PAGE).not.toContain('https://');
  });

  test('no hardcoded price claim anywhere in the page', () => {
    expect(PAGE).not.toContain('৳৩০');
    expect(PAGE).not.toMatch(/সেবা চার্জ: ৳\d/);
  });

  test('no watermark language on the page', () => {
    expect(PAGE.toLowerCase()).not.toContain('watermark');
    expect(PAGE).not.toContain('জলছাপ');
  });
});

describe('land-khatian inline script syntax', () => {
  test('every inline script parses', () => {
    const scripts = inlineScripts(PAGE);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) {
      expect(() => new vm.Script(s)).not.toThrow();
    }
  });

  test('service-detail inline script still parses', () => {
    for (const s of inlineScripts(DETAIL)) {
      expect(() => new vm.Script(s)).not.toThrow();
    }
  });
});

describe('land-khatian page: simple form (2026-11-04)', () => {
  test('optional groups are collapsed <details>; all field ids unchanged', () => {
    for (const id of ['divisionSel', 'districtSel', 'upazilaSel', 'mouzaSel',
      'searchType', 'surveySel', 'surveyWrap',
      'khatianNo', 'ownerName', 'dagNo']) {
      expect(PAGE).toContain('id="' + id + '"');
    }
    expect(PAGE).toContain('id="nameDagWrap"');
    expect(PAGE).toContain('id="surveyPickWrap"');
    expect(PAGE).toContain('<details');
  });
  test('owner/dag and survey picks live inside their details blocks, not as top-level fields', () => {
    const nameDag = PAGE.split('id="nameDagWrap"')[1].split('</details>')[0];
    expect(nameDag).toContain('id="ownerName"');
    expect(nameDag).toContain('id="dagNo"');
    const surveyPick = PAGE.split('id="surveyPickWrap"')[1].split('</details>')[0];
    expect(surveyPick).toContain('id="searchType"');
    expect(surveyPick).toContain('id="surveySel"');
  });
  test('default search mode is still all surveys (first option)', () => {
    const m = PAGE.match(/id="searchType"[^>]*>([\s\S]*?)<\/select>/);
    expect(m).not.toBeNull();
    expect(m[1].trim().startsWith('<option value="all">')).toBe(true);
  });
});
