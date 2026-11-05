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

describe('orders.html — every status has a filter button (audit #42)', () => {
  const html = read('frontend/orders.html');
  const buttons = [...html.matchAll(/<button class="fbtn[^"]*" data-st="([^"]*)">([^<]*)<\/button>/g)];

  test('ব্যর্থ / গৃহীত / নিবন্ধিত each have their own button', () => {
    const bySt = Object.fromEntries(buttons.map(([, st, label]) => [st, label]));
    expect(bySt.failed).toBe('ব্যর্থ');
    expect(bySt.received).toBe('গৃহীত');
    expect(bySt.registered).toBe('নিবন্ধিত');
  });

  test('বাতিল and রিফান্ড are separate buttons (no merged বাতিল/রিফান্ড)', () => {
    const bySt = Object.fromEntries(buttons.map(([, st, label]) => [st, label]));
    expect(bySt.cancelled).toBe('বাতিল');
    expect(bySt.refunded).toBe('রিফান্ডেড');
    // no button label merges two statuses (the HTML comment above
    // the row still mentions the old merged label, by design)
    for (const [, , label] of buttons) expect(label).not.toContain('/');
  });

  test('every button label matches the status word the list shows (STBN)', () => {
    const stbn = { new: 'নতুন', pending: 'অপেক্ষমান', received: 'গৃহীত', processing: 'প্রসেসিং', registered: 'নিবন্ধিত', completed: 'সম্পন্ন', delivered: 'ডেলিভার্ড', failed: 'ব্যর্থ', cancelled: 'বাতিল', refunded: 'রিফান্ডেড' };
    for (const [, st, label] of buttons) {
      if (!st) continue; // "সব অর্ডার" has no status
      expect(label).toBe(stbn[st]);
    }
    // the #41 deep link works for the new buttons too (whitelisted
    // against the DOM buttons, not a hardcoded list)
    expect(html).toContain('querySelector(\'#filters .fbtn[data-st="\' + wantStatus + \'"]\')');
  });
});
