/**
 * Audit item 2 (2026-11-07): verify no longer writes last-result.html.
 *
 * Every verify used to write the full BDRIS result page to
 * last-result.html on disk; it was deleted on success but left on failure
 * (personal data on disk), and the single shared filename raced between
 * concurrent verifies. The result page now lives only in the request's
 * memory and is dropped when the handler returns; a parse failure still
 * returns the same debug excerpt (cell texts only) in the response.
 *
 * Mock-only: the BDRIS fetch is mocked (fake form page, fake GIF captcha,
 * fake result page), so no live BDRIS call and no charge — the charge
 * gate lives in the backend, not the engine, and these tests call the
 * engine directly. The local engine is reached via the real fetch
 * (127.0.0.1 passthrough). All values below are synthetic test fixtures,
 * not real personal data.
 *
 * Run: node --test engines/birth-final/tests/verify-diagnostic.test.js
 */
'use strict';

process.env.ABC_JWT_SECRET = 'test-diagnostic-secret';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ENGINE_SECRET_HEADER = 'x-engine-secret';
const ENGINE_SECRET = 'test-diagnostic-secret';
const LAST_RESULT = path.join(__dirname, '..', 'last-result.html');

// --- Mock BDRIS (everify.bdris.gov.bd) ------------------------------------
const realFetch = global.fetch;
// Minimal 1x1 transparent GIF (bytes start with 'GIF89a').
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
const FORM_PAGE = '<html><body><form>' +
  '<input name="__RequestVerificationToken" type="hidden" value="tok-test" />' +
  '<input name="CaptchaDeText" type="hidden" value="det-test" />' +
  '<img src="/DefaultCaptcha/Generate?t=abc123" />' +
  '</form></body></html>';
// Synthetic fixtures only — not real data.
const RESULT_SUCCESS = '<html><body><table>' +
  '<tr><td>Birth Registration Number</td><td>11111111111111111</td></tr>' +
  '<tr><td>Registered Person Name</td><td>TEST PERSON</td></tr>' +
  '</table></body></html>';
const RESULT_PARSE_FAIL = '<html><body><p>Some page with no recognizable record table.</p></body></html>';

let mockResultHtml = RESULT_SUCCESS;

function mockResp({ text, buf, contentType, status = 200 }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? (contentType || 'text/html') : null),
      getSetCookie: () => [],
    },
    text: async () => (text !== undefined ? text : ''),
    arrayBuffer: async () => (buf || Buffer.alloc(0)),
  };
}

global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(u, opts); // this test's own calls to the local engine
  if (u === 'https://everify.bdris.gov.bd/') return mockResp({ text: FORM_PAGE });
  if (u.startsWith('https://everify.bdris.gov.bd/DefaultCaptcha/Generate')) return mockResp({ buf: GIF_1X1, contentType: 'image/gif' });
  if (u === 'https://everify.bdris.gov.bd/UBRNVerification/Search' && opts && opts.method === 'POST') return mockResp({ text: mockResultHtml });
  throw new Error('Unexpected fetch in test: ' + u);
};

const { app } = require('../server');

let base;
let server;

before(async () => {
  // Clean baseline: no leftover diagnostic file from an earlier run.
  try { fs.unlinkSync(LAST_RESULT); } catch (_) {}
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  global.fetch = realFetch;
});

async function newSession() {
  const r = await fetch(base + '/api/captcha', { headers: { [ENGINE_SECRET_HEADER]: ENGINE_SECRET } });
  assert.strictEqual(r.status, 200);
  const b = await r.json();
  assert.strictEqual(b.success, true);
  assert.ok(b.sessionId);
  return b.sessionId;
}

async function doVerify(sessionId) {
  return fetch(base + '/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [ENGINE_SECRET_HEADER]: ENGINE_SECRET },
    body: JSON.stringify({ sessionId, brn: '11111111111111111', dob: '2000-01-01', captcha: '1234' }),
  });
}

describe('birth verify diagnostic (audit item 2)', () => {
  it('successful verify leaves no last-result.html on disk', async () => {
    mockResultHtml = RESULT_SUCCESS;
    assert.strictEqual(fs.existsSync(LAST_RESULT), false);
    const sessionId = await newSession();
    const r = await doVerify(sessionId);
    assert.strictEqual(r.status, 200);
    const b = await r.json();
    assert.strictEqual(b.success, true);
    assert.ok(b.data && b.data.nameEn);
    assert.strictEqual(fs.existsSync(LAST_RESULT), false);
  });

  it('failed verify (parse failure) leaves no last-result.html on disk', async () => {
    mockResultHtml = RESULT_PARSE_FAIL;
    assert.strictEqual(fs.existsSync(LAST_RESULT), false);
    const sessionId = await newSession();
    const r = await doVerify(sessionId);
    assert.strictEqual(r.status, 200);
    const b = await r.json();
    assert.strictEqual(b.success, false);
    assert.ok(b.error && b.error.includes('no file saved'));
    assert.ok(Array.isArray(b.debug));
    assert.strictEqual(fs.existsSync(LAST_RESULT), false);
  });

  it('concurrent verifies do not clobber each other and leave no file', async () => {
    mockResultHtml = RESULT_SUCCESS;
    assert.strictEqual(fs.existsSync(LAST_RESULT), false);
    const sessions = [];
    for (let i = 0; i < 4; i++) sessions.push(await newSession());
    const results = await Promise.all(sessions.map((id) => doVerify(id)));
    for (const r of results) {
      assert.strictEqual(r.status, 200);
      const b = await r.json();
      assert.strictEqual(b.success, true);
      assert.ok(b.data && b.data.nameEn);
    }
    assert.strictEqual(fs.existsSync(LAST_RESULT), false);
  });
});
