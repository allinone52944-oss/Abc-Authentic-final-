// build-standalone.js - assemble cert-engine-standalone.js (single-file engine).
//   node build-standalone.js
// Injects: bundled qrcode.js (UMD tail stripped) + validated Code128 table
// into standalone-core.js. Re-run after touching either source.
const fs = require('fs');
const path = require('path');

const QR_PATH = path.join(__dirname, '..', 'birth-certificate', 'assets', 'vendor', 'qrcode.js');
const TABLE_PATH = path.join(__dirname, '_c128table.json');
const CORE_PATH = path.join(__dirname, 'standalone-core.js');
const OUT_PATH = path.join(__dirname, 'cert-engine-standalone.js');

const qr = fs.readFileSync(QR_PATH, 'utf8');
const marker = '\n(function (factory) {';
const idx = qr.indexOf(marker);
if (idx < 0) throw new Error('qrcode UMD tail marker not found');
const qrBody = qr.slice(0, idx).replace(/\s+$/, '');
if (/module\.exports|define\(/.test(qrBody)) throw new Error('qrcode body still references UMD');
if (!/var qrcode = function/.test(qrBody)) throw new Error('qrcode factory not found');

const table = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8'));
if (table.patterns.length !== 107 || table.patterns[103] !== null) throw new Error('bad table');

let core = fs.readFileSync(CORE_PATH, 'utf8');
if (!core.includes('/*__QRCODE_BODY__*/') || !core.includes('/*__C128_TABLE__*/null')) {
    throw new Error('core placeholders missing');
}
core = core.replace('/*__QRCODE_BODY__*/', () => qrBody);
core = core.replace('/*__C128_TABLE__*/null', () => JSON.stringify(table.patterns));

const headerNote = '// Assembled by build-standalone.js on ' + new Date().toISOString() +
    ' from standalone-core.js + qrcode.js + _c128table.json\n';
fs.writeFileSync(OUT_PATH, headerNote + core);
const kb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
console.log('wrote cert-engine-standalone.js (' + kb + ' KB)');
// sanity: require + smoke
const CE = require(OUT_PATH);
CE.build({ number: '20008812737140064' }).then((r) => {
    console.log('smoke: key=' + r.key.slice(0, 12) + '... bar=' + r.barcode.moduleCount +
        ' qr=' + r.qr.moduleSize + ' code=' + r.code);
}).catch((e) => { console.error('SMOKE FAIL', e.message); process.exit(1); });
