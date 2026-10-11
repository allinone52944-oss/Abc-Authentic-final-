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
 *  - Chrome is needed only for /api/pdf (spawned on demand). The adapter
 *    auto-resolves it: system Chrome -> puppeteer's bundled Chrome ->
 *    one-time background download. A 'chrome' shim is placed on PATH so the
 *    engine's spawn('chrome', ...) works with zero manual install.
 *    First /api/pdf waits briefly for the download; without Chrome the
 *    endpoint fails gracefully (500 JSON), other endpoints unaffected.
 *  - Fonts are embedded (base64) — no font install needed.
 *
 * Security: DRN is never logged in plain text (masked, last 4 digits).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');

let _config = {};
let _handler = null;
let _loaded = false;

// ---- Chrome auto-resolution (zero manual install) ----
// The engine spawns the literal command 'chrome' for /api/pdf (vector PDF).
// On the VM there may be no system Chrome and the user cannot SSH easily,
// so the adapter guarantees 'chrome' resolves:
//   1. system Chrome/Chromium if present,
//   2. puppeteer's bundled Chrome (backend's puppeteer postinstall already
//      downloads it to ~/.cache/puppeteer — same one the BDRIS engine uses),
//   3. background one-time download via @puppeteer/browsers (~150MB).
// A tiny shim script <engine>/bin/chrome -> real binary is placed on PATH,
// so the engine's spawn('chrome', [...]) works untouched.
// If Chrome can never be provided, /api/pdf fails gracefully (engine returns
// 500 JSON) while captcha/verify/preview keep working.
let _chromePath = null;
let _chromeReadyResolve = null;
const _chromeReady = new Promise((r) => { _chromeReadyResolve = r; });
let _chromeLogged = false;

function backendDir() {
    return path.join(__dirname, '..', '..', 'backend');
}

function systemChrome() {
    const cands = [
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/snap/bin/chromium', '/opt/google/chrome/chrome'
    ];
    for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
        try {
            const r = spawnSync('which', [bin], { encoding: 'utf8' });
            const p = (r.stdout || '').trim().split('\n')[0];
            if (r.status === 0 && p && fs.existsSync(p)) return p;
        } catch (_) {}
    }
    return null;
}

async function puppeteerChrome() {
    try {
        const puppeteerPath = require.resolve('puppeteer', { paths: [backendDir()] });
        const puppeteer = require(puppeteerPath);
        const exe = await puppeteer.executablePath();
        if (exe && fs.existsSync(exe)) return exe;
    } catch (e) {
        console.warn('[death-verify] puppeteer chrome lookup failed:', e.message);
    }
    return null;
}

async function installPuppeteerChrome() {
    try {
        const browsersPath = require.resolve('@puppeteer/browsers', { paths: [backendDir()] });
        const { install, Browser } = require(browsersPath);
        console.log('[death-verify] Chrome not found — downloading bundled Chrome (~150MB, one-time, no sudo)...');
        const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');
        const result = await install({ browser: Browser.CHROME, cacheDir });
        const exe = result && result.executablePath;
        if (exe && fs.existsSync(exe)) {
            console.log('[death-verify] Chrome auto-installed:', exe);
            return exe;
        }
    } catch (e) {
        console.warn('[death-verify] Chrome auto-download failed:', e.message);
    }
    return null;
}

function installChromeShim(realPath) {
    try {
        const binDir = path.join(__dirname, 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        const shim = path.join(binDir, 'chrome');
        fs.writeFileSync(shim, '#!/bin/sh\nexec "' + String(realPath).replace(/"/g, '') + '" "$@"\n', { mode: 0o755 });
        fs.chmodSync(shim, 0o755);
        const sep = path.delimiter;
        const parts = String(process.env.PATH || '').split(sep);
        if (!parts.includes(binDir)) process.env.PATH = binDir + sep + (process.env.PATH || '');
        return true;
    } catch (e) {
        console.warn('[death-verify] could not install chrome shim:', e.message);
        return false;
    }
}

async function ensureChrome() {
    try {
        let found = systemChrome() || await puppeteerChrome();
        if (!found) found = await installPuppeteerChrome();
        if (found && fs.existsSync(found)) {
            _chromePath = found;
            installChromeShim(found);
            if (!_chromeLogged) {
                _chromeLogged = true;
                console.log('[death-verify] Chrome ready for PDF:', found);
            }
        } else if (!_chromeLogged) {
            _chromeLogged = true;
            console.warn('[death-verify] Chrome not available — /api/pdf will fail gracefully; captcha/verify/preview still work.');
        }
    } catch (e) {
        console.warn('[death-verify] Chrome resolution error:', e.message);
    } finally {
        _chromeReadyResolve(_chromePath);
    }
}

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
    // Resolve Chrome in the background (non-blocking): system -> puppeteer
    // bundled -> one-time download. First /api/pdf waits for it (see getApp).
    ensureChrome();
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
    return async function deathVerifyMiddleware(req, res, next) {
        try {
            const url = req.url || '';
            if (url === '/api/pdf' || url.startsWith('/api/pdf?')) {
                // First PDF request waits for the background Chrome resolution
                // (max ~3 min for a one-time download); afterwards the engine
                // fails gracefully on its own if Chrome never arrives.
                await Promise.race([
                    _chromeReady,
                    new Promise((r) => setTimeout(() => r(null), 180000))
                ]);
            }
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
