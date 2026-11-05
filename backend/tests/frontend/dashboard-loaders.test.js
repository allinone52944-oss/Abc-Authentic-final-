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
