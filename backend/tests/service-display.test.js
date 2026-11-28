const fs = require('fs');
const path = require('path');
const dash = fs.readFileSync(path.join(__dirname, '../../frontend/dashboard.html'), 'utf8');
const m = dash.match(/function dashboardServices\(\) \{[\s\S]*?\n\}/);
const run = (list) => { const _allServices = list; return new Function('_allServices', m[0] + '; return dashboardServices();')(_allServices); };

test('hidden services never appear on dashboard', () => {
  const out = run([{ id: 'a' }, { id: 'b', show_on_dashboard: false }]);
  expect(out.map(s => s.id)).toEqual(['a']);
});
test('highlighted services keep the admin order', () => {
  const out = run([{ id: 'a' }, { id: 'b', featured: true }, { id: 'c' }]);
  expect(out.map(s => s.id)).toEqual(['a', 'b', 'c']);
});
test('display endpoint never updates price or status', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
  const start = src.indexOf("router.put('/services/:id/display'");
  const end = src.indexOf('\nrouter.', start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const update = src.slice(start, end).match(/UPDATE services SET[\s\S]*?WHERE id =/);
  expect(update).not.toBeNull();
  expect(update[0]).not.toMatch(/\b(?:price|status)\s*=/);
});
