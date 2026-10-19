'use strict';
/**
 * engine.js - Node wrapper around the shared cert-engine.js (single source of truth).
 *
 * Same logic as the browser bootstrap in birth-certificate/index.html:
 *   key engine (Node crypto SHA-512) + bwip-js modules + node-qrcode matrix
 *   -> scan-exact QR/barcode gray canvases -> PNG data URLs (Node-only concern).
 *
 * Verify: npm run test:engine  (cross-checked 15/15 against birth-certificate/update_codes.py)
 */
const crypto = require('crypto');
const zlib = require('zlib');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const CE = require('./cert-engine');

const GEOMETRY = CE.GEOMETRY;

// platform providers -------------------------------------------------------
const sha512 = (bytes) => crypto.createHash('sha512').update(Buffer.from(bytes)).digest('base64');

// npm qrcode adapter -> { size, data } (same lib family as browser qrcode.js)
function qrMatrixData(text) {
    const qr = QRCode.create(String(text), { errorCorrectionLevel: 'Q' });
    return { size: qr.modules.size, data: qr.modules.data };
}
const qrMatrix = (text) => {
    const d = qrMatrixData(text);
    return { size: d.size, isDark: (i, j) => !!d.data[i * d.size + j] };
};

const providers = { sha512, bwipjs, qrMatrix };

// ---------------------------------------------------------------------------
// PNG writer (grayscale, pHYs 300dpi like PIL dpi=(300,300)) - Node only
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
}

function grayToPng(px, w, h) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 0;  // color type: grayscale
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const stride = w + 1;
    const raw = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
        raw[y * stride] = 0; // filter: none
        Buffer.from(px.buffer, px.byteOffset + y * w, w).copy(raw, y * stride + 1);
    }
    const phys = Buffer.alloc(9);
    phys.writeUInt32BE(11811, 0); // 300 dpi
    phys.writeUInt32BE(11811, 4);
    phys[8] = 1; // unit: metre
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('pHYs', phys),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

const toDataUrl = (png) => 'data:image/png;base64,' + png.toString('base64');

// ---------------------------------------------------------------------------
// public API (same shape as before the shared-engine refactor; build is async)
// ---------------------------------------------------------------------------
const makeKey = (number, length) => CE.makeKey(number, length, sha512);
const keyFromUrl = CE.keyFromUrl;
const verifyUrlForKey = CE.verifyUrlForKey;
const resolveVerifyUrl = (opts) => CE.resolveVerifyUrl(opts, sha512);

async function qrPng(text) {
    const q = CE.drawQrGray(qrMatrix(text));
    return { png: grayToPng(q.px, q.w, q.h), width: q.w, height: q.h, modules: q.modules };
}

async function barcodePng(text) {
    const mods = CE.barcodeModules(text, bwipjs);
    const b = CE.drawBarcodeGray(mods);
    return { png: grayToPng(b.px, b.w, b.h), width: b.w, height: b.h,
             moduleCount: b.moduleCount, moduleWidthPx: b.moduleWidthPx };
}

async function build(opts) {
    const r = await CE.build(opts, providers);
    const qrP = grayToPng(r.qr.px, r.qr.width, r.qr.height);
    const barP = grayToPng(r.barcode.px, r.barcode.width, r.barcode.height);
    return {
        number: r.number,
        key: r.key,
        keySource: r.keySource,
        code: r.code,
        verifyUrl: r.verifyUrl,
        qr: { content: r.qr.content, width: r.qr.width, height: r.qr.height, bbox: r.qr.bbox,
              moduleSize: r.qr.moduleSize, png: qrP, dataUrl: toDataUrl(qrP) },
        barcode: { text: r.barcode.text, width: r.barcode.width, height: r.barcode.height,
                   moduleCount: r.barcode.moduleCount, png: barP, dataUrl: toDataUrl(barP) }
    };
}

module.exports = {
    makeKey, keyFromUrl, codeForKey: CE.codeForKey, verifyUrlForKey, resolveVerifyUrl,
    qrMatrix: qrMatrixData, qrPng, barcodePng,
    barcodeModules: (text) => CE.barcodeModules(text, bwipjs),
    grayToPng, toDataUrl, build, GEOMETRY, shared: CE
};
