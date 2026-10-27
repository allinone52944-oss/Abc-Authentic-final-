/**
 * walkGeoChain loose matching (2026-10-27, live-proven failure):
 * the Stage A probe failed live at step 1 — no entry STRICTLY
 * equal to "চট্টগ্রাম" under parent 1 — while the working path
 * calls the same endpoint and succeeds via its loose matcher.
 * walkGeoChain must therefore use the SAME shared matcher
 * (v2/http/geoMatch.js) as the working path, never strict
 * equality. These tests stub getGeo (no network, no live host)
 * and drive walkGeoChain directly.
 * Run: node --test engines/bdris-apply/v2/tests/http-walk-loose.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BdrisHttpClient } = require('../http/client');
const { normalizeBn } = require('../http/geoMatch');
const geoServiceExports = require('../services/HttpGeoService');

// Stub getGeo: per (parent, order, type) key, return fixed entries
// and a targetGeoOrder; record every call to prove order-following.
function stubClient(pages) {
  // base is required by the constructor but never fetched: getGeo is
  // stubbed below, so this host is never contacted.
  const client = new BdrisHttpClient({ base: 'https://example.invalid' });
  const calls = [];
  client.getGeo = async (parent, order, type, opts = {}) => {
    calls.push({ parent: String(parent), order, type, ward: !!opts.ward });
    const page = pages[`${parent}|${order}|${type}`];
    assert.ok(page, `unexpected geo call ${parent}|${order}|${type}`);
    return { entries: page.entries, targetGeoOrder: page.targetGeoOrder };
  };
  return { client, calls };
}

describe('walkGeoChain uses the shared loose matcher, not strict equality', () => {
  it('division substring: list "চট্টগ্রাম বিভাগ" matches want "চট্টগ্রাম" (the live probe failure)', async () => {
    const { client, calls } = stubClient({
      '1|1|1': { entries: [{ id: '2', nameBn: 'চট্টগ্রাম বিভাগ' }], targetGeoOrder: 2 },
      '2|2|2': { entries: [{ id: '3', nameBn: 'কক্সবাজার' }], targetGeoOrder: 3 },
    });
    const out = await client.walkGeoChain({
      firstParentId: '1', firstGeoOrder: 1,
      steps: [
        { geoType: 1, nameBn: 'চট্টগ্রাম' },
        { geoType: 2, nameBn: 'কক্সবাজার' },
      ],
    });
    assert.strictEqual(out[0].chosen.id, '2');
    assert.strictEqual(out[1].chosen.id, '3');
    // Second call follows the FIRST response's targetGeoOrder (2),
    // and uses the chosen entry's id as parent — never order+1.
    assert.deepStrictEqual(calls[1], { parent: '2', order: 2, type: 2, ward: false });
  });

  it('dot variant: list "PMKhali" matches want "P.M. Khali"', async () => {
    const { client } = stubClient({
      '1|1|1': { entries: [{ id: '2', nameBn: 'চট্টগ্রাম' }], targetGeoOrder: 2 },
      '2|2|5': { entries: [{ id: '9', nameBn: 'PMKhali' }], targetGeoOrder: 6 },
    });
    const out = await client.walkGeoChain({
      firstParentId: '1', firstGeoOrder: 1,
      steps: [
        { geoType: 1, nameBn: 'চট্টগ্রাম' },
        { geoType: 5, nameBn: 'P.M. Khali' },
      ],
    });
    assert.strictEqual(out[1].chosen.id, '9');
  });

  it('exact match still works, and a genuine miss still throws GEO_NOT_FOUND', async () => {
    const { client } = stubClient({
      '1|1|1': { entries: [{ id: '2', nameBn: 'চট্টগ্রাম' }], targetGeoOrder: 2 },
    });
    const out = await client.walkGeoChain({
      firstParentId: '1', firstGeoOrder: 1,
      steps: [{ geoType: 1, nameBn: 'চট্টগ্রাম' }],
    });
    assert.strictEqual(out[0].chosen.id, '2');
    await assert.rejects(
      client.walkGeoChain({
        firstParentId: '1', firstGeoOrder: 1,
        steps: [{ geoType: 1, nameBn: 'সিলেট' }],
      }),
      (e) => e.code === 'GEO_NOT_FOUND',
    );
  });

  it('the working path and the probe chain share one matcher function', () => {
    assert.strictEqual(
      geoServiceExports.normalizeBn, normalizeBn,
      'HttpGeoService must re-export the shared normalizeBn, not a local copy',
    );
  });
});
