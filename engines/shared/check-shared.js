'use strict';
// Verification for the shared helpers branch. Run: node engines/shared/check-shared.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..', '..');
function md5(p) { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); }
function fail(m) { console.error('FAIL:', m); process.exit(1); }
const shared = __dirname;
for (const f of ['solve_local.py', 'templates.json', 'cert-engine-standalone.js']) {
  if (!fs.existsSync(path.join(shared, f))) fail('missing shared ' + f);
}
const templates = JSON.parse(fs.readFileSync(path.join(shared, 'templates.json'), 'utf8'));
if (!Array.isArray(templates) || templates.length !== 120) fail('templates must have 120 entries, got ' + templates.length);
for (const [d, v] of templates) { if (!d || !Array.isArray(v) || v.length !== 1024) fail('bad template entry'); }
const CE = require(path.join(shared, 'cert-engine-standalone.js'));
return CE.selftest().then((r) => {
  console.log('shared templates: 120 entries OK');
  console.log('shared cert-engine selftest:', r);
  for (const eng of ['birth-final', 'death-final']) {
    const server = path.join(root, 'engines', eng, eng === 'birth-final' ? 'server.js' : 'death-verify-server.js');
    const src = fs.readFileSync(server, 'utf8');
    if (!src.includes("'shared', 'solve_local.py'")) fail(eng + ' does not resolve shared solver');
    if (fs.existsSync(path.join(root, 'engines', eng, 'solve_local.py'))) fail(eng + ' still has local solve_local.py');
    if (fs.existsSync(path.join(root, 'engines', eng, 'templates.json'))) fail(eng + ' still has local templates.json');
  }
  console.log('both engines resolve shared solver, no local solver/templates copies remain');
  console.log('shared md5 templates:', md5(path.join(shared, 'templates.json')));
});
