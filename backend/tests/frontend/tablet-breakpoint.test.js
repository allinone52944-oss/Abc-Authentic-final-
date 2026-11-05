// Audit #56 — the tablet gap: the global collapse was at 768px but
// wallet/login/manual-submit reflow at 900px (admin at 900/960px),
// so 769–900px was half-collapsed. One tablet breakpoint now: 900px.
// The remaining 768px rules are phone-level tweaks (orders table→
// cards, dashboard, nid-replica, admin phone rules) and stay.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('one tablet breakpoint: 900px (audit #56)', () => {
  test('premium.css global collapse (sidebar, main padding, grids) is at 900px', () => {
    const css = read('frontend/css/premium.css');
    expect(css).toContain('@media (max-width: 900px)');
    const block = css.slice(css.indexOf('@media (max-width: 900px)'));
    expect(block).toContain('.sidebar {\n    display: none;');
    expect(block).toContain('padding-bottom: 84px;');
    expect(block).toContain('.desktop {\n    flex-direction: column;');
    expect(css).not.toContain('@media (max-width: 768px)');
  });

  test('motion.css shows the tabbar + body padding + FAB lift at 900px too', () => {
    const css = read('frontend/css/motion.css');
    expect(css).toContain('@media (max-width: 900px)');
    expect(css).not.toContain('@media (max-width: 768px)');
    const tabbar = css.slice(css.indexOf('@media (max-width: 900px)'));
    expect(tabbar).toContain('.m-tabbar { display: flex; }');
    expect(tabbar).toContain('body { padding-bottom: 76px; }');
    expect(tabbar).toContain('bottom: 84px;');
  });

  test('admin has no 960px breakpoint left; its tablet rules are 900px', () => {
    const html = read('frontend/admin.html');
    expect(html).not.toContain('max-width: 960px');
    expect(html).toContain('@media (max-width: 900px)');
  });

  test('the pages that already reflowed at 900px are unchanged', () => {
    for (const p of ['frontend/wallet.html', 'frontend/login.html', 'frontend/manual-submit.html']) {
      expect(read(p)).toContain('@media (max-width: 900px)');
    }
  });
});
