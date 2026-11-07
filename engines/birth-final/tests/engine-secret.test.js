/**
 * Audit item 1 (2026-11-07): birth engine rejects direct localhost calls.
 *
 * The standalone engine used to serve /api/* with open CORS and no auth,
 * so anything on the server that could reach 127.0.0.1:3000 bypassed the
 * backend mount (requireAuth + limiter + charge gate). Now every engine
 * API call must carry the shared secret header (x-engine-secret), set by
 * the backend proxy (engines/birth-final/index.js getApp()) from the
 * backend env secret (ABC_JWT_SECRET || JWT_SECRET). Direct calls without
 * the valid secret get 401 ENGINE_AUTH_REQUIRED — before any handler runs
 * (so no BDRIS call is made). The render-token check on /api/preview and
 * /generate-pdf is untouched (defense in depth).
 *
 * Mock-only: no BDRIS, no backend, no charge. The /api/store/health
 * endpoint is local (file store) and needs no network.
 *
 * Run: node --test engines/birth-final/tests/engine-secret.test.js
 */
'use strict';

process.env.ABC_JWT_SECRET = 'test-engine-secret';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { app } = require('../server');
const { mintRenderToken, RENDER_TOKEN_HEADER } = require('../../shared/render-token');

const ENGINE_SECRET_HEADER = 'x-engine-secret';
const ENGINE_SECRET = 'test-engine-secret';

let base;
let server;
let proxyBase;
let proxyServer;

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  const enginePort = server.address().port;
  base = 'http://127.0.0.1:' + enginePort;
  // The proxy reads the engine port at require time.
  process.env.BIRTH_ENGINE_PORT = String(enginePort);
  const birthProxy = require('../index');
  const proxyApp = birthProxy.getApp();
  // Plain http requests have .url, not Express's .originalUrl (which the
  // proxy reads) — set it, exactly as Express would.
  await new Promise((resolve) => {
    proxyServer = http.createServer((req, res) => {
      req.originalUrl = req.url;
      proxyApp(req, res);
    }).listen(0, '127.0.0.1', resolve);
  });
  proxyBase = 'http://127.0.0.1:' + proxyServer.address().port;
});

after(async () => {
  await new Promise((resolve) => proxyServer.close(resolve));
  await new Promise((resolve) => server.close(resolve));
});

describe('birth engine shared-secret gate (audit item 1)', () => {
  it('GET /api/store/health without the secret -> 401 ENGINE_AUTH_REQUIRED', async () => {
    const r = await fetch(base + '/api/store/health');
    assert.strictEqual(r.status, 401);
    const b = await r.json();
    assert.strictEqual(b.error, 'ENGINE_AUTH_REQUIRED');
  });

  it('GET /api/store/health with a wrong secret -> 401', async () => {
    const r = await fetch(base + '/api/store/health', {
      headers: { [ENGINE_SECRET_HEADER]: 'not-the-secret' },
    });
    assert.strictEqual(r.status, 401);
  });

  it('GET /api/store/health with the valid secret -> 200', async () => {
    const r = await fetch(base + '/api/store/health', {
      headers: { [ENGINE_SECRET_HEADER]: ENGINE_SECRET },
    });
    assert.strictEqual(r.status, 200);
    const b = await r.json();
    assert.strictEqual(b.success, true);
  });

  it('GET /api/captcha without the secret -> 401 (no BDRIS call is made)', async () => {
    const r = await fetch(base + '/api/captcha');
    assert.strictEqual(r.status, 401);
    const b = await r.json();
    assert.strictEqual(b.error, 'ENGINE_AUTH_REQUIRED');
  });

  it('preview with a valid render token but no engine secret -> 401 (secret gate runs first)', async () => {
    const tok = mintRenderToken('birth', 'u1', 'att-1');
    const r = await fetch(base + '/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [RENDER_TOKEN_HEADER]: tok },
      body: JSON.stringify({}),
    });
    assert.strictEqual(r.status, 401);
    const b = await r.json();
    assert.strictEqual(b.error, 'ENGINE_AUTH_REQUIRED');
  });

  it('proxied call (no secret from the client) reaches the engine -> 200', async () => {
    const r = await fetch(proxyBase + '/api/bdris-engine/api/store/health');
    assert.strictEqual(r.status, 200);
    const b = await r.json();
    assert.strictEqual(b.success, true);
  });

  it('proxied call with a client-injected wrong secret is overwritten -> 200', async () => {
    const r = await fetch(proxyBase + '/api/bdris-engine/api/store/health', {
      headers: { [ENGINE_SECRET_HEADER]: 'forged-by-client' },
    });
    assert.strictEqual(r.status, 200);
    const b = await r.json();
    assert.strictEqual(b.success, true);
  });

  // GET / (Studio UI page) is NOT secret-gated — it serves no data, so the
  // gate must not reject it. (Note: it currently 404s on pristine main too
  // — a pre-existing sendFile issue, verified by stashing this change;
  // out of scope for audit items 1 and 2. The point here is only that the
  // secret gate does not block it.)
  it('GET / is not rejected by the secret gate (no 401)', async () => {
    const r = await fetch(base + '/');
    assert.notStrictEqual(r.status, 401);
  });
});
