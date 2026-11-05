/**
 * Audit #5: birth engine refuses renders without a gate-minted token.
 *
 * Direct localhost hits on :3000 used to render a certificate from
 * any body, free. Now /api/preview and /generate-pdf require the
 * short-lived render token the backend charge gate mints for an
 * allowed render; without it (or with a forged/wrong-engine token)
 * the engine answers 402 CHARGE_REQUIRED and renders nothing.
 *
 * Run: node --test engines/birth-final/tests/render-token.test.js
 * (needs engines/birth-final/node_modules; the PDF route is only
 * tested for rejection — a successful PDF needs a browser.)
 */
'use strict';

process.env.ABC_JWT_SECRET = 'test-render-secret';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { app } = require('../server');
const { mintRenderToken, RENDER_TOKEN_HEADER } = require('../../shared/render-token');

let base;
let server;

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const payload = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample-payload.json'), 'utf8'));

async function postPreview(headers) {
  return fetch(base + '/api/preview', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(payload),
  });
}

describe('birth render token gate (audit #5)', () => {
  it('preview without a token -> 402 CHARGE_REQUIRED, no html', async () => {
    const r = await postPreview();
    assert.strictEqual(r.status, 402);
    const b = await r.json();
    assert.strictEqual(b.error, 'CHARGE_REQUIRED');
    assert.ok(!b.html);
  });

  it('preview with a forged token -> 402', async () => {
    const r = await postPreview({ [RENDER_TOKEN_HEADER]: 'v1.birth.aaaa.bbbb.9999999999999.deadbeef' });
    assert.strictEqual(r.status, 402);
  });

  it('preview with a gate-minted token -> 200 with certificate html', async () => {
    const tok = mintRenderToken('birth', 'u1', 'att-1');
    const r = await postPreview({ [RENDER_TOKEN_HEADER]: tok });
    assert.strictEqual(r.status, 200);
    const b = await r.json();
    assert.strictEqual(b.success, true);
    assert.ok(typeof b.html === 'string' && b.html.length > 100);
  });

  it('a death token does not open the birth engine', async () => {
    const tok = mintRenderToken('death', 'u1', 'att-1');
    const r = await postPreview({ [RENDER_TOKEN_HEADER]: tok });
    assert.strictEqual(r.status, 402);
  });

  it('generate-pdf without a token -> 402 (no browser launched)', async () => {
    const r = await fetch(base + '/generate-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(r.status, 402);
    const b = await r.json();
    assert.strictEqual(b.error, 'CHARGE_REQUIRED');
  });
});
