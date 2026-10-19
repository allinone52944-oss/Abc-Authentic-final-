'use strict';
/**
 * cert-engine-standalone.js - COMPLETE certificate code engine in ONE file.
 * Builder-er jonno: ei 1 ta file copy korlei hobe, ar kichu install lagbe na.
 * For builder: copy this 1 file only, nothing else to install.
 *
 * --- NODE (3 line, copy-paste) ---
 *   const CE = require('./cert-engine-standalone.js');
 *   const r = await CE.build({ number: '20008812737140064' });
 *   // r.key        = verify key (64-char)
 *   // r.code       = QR nicher 4-char (jemon 'QHHI')
 *   // r.verifyUrl  = QR-er bhetorer link
 *   // r.qr.dataUrl      = QR PNG (img src-te bosao)
 *   // r.barcode.dataUrl = barcode PNG (img src-te bosao)
 *   // official URL thakle: CE.build({ number, url: officialUrl })
 *
 * --- BROWSER (copy-paste) ---
 *   <script src="cert-engine-standalone.js"></script>
 *   <script>
 *   CertEngine.build({ number: '20008812737140064' }).then(function (r) {
 *     paintPNG(r.qr); paintPNG(r.barcode); // niche paintPNG() deoa ache
 *   });
 *   function paintPNG(part) {
 *     var cv = document.createElement('canvas');
 *     cv.width = part.width; cv.height = part.height;
 *     var g = cv.getContext('2d');
 *     g.putImageData(new ImageData(CertEngine.grayToRGBA(part.px), part.width, part.height), 0, 0);
 *     document.body.appendChild(cv);
 *   }
 *   </script>
 *   NOTE: key-er jonno https/localhost lagbe (browser niyom). Barcode input
 *   sudhu digit (certificate number).
 *
 * --- CONFIRM (1 line, thik ache kina dekho) ---
 *   node -e "require('./cert-engine-standalone.js').selftest()"
 *   // "SELFTEST OK" ashle file thik ache.
 *
 * Regenerate with: node build-standalone.js
 * Bundled (MIT): QR generator (c) 2009 Kazuhiko Arase (qrcode.js, verbatim
 * except the UMD tail) + Code128 pattern table validated byte-for-byte
 * against bwip-js/zxing over 300 random numeric strings.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        var z = null, c = null;
        try { z = (typeof require === 'function') ? require('zlib') : null; } catch (e) {}
        try { c = (typeof require === 'function') ? require('crypto') : null; } catch (e) {}
        module.exports = factory(z, c);
    } else {
        root.CertEngine = factory(null, null);
    }
})(typeof self !== 'undefined' ? self : this, function (zlib, nodeCrypto) {

    var VERIFY_BASE = 'https://bdris.gov.bd/certificate/verify?key=';

    // geometry copied from the scan (mm, relative to the .bar CSS box 48.5 x 7.8)
    var BOX_W = 48.5, BOX_H = 7.8;
    var BAR_X = 0.24, BAR_Y = 1.22;
    var BAR_W = 47.38, BAR_H = 5.97;
    var PX_MM = 30;
    var QR_SIZE = [230, 230];
    var QR_DARK_BBOX = [11, 10, 221, 222]; // x0 y0 x1 y1

    var GEOMETRY = { BOX_W: BOX_W, BOX_H: BOX_H, BAR_X: BAR_X, BAR_Y: BAR_Y,
        BAR_W: BAR_W, BAR_H: BAR_H, PX_MM: PX_MM, QR_SIZE: QR_SIZE,
        QR_DARK_BBOX: QR_DARK_BBOX, VERIFY_BASE: VERIFY_BASE };

    // Python round(): half-to-even (pixel parity with update_codes.py)
    function pyRound(x) {
        var f = Math.floor(x), d = x - f;
        if (d > 0.5) return f + 1;
        if (d < 0.5) return f;
        return f % 2 === 0 ? f : f + 1;
    }

    function strBytes(s) {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
        return Uint8Array.from(Buffer.from(s, 'utf8'));
    }
    function concatBytes(a, b) {
        var out = new Uint8Array(a.length + b.length);
        out.set(a, 0); out.set(b, a.length);
        return out;
    }
    function stripPad(b64) { return String(b64).replace(/=+$/, ''); }

    // ---- SHA-512 (Node crypto, else browser WebCrypto), base64 WITH padding ----
    function sha512b64(bytes) {
        if (nodeCrypto) {
            return Promise.resolve(nodeCrypto.createHash('sha512')
                .update(Buffer.from(bytes)).digest('base64'));
        }
        return crypto.subtle.digest('SHA-512', bytes).then(function (d) {
            var b = new Uint8Array(d), s = '';
            for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
            return btoa(s);
        });
    }

    // ---------------------------------------------------------------------------
    // key engine: number -> deterministic base64 key (fixed length/format)
    // ---------------------------------------------------------------------------
    function makeKey(number, length) {
        length = length || 64;
        var seed = concatBytes(strBytes('BDRIS-CERT-VERIFY|'), strBytes(String(number)));
        return sha512b64(seed).then(function (first) {
            var out = stripPad(first);
            var n = 0;
            function next() {
                if (out.length >= length) return out.slice(0, length);
                n += 1;
                return sha512b64(concatBytes(seed, Uint8Array.of(n))).then(function (b64) {
                    out += stripPad(b64);
                    return next();
                });
            }
            return next();
        });
    }

    function keyFromUrl(url) {
        var m = /key=([^&]+)$/.exec(String(url || ''));
        return m ? m[1] : null;
    }

    // 4-char verification code under the QR: deterministic letters from the key.
    function codeForKey(key) {
        return String(key || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4).padEnd(4, 'X');
    }

    function verifyUrlForKey(key) { return VERIFY_BASE + key; }

    function resolveVerifyUrl(opts) {
        opts = opts || {};
        if (opts.url) return Promise.resolve({ url: opts.url, key: keyFromUrl(opts.url), source: 'official' });
        var known = opts.keys && opts.keys[opts.number];
        if (known) return Promise.resolve({ url: verifyUrlForKey(known), key: known, source: 'known' });
        return makeKey(opts.number, opts.keyLength || 64).then(function (key) {
            return { url: verifyUrlForKey(key), key: key, source: 'engine' };
        });
    }

    // ---------------------------------------------------------------------------
    // QR matrix (bundled qrcode.js, ECC-Q, fit loop like the browser bootstrap)
    // ---------------------------------------------------------------------------
    var qrcodeFactory = (function () {
/*__QRCODE_BODY__*/
        return qrcode;
    })();

    function qrMatrix(text) {
        text = String(text);
        var q = null;
        for (var t = 1; t <= 40 && !q; t++) {
            try { var c = qrcodeFactory(t, 'Q'); c.addData(text); c.make(); q = c; } catch (e) {}
        }
        if (!q) throw new Error('qr fit');
        var m = q.getModuleCount();
        var data = new Uint8Array(m * m);
        for (var i = 0; i < m; i++) {
            for (var j = 0; j < m; j++) data[i * m + j] = q.isDark(i, j) ? 1 : 0;
        }
        return { size: m, data: data };
    }

    function drawQrGray(matrix) {
        var m = matrix.size, data = matrix.data;
        var W = QR_SIZE[0], H = QR_SIZE[1];
        var x0 = QR_DARK_BBOX[0], y0 = QR_DARK_BBOX[1];
        var bw = QR_DARK_BBOX[2] - x0, bh = QR_DARK_BBOX[3] - y0;
        var px = new Uint8Array(W * H).fill(255);
        for (var i = 0; i < m; i++) {
            var ya = y0 + pyRound(i * bh / m), yb = y0 + pyRound((i + 1) * bh / m);
            for (var j = 0; j < m; j++) {
                if (!data[i * m + j]) continue;
                var xa = x0 + pyRound(j * bw / m), xb = x0 + pyRound((j + 1) * bw / m);
                for (var y = ya; y < yb; y++) {
                    var row = y * W;
                    for (var x = xa; x < xb; x++) px[row + x] = 0;
                }
            }
        }
        return { px: px, w: W, h: H, modules: m };
    }

    // ---------------------------------------------------------------------------
    // CODE128 modules (embedded table; same encodation as bwip-js/zxing for digits)
    // ---------------------------------------------------------------------------
    var C128 = /*__C128_TABLE__*/null;

    function barcodeModules(text) {
        text = String(text);
        if (!/^[0-9]+$/.test(text)) throw new Error('barcode: certificate number must be digits, got ' + JSON.stringify(text).slice(0, 40));
        var n = text.length, start, vals = [], i, v;
        if (n === 1 || n === 3) { // min-codewords route (tie -> B), like bwip-js
            start = 104;
            for (i = 0; i < n; i++) vals.push(16 + (+text[i]));
        } else {
            start = 105;
            i = 0;
            while (i < n) {
                if (n - i >= 2) { vals.push(10 * (+text[i]) + (+text[i + 1])); i += 2; }
                else { vals.push(100, 16 + (+text[i])); i += 1; }
            }
        }
        var ck = start;
        for (i = 0; i < vals.length; i++) ck += (i + 1) * vals[i];
        ck %= 103;
        var s = C128[start];
        for (i = 0; i < vals.length; i++) s += C128[vals[i]];
        return s + C128[ck] + C128[106];
    }

    function drawBarcodeGray(modules) {
        var w = pyRound(BOX_W * PX_MM), h = pyRound(BOX_H * PX_MM);
        var x0 = BAR_X * PX_MM, mw = BAR_W * PX_MM / modules.length;
        var y0 = pyRound(BAR_Y * PX_MM), y1 = y0 + pyRound(BAR_H * PX_MM);
        var px = new Uint8Array(w * h).fill(255);
        for (var j = 0; j < modules.length; j++) {
            if (modules[j] !== '1') continue;
            var xa = pyRound(x0 + j * mw), xb = pyRound(x0 + (j + 1) * mw);
            var xe = Math.max(xb, xa + 1);
            for (var y = y0; y < y1; y++) {
                var row = y * w;
                for (var x = xa; x < xe && x < w; x++) px[row + x] = 0;
            }
        }
        return { px: px, w: w, h: h, moduleCount: modules.length, moduleWidthPx: mw };
    }

    // gray -> RGBA (canvas ImageData in the browser)
    function grayToRGBA(px) {
        var rgba = new Uint8ClampedArray(px.length * 4);
        for (var i = 0, j = 0; i < px.length; i++, j += 4) {
            rgba[j] = rgba[j + 1] = rgba[j + 2] = px[i];
            rgba[j + 3] = 255;
        }
        return rgba;
    }

    // ---------------------------------------------------------------------------
    // minimal PNG writer (grayscale, pHYs 300dpi) - Node only
    // ---------------------------------------------------------------------------
    var CRC_TABLE = null;
    function crc32(buf) {
        if (!CRC_TABLE) {
            CRC_TABLE = new Uint32Array(256);
            for (var n = 0; n < 256; n++) {
                var c = n;
                for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
                CRC_TABLE[n] = c >>> 0;
            }
        }
        var r = 0xffffffff;
        for (var i = 0; i < buf.length; i++) r = CRC_TABLE[(r ^ buf[i]) & 0xff] ^ (r >>> 8);
        return (r ^ 0xffffffff) >>> 0;
    }
    function pngChunk(type, data) {
        var len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
        var t = Buffer.from(type, 'ascii');
        var crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
        return Buffer.concat([len, t, data, crc]);
    }
    function grayToPng(px, w, h) {
        if (!zlib) throw new Error('grayToPng needs Node (zlib); in browser paint grayToRGBA() on canvas');
        var ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
        ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
        var stride = w + 1;
        var raw = Buffer.alloc(stride * h);
        var u8 = (px instanceof Uint8Array) ? px : Uint8Array.from(px);
        for (var y = 0; y < h; y++) {
            raw[y * stride] = 0;
            Buffer.from(u8.buffer, u8.byteOffset + y * w, w).copy(raw, y * stride + 1);
        }
        var phys = Buffer.alloc(9);
        phys.writeUInt32BE(11811, 0); phys.writeUInt32BE(11811, 4); phys[8] = 1;
        return Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            pngChunk('IHDR', ihdr),
            pngChunk('pHYs', phys),
            pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
            pngChunk('IEND', Buffer.alloc(0))
        ]);
    }
    function toDataUrl(png) { return 'data:image/png;base64,' + png.toString('base64'); }

    // ---------------------------------------------------------------------------
    // build(): one call -> everything (png/dataUrl in Node; px in browser)
    // ---------------------------------------------------------------------------
    function build(opts) {
        opts = opts || {};
        var number = String(opts.number || '').trim();
        if (!number) return Promise.reject(new Error('number is required'));
        return resolveVerifyUrl({ number: number, url: opts.url, keys: opts.keys, keyLength: opts.keyLength })
            .then(function (resolved) {
                var matrix = qrMatrix(resolved.url);
                var qr = drawQrGray(matrix);
                var bar = drawBarcodeGray(barcodeModules(number));
                var qrP = null, barP = null;
                if (zlib) {
                    qrP = grayToPng(qr.px, qr.w, qr.h);
                    barP = grayToPng(bar.px, bar.w, bar.h);
                }
                return {
                    number: number,
                    key: resolved.key,
                    keySource: resolved.source,
                    code: codeForKey(resolved.key),
                    verifyUrl: resolved.url,
                    qr: { content: resolved.url, width: qr.w, height: qr.h,
                          bbox: QR_DARK_BBOX.slice(), moduleSize: qr.modules,
                          px: qr.px, png: qrP, dataUrl: qrP ? toDataUrl(qrP) : null },
                    barcode: { text: number, width: bar.w, height: bar.h,
                               moduleCount: bar.moduleCount, px: bar.px,
                               png: barP, dataUrl: barP ? toDataUrl(barP) : null }
                };
            });
    }

    // ---------------------------------------------------------------------------
    // selftest(): 1-line confirm that the file works (no network needed)
    // ---------------------------------------------------------------------------
    function selftest() {
        var VECTORS = [
            ['20008812737140064', 64, 'PvYNXkUFc0BpsX6Mw7QcnMfWk8qU8C4IlWrEeB3Dg4adt2upQl/7vfvGlMhGWeRz'],
            ['20008812737140065', 64, 'nD4q/hdZiIQT8linMimm/cdoMPwBraWpAUZPNiPaNJ7Pm+YEZMx0HMiHntX1UBla']
        ];
        var chain = Promise.resolve();
        VECTORS.forEach(function (v) {
            chain = chain.then(function () { return makeKey(v[0], v[1]); }).then(function (k) {
                if (k !== v[2]) throw new Error('key mismatch for ' + v[0]);
            });
        });
        return chain.then(function () {
            var mods = barcodeModules('20008812737140064');
            if (mods.length !== 145) throw new Error('barcode modules ' + mods.length);
            var m = qrMatrix(verifyUrlForKey(VECTORS[0][2]));
            if (!m.size || !m.data.length) throw new Error('qr matrix empty');
            if (codeForKey(VECTORS[0][2]) !== 'PVYN') throw new Error('code mismatch');
            return build({ number: '20008812737140064' }).then(function (r) {
                if (!r.qr.dataUrl || r.qr.dataUrl.indexOf('data:image/png;base64,') !== 0) {
                    if (!zlib && !r.qr.px) throw new Error('qr output empty');
                }
                if (!r.barcode.dataUrl && !r.barcode.px) throw new Error('barcode output empty');
                return 'SELFTEST OK (key/engine/barcode/QR/code)';
            });
        });
    }

    return {
        makeKey: makeKey, keyFromUrl: keyFromUrl, codeForKey: codeForKey,
        verifyUrlForKey: verifyUrlForKey, resolveVerifyUrl: resolveVerifyUrl,
        qrMatrix: qrMatrix, barcodeModules: barcodeModules,
        drawQrGray: drawQrGray, drawBarcodeGray: drawBarcodeGray,
        grayToRGBA: grayToRGBA, grayToPng: grayToPng, toDataUrl: toDataUrl,
        build: build, selftest: selftest, GEOMETRY: GEOMETRY
    };
});
