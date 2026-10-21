// Regression guard (2026-10-21): admin.js runs inside an IIFE, so
// any controller referenced from an inline handler
// (onclick="AdmX.method()") MUST be exported as window.AdmX —
// otherwise the click throws "AdmX is not defined". This is how
// AdmActivity shipped broken: defined with const, never exported.
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', '..', 'frontend');
const adminJs = fs.readFileSync(path.join(FRONTEND, 'js', 'admin.js'), 'utf8');
const appJs = fs.readFileSync(path.join(FRONTEND, 'js', 'app.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(FRONTEND, 'admin.html'), 'utf8');

function handlerSegments(src) {
  const segs = [];
  for (const m of src.matchAll(/on(?:click|keydown|change)=\\"([^"]*?)\\"/g)) segs.push(m[1]);
  for (const m of src.matchAll(/on(?:click|keydown|change)="([^"]*)"/g)) segs.push(m[1]);
  return segs;
}

test('every controller used in an inline handler is window-exported', () => {
  const used = new Set();
  for (const seg of [...handlerSegments(adminJs), ...handlerSegments(adminHtml)]) {
    for (const m of seg.matchAll(/\b([A-Z][A-Za-z0-9]*)\s*\./g)) used.add(m[1]);
  }
  expect(used.size).toBeGreaterThan(0);
  const exported = new Set();
  for (const m of (adminJs + '\n' + appJs).matchAll(/window\.([A-Za-z0-9]+)\s*=/g)) exported.add(m[1]);
  const missing = [...used].filter((id) => !exported.has(id));
  expect(missing).toEqual([]);
});
