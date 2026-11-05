// Audit #41 — dashboard status cards link to /orders.html?status=…
// but the page ignored the query and always showed all orders.
// The page now reads ?status= on load and activates the matching
// filter button.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('orders.html — ?status= deep link (audit #41)', () => {
  const html = read('frontend/orders.html');
  const dashboard = read('frontend/dashboard.html');

  test('init reads ?status= from the URL', () => {
    expect(html).toContain("new URLSearchParams(location.search).get('status')");
  });

  test('the matching filter button is activated and the filter applied', () => {
    expect(html).toContain('querySelector(\'#filters .fbtn[data-st="\' + wantStatus + \'"]\')');
    expect(html).toContain("wantBtn.classList.add('on')");
    expect(html).toContain('status = wantStatus');
    // the status is applied before the first load (the last load() in
    // init — earlier ones are inside the click handlers)
    const initFn = html.slice(html.indexOf('async function init(){'), html.indexOf('async function load(){'));
    expect(initFn.indexOf('status = wantStatus')).toBeLessThan(initFn.lastIndexOf('load();'));
  });

  test('an unknown ?status= falls back to all orders (no filter set)', () => {
    const initFn = html.slice(html.indexOf('async function init(){'), html.indexOf('async function load(){'));
    expect(initFn).toContain('if (wantBtn) {');
    expect(initFn).not.toMatch(/status = wantStatus;\s*}\s*else/);
  });

  test('the dashboard actually links here with ?status= (the links this fix serves)', () => {
    expect(dashboard).toContain("'/orders.html?status=completed'");
    expect(dashboard).toContain("'/orders.html?status=processing'");
  });
});
