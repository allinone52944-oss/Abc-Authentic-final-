'use strict';
/**
 * engines/death-verify/index.js — Abc Authentic adapter for the
 * Death-Verify Engine (standalone DRN verification tool).
 *
 * WRAPPING ONLY — the engine folder is an as-is copy of the
 * Death-Verify-Engine.zip contents (see README.txt / ENGINE_API.txt /
 * BUILDER_NOTE.txt). No engine logic is modified here.
 * Deterministic: same input → same output.
 *
 * Integration:
 *  - getApp() → Express-compatible middleware wrapping the engine's own
 *    request handler (death-verify-server.js is a raw Node http server, not
 *    an Express app — its handler is captured at load time without ever
 *    binding port 3001). Endpoints used as-is:
 *      GET  /api/captcha       → { success, sessionId, image, diag }
 *      POST /api/solve-captcha → { success, answer, method }
 *      POST /api/verify        → { success, data } | { success:false, error }
 *      POST /api/preview       → { success, html }   (death replica)
 *      POST /api/pdf           → application/pdf bytes (vector A4)
 *  - The backend mounts it at /api/death-engine with JWT auth + rate limit.
 *
 * Notes:
 *  - The main backend applies express.json() globally, which consumes the
 *    request stream before this middleware runs. The engine reads the raw
 *    body itself (req.on('data'/'end')), so the already-parsed body is
 *    re-emitted for it (body replay shim below).
 *  - Python + opencv + ddddocr enable the OFFLINE captcha solver. If they
 *    are missing, the engine degrades gracefully: manual entry (and optional
 *    Gemini) still work — startup never breaks.
 *  - Chrome is needed only for /api/pdf (spawned on demand).
 *  - Fonts are embedded (base64) — no font install needed.
 *
 * Security: DRN is never logged in plain text (masked, last 4 digits).
 */

const path = require('path');
const http = require('http');

let _config = {};
let _handler = null;
let _loaded = false;

// Mask DRN in logs: show only last 4 digits
function maskDrn(drn) {
    const s = String(drn || '').replace(/\D/g, '');
    return s.length > 4 ? '*'.repeat(s.length - 4) + s.slice(-4) : '****';
}

// Load death-verify-server.js WITHOUT letting it bind port 3001.
// The file calls http.createServer(handler) then server.listen(3001).
// We temporarily replace http.createServer to capture the handler and
// return a dummy server whose listen() is a harmless no-op.
// The require() runs synchronously, so the patch is contained in this tick.
function loadEngine() {
    if (_loaded) return;
    const origCreateServer = http.createServer;
    http.createServer = function (listener) {
        if (typeof listener === 'function') _handler = listener;
        const dummy = {};
        const noop = () => dummy;
        dummy.on = noop;
        dummy.once = noop;
        dummy.listen = (port, host, cb) => {
            if (typeof host === 'function') host();
            else if (typeof cb === 'function') cb();
            return dummy;
        };
        dummy.close = noop;
        dummy.address = () => null;
        return dummy;
    };
    try {
        require(path.join(__dirname, 'death-verify-server.js'));
    } finally {
        http.createServer = origCreateServer;
    }
    if (typeof _handler !== 'function') {
        throw new Error('death-verify request handler could not be captured');
    }
    _loaded = true;
}

// The engine reads the raw body via req.on('data')/req.on('end').
// When the main app's global express.json() already consumed the stream,
// re-emit the parsed body so the engine sees exactly what was posted.
function replayBody(req) {
    if (req.body === undefined || typeof req.on !== 'function') return;
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const buf = Buffer.from(raw, 'utf8');
    const origOn = req.on.bind(req);
    req.on = function (ev, fn) {
        if (ev === 'data') {
            process.nextTick(() => { try { fn(buf); } catch (_) {} });
            return req;
        }
        if (ev === 'end') {
            process.nextTick(() => { try { fn(); } catch (_) {} });
            return req;
        }
        return origOn(ev, fn);
    };
}

function init(config) {
    _config = Object.assign({}, config || {});
    // Pre-load now so mount-time failures surface in server logs, not per-request.
    loadEngine();
    return { ok: true };
}

function getInfo() {
    return {
        id: 'death-verify',
        name: 'Death Record Verify',
        name_bn: 'মৃত্যু নিবন্ধন যাচাই',
        version: '1.0.0',
        capabilities: ['captcha', 'verify', 'certificate-pdf', 'certificate-html'],
        mode: 'as-is-studio-wrap',
        input: { drn: '17-digit DRN', dod: 'DD/MM/YYYY' }
    };
}

// Express middleware (req, res, next) wrapping the engine's own handler.
// Express strips the mount prefix, so the engine sees /api/captcha etc.
function getApp() {
    loadEngine();
    return function deathVerifyMiddleware(req, res, next) {
        try {
            replayBody(req);
            _handler(req, res);
        } catch (e) {
            next(e);
        }
    };
}

// engines/README.md pipeline contract.
// Captcha is interactive → the frontend uses the mounted API endpoints.
// run() reports what the caller must do.
async function run(payload) {
    const p = payload || {};
    if (p.drn) console.log(`[death-verify] verify requested for DRN ${maskDrn(p.drn)}`);
    return {
        ok: false,
        error: 'Interactive captcha flow: use the engine API — GET /api/captcha → POST /api/verify {sessionId, drn, dod DD/MM/YYYY, captcha} → POST /api/preview|/api/pdf.',
        code: 'NEEDS_CAPTCHA',
        needsCaptcha: true,
        apiBase: '/api/death-engine'
    };
}

module.exports = { init, getInfo, getApp, run, maskDrn };
