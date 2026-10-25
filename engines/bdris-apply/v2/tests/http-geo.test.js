/**
 * HttpGeoService + AddressService HTTP-first zone/ward tests.
 * Local mock client only — no live bdris.gov.bd contact, no browser,
 * no personal data. Mock names are fixtures from the reported
 * production case (Dhaka / Dhaka / Dhaka South City Corporation).
 *
 * Run: node --test engines/bdris-apply/v2/tests/http-geo.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const { HttpGeoService } = require('../services/HttpGeoService');
const { AddressService, clearGeoCache } = require('../services/AddressService');

beforeEach(() => clearGeoCache());

function mockClient() {
  const calls = [];
  const geo = (parent, order, type, ward, entries, target) => ({ parent: String(parent), order, type, ward: !!ward, entries, target });
  const table = [
    geo('1', 1, 1, false, [{ id: 4, nameBn: 'ঢাকা', nameEn: 'DHAKA' }], 2),
    geo(4, 2, 2, false, [{ id: 30, nameBn: 'ঢাকা', nameEn: 'DHAKA' }], 3),
    geo(30, 3, 8, false, [{ id: 300, nameBn: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', nameEn: 'DHAKA SOUTH' }], 5),
    geo(30, 3, 3, false, [{ id: 310, nameBn: 'সাভার', nameEn: 'SAVAR' }], 4),
    geo(300, 5, 6, true, [{ id: 400, nameBn: 'অঞ্চল - ১' }, { id: 401, nameBn: 'অঞ্চল - ২' }], 6),
    geo(400, 5, 6, true, [{ id: 500, nameBn: 'ওয়ার্ড - ১' }], 6),
    geo(310, 4, 4, false, [{ id: 320, nameBn: 'সাভার পৌরসভা' }], 7),
    geo(310, 4, 5, false, [{ id: 321, nameBn: 'সাভার ইউনিয়ন' }], 7),
    geo(320, 7, 13, false, [{ id: 330, nameBn: 'ওয়ার্ড - ১' }], 7),
  ];
  return {
    calls,
    bootstrapped: true,
    async bootstrap() { this.bootstrapped = true; },
    async getGeo(parentGeoId, geoOrder, geoType, opts = {}) {
      calls.push({ parent: String(parentGeoId), order: geoOrder, type: geoType, ward: !!opts.ward, geoGroup: opts.geoGroup });
      const row = table.find((r) => r.parent === String(parentGeoId) && r.order === geoOrder && r.type === geoType && r.ward === !!opts.ward);
      if (!row) return { entries: [], targetGeoOrder: geoOrder + 1, geoOrder, geoType, geoGroup: opts.geoGroup };
      return { entries: row.entries, targetGeoOrder: row.target, geoOrder, geoType, geoGroup: opts.geoGroup };
    },
  };
}

const cityCorpParents = { division: 'ঢাকা', district: 'ঢাকা', upazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', zone: '' };

describe('HttpGeoService zone (city corp)', () => {
  it('returns the WardInCityCorp zone list for Dhaka South, following targetGeoOrder 3 -> 5', async () => {
    const svc = new HttpGeoService({ client: mockClient() });
    const res = await svc.getZoneOptions(cityCorpParents, 'birth');
    assert.strictEqual(res.isCityCorp, true);
    assert.deepStrictEqual(res.options.map((o) => o.name), ['অঞ্চল - ১', 'অঞ্চল - ২']);
    assert.deepStrictEqual(res.options.map((o) => o.id), [400, 401]);
  });

  it('uses geoGroup permAddr for the perm form', async () => {
    const client = mockClient();
    const svc = new HttpGeoService({ client });
    await svc.getZoneOptions(cityCorpParents, 'perm');
    assert.ok(client.calls.every((c) => c.geoGroup === 'permAddr'), 'every geo call must carry permAddr');
  });

  it('throws on an empty zone list instead of returning []', async () => {
    const client = mockClient();
    client.getGeo = async () => ({ entries: [], targetGeoOrder: 5, geoOrder: 5, geoType: 6, geoGroup: 'birthPlace' });
    const svc = new HttpGeoService({ client });
    await assert.rejects(() => svc.getZoneOptions(cityCorpParents, 'birth'), (e) => e.code === 'GEO_NOT_FOUND' || e.code === 'GEO_EMPTY');
  });
});

describe('HttpGeoService ward (city corp)', () => {
  it('returns wards after a zone is chosen (parent=zone, order 5, type 6, ward=true)', async () => {
    const svc = new HttpGeoService({ client: mockClient() });
    const res = await svc.getWardOptions({ ...cityCorpParents, zone: 'অঞ্চল - ১' }, 'birth');
    assert.deepStrictEqual(res.options.map((o) => o.name), ['ওয়ার্ড - ১']);
    assert.strictEqual(res.options[0].id, 500);
  });

  it('returns merged paurasava+union options for an upazila branch', async () => {
    const svc = new HttpGeoService({ client: mockClient() });
    const res = await svc.getZoneOptions({ division: 'ঢাকা', district: 'ঢাকা', upazila: 'সাভার', zone: '' }, 'birth');
    assert.strictEqual(res.isCityCorp, false);
    assert.deepStrictEqual(res.options.map((o) => o.name), ['সাভার পৌরসভা', 'সাভার ইউনিয়ন']);
  });
});

describe('AddressService HTTP-first with Playwright fallback', () => {
  it('uses HTTP options and never calls the Playwright navigator on HTTP success', async () => {
    let navCalls = 0;
    const nav = { getAddressOptions: async () => { navCalls++; return [{ id: 'x', name: 'stale' }]; } };
    const httpGeo = new HttpGeoService({ client: mockClient() });
    const svc = new AddressService(nav, { httpGeo });
    const opts = await svc.getOptions('zone', cityCorpParents, 'birth');
    assert.deepStrictEqual(opts.map((o) => o.name), ['অঞ্চল - ১', 'অঞ্চল - ২']);
    assert.strictEqual(navCalls, 0, 'Playwright must not run when HTTP succeeds');
  });

  it('falls back to Playwright when HTTP fails, and throws when both fail', async () => {
    const failingHttp = { getZoneOptions: async () => { throw new Error('HttpGeo: bootstrap failed'); }, getWardOptions: async () => { throw new Error('HttpGeo: bootstrap failed'); } };
    let navCalls = 0;
    const nav = { getAddressOptions: async () => { navCalls++; return [{ id: '9', name: 'ওয়ার্ড - ৯' }]; } };
    const svc = new AddressService(nav, { httpGeo: failingHttp });
    const opts = await svc.getOptions('zone', cityCorpParents, 'birth');
    assert.strictEqual(navCalls, 1);
    assert.strictEqual(opts[0].name, 'ওয়ার্ড - ৯');
    const navEmpty = { getAddressOptions: async () => [] };
    const svc2 = new AddressService(navEmpty, { httpGeo: failingHttp });
    await assert.rejects(
      () => svc2.getOptions('zone', { ...cityCorpParents, upazila: 'ঢাকা উত্তর সিটি কর্পোরেশন' }, 'birth'),
      (e) => e.code === 'ZONE_WARD_FETCH_FAILED',
    );
  });

  it('never caches an empty/failed result: a retry re-runs the fetch', async () => {
    const failingHttp = { getZoneOptions: async () => { throw new Error('HttpGeo: empty'); }, getWardOptions: async () => { throw new Error('HttpGeo: empty'); } };
    let calls = 0;
    const nav = { getAddressOptions: async () => { calls++; return []; } };
    const svc = new AddressService(nav, { httpGeo: failingHttp });
    await assert.rejects(() => svc.getOptions('ward', { ...cityCorpParents, zone: 'অঞ্চল - ৯' }, 'birth'));
    await assert.rejects(() => svc.getOptions('ward', { ...cityCorpParents, zone: 'অঞ্চল - ৯' }, 'birth'));
    assert.strictEqual(calls, 2, 'failed/empty results must never be cached');
  });
});

describe('AddressService HTTP budget (2026-10-25 proven budget fix)', () => {
  it('defaults the HTTP budget to 8000ms', () => {
    const svc = new AddressService(null, {});
    assert.strictEqual(svc.httpTimeoutMs, 8000);
  });

  it('a hung HTTP attempt does NOT starve the Playwright fallback', async () => {
    // Never-resolving HTTP geo: without a budget this getOptions
    // would hang until the 30s executor TIMEOUT and the fallback
    // would never run. With the injected 50ms budget it must fall
    // through to the navigator immediately.
    const hungHttp = {
      getZoneOptions: () => new Promise(() => {}),
      getWardOptions: () => new Promise(() => {}),
    };
    const nav = { getAddressOptions: async () => [{ id: '9', name: 'অঞ্চল - ৯' }] };
    const svc = new AddressService(nav, { httpGeo: hungHttp, httpTimeoutMs: 50 });
    const t0 = Date.now();
    const opts = await svc.getOptions('zone', cityCorpParents, 'birth');
    assert.deepStrictEqual(opts.map((o) => o.name), ['অঞ্চল - ৯']);
    assert.ok(Date.now() - t0 < 5000, 'budget cut must return in well under the executor timeout');
  });

  it('a hung HTTP attempt + empty Playwright composes an error naming the budget timeout', async () => {
    const hungHttp = {
      getZoneOptions: () => new Promise(() => {}),
      getWardOptions: () => new Promise(() => {}),
    };
    const navEmpty = { getAddressOptions: async () => [] };
    const svc = new AddressService(navEmpty, { httpGeo: hungHttp, httpTimeoutMs: 50 });
    await assert.rejects(
      () => svc.getOptions('zone', cityCorpParents, 'birth'),
      (e) => e.code === 'ZONE_WARD_FETCH_FAILED'
        && /timed out after 50ms/.test(e.message)
        && /Playwright: .*empty/.test(e.message),
    );
  });
});
