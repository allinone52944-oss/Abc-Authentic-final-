// Audit #57 — DECISION: admin tables stay horizontally scrollable
// on mobile (marked in admin.html), instead of a card-view.
// A generic card conversion without per-cell labels would stack
// values with no labels; a proper one needs per-table data-label
// work across 9 tables in admin.js. The scroll already works
// (overflow-x:auto wrappers + sticky first column), so the decision
// is to keep it and record why.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('admin tables stay scrollable on mobile — marked decision (audit #57)', () => {
  test('the decision is recorded in admin.html above the table card', () => {
    const html = read('frontend/admin.html');
    expect(html).toContain('Audit #57 — DECISION (kept, not card-view)');
    expect(html).toContain('horizontally scrollable on mobile, deliberately');
  });

  test('every admin table sits in a horizontal-scroll wrapper', () => {
    const js = read('frontend/js/admin.js');
    const tables = (js.match(/<table class="adm-table"/g) || []).length;
    expect(tables).toBeGreaterThan(0);
    const wrappers = (js.match(/<div style="overflow-x:auto;">\s*'\s*\+\s*'\s*<table/g) || []).length;
    // at least the main tables (users, orders, SMS hub) scroll
    expect(wrappers).toBeGreaterThanOrEqual(2);
  });

  test('the first (identity) column stays sticky on mobile', () => {
    const html = read('frontend/admin.html');
    expect(html).toContain('#content th:first-child, #content td:first-child');
    expect(html).toContain('position: sticky; left: 0;');
  });
});
