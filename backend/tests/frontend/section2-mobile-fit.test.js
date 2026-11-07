// Premium audit §2 (2026-11-07) — mobile / PC fit.
// The report's §2 was partly stale, so the tests pin the CURRENT
// (fixed) state, not the report's wording:
//   - the "4 tabs" claim was stale: dashboard/history already had 6;
//     the real drift was 12 pages on 5 tabs (no ইতিহাস), 2 sidebar
//     pages with NO tabbar at all (land, nid-server-copy), an emoji
//     tabbar on order-detail, and THREE unclosed tabbar divs
//     (land-khatian, land-mouza-map, qr-photo-verify).
//   - the "768px only" claim was stale: audit #56 already set the
//     900px breakpoint; the remaining tablet work is the 901-1200px
//     band, tuned here.
//   - sidebar icons: 5 pages used emoji, 12 used SVG — now all SVG.
// Deliberately NOT touched: bdris-apply (own nav; audit #54/#80),
// birth-final / death-final / manual-submit (no sidebar by design;
// manual-submit is a redirect page, audit #51), admin / auth pages.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TABBAR_PAGES = ['dashboard', 'history', 'land-khatian', 'land-mouza-map',
  'land', 'nid-replica', 'nid-server-copy', 'order-create', 'order-detail',
  'order-status', 'orders', 'profile', 'qr-photo-verify', 'service-detail',
  'services', 'wallet'];
// page -> the tab marked active (null = page is not a tab destination)
const ACTIVE = {
  dashboard: 'হোম', history: 'ইতিহাস', services: 'সেবা', 'service-detail': 'সেবা',
  orders: 'অর্ডার', 'order-create': 'অর্ডার', 'order-detail': 'অর্ডার',
  'order-status': 'অর্ডার', wallet: 'ওয়ালেট', profile: 'প্রোফাইল',
};
const EMOJI = /[🏠🧩🌾🗺️🪪🔍📦🕘👛👤🛎️💳]/u;

function tabbarOf(html) {
  const m = html.match(/<div class="m-tabbar">([\s\S]*?)\n<\/div>/);
  if (!m) throw new Error('no closed tabbar block found');
  return m[1];
}

describe('premium audit §2 — one six-tab mobile tabbar everywhere', () => {
  for (const name of TABBAR_PAGES) {
    test(`${name}: six tabs incl. ইতিহাস`, () => {
      const html = read(`frontend/${name}.html`);
      const block = tabbarOf(html);
      const want = ACTIVE[name] || null;
      // The active tab has no link (it IS the current page) — its
      // destination is proven by the label + the active test below.
      for (const [label, dest] of [['হোম', '/dashboard.html'], ['সেবা', '/services.html'],
        ['অর্ডার', '/orders.html'], ['ইতিহাস', '/history.html'], ['ওয়ালেট', '/wallet.html'],
        ['প্রোফাইল', '/profile.html']]) {
        expect(block).toContain(`</div>${label}</div>`);
        if (label !== want) expect(block).toContain(`location.href='${dest}'`);
      }
    });
  }

  test('active tab is marked only on destination pages', () => {
    for (const name of TABBAR_PAGES) {
      const html = read(`frontend/${name}.html`);
      const block = tabbarOf(html);
      const want = ACTIVE[name] || null;
      const ons = [...block.matchAll(/class="m-tab on"[^>]*><div class="ico">[\s\S]*?<\/div>([^<]+)<\/div>/g)]
        .map((m) => m[1]);
      if (want) {
        expect(ons).toEqual([want]);
      } else {
        expect(ons).toEqual([]);
      }
    }
  });

  test('no emoji anywhere in a tabbar', () => {
    for (const name of TABBAR_PAGES) {
      const html = read(`frontend/${name}.html`);
      expect(tabbarOf(html)).not.toMatch(EMOJI);
    }
  });

  test('the three unclosed tabbar divs are closed now', () => {
    for (const name of ['land-khatian', 'land-mouza-map', 'qr-photo-verify']) {
      const html = read(`frontend/${name}.html`);
      expect(html).toContain('</div>\n</body>');
    }
  });
});

describe('premium audit §2 — sidebar icons all SVG', () => {
  test('no emoji in any sidebar link icon', () => {
    for (const name of [...TABBAR_PAGES, 'admin']) {
      const html = read(`frontend/${name}.html`);
      const links = html.split('\n').filter((l) => l.includes('side-link'));
      for (const l of links) expect(l).not.toMatch(EMOJI);
    }
  });

  test('the five converted sidebars use the shared SVG set', () => {
    for (const name of ['land-khatian', 'land-mouza-map', 'land', 'nid-server-copy', 'qr-photo-verify']) {
      const html = read(`frontend/${name}.html`);
      const icos = [...html.matchAll(/<span class="ico">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
      expect(icos.length).toBeGreaterThanOrEqual(7);
      for (const ico of icos) expect(ico).toContain('<svg');
    }
  });
});

describe('premium audit §2 — tablet band 901-1200px', () => {
  test('premium.css narrows the shell between tablet and desktop', () => {
    const css = read('frontend/css/premium.css');
    expect(css).toContain('@media (min-width: 901px) and (max-width: 1200px)');
    expect(css).toMatch(/@media \(min-width: 901px\) and \(max-width: 1200px\) \{\s*\.sidebar \{ width: 200px;/);
    expect(css).toContain('.main { padding: 24px 20px; }');
  });
});
