'use strict';
/**
 * engines/nid-replica/index.js — loader entry for the NID Replica Engine.
 *
 * Re-exports the as-is wrapper (adapter.js). The NID flow is interactive
 * (upload PDF → review fields → build), so run() reports the API to use —
 * same pattern as the death-verify engine's NEEDS_CAPTCHA response.
 */
const adapter = require('./adapter.js');

async function run(payload) {
    return {
        ok: false,
        error: 'Interactive flow: use the engine API — POST /api/nid-engine/extract {multipart pdf} → { jobId, fields, images } → POST /api/nid-engine/build { jobId, fields } → application/pdf.',
        code: 'NEEDS_UPLOAD',
        apiBase: '/api/nid-engine'
    };
}

module.exports = Object.assign({ run }, adapter);
