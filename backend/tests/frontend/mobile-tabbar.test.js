// Audit #53 — the three pages have a .sidebar that premium.css
// hides at ≤768px, and none had an m-tabbar or a back-link: on
// mobile there was no navigation at all. Each now carries the same
// six-tab mobile tabbar the other pages use (premium audit §2,
// 2026-11-07: ইতিহাস added everywhere; land + nid-server-copy,
// which had a sidebar but no tabbar at all, got the tabbar too).
// Navigation only — nothing on the QR page's verification logic
// was touched.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAGES = [
  'frontend/land-khatian.html',
  'frontend/land-mouza-map.html',
  'frontend/qr-photo-verify.html',
  'frontend/land.html',
  'frontend/nid-server-copy.html',
];

describe('mobile tabbar on the sidebar pages (audit #53, premium audit §2)', () => {
  for (const p of PAGES) {
    test(`${p} has the six-tab mobile tabbar`, () => {
      const html = read(p);
      expect(html).toContain('<div class="m-tabbar">');
      for (const dest of ['/dashboard.html', '/services.html', '/orders.html', '/history.html', '/wallet.html', '/profile.html']) {
        expect(html).toContain(`location.href='${dest}'`);
      }
      // no tab is marked active — none of these pages is a tab destination
      expect(html).not.toContain('class="m-tab on"');
    });
  }

  test('qr-photo-verify.html: the change is navigation only', () => {
    const html = read('frontend/qr-photo-verify.html');
    const tabbar = html.slice(html.indexOf('<div class="m-tabbar">'));
    expect(tabbar).not.toMatch(/qr|QR|verify/i);
  });
});
