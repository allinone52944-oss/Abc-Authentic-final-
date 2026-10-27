/**
 * Call-site probe (2026-10-27): the live script-probe run proved the
 * form page defines the office URLs as JS constants
 * (findOfficeByParentGeoIdRestUrl /
 * findOfficeGeoProjectionByParentGeoIdRestUrl), but the URL-string
 * grep alone cannot show HOW they are called (method, params), and
 * the first 5 bundles were libraries with no matches. So the script
 * step now also greps page + bundles for the constant names
 * (call-site grep helpers) and fetches up to 15 bundles. These tests
 * cover the new helper and the extended step, including a 6th bundle
 * carrying the call — past the old 5-bundle cap. No network, no live
 * host.
 * Run: node --test engines/bdris-apply/v2/tests/http-script-callsite.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runStageAProbe, extractOfficeCallMatches } = require('../services/HttpPathRunner');

describe('call-site grep helpers', () => {
  it('extractOfficeCallMatches finds both constant names with surrounding context', () => {
    const text = 'xx $.ajax({url: findOfficeByParentGeoIdRestUrl, data: {parentGeoId: 7}}) yy fetch(findOfficeGeoProjectionByParentGeoIdRestUrl) zz';
    const m = extractOfficeCallMatches(text);
    assert.strictEqual(m.length, 2);
    assert.strictEqual(m[0].match, 'findOfficeByParentGeoIdRestUrl');
    assert.ok(m[0].context.includes('parentGeoId'));
    assert.strictEqual(m[1].match, 'findOfficeGeoProjectionByParentGeoIdRestUrl');
    assert.ok(m[1].context.includes('fetch('));
  });

  it('extractOfficeCallMatches caps at 5 and returns [] for no match', () => {
    const text = Array(7).fill('findOfficeByParentGeoIdRestUrl').join(' ');
    assert.strictEqual(extractOfficeCallMatches(text).length, 5);
    assert.deepStrictEqual(extractOfficeCallMatches('nothing here'), []);
  });
});

describe('runStageAProbe script step with call-site grep', () => {
  it('page usage + 6th-bundle usage are both recorded (past the old 5-bundle cap)', async () => {
    const libs = [1, 2, 3, 4, 5].map((n) => `<script src="/js/lib${n}.js"></script>`).join('');
    const client = {
      bootstrapped: true,
      base: 'https://example.invalid',
      fetchFormPageText: async () => ({
        url: '/br/application', status: 200, ok: true, contentType: 'text/html', bodyLength: 200,
        text: 'const findOfficeByParentGeoIdRestUrl = "/api/office/find-by-geo-id"; '
          + '$.ajax({url: findOfficeByParentGeoIdRestUrl, data: {parentGeoId: 1988}}) '
          + libs + '<script src="/js/app.js"></script>',
      }),
      fetchPageText: async (src) => ({
        url: src, status: 200, ok: true, contentType: 'application/javascript', bodyLength: 60,
        text: src === '/js/app.js'
          ? 'function loadOffice(id){ return $.get(findOfficeByParentGeoIdRestUrl, {parentGeoId: id}); }'
          : '/* library, no office code */',
      }),
    };
    const r = await runStageAProbe({ client, scriptProbe: true });
    assert.strictEqual(r.ok, true);
    assert.ok(r.steps.includes('script'));
    assert.ok(r.results.script.pageCallMatches.length >= 1, 'page usage of the constant must be recorded');
    assert.ok(r.results.script.pageCallMatches[0].context.includes('parentGeoId'));
    assert.strictEqual(r.results.script.scripts.length, 6, '6th bundle must be fetched (old cap was 5)');
    assert.strictEqual(r.results.script.scripts[5].url, '/js/app.js');
    assert.strictEqual(r.results.script.scripts[5].callMatches.length, 1);
    assert.strictEqual(r.results.script.scripts[5].callMatches[0].match, 'findOfficeByParentGeoIdRestUrl');
    assert.deepStrictEqual(r.results.script.scripts[0].callMatches, []);
  });

  it('page without constant usage: empty call matches, still ok', async () => {
    const client = {
      bootstrapped: true,
      base: 'https://example.invalid',
      fetchFormPageText: async () => ({ url: '/br/application', status: 200, ok: true, contentType: 'text/html', bodyLength: 20, text: '<html>no office here</html>' }),
      fetchPageText: async () => { throw new Error('must not be called without script srcs'); },
    };
    const r = await runStageAProbe({ client, scriptProbe: true });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.results.script.pageCallMatches, []);
    assert.deepStrictEqual(r.results.script.scripts, []);
  });
});
