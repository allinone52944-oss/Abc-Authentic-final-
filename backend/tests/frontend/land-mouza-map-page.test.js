// Static checks on frontend/land-mouza-map.html (SEPARATE
// engine from land-khatian, 2026-11-04: own page, own
// services row, own fee — never a button inside the khatian
// page). No live calls; the page text is the contract.
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'frontend', 'land-mouza-map.html'), 'utf8'
);

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

describe('land-mouza-map page markup', () => {
  const IDS = [
    'divisionSel', 'districtSel', 'upazilaSel', 'surveySel', 'mouzaSel',
    'searchForm', 'searchBtn', 'priceText', 'priceLine', 'balVal',
    'errBox', 'okBox', 'resultsBox', 'sheetsList',
    'disclaimer', 'resultsDisclaimer',
  ];
  test.each(IDS)('has element id %s', (id) => {
    expect(PAGE).toContain('id="' + id + '"');
  });

  test('calls the map engine endpoints (not the khatian ones)', () => {
    expect(PAGE).toContain('/api/land-mouza-map/price');
    expect(PAGE).toContain('/api/land-mouza-map/search');
    expect(PAGE).toContain('/api/land-mouza-map/preview/');
    expect(PAGE).not.toContain('/api/land-khatian/maps');
  });

  test('labels the preview honestly: not a certified sheet', () => {
    expect(PAGE).toContain('সার্টিফাইড মৌজা শিট নয়');
    expect(PAGE).toContain('প্রিভিউ');
  });

  test('preview images load authenticated (no raw img src → would 401)', () => {
    // A plain <img src="/api/..."> sends no login header, so
    // the order-gated preview would 401. Images must load via
    // authenticated fetch → blob → object URL.
    expect(PAGE).not.toContain('src="/api/land-mouza-map/preview');
    expect(PAGE).toContain('createObjectURL');
  });

  test('survey is required (maps need exactly one survey)', () => {
    expect(PAGE).toContain('id="surveySel"');
    expect(PAGE).toContain('এলাকা, জরিপ ও মৌজা');
  });

  test('premium two-column on wide PC: form left, results right (audit P0 #1)', () => {
    expect(PAGE).toContain('class="land-layout"');
    expect(PAGE).toContain('@media (min-width: 1200px)');
    expect(PAGE).toContain('grid-template-columns: minmax(360px, 420px) minmax(0, 1fr)');
    expect(PAGE).toContain('.land-layout #resultsBox { max-width: none; }');
    // The 720px cap must not survive as an inline style (a
    // stylesheet rule cannot beat it): it lives in CSS now.
    expect(PAGE).not.toContain('max-width:720px; display:none');
    // Structural proof (not just the class existing): the results
    // box must be a DIRECT CHILD of .land-layout. A naive parser
    // breaks on the JS strings inside <script> blocks, so strip
    // scripts and comments first, then track <div> depth.
    expect(layoutHasResults(PAGE, 'id="resultsBox"')).toBe(true);
  });
});
