// engine.js self-test: generate outputs for the delivery number + official URL.
// Writes to _test_out/ for external (Python zxingcpp) cross-verification.
// Usage: node test_engine.js
const fs = require('fs');
const path = require('path');
const engine = require('./engine');

const NUMBER = '20008812737140064';
const OFFICIAL_URL = 'https://bdris.gov.bd/certificate/verify?key=TSYiAHrMWWjGwps6S6dAppFbTVJIdTFSZUXfAtUFCwWY3nhUm30/BEy2sCdsZ3cP';

const outDir = path.join(__dirname, '_test_out');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
    const r1 = await engine.build({ number: NUMBER });                       // engine-generated key
    const r2 = await engine.build({ number: NUMBER, url: OFFICIAL_URL });    // official (BDRIS) URL

    fs.writeFileSync(path.join(outDir, 'qr.png'), r2.qr.png);            // official URL -> compare vs birth-certificate assets/qr.png
    fs.writeFileSync(path.join(outDir, 'qr_engine.png'), r1.qr.png);     // engine URL
    fs.writeFileSync(path.join(outDir, 'barcode.png'), r1.barcode.png);  // compare vs birth-certificate assets/barcode.png

    const result = {
        number: NUMBER,
        engineKey: r1.key,
        engineKeyLen: r1.key.length,
        engineUrl: r1.verifyUrl,
        engineKeySource: r1.keySource,
        officialUrl: r2.verifyUrl,
        officialKeySource: r2.keySource,
        officialKey: r2.key,
        qrModules: r1.qr.moduleSize,
        barcodeModules: r1.barcode.moduleCount,
        barcodeSize: [r1.barcode.width, r1.barcode.height],
        qrSize: [r1.qr.width, r1.qr.height]
    };
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    const matOff = engine.qrMatrix(r2.qr.content);
    fs.writeFileSync(path.join(outDir, 'matrix_official.json'), JSON.stringify({ size: matOff.size, data: Array.from(matOff.data) }));
    const matEng = engine.qrMatrix(r1.qr.content);
    fs.writeFileSync(path.join(outDir, 'matrix_engine.json'), JSON.stringify({ size: matEng.size, data: Array.from(matEng.data) }));
    console.log(JSON.stringify(result, null, 2));
    console.log('test outputs written to _test_out/');
})().catch((e) => { console.error(e); process.exit(1); });
