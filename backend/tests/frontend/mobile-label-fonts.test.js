// Audit #62 — small mobile fonts (9–10px). Mobile labels minimum 11–12px.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('mobile labels are at least 11px (audit #62)', () => {
  test('dashboard engine tag + pulse badge are 11px (were 10px)', () => {
    const html = read('frontend/dashboard.html');
    expect(html).toContain('font-size: 11px;\n      padding: 2px 6px;');
    expect(html).toContain('font-size: 11px; /* audit #62 — mobile labels minimum 11px */');
    // the footer (11px) and card h4 (13px) already met the floor
    expect(html).toContain('font-size: 11px;');
  });

  test('admin step label is 11px at every width (was 10px base, 9px mobile)', () => {
    const html = read('frontend/admin.html');
    expect(html).toContain('.adm-step-label { font-size:11px;');
    expect(html).not.toContain('.adm-step-label { font-size:9px; }');
    expect(html).not.toContain('.adm-step-label { font-size:10px;');
  });

  test('the mobile tab labels are 12px (were 11px)', () => {
    const css = read('frontend/css/motion.css');
    expect(css).toContain('font-size: 12px; /* audit #62');
  });

  test('no 8–9px font remains anywhere in the frontend', () => {
    const dir = path.join(ROOT, 'frontend');
    const bad = [];
    const scan = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) { scan(p); continue; }
        if (!/\.(html|css|js)$/.test(f.name)) continue;
        const text = fs.readFileSync(p, 'utf8');
        const re = /font-size:\s*([89])px/g;
        let m;
        while ((m = re.exec(text))) bad.push(`${path.relative(ROOT, p)}: ${m[1]}px`);
      }
    };
    scan(dir);
    expect(bad).toEqual([]);
  });
});
