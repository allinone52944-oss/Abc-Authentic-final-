/**
 * Script probe (2026-10-27): the guessed GET+?geoId= office calls
 * returned the site's HTML shell, not data — so the real office
 * call convention must be read from the form page's own script.
 * The probe fetches the form page with the SEEDED session, greps
 * it for the office URL strings, then greps same-origin script
 * bundles the same way. Read-only: no upload, OTP or submit.
 * These tests cover the pure grep helpers, the client page fetch,
 * and the probe's script step (incl. the opt-in: no flag means
 * no script key). No network, no live host.
 * Run: node --test engines/bdris-apply/v2/tests/http-script-probe.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BdrisHttpClient } = require('../http/client');
const { runStageAProbe, extractOfficeMatches, extractScriptSrcs } = require('../services/HttpPathRunner');

function cannedFetch({ status, contentType, body }) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null),
      getSetCookie: undefined,
    },
    text: async () => body,
  });
}

describe('script probe grep helpers', () => {
  it('extractOfficeMatches finds both URL patterns with surrounding context', () => {
    const text = 'xx fetch("/api/office/find-by-geo-id", {method:"POST"}) yy $.get("/api/office/find-office-geo-projection-by-geo-id?id=1") zz';
    const m = extractOfficeMatches(text);
    assert.strictEqual(m.length, 2);
    assert.strictEqual(m[0].match, 'find-by-geo-id');
    assert.ok(m[0].context.includes('fetch('));
    assert.strictEqual(m[1].match, 'find-office-geo-projection-by-geo-id');
    assert.ok(m[1].context.includes('$.get('));
  });

  it('extractOfficeMatches caps at 5 and returns [] for no match', () => {
    const text = Array(7).fill('find-by-geo-id').join(' ');
    assert.strictEqual(extractOfficeMatches(text).length, 5);
    assert.deepStrictEqual(extractOfficeMatches('nothing here'), []);
  });

  it('extractScriptSrcs keeps same-origin, skips third-party/data, dedups', () => {
    const html = '<script src="/assets/js/a.js"></script><script src="https://bdris.gov.bd/assets/js/b.js"></script>'
      + '<script src="https://cdn.example.com/x.js"></script><script src="data:text/javascript,1"></script>'
      + '<script src="/assets/js/a.js"></script>';
    assert.deepStrictEqual(
      extractScriptSrcs(html, 'https://bdris.gov.bd'),
      ['/assets/js/a.js', '/assets/js/b.js'],
    );
  });
});

describe('client page fetch (seeded only)', () => {
  it('fetchFormPageText returns url/status/content-type/length/text', async () => {
    const body = '<html>form</html>';
    const client = new BdrisHttpClient({ base: 'https://example.invalid', fetchImpl: cannedFetch({ status: 200, contentType: 'text/html', body }) });
    client.bootstrapped = true;
    client.csrfToken = 't';
    const page = await client.fetchFormPageText();
    assert.strictEqual(page.url, '/br/application');
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.bodyLength, body.length);
    assert.strictEqual(page.text, body);
  });
});

describe('runStageAProbe script step', () => {
  it('inline page match + bundle match are both recorded', async () => {
    const client = {
      bootstrapped: true,
      base: 'https://example.invalid',
      fetchFormPageText: async () => ({
        url: '/br/application', status: 200, ok: true, contentType: 'text/html', bodyLength: 100,
        text: 'inline fetch("/api/office/find-by-geo-id") here <script src="/assets/js/app.js"></script>',
      }),
      fetchPageText: async (src) => ({
        url: src, status: 200, ok: true, contentType: 'application/javascript', bodyLength: 50,
        text: 'axios.post("/api/office/find-office-geo-projection-by-geo-id", {geoId})',
      }),
    };
    const r = await runStageAProbe({ client, scriptProbe: true });
    assert.strictEqual(r.ok, true);
    assert.ok(r.steps.includes('script'));
    assert.strictEqual(r.results.script.pageMatches.length, 1);
    assert.strictEqual(r.results.script.scripts.length, 1);
    assert.strictEqual(r.results.script.scripts[0].matches.length, 1);
    assert.strictEqual(r.results.script.scripts[0].matches[0].match, 'find-office-geo-projection-by-geo-id');
  });

  it('page without office strings: empty matches, still ok', async () => {
    const client = {
      bootstrapped: true,
      base: 'https://example.invalid',
      fetchFormPageText: async () => ({ url: '/br/application', status: 200, ok: true, contentType: 'text/html', bodyLength: 20, text: '<html>no office here</html>' }),
      fetchPageText: async () => { throw new Error('must not be called without script srcs'); },
    };
    const r = await runStageAProbe({ client, scriptProbe: true });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.results.script.pageMatches, []);
    assert.deepStrictEqual(r.results.script.scripts, []);
  });

  it('form fetch failure is recorded, not thrown', async () => {
    const client = {
      bootstrapped: true,
      fetchFormPageText: async () => { const e = new Error('net down'); e.code = 'FETCH_FAILED'; throw e; },
    };
    const r = await runStageAProbe({ client, scriptProbe: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.results.script.ok, false);
    assert.strictEqual(r.results.script.error, 'FETCH_FAILED');
  });

  it('no scriptProbe flag: no script key at all (opt-in)', async () => {
    const client = { bootstrapped: true };
    const r = await runStageAProbe({ client });
    assert.strictEqual(r.results.script, undefined);
    assert.ok(!r.steps.includes('script'));
  });
});
