/**
 * Audit #86 — orphan/dead files stay removed.
 *
 * frontend/css/blue.css and frontend/css/coffee.css had zero
 * references from any HTML/JS (old theme files; the rebuild
 * loads premium.css). frontend/offline.html had zero references
 * and could never be served: sw.js (v6) deliberately has no
 * fetch handler (a cache-first strategy caused corrupt/stale
 * renders), so no offline fallback exists to show it. Re-adding
 * offline support would be a new service-worker design, not a
 * restore of this file — it stays in git history.
 *
 * NOT dead, and NOT removed (the audit's own proof): birth-final
 * and death-final are mounted; land-scan/search/verify index.js
 * files are loader manifests; land-khatian/mouza are linked from
 * service-detail; engine-internal standalone HTML may be dev
 * tools and is outside frontend-static scope.
 */
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', '..', 'frontend');

function frontendFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...frontendFiles(p));
    else if (/\.(html|js|css|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('audit #86 — dead files stay gone', () => {
  test('the three orphan files do not exist', () => {
    expect(fs.existsSync(path.join(FRONTEND, 'css', 'blue.css'))).toBe(false);
    expect(fs.existsSync(path.join(FRONTEND, 'css', 'coffee.css'))).toBe(false);
    expect(fs.existsSync(path.join(FRONTEND, 'offline.html'))).toBe(false);
  });

  test('nothing in the frontend references the removed files', () => {
    const hits = { 'blue.css': 0, 'coffee.css': 0, 'offline.html': 0 };
    for (const f of frontendFiles(FRONTEND)) {
      const text = fs.readFileSync(f, 'utf8');
      for (const name of Object.keys(hits)) {
        hits[name] += text.split(name).length - 1;
      }
    }
    expect(hits['blue.css']).toBe(0);
    expect(hits['offline.html']).toBe(0);
    // Exactly one mention of coffee.css remains: the historical
    // note in motion.css ('was coffee.css-only; rebuilt pages
    // don't load it') — a comment, not a load.
    expect(hits['coffee.css']).toBe(1);
  });
});
