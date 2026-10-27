/**
 * getOfficeId probe (2026-10-27): the uploaded OTP/office log proves
 * officeId comes from a page function getOfficeId() (empty → 0) —
 * but not what that function does inside. So the script step now
 * also greps the page + bundles for the getOfficeId name
 * (getOfficeId grep helpers), recording pageFnMatches and per-bundle
 * fnMatches, so the definition/body surfaces with context. No
 * network, no live host.
 * Run: node --test engines/bdris-apply/v2/tests/http-script-getofficeid.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runStageAProbe, extractGetOfficeIdMatches } = require('../services/HttpPathRunner');

describe('getOfficeId grep helpers', () => {
  it('extractGetOfficeIdMatches finds the definition with body context', () => {
    const text = 'xx function getOfficeId(){ var id = $("#officeId").val(); return id ? id : 0; } yy';
    const m = extractGetOfficeIdMatches(text);
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].match, 'getOfficeId');
    assert.ok(m[0].context.includes('function getOfficeId'));
    assert.ok(m[0].context.includes('return id'));
  });

  it('extractGetOfficeIdMatches caps at 5 and returns [] for no match', () => {
    const text = Array(7).fill('getOfficeId').join(' ');
    assert.strictEqual(extractGetOfficeIdMatches(text).length, 5);
    assert.deepStrictEqual(extractGetOfficeIdMatches('nothing here'), []);
  });
});

describe('runStageAProbe script step with getOfficeId grep', () => {
  it('page definition + bundle usage are both recorded', async () => {
    const client = {
      bootstrapped: true,
      base: 'https://example.invalid',
      fetchFormPageText: async () => ({
        url: '/br/application', status: 200, ok: true, contentType: 'text/html', bodyLength: 200,
        text: 'function getOfficeId(){ return officeIdFromGeo || 0; } <script src="/js/app.js"></script>',
      }),
      fetchPageText: async (src) => ({
        url: src, status: 200, ok: true, contentType: 'application/javascript', bodyLength: 60,
        text: 'var oid = getOfficeId(); sendOtp(oid);',
      }),
    };
    const r = await runStageAProbe({ client, scriptProbe: true });
    assert.strictEqual(r.ok, true);
    assert.ok(r.steps.includes('script'));
    assert.strictEqual(r.results.script.pageFnMatches.length, 1);
    assert.ok(r.results.script.pageFnMatches[0].context.includes('function getOfficeId'));
    assert.strictEqual(r.results.script.scripts.length, 1);
    assert.strictEqual(r.results.script.scripts[0].fnMatches.length, 1);
    assert.ok(r.results.script.scripts[0].fnMatches[0].context.includes('sendOtp'));
  });

  it('page without getOfficeId: empty fn matches, still ok', async () => {
    const client = {
      bootstrapped: true,
      base: 'https://example.invalid',
      fetchFormPageText: async () => ({ url: '/br/application', status: 200, ok: true, contentType: 'text/html', bodyLength: 20, text: '<html>no office fn here</html>' }),
      fetchPageText: async () => { throw new Error('must not be called without script srcs'); },
    };
    const r = await runStageAProbe({ client, scriptProbe: true });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.results.script.pageFnMatches, []);
    assert.deepStrictEqual(r.results.script.scripts, []);
  });
});
