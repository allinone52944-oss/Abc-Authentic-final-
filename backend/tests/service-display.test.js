const fs = require('fs');
const path = require('path');
const dash = fs.readFileSync(path.join(__dirname, '../../frontend/dashboard.html'), 'utf8');
const m = dash.match(/function dashboardServices\(\) \{[\s\S]*?\n\}/);
const run = (list) => { const _allServices = list; return new Function('_allServices', m[0] + '; return dashboardServices();')(_allServices); };

test('hidden services never appear on dashboard', () => {
  const out = run([{ id: 'a' }, { id: 'b', show_on_dashboard: false }]);
  expect(out.map(s => s.id)).toEqual(['a']);
});
test('highlighted services come first, rest keep admin order', () => {
  const out = run([{ id: 'a' }, { id: 'b', featured: true }, { id: 'c' }]);
  expect(out.map(s => s.id)).toEqual(['b', 'a', 'c']);
});
test('display endpoint never updates price or status', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
  const h = src.slice(src.indexOf("'/services/:id/display'"), src.indexOf("router.put('/services/:id', async"));
  expect(h).not.toMatch(/price|status\s*=/);
});
