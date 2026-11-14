// Audit #76 — dashboard banner-load failure shows a retry box like
// the notice loader does, instead of failing silently.
const fs = require('fs');
const path = require('path');

const DASH = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'frontend', 'dashboard.html'),
  'utf8',
);

function fnBody(name) {
  const start = DASH.indexOf('async function ' + name + '()');
  expect(start).toBeGreaterThan(-1);
  const next = DASH.indexOf('\nasync function ', start + 1);
  return DASH.slice(start, next === -1 ? undefined : next);
}

describe('dashboard loaders fail visibly (audit #76)', () => {
  test('loadBanners throws on a non-OK response, like loadNotices', () => {
    expect(fnBody('loadBanners')).toContain("if (!r.ok) throw new Error('bad');");
    expect(fnBody('loadNotices')).toContain("if (!r.ok) throw new Error('bad');");
  });

  test('loadBanners catch renders a retry box on both strips', () => {
    const body = fnBody('loadBanners');
    expect(body).not.toContain('catch (e) {}');
    expect(body).toContain("retryBox('loadBanners')");
    expect(body).toContain("document.getElementById('bnStrip')");
    expect(body).toContain("document.getElementById('bnStripM')");
  });

  test('loadNotices retry behavior is unchanged (the pattern copied)', () => {
    expect(fnBody('loadNotices')).toContain("box.innerHTML = retryBox('loadNotices');");
  });
});

describe('B1#1/B2#12 — dashboard notices render **bold** / *italic*, never raw asterisks or HTML', () => {
  const vm = require('vm');
  function loadRenderNoticeText() {
    const start = DASH.indexOf('function escapeHtml(s)');
    const end = DASH.indexOf('function bnNum(n)');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const ctx = {};
    vm.runInNewContext(DASH.slice(start, end), ctx);
    expect(typeof ctx.renderNoticeText).toBe('function');
    return ctx.renderNoticeText;
  }

  test('the reproduction case renders bold, with no literal asterisks', () => {
    const render = loadRenderNoticeText();
    const out = render('**গুরুত্বপূর্ণ:** আগামীকাল সকাল ৯টা থেকে সেবা বন্ধ থাকবে।');
    expect(out).toBe('<strong>গুরুত্বপূর্ণ:</strong> আগামীকাল সকাল ৯টা থেকে সেবা বন্ধ থাকবে।');
    expect(out).not.toContain('**');
  });

  test('single * renders italic; unmatched * stays literal', () => {
    const render = loadRenderNoticeText();
    expect(render('এটি *গুরুত্বপূর্ণ* তথ্য')).toBe('এটি <em>গুরুত্বপূর্ণ</em> তথ্য');
    expect(render('৫ * ৩ = ১৫')).toBe('৫ * ৩ = ১৫');
  });

  test('stored HTML is escaped first — no markup can execute', () => {
    const render = loadRenderNoticeText();
    const out = render('**সতর্ক:** <script>alert(1)</script>');
    expect(out).toBe('<strong>সতর্ক:</strong> &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>');
  });

  test('both notice renderers use renderNoticeText (list, marquee, modal)', () => {
    expect(fnBody('loadNotices')).toContain('renderNoticeText(n.title)');
    expect(fnBody('loadNotices')).toContain('renderNoticeText(trunc(n.message, 60))');
    expect(fnBody('loadNotices')).toContain('renderNoticeText(valid[0].title)');
    expect(fnBody('showNotices')).toContain("renderNoticeText(n.title || 'বিজ্ঞপ্তি')");
    expect(fnBody('showNotices')).toContain("renderNoticeText(n.message || '')");
  });
});
describe('audit #82 — engine cards render once from ENGINE_CARDS', () => {
  const DASH = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'frontend', 'dashboard.html'),
    'utf8',
  );

  test('one array holds all seven cards; no hardcoded card blocks remain', () => {
    const m = DASH.match(/const ENGINE_CARDS = \[([\s\S]*?)\];/);
    expect(m).toBeTruthy();
    expect(m[1].split('href:').length - 1).toBe(7);
    // The only '<div class="engine-card"' left is the renderer's
    // own template string — the 14 hardcoded blocks are gone.
    expect(DASH.split('<div class="engine-card"').length - 1).toBe(1);
    expect(DASH).not.toContain('<!-- Engine 1:');
    expect(DASH).not.toContain('<!-- M Engine 1');
  });

  test('both grids render from the array, before loadServices updates charges', () => {
    expect(DASH).toContain('id="engineGridDesk"');
    expect(DASH).toContain('id="engineGridMob"');
    expect(DASH).toContain('function renderEngineCards()');
    const init = DASH.slice(DASH.indexOf('async function init()'));
    expect(init.indexOf('renderEngineCards();')).toBeLessThan(init.indexOf('loadServices();'));
  });

  test('the land card price reads the live land-khatian row, not the removed land-search row', () => {
    expect(DASH).toContain("s.engine_id === 'land-khatian'");
    expect(DASH).not.toContain("s.engine_id === 'land-search'");
  });
});
