// Audit #55 — iOS auto-zooms when a focused form input is under
// 16px. All form inputs are 16px at the mobile breakpoint now.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('form inputs are 16px at the mobile breakpoint (audit #55)', () => {
  test('premium.css sets 16px for .field inputs/selects/textareas ≤768px', () => {
    const css = read('frontend/css/premium.css');
    const mq = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(mq).toContain('.field input, .field select, .field textarea');
    expect(mq).toContain('font-size: 16px;');
  });

  test('the three pages with their own 15px input rule are 16px now', () => {
    for (const p of ['frontend/land-khatian.html', 'frontend/land-mouza-map.html', 'frontend/qr-photo-verify.html']) {
      const html = read(p);
      expect(html).not.toMatch(/\.field input\[type=text\][\s\S]{0,200}?font-size: 15px/);
      expect(html).toContain('font-size: 16px;');
    }
  });

  test('no inline input/textarea/select in any page is under 16px', () => {
    const dir = path.join(ROOT, 'frontend');
    const bad = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
      const html = read(path.join('frontend', f));
      const re = /<(input|textarea|select)[^>]*font-size:\s*(\d+)px[^>]*>/g;
      let m;
      while ((m = re.exec(html))) {
        if (Number(m[2]) < 16) bad.push(`${f}: <${m[1]}> ${m[2]}px`);
      }
    }
    expect(bad).toEqual([]);
  });
});
