/**
 * Office raw-body diagnostic (2026-10-27): the live office probe
 * returned ok:true + response:null for BOTH geoId 1988 (union) and
 * 7193 (ward). officeGet collapses three different server answers
 * to that bare null — empty body, HTML page served with 200, and
 * JSON null — so the next live run must record the raw shape.
 * These tests cover the probe-only officeGetRaw (the submit chain
 * still uses officeGet, untouched) and the probe's raw-preferred
 * recording with fallback to the old shape for doubles without
 * the raw method. No network, no live host.
 * Run: node --test engines/bdris-apply/v2/tests/http-office-raw.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BdrisHttpClient } = require('../http/client');
const { runStageAProbe } = require('../services/HttpPathRunner');

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

function seededClient(fetchImpl) {
  const client = new BdrisHttpClient({ base: 'https://example.invalid', fetchImpl });
  client.bootstrapped = true;
  client.csrfToken = 't';
  return client;
}

describe('officeGetRaw records the raw response shape (probe-only)', () => {
  it('JSON body: json parsed, status/content-type/length/preview recorded', async () => {
    const body = JSON.stringify({ officeId: 5, name: 'PM Khali UP' });
    const client = seededClient(cannedFetch({ status: 200, contentType: 'application/json', body }));
    const raw = await client.findOfficeByGeoIdRaw({ geoId: '1988' });
    assert.strictEqual(raw.url, '/api/office/find-by-geo-id?geoId=1988');
    assert.strictEqual(raw.status, 200);
    assert.strictEqual(raw.ok, true);
    assert.strictEqual(raw.contentType, 'application/json');
    assert.strictEqual(raw.bodyLength, body.length);
    assert.strictEqual(raw.bodyPreview, body);
    assert.deepStrictEqual(raw.json, { officeId: 5, name: 'PM Khali UP' });
  });

  it('HTML body with 200: json null BUT preview proves it is a page, not an empty body', async () => {
    const body = '<!DOCTYPE html><html><head><title>Login</title></head></html>';
    const client = seededClient(cannedFetch({ status: 200, contentType: 'text/html', body }));
    const raw = await client.findOfficeByGeoIdRaw({ geoId: '1988' });
    assert.strictEqual(raw.json, null);
    assert.strictEqual(raw.bodyLength, body.length);
    assert.ok(raw.bodyLength > 0);
    assert.ok(raw.bodyPreview.startsWith('<!DOCTYPE html>'));
  });

  it('empty body: json null AND length 0 — distinguishable from the HTML case', async () => {
    const client = seededClient(cannedFetch({ status: 200, contentType: 'application/json', body: '' }));
    const raw = await client.findOfficeByGeoIdRaw({ geoId: '1988' });
    assert.strictEqual(raw.json, null);
    assert.strictEqual(raw.bodyLength, 0);
    assert.strictEqual(raw.bodyPreview, '');
  });
});

describe('runStageAProbe prefers the raw office method, falls back to the old shape', () => {
  it('raw stub: probe records url/status/content-type/length/preview + response', async () => {
    const client = {
      bootstrapped: true,
      walkGeoChain: async () => [],
      findOfficeByGeoIdRaw: async () => ({
        url: '/api/office/find-by-geo-id?geoId=7193', status: 200, ok: true,
        contentType: 'text/html', bodyLength: 42, bodyPreview: '<html>hi', json: null,
      }),
      findOfficeGeoProjectionByGeoIdRaw: async () => ({
        url: '/api/office/find-office-geo-projection-by-geo-id?geoId=7193', status: 200, ok: true,
        contentType: 'application/json', bodyLength: 4, bodyPreview: 'null', json: null,
      }),
    };
    const r = await runStageAProbe({ client, officeParams: { geoId: '7193' }, officeProjectionParams: { geoId: '7193' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.results.office.url, '/api/office/find-by-geo-id?geoId=7193');
    assert.strictEqual(r.results.office.bodyLength, 42);
    assert.strictEqual(r.results.office.bodyPreview, '<html>hi');
    assert.strictEqual(r.results.office.response, null);
    assert.strictEqual(r.results.officeProjection.contentType, 'application/json');
  });

  it('old-style stub without raw methods: old {ok, response} shape preserved', async () => {
    const client = {
      bootstrapped: true,
      walkGeoChain: async () => [],
      findOfficeByGeoId: async () => ({ officeId: 9 }),
      findOfficeGeoProjectionByGeoId: async () => ({ officeId: 9 }),
    };
    const r = await runStageAProbe({ client, officeParams: { geoId: '7193' }, officeProjectionParams: { geoId: '7193' } });
    assert.deepStrictEqual(r.results.office, { ok: true, response: { officeId: 9 } });
    assert.deepStrictEqual(r.results.officeProjection, { ok: true, response: { officeId: 9 } });
  });
});
