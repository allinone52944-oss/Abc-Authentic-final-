// End-to-end smoke: adapter.extractFields + adapter.buildReports
// on the bundled template reports (sample v1/v2 fixtures), through
// the REAL adapter + REAL Python pipeline — no mocks.
// Run from the repo root with the test venv first on PATH so
// `python3` has pymupdf/Pillow/qrcode/fonttools:
//   PATH=/home/hatch/workspace/.tmp-server-copy/venv/bin:$PATH \
//     node engines/nid-server-report/tests/smoke.js
// Prints only counts/sizes — NEVER field values (the templates
// carry a sample person's data; identifiers stay out of logs).
const fs = require('fs');
const path = require('path');
const adapter = require('../adapter');

const ENGINE = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nsr-smoke-'));

async function main() {
  const v1Tpl = path.join(ENGINE, 'report_v1_template.pdf');
  const src = fs.readFileSync(v1Tpl);
  const ex = await adapter.extractFields(src, 'smoke-user');
  console.log('extract ok:', ex.ok, '| error:', ex.error || 'none');
  if (!ex.ok) process.exit(1);
  console.log('fields extracted:', Object.keys(ex.fields).length);
  console.log('hasCoreData:', adapter.hasCoreData(ex.fields));
  console.log('images:', (ex.images || []).map((i) => i.name).join(', ') || 'none');
  const build = await adapter.buildReports(ex.jobId, ex.fields, ex.images, 'smoke-user');
  console.log('build ok:', build.ok, '| error:', build.error || 'none');
  if (!build.ok) process.exit(1);
  console.log('v1 bytes:', build.v1Buffer.length, '| v2 bytes:', build.v2Buffer.length);
  const out = path.join(TMP, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, build.base + '-v1.pdf'), build.v1Buffer);
  fs.writeFileSync(path.join(out, build.base + '-v2.pdf'), build.v2Buffer);
  console.log('smoke output dir:', out);
  console.log('SMOKE PASS');
}

main().catch((e) => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
