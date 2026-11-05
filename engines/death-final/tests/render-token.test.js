/**
 * Audit #5: death engine refuses renders without a gate-minted token.
 *
 * Direct localhost hits on :3104 used to render a certificate from
 * any body, free. Now /api/preview and /api/pdf require the
 * short-lived render token the backend charge gate mints for an
 * allowed render; without it (or with a forged/wrong-engine token)
 * the engine answers 402 CHARGE_REQUIRED and renders nothing.
 *
 * Run: node --test engines/death-final/tests/render-token.test.js
 * (the PDF route is only tested for rejection — a successful PDF
 * needs system Chrome.)
 */
'use strict';

process.env.ABC_JWT_SECRET = 'test-render-secret';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { server } = require('../death-verify-server');
const { mintRenderToken, RENDER_TOKEN_HEADER } = require('../../shared/render-token');

let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const payload = {
  brn: '20008812737140064',
  nameEn: 'Test Person',
  nameBn: 'টেস্ট পারসন',
  fatherEn: 'Test Father',
  motherEn: 'Test Mother',
  dod: '01/01/2020',
  regDate: '02/01/2020',
};

async function post(path, headers) {
  return fetch(base + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(payload),
  });
}

describe('death render token gate (audit #5)', () => {
  it('preview without a token -> 402 CHARGE_REQUIRED, no html', async () => {
    const r = await post('/api/preview');
    assert.strictEqual(r.status, 402);
    const b = await r.json();
    assert.strictEqual(b.error, 'CHARGE_REQUIRED');
    assert.ok(!b.html);
  });

  it('preview with a forged token -> 402', async () => {
    const r = await post('/api/preview', { [RENDER_TOKEN_HEADER]: 'v1.death.aaaa.bbbb.9999999999999.deadbeef' });
    assert.strictEqual(r.status, 402);
  });

  it('preview with a gate-minted token -> 200 with certificate html', async () => {
    const tok = mintRenderToken('death', 'u1', 'att-1');
    const r = await post('/api/preview', { [RENDER_TOKEN_HEADER]: tok });
    assert.strictEqual(r.status, 200);
    const b = await r.json();
    assert.strictEqual(b.success, true);
    assert.ok(typeof b.html === 'string' && b.html.length > 100);
  });

  it('a birth token does not open the death engine', async () => {
    const tok = mintRenderToken('birth', 'u1', 'att-1');
    const r = await post('/api/preview', { [RENDER_TOKEN_HEADER]: tok });
    assert.strictEqual(r.status, 402);
  });

  it('pdf without a token -> 402 (no Chrome launched)', async () => {
    const r = await post('/api/pdf');
    assert.strictEqual(r.status, 402);
    const b = await r.json();
    assert.strictEqual(b.error, 'CHARGE_REQUIRED');
  });
});
