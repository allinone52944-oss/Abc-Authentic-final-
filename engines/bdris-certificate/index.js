'use strict';
/**
 * engines/bdris-certificate/index.js — Abc Authentic adapter for the
 * BDRIS Certificate Studio v3 engine.
 *
 * WRAPPING ONLY — the engine folder is a byte-identical copy of the
 * BuilderEngine-fixed.zip contents (see BUILDER.txt / BUILDER_NOTE.txt).
 * No engine logic is modified here. Deterministic: same input → same output.
 *
 * Integration:
 *  - getApp()    → the engine's own Express app (server.js). The backend
 *                   mounts it (with auth + rate limit) so the engine's
 *                   existing API endpoints are used as-is:
 *                   GET  /api/captcha  → { sessionId, image }
 *                   POST /api/solve-captcha → { answer } (local→Gemini→manual)
 *                   POST /api/verify   → { success, data }
 *                   POST /api/preview  → { html }
 *                   POST /generate-pdf → PDF download (~475KB vector)
 *  - generate()  → require('./certificate-builder').buildCertificate(record)
 *                   → { html, png, pdf }  (per BUILDER instructions)
 *  - run()       → engines/README.md pipeline contract
 *
 * Deps are installed with `npm ci` inside this folder (see package-lock.json).
 * Security: BRN/DOB are never logged in plain text (masked).
 */
const path = require('path');

let _config = {};

function init(config) {
    _config = Object.assign({}, config || {});
    return { ok: true };
}

function getInfo() {
    return {
        id: 'bdris-certificate',
        name: 'BDRIS Birth Certificate',
        name_bn: 'জন্ম নিবন্ধন সনদ',
        version: '3.0.0',
        capabilities: ['captcha', 'verify', 'certificate-pdf', 'certificate-html', 'certificate-png'],
        mode: 'as-is-studio-wrap'
    };
}

// Mask BRN in logs: show only last 4 digits
function maskBrn(brn) {
    const s = String(brn || '');
    return s.length > 4 ? '*'.repeat(s.length - 4) + s.slice(-4) : '****';
}

// The engine's own Express app (server.js) — mounted by the backend as-is.
// require() is lazy so a missing `npm ci` never breaks backend startup
// (engines-loader already try/catches, this is belt-and-braces).
function getApp() {
    const server = require(path.join(__dirname, 'server.js'));
    return server.app;
}

// Per BUILDER instructions:
//   const out = await require('./certificate-builder').buildCertificate(record)
//   → { html, png, pdf }   (pdf ≈ 475KB vector; png 794x1123)
async function generate(payload) {
    const record = (payload && payload.record) || {};
    const brn = String(record.brn || '').trim();
    if (brn) console.log(`[bdris-certificate] buildCertificate for BRN ${maskBrn(brn)}`);
    const builder = require(path.join(__dirname, 'certificate-builder.js'));
    const out = await builder.buildCertificate(record);
    return {
        ok: true,
        html: out.html,
        png: out.png,     // Buffer or null
        pdf: out.pdf,     // Buffer (~475KB vector)
        engine: out.engine,
        fileName: `Certificate_${brn || 'output'}.pdf`
    };
}

// engines/README.md pipeline contract.
// Captcha is interactive → the frontend uses the mounted API endpoints
// (getCaptcha/verify flow). run() handles the record-direct path and
// reports what the caller must do otherwise.
async function run(payload) {
    const p = payload || {};
    if (p.record && (p.record.brn || p.record.nameEn)) {
        const g = await generate({ record: p.record });
        return { ok: true, result: { html: g.html, png: g.png, pdf: g.pdf, engine: g.engine, fileName: g.fileName }, stage: 'generate' };
    }
    return {
        ok: false,
        error: 'Interactive captcha flow: use the engine API — GET /api/captcha → POST /api/verify {sessionId, brn, dob, captcha} → POST /generate-pdf.',
        code: 'NEEDS_CAPTCHA',
        needsCaptcha: true,
        apiBase: '/api/bdris-engine'
    };
}

module.exports = { init, getInfo, getApp, generate, run, maskBrn };
