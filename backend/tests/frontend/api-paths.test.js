/**
 * Regression guard — ABC.api() path prefix.
 *
 * Keep authored paths relative to the API base (e.g. ABC.api('/services')).
 * The helper also accepts full root-relative API paths returned by History.
 * app.test.js covers those returned paths through token refresh.
 *
 * That exact bug shipped in qr-photo-verify.html (2026-10-21,
 * `const API = '/api/qr-verify'`): the price line never loaded and the
 * verify POST would have 404'd too. This scan makes the mistake
 * impossible to reintroduce in any page.
 */

const fs = require('fs');
const path = require('path');

const FRONTEND_DIR = path.join(__dirname, '..', '..', '..', 'frontend');
// app.js is the implementation of api() itself — it legitimately
// contains the '/api' prefix in its own fetch() calls.
const SKIP = new Set([path.join('js', 'app.js')]);

function collectFiles(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.join(base, name);
    if (fs.statSync(full).isDirectory()) collectFiles(full, rel, out);
    else if (/\.(html|js)$/.test(name) && !SKIP.has(rel)) out.push(full);
  }
  return out;
}

describe('ABC.api() paths must not repeat the /api prefix', () => {
  const files = collectFiles(FRONTEND_DIR, '', []);
  const directCall = /ABC\.api\(\s*['"`]\/api\b/;
  const assignedBase = /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*['"`]\/api\b/;

  test('scan actually covers pages that use ABC.api', () => {
    const users = files.filter((f) => fs.readFileSync(f, 'utf8').includes('ABC.api('));
    expect(users.length).toBeGreaterThan(5);
  });

  test('no ABC.api() call passes an /api-prefixed literal', () => {
    const bad = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      if (directCall.test(src)) bad.push(path.relative(FRONTEND_DIR, f));
    }
    expect(bad).toEqual([]);
  });

  test('no base-path variable assigned an /api-prefixed literal in ABC.api pages', () => {
    const bad = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      if (src.includes('ABC.api(') && assignedBase.test(src)) {
        bad.push(path.relative(FRONTEND_DIR, f));
      }
    }
    expect(bad).toEqual([]);
  });
});
