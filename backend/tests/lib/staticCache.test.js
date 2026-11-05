// Audit #68 — cache headers: immutable only with ?v=, short cache
// otherwise; the same rule on /assets; HTML always revalidates.
const { cacheControlFor } = require('../../lib/staticCache');

describe('static cache rule (audit #68)', () => {
  test('versioned assets get 1-year immutable', () => {
    expect(cacheControlFor('/js/app.js?v=18', '/x/app.js')).toBe('public, max-age=31536000, immutable');
    expect(cacheControlFor('/css/premium.css?v=1', '/x/premium.css')).toBe('public, max-age=31536000, immutable');
    expect(cacheControlFor('/mouza-offices.json?v=1', '/x/mouza-offices.json')).toBe('public, max-age=31536000, immutable');
    expect(cacheControlFor('/assets/fonts/a.woff2?v=2', '/x/a.woff2')).toBe('public, max-age=31536000, immutable');
  });

  test('unversioned assets get a short cache, never immutable', () => {
    expect(cacheControlFor('/js/socket.io.min.js', '/x/socket.io.min.js')).toBe('public, max-age=3600, must-revalidate');
    expect(cacheControlFor('/icons/whatsapp.svg', '/x/whatsapp.svg')).toBe('public, max-age=3600, must-revalidate');
    // no URL at all (e.g. setHeaders without req) fails safe: short cache
    expect(cacheControlFor(undefined, '/x/app.js')).toBe('public, max-age=3600, must-revalidate');
  });

  test('HTML always revalidates, whatever the query', () => {
    expect(cacheControlFor('/dashboard.html?v=1', '/x/dashboard.html')).toBe('no-cache, no-store, must-revalidate');
    expect(cacheControlFor('/dashboard.html', '/x/dashboard.html')).toBe('no-cache, no-store, must-revalidate');
  });

  test('unknown extensions keep the Express default (no header set)', () => {
    expect(cacheControlFor('/x.map?v=1', '/x/app.js.map')).toBeUndefined();
  });
});

describe('static cache wiring (audit #68)', () => {
  const fs = require('fs');
  const path = require('path');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

  test('both static mounts use the shared cache rule', () => {
    expect(serverSrc).toContain("require('./lib/staticCache')");
    expect(serverSrc).toContain('setHeaders: staticCacheHeaders');
    // frontend mount + /assets mount, no bare express.static without setHeaders
    const mounts = serverSrc.match(/express\.static\(/g) || [];
    expect(mounts.length).toBe(2);
    expect(serverSrc).not.toContain('max-age=31536000, immutable');
  });

  test('every JS reference in the frontend is versioned', () => {
    const FRONTEND = path.join(__dirname, '..', '..', '..', 'frontend');
    const unversioned = [];
    for (const f of fs.readdirSync(FRONTEND).filter((x) => x.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(FRONTEND, f), 'utf8');
      for (const m of html.matchAll(/(?:src|href)="([^"]+\.js)"/g)) {
        if (!m[1].includes('?v=')) unversioned.push(f + ': ' + m[1]);
      }
    }
    expect(unversioned).toEqual([]);
  });
});
