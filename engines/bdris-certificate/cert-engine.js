'use strict';
/**
 * cert-engine.js - SINGLE SOURCE OF TRUTH for the certificate code logic.
 *
 * Shared by:
 *   - BDRIS Scrapper (Node)  : require('./cert-engine')
 *   - birth-certificate (browser) : window.CertEngine via <script src>
 *
 * Logic contained (platform-neutral):
 *   key engine   : base64(sha512("BDRIS-CERT-VERIFY|" + number)) stripped, extended, sliced
 *                  (hash primitive is INJECTED: Node crypto / browser WebCrypto - both SHA-512)
 *   verify URL   : https://bdris.gov.bd/certificate/verify?key=...
 *   QR draw      : matrix -> 230x230 gray canvas, dark bbox (11,10,221,222), python-round parity
 *   barcode draw : CODE128 modules -> 48.5x7.8mm box at 30px/mm, bars at x0.24/y1.22mm,
 *                  region 47.38x5.97mm (scan geometry)
 *
 * Providers injected by the platform (see build() second argument):
 *   sha512(bytes)            -> Promise<base64-with-padding>   (SHA-512 of bytes)
 *   bwipjs                   -> bwip-js (raw() for CODE128 modules; node require or browser global)
 *   qrMatrix(text)           -> { size, isDark(i,j) }          (node-qrcode or qrcode.js adapter)
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CertEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    const VERIFY_BASE = 'https://bdris.gov.bd/certificate/verify?key=';

    // geometry copied from the scan (mm, relative to the .bar CSS box 48.5 x 7.8)
    const BOX_W = 48.5, BOX_H = 7.8;
    const BAR_X = 0.24, BAR_Y = 1.22;
    const BAR_W = 47.38, BAR_H = 5.97;
    const PX_MM = 30;
    const QR_SIZE = [230, 230];
    const QR_DARK_BBOX = [11, 10, 221, 222]; // x0 y0 x1 y1

    const GEOMETRY = { BOX_W, BOX_H, BAR_X, BAR_Y, BAR_W, BAR_H, PX_MM, QR_SIZE, QR_DARK_BBOX, VERIFY_BASE };

    // Python round(): half-to-even. Math.round() is half-up - pyRound keeps pixel parity.
    function pyRound(x) {
        const f = Math.floor(x), d = x - f;
        if (d > 0.5) return f + 1;
        if (d < 0.5) return f;
        return f % 2 === 0 ? f : f + 1;
    }

    const strBytes = (s) => (typeof TextEncoder !== 'undefined'
        ? new TextEncoder().encode(s)
        : Uint8Array.from(Buffer.from(s, 'utf8')));

    function concatBytes(a, b) {
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
    }

    const stripPad = (b64) => String(b64).replace(/=+$/, '');

    // ---------------------------------------------------------------------------
    // key engine: number -> deterministic base64 key (fixed length/format)
    // ---------------------------------------------------------------------------
    async function makeKey(number, length, sha512) {
        length = length || 64;
        if (typeof sha512 !== 'function') throw new Error('sha512 provider required');
        const seed = concatBytes(strBytes('BDRIS-CERT-VERIFY|'), strBytes(String(number)));
        let out = stripPad(await sha512(seed));
        let n = 0;
        while (out.length < length) {
            n += 1;
            out += stripPad(await sha512(concatBytes(seed, Uint8Array.of(n))));
        }
        return out.slice(0, length);
    }

    function keyFromUrl(url) {
        const m = /key=([^&]+)$/.exec(String(url || ''));
        return m ? m[1] : null;
    }

    // 4-char verification code under the QR: deterministic letters from the key.
    // (A genuine BDRIS-issued code comes from the record itself and wins;
    //  this is the fallback so the code field is never empty.)
    function codeForKey(key) {
        return String(key || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4).padEnd(4, 'X');
    }

    function verifyUrlForKey(key) {
        return VERIFY_BASE + key;
    }

    /**
     * Resolve verify key/url: explicit url wins, then per-number key map, else engine key.
     * Returns { url, key, source } where source is 'official' | 'known' | 'engine'.
     */
    async function resolveVerifyUrl(opts, sha512) {
        opts = opts || {};
        if (opts.url) return { url: opts.url, key: keyFromUrl(opts.url), source: 'official' };
        const known = opts.keys && opts.keys[opts.number];
        if (known) return { url: verifyUrlForKey(known), key: known, source: 'known' };
        const key = await makeKey(opts.number, opts.keyLength || 64, sha512);
        return { url: verifyUrlForKey(key), key, source: 'engine' };
    }

    // ---------------------------------------------------------------------------
    // barcode: CODE128 module pattern from bwip-js raw encoder (sbs == zxing pattern)
    // ---------------------------------------------------------------------------
    function barcodeModules(text, bwipjs) {
        if (!bwipjs || typeof bwipjs.raw !== 'function') throw new Error('bwipjs provider required');
        const stack = bwipjs.raw('code128', String(text), '');
        const sbs = stack[0].sbs;
        let s = '';
        for (let i = 0; i < sbs.length; i++) s += (i % 2 === 0 ? '1' : '0').repeat(sbs[i]);
        return s; // '1' = dark bar, index 0 = first bar
    }

    function drawBarcodeGray(modules) {
        const w = pyRound(BOX_W * PX_MM);
        const h = pyRound(BOX_H * PX_MM);
        const x0 = BAR_X * PX_MM;
        const mw = BAR_W * PX_MM / modules.length;
        const y0 = pyRound(BAR_Y * PX_MM);
        const y1 = y0 + pyRound(BAR_H * PX_MM);
        const px = new Uint8Array(w * h).fill(255);
        for (let j = 0; j < modules.length; j++) {
            if (modules[j] !== '1') continue;
            const xa = pyRound(x0 + j * mw);
            const xb = pyRound(x0 + (j + 1) * mw);
            const xe = Math.max(xb, xa + 1);
            for (let y = y0; y < y1; y++) {
                const row = y * w;
                for (let x = xa; x < xe && x < w; x++) px[row + x] = 0;
            }
        }
        return { px, w, h, moduleCount: modules.length, moduleWidthPx: mw };
    }

    // ---------------------------------------------------------------------------
    // QR: matrix -> 230x230 gray canvas (scan-exact dark bbox)
    // ---------------------------------------------------------------------------
    function drawQrGray(matrix) {
        const m = matrix.size;
        const W = QR_SIZE[0], H = QR_SIZE[1];
        const x0 = QR_DARK_BBOX[0], y0 = QR_DARK_BBOX[1];
        const bw = QR_DARK_BBOX[2] - x0, bh = QR_DARK_BBOX[3] - y0;
        const px = new Uint8Array(W * H).fill(255);
        for (let i = 0; i < m; i++) {
            const ya = y0 + pyRound(i * bh / m);
            const yb = y0 + pyRound((i + 1) * bh / m);
            for (let j = 0; j < m; j++) {
                if (!matrix.isDark(i, j)) continue;
                const xa = x0 + pyRound(j * bw / m);
                const xb = x0 + pyRound((j + 1) * bw / m);
                for (let y = ya; y < yb; y++) {
                    const row = y * W;
                    for (let x = xa; x < xb; x++) px[row + x] = 0;
                }
            }
        }
        return { px, w: W, h: H, modules: m };
    }

    // gray -> RGBA (for canvas ImageData in the browser)
    function grayToRGBA(px) {
        const rgba = new Uint8ClampedArray(px.length * 4);
        for (let i = 0, j = 0; i < px.length; i++, j += 4) {
            rgba[j] = rgba[j + 1] = rgba[j + 2] = px[i];
            rgba[j + 3] = 255;
        }
        return rgba;
    }

    // ---------------------------------------------------------------------------
    // build(): one call -> everything a certificate output needs (platform-neutral)
    //   opts     : { number, url?, keys?, keyLength? }
    //   providers: { sha512(bytes)->base64|Promise, bwipjs, qrMatrix(text)->matrix }
    // ---------------------------------------------------------------------------
    async function build(opts, providers) {
        opts = opts || {};
        providers = providers || {};
        const number = String(opts.number || '').trim();
        if (!number) throw new Error('number is required');
        const resolved = await resolveVerifyUrl({ number, url: opts.url, keys: opts.keys, keyLength: opts.keyLength },
                                                providers.sha512);
        const matrix = providers.qrMatrix(resolved.url);
        const qr = drawQrGray(matrix);
        const mods = barcodeModules(number, providers.bwipjs);
        const bar = drawBarcodeGray(mods);
        return {
            number,
            key: resolved.key,
            keySource: resolved.source,
            code: codeForKey(resolved.key),
            verifyUrl: resolved.url,
            qr: { content: resolved.url, width: qr.w, height: qr.h, bbox: QR_DARK_BBOX.slice(),
                  moduleSize: qr.modules, px: qr.px },
            barcode: { text: number, width: bar.w, height: bar.h, moduleCount: bar.moduleCount,
                       px: bar.px }
        };
    }

    return {
        GEOMETRY, VERIFY_BASE, pyRound,
        makeKey, keyFromUrl, codeForKey, verifyUrlForKey, resolveVerifyUrl,
        barcodeModules, drawBarcodeGray, drawQrGray, grayToRGBA, build
    };
});
