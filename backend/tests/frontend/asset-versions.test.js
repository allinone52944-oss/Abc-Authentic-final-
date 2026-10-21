// Regression guard (2026-10-21): shared CSS/JS assets are served
// through Cloudflare's immutable cache keyed by the full URL, so
// every page MUST reference the same ?v= of a shared asset. The
// dashboard was bumped to motion.css?v=3 while all other pages
// stayed on ?v=2 — they kept receiving the old cached stylesheet
// and the WhatsApp floating button lost its green styling there.
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', '..', 'frontend');

test('all pages reference the SAME version of each shared asset', () => {
  const seen = new Map(); // asset -> Map(version -> [files])
  for (const f of fs.readdirSync(FRONTEND).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(FRONTEND, f), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="[^"]*\/([a-z0-9.-]+\.(?:css|js))\?v=(\d+)"/g)) {
      const [, asset, v] = m;
      if (!seen.has(asset)) seen.set(asset, new Map());
      const byVer = seen.get(asset);
      if (!byVer.has(v)) byVer.set(v, []);
      byVer.get(v).push(f);
    }
  }
  const drift = [];
  for (const [asset, byVer] of seen) {
    if (byVer.size > 1) {
      drift.push(asset + ': ' + [...byVer.entries()].map(([v, files]) => 'v' + v + ' in ' + files.join(', ')).join(' | '));
    }
  }
  expect(drift).toEqual([]);
});
