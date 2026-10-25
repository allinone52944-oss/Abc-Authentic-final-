/**
 * RequestNameLog tests — names-only logging (alternative path 2).
 * Run: node --test v2/tests/request-name-log.test.js
 * (from engines/bdris-apply/)
 *
 * ALL request data below is FAKE mock data. No real applicant, OTP,
 * token, cookie, phone, name, or application value appears here.
 * Assertions prove the opposite: fake values fed in must NOT appear
 * in any log entry.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  isRequestNameLogEnabled,
  matchesSubmitRequest,
  safePath,
  buildLogEntry,
  createRequestNameLogger,
} = require('../services/RequestNameLog');

// Fake Playwright-style request (method API).
function fakeRequest({ url, method = 'POST', headers = {}, body = null, buffer = undefined }) {
  return {
    url: () => url,
    method: () => method,
    headers: () => headers,
    postData: () => body,
    postDataBuffer: buffer === undefined ? undefined : () => Buffer.from(buffer, 'utf8'),
  };
}

const REGISTER_URL = 'https://bdris.gov.bd/api/br/application/register';
const VERIFY_URL = 'https://bdris.gov.bd/api/otp/verify';

describe('enable flag (safe-by-default, same pattern as BDRIS_HTTP_PATH)', () => {
  it('is OFF when unset, empty, or unrecognised', () => {
    assert.strictEqual(isRequestNameLogEnabled({}), false);
    assert.strictEqual(isRequestNameLogEnabled({ BDRIS_REQUEST_NAME_LOG: '' }), false);
    assert.strictEqual(isRequestNameLogEnabled({ BDRIS_REQUEST_NAME_LOG: 'off' }), false);
    assert.strictEqual(isRequestNameLogEnabled({ BDRIS_REQUEST_NAME_LOG: '0' }), false);
    assert.strictEqual(isRequestNameLogEnabled({ BDRIS_REQUEST_NAME_LOG: 'maybe' }), false);
  });

  it('is ON only for an explicit opt-in value', () => {
    for (const v of ['on', '1', 'true', 'yes', 'enabled', 'ON', ' True ']) {
      assert.strictEqual(isRequestNameLogEnabled({ BDRIS_REQUEST_NAME_LOG: v }), true, v);
    }
  });
});

describe('request matching', () => {
  it('matches the canonical submit/verify/receive endpoints', () => {
    assert.strictEqual(matchesSubmitRequest(REGISTER_URL), true);
    assert.strictEqual(matchesSubmitRequest(VERIFY_URL), true);
    assert.strictEqual(matchesSubmitRequest('https://bdris.gov.bd/api/application/receive'), true);
  });

  it('matches other bdris.gov.bd paths containing register/verify/receive', () => {
    assert.strictEqual(matchesSubmitRequest('https://bdris.gov.bd/api/something/register-step'), true);
    assert.strictEqual(matchesSubmitRequest('https://bdris.gov.bd/api/otp/verify-code'), true);
  });

  it('ignores unrelated bdris paths and other hosts', () => {
    assert.strictEqual(matchesSubmitRequest('https://bdris.gov.bd/api/geo/list'), false);
    assert.strictEqual(matchesSubmitRequest('https://example.com/api/br/application/register'), false);
    assert.strictEqual(matchesSubmitRequest('not a url'), false);
  });

  it('masks digit runs in non-canonical paths, keeps canonical paths verbatim', () => {
    assert.strictEqual(safePath(REGISTER_URL), '/api/br/application/register');
    assert.strictEqual(
      safePath('https://bdris.gov.bd/api/thing/register/12345/step'),
      '/api/thing/register/:id/step'
    );
  });
});

describe('keys-only extraction (values must never appear)', () => {
  it('JSON: nested keys preserved, all values absent', () => {
    const body = JSON.stringify({
      sampleOuter: { sampleInner: 'FAKE_SECRET_VALUE_1', sampleList: [{ sampleItem: 'FAKE_SECRET_VALUE_2' }] },
      sampleOtp: '999999',
      samplePhone: '01000000000',
    });
    const entry = buildLogEntry(fakeRequest({
      url: REGISTER_URL,
      headers: { 'content-type': 'application/json' },
      body,
    }));
    assert.ok(entry);
    assert.deepStrictEqual(entry.bodyFields, {
      sampleOuter: { sampleInner: null, sampleList: [{ sampleItem: null }] },
      sampleOtp: null,
      samplePhone: null,
    });
    const text = JSON.stringify(entry);
    assert.ok(!text.includes('FAKE_SECRET_VALUE_1'));
    assert.ok(!text.includes('FAKE_SECRET_VALUE_2'));
    assert.ok(!text.includes('999999'));
    assert.ok(!text.includes('01000000000'));
  });

  it('form-urlencoded: param names only, values absent', () => {
    const entry = buildLogEntry(fakeRequest({
      url: VERIFY_URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'sampleOtp=999999&samplePhone=01000000000&sampleName=FakePerson',
    }));
    assert.deepStrictEqual(entry.bodyFields, ['sampleOtp', 'samplePhone', 'sampleName']);
    assert.ok(!JSON.stringify(entry).includes('999999'));
    assert.ok(!JSON.stringify(entry).includes('FakePerson'));
  });

  it('multipart: field names only, file contents absent', () => {
    const body = [
      '------FakeBoundary',
      'Content-Disposition: form-data; name="sampleField"',
      '',
      'FAKE_FILE_CONTENT_BYTES',
      '------FakeBoundary',
      'Content-Disposition: form-data; name="sampleFile"; filename="fake.bin"',
      'Content-Type: application/octet-stream',
      '',
      'FAKE_BINARY_PAYLOAD',
      '------FakeBoundary--',
    ].join('\r\n');
    const entry = buildLogEntry(fakeRequest({
      url: REGISTER_URL,
      headers: { 'content-type': 'multipart/form-data; boundary=----FakeBoundary' },
      body,
    }));
    assert.deepStrictEqual(entry.bodyFields, ['sampleField', 'sampleFile']);
    assert.strictEqual(entry.contentType, 'multipart/form-data'); // boundary stripped
    assert.ok(!JSON.stringify(entry).includes('FAKE_FILE_CONTENT_BYTES'));
    assert.ok(!JSON.stringify(entry).includes('FAKE_BINARY_PAYLOAD'));
    assert.ok(!JSON.stringify(entry).includes('FakeBoundary'));
  });

  it('query string: parameter names only, values absent; body kind empty when no body', () => {
    const entry = buildLogEntry(fakeRequest({
      url: REGISTER_URL + '?sampleParam=FAKE_VALUE&sampleOther=12345',
      method: 'GET',
      headers: {},
      body: null,
    }));
    assert.deepStrictEqual(entry.queryParams, ['sampleParam', 'sampleOther']);
    assert.strictEqual(entry.bodyKind, 'empty');
    assert.ok(!JSON.stringify(entry).includes('FAKE_VALUE'));
  });

  it('secret headers are never recorded, even when present', () => {
    const entry = buildLogEntry(fakeRequest({
      url: VERIFY_URL,
      headers: {
        'content-type': 'application/json',
        cookie: 'FAKE_COOKIE_VALUE',
        authorization: 'Bearer FAKE_TOKEN_VALUE',
        'x-csrf-token': 'FAKE_CSRF_VALUE',
      },
      body: JSON.stringify({ sampleOtp: '999999' }),
    }));
    const text = JSON.stringify(entry);
    assert.ok(!text.includes('FAKE_COOKIE_VALUE'));
    assert.ok(!text.includes('FAKE_TOKEN_VALUE'));
    assert.ok(!text.includes('FAKE_CSRF_VALUE'));
    assert.ok(!text.includes('cookie'));
    assert.ok(!text.includes('authorization'));
    assert.ok(!text.includes('x-csrf-token'));
    assert.strictEqual(entry.contentType, 'application/json');
  });

  it('non-matching requests produce no entry', () => {
    assert.strictEqual(buildLogEntry(fakeRequest({
      url: 'https://bdris.gov.bd/api/geo/list',
      body: JSON.stringify({ sample: 'value' }),
    })), null);
  });

  it('a throwing request object never throws into the caller', () => {
    const bad = {
      url: () => { throw new Error('boom'); },
      method: () => { throw new Error('boom'); },
    };
    assert.strictEqual(buildLogEntry(bad), null);
    assert.strictEqual(buildLogEntry(null), null);
  });
});

describe('logger wiring (fail-open, idempotent)', () => {
  it('disabled logger records nothing and attaches nothing', () => {
    const lines = [];
    const logger = createRequestNameLogger({ enabled: false, write: (l) => lines.push(l) });
    assert.strictEqual(logger.enabled, false);
    assert.strictEqual(logger.handleRequest(fakeRequest({
      url: REGISTER_URL, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sample: 'value' }),
    })), null);
    assert.deepStrictEqual(lines, []);
    const page = { on: () => { throw new Error('must not be called'); } };
    assert.strictEqual(logger.attach(page), false);
  });

  it('enabled logger writes one JSON line per matching request only', () => {
    const lines = [];
    const logger = createRequestNameLogger({ enabled: true, write: (l) => lines.push(l) });
    logger.handleRequest(fakeRequest({
      url: REGISTER_URL, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sampleField: 'FAKE_VALUE' }),
    }));
    logger.handleRequest(fakeRequest({
      url: 'https://bdris.gov.bd/api/geo/list',
      body: JSON.stringify({ sampleField: 'FAKE_VALUE' }),
    }));
    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.path, '/api/br/application/register');
    assert.strictEqual(parsed.method, 'POST');
    assert.ok(!lines[0].includes('FAKE_VALUE'));
  });

  it('a failing write does not throw and is reported via onError', () => {
    const errors = [];
    const logger = createRequestNameLogger({
      enabled: true,
      write: () => { throw new Error('disk full (fake)'); },
      onError: (e) => errors.push(e.message),
    });
    let entry;
    assert.doesNotThrow(() => {
      entry = logger.handleRequest(fakeRequest({
        url: VERIFY_URL, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sampleField: 'value' }),
      }));
    });
    assert.ok(entry);
    assert.deepStrictEqual(errors, ['disk full (fake)']);
  });

  it('attach is idempotent and only forwards matching requests', () => {
    const lines = [];
    const logger = createRequestNameLogger({ enabled: true, write: (l) => lines.push(l) });
    let handler = null;
    let onCalls = 0;
    const page = { on: (event, fn) => { onCalls += 1; handler = fn; } };
    assert.strictEqual(logger.attach(page), true);
    assert.strictEqual(logger.attach(page), false); // second attach is a no-op
    assert.strictEqual(onCalls, 1);
    handler(fakeRequest({ url: VERIFY_URL, headers: {}, body: null }));
    handler(fakeRequest({ url: 'https://bdris.gov.bd/api/geo/list', headers: {}, body: null }));
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(logger.attach({}), false); // page without .on
    assert.strictEqual(logger.attach(null), false);
  });
});
