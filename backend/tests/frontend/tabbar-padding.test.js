// Audit #61 — the 76px body padding (motion.css) and the 84px .main
// padding (premium.css) applied on every page at the tablet
// breakpoint, even pages with no tabbar — 76–84px of dead space at
// the bottom. Both paddings are now scoped to pages that actually
// have a tabbar (body.has-tabbar).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TABBAR_PAGES = ['dashboard', 'history', 'land-khatian', 'land-mouza-map', 'manual-submit',
  'nid-replica', 'order-create', 'order-detail', 'order-status', 'orders',
  'profile', 'qr-photo-verify', 'service-detail', 'services', 'wallet'];
const NO_TABBAR_PAGES = ['bdris-apply', 'land', 'login', 'admin', 'nid-server-copy',
  'birth-final', 'death-final', 'index'];

describe('tabbar bottom padding only on tabbar pages (audit #61)', () => {
  test('motion.css reserves body room only for body.has-tabbar', () => {
    const css = read('frontend/css/motion.css');
    expect(css).toContain('body.has-tabbar { padding-bottom: 76px; }');
    expect(css).not.toMatch(/^\s*body \{ padding-bottom: 76px; \}/m);
  });

  test('premium.css reserves .main room only for body.has-tabbar .main', () => {
    const css = read('frontend/css/premium.css');
    expect(css).toContain('body.has-tabbar .main {');
    expect(css).toContain('padding-bottom: 84px;');
  });

  test('every page with a tabbar carries the has-tabbar body class', () => {
    for (const name of TABBAR_PAGES) {
      const html = read(`frontend/${name}.html`);
      expect(html).toContain('<div class="m-tabbar">');
      expect(html).toContain('<body class="has-tabbar">');
    }
  });

  test('pages without a tabbar carry no has-tabbar class (no dead padding)', () => {
    for (const name of NO_TABBAR_PAGES) {
      const html = read(`frontend/${name}.html`);
      expect(html).not.toContain('<div class="m-tabbar">');
      expect(html).not.toContain('has-tabbar');
    }
  });
});
