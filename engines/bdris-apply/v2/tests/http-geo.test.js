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
    geo(30, 3, 8, false, [{ id: 300, nameBn: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', nameEn: 'DHAKA SOUTH' }], 3),
    geo(30, 3, 3, false, [{ id: 310, nameBn: 'সাভার', nameEn: 'SAVAR' }], 4),
    // Proven live zone URL (2026-10-26): parent cityCorp id, order 3,
    // type 8 (parent type), ward=true — NOT type 6.
    geo(300, 3, 8, true, [{ id: 400, nameBn: 'অঞ্চল - ১' }, { id: 401, nameBn: 'অঞ্চল - ২' }], 5),
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

describe('AddressService session-seeded HTTP (live banner 2026-10-26: bare fetch 403)', () => {
  // Mock client in the real BdrisHttpClient shape: starts
  // unbootstrapped, becomes bootstrapped only via seedFromBrowser
  // (browser cookies + page CSRF), never via a fetch bootstrap.
  function seededMockClient() {
    const base = mockClient();
    base.bootstrapped = false;
    base.geoCalls = 0;
    const origGetGeo = base.getGeo.bind(base);
    base.getGeo = async (...args) => { base.geoCalls++; return origGetGeo(...args); };
    base.seedFromBrowser = function ({ cookies, csrfToken }) {
      if (!csrfToken) throw new Error('BOOTSTRAP_NO_CSRF');
      this.bootstrapped = true;
      this.seeded = { cookies, csrfToken };
    };
    return base;
  }
  function fakePage() {
    return {
      context: () => ({ cookies: async () => [{ name: 'TS01', value: 'browser-session' }] }),
      evaluate: async () => ({ token: 'page-csrf', headerName: 'X-CSRF-TOKEN' }),
    };
  }

  it('seeds HTTP from the warm Playwright page and never calls the navigator on success', async () => {
    const client = seededMockClient();
    const httpGeo = new HttpGeoService({ client });
    let navCalls = 0;
    const nav = {
      page: fakePage(),
      getAddressOptions: async () => { navCalls++; return [{ id: 'x', name: 'stale' }]; },
    };
    const svc = new AddressService(nav, { httpGeo });
    const opts = await svc.getOptions('zone', cityCorpParents, 'birth');
    assert.deepStrictEqual(opts.map((o) => o.name), ['অঞ্চল - ১', 'অঞ্চল - ২']);
    assert.strictEqual(navCalls, 0, 'Playwright cascade must not run when seeded HTTP succeeds');
    assert.strictEqual(client.seeded.csrfToken, 'page-csrf');
    assert.strictEqual(client.seeded.cookies[0].name, 'TS01');
  });

  it('with no warm session, bare fetch is NEVER attempted: geo is not called at all', async () => {
    const client = seededMockClient();
    const httpGeo = new HttpGeoService({ client });
    const nav = { getAddressOptions: async () => [] }; // no .page
    const svc = new AddressService(nav, { httpGeo });
    await assert.rejects(
      () => svc.getOptions('zone', cityCorpParents, 'birth'),
      (e) => e.code === 'ZONE_WARD_FETCH_FAILED'
        && /no warm Playwright session/.test(e.message),
    );
    assert.strictEqual(client.geoCalls, 0, 'a bare fetch bootstrap would have called geo; it must not happen');
  });

  it('seeded HTTP failure still falls back to the Playwright cascade', async () => {
    const client = seededMockClient();
    client.getGeo = async () => { throw new Error('Geo call returned status 403'); };
    const httpGeo = new HttpGeoService({ client });
    const nav = {
      page: fakePage(),
      getAddressOptions: async () => [{ id: '9', name: 'অঞ্চল - ৯' }],
    };
    const svc = new AddressService(nav, { httpGeo });
    const opts = await svc.getOptions('zone', cityCorpParents, 'birth');
    assert.deepStrictEqual(opts.map((o) => o.name), ['অঞ্চল - ৯']);
  });
});

describe('Proven live zone/ward URLs (2026-10-26, public geo data)', () => {
  // Fake client keyed to the exact live chain, not to the old mock
  // table: division 4 -> district 25 -> cityCorp 5689 (Dhaka South).
  // Zone fixture = the 10 zones from the live Sample B response.
  const liveZones = [
    { id: 5690, nameBn: 'অঞ্চল - ১, নগর ভবন' },
    { id: 5975, nameBn: 'অঞ্চল - ১০' },
    { id: 5691, nameBn: 'অঞ্চল - ২, খিলগাঁও' },
    { id: 5692, nameBn: 'অঞ্চল - ৩, আজিমপুর' },
    { id: 5693, nameBn: 'অঞ্চল - ৪, নগর ভবন' },
    { id: 5694, nameBn: 'অঞ্চল - ৫, সায়েদাবাদ' },
    { id: 5971, nameBn: 'অঞ্চল - ৬' },
    { id: 5972, nameBn: 'অঞ্চল - ৭' },
    { id: 5973, nameBn: 'অঞ্চল - ৮' },
    { id: 5974, nameBn: 'অঞ্চল - ৯' },
  ];
  function liveClient() {
    const calls = [];
    const table = [
      { parent: '1', order: 1, type: 1, ward: false, entries: [{ id: 4, nameBn: 'ঢাকা' }], target: 2 },
      { parent: '4', order: 2, type: 2, ward: false, entries: [{ id: 25, nameBn: 'ঢাকা' }], target: 3 },
      { parent: '25', order: 3, type: 8, ward: false, entries: [{ id: 5689, nameBn: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন' }], target: 3 },
      // The proven zone call: /5689?ward=true&geoGroup=birthPlace&geoOrder=3&geoType=8
      { parent: '5689', order: 3, type: 8, ward: true, entries: liveZones, target: 5 },
      // The proven ward calls: /5692 and /5972, order 5, type 6, ward=true
      { parent: '5692', order: 5, type: 6, ward: true, entries: [{ id: 1, nameBn: 'ওয়ার্ড - ১' }], target: 5 },
      { parent: '5972', order: 5, type: 6, ward: true, entries: [{ id: 1, nameBn: 'ওয়ার্ড - ১' }], target: 5 },
    ];
    return {
      calls,
      bootstrapped: true,
      async getGeo(parentGeoId, geoOrder, geoType, opts = {}) {
        calls.push({ parent: String(parentGeoId), order: geoOrder, type: geoType, ward: !!opts.ward, geoGroup: opts.geoGroup });
        const row = table.find((r) => r.parent === String(parentGeoId) && r.order === geoOrder && r.type === geoType && r.ward === !!opts.ward);
        if (!row) return { entries: [], targetGeoOrder: geoOrder + 1, geoOrder, geoType, geoGroup: opts.geoGroup };
        return { entries: row.entries, targetGeoOrder: row.target, geoOrder, geoType, geoGroup: opts.geoGroup };
      },
    };
  }
  const liveParents = { division: 'ঢাকা', district: 'ঢাকা', upazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', zone: '' };

  it('zone call is exactly (5689, order 3, type 8, ward=true) and returns all 10 live zones', async () => {
    const client = liveClient();
    const svc = new HttpGeoService({ client });
    const res = await svc.getZoneOptions(liveParents, 'birth');
    assert.strictEqual(res.options.length, 10);
    assert.deepStrictEqual(res.options.map((o) => o.id), [5690, 5975, 5691, 5692, 5693, 5694, 5971, 5972, 5973, 5974]);
    assert.ok(client.calls.some((c) => c.parent === '5689' && c.order === 3 && c.type === 8 && c.ward === true),
      'zone call must be parent 5689, order 3, type 8, ward=true (proven live URL)');
    assert.ok(!client.calls.some((c) => c.parent === '5689' && c.type === 6),
      'the old type-6 zone call must never be made for the cityCorp branch');
    assert.strictEqual(res.zoneTargetOrder, 5);
  });

  it('ward call stays exactly (zone id, order 5, type 6, ward=true) for Zone-3 and Zone-7', async () => {
    const client = liveClient();
    const svc = new HttpGeoService({ client });
    await svc.getWardOptions({ ...liveParents, zone: 'অঞ্চল - ৩, আজিমপুর' }, 'birth');
    assert.ok(client.calls.some((c) => c.parent === '5692' && c.order === 5 && c.type === 6 && c.ward === true),
      'ward call for Zone-3 must be /5692?ward=true&geoOrder=5&geoType=6');
    const client2 = liveClient();
    const svc2 = new HttpGeoService({ client: client2 });
    await svc2.getWardOptions({ ...liveParents, zone: 'অঞ্চল - ৭' }, 'birth');
    assert.ok(client2.calls.some((c) => c.parent === '5972' && c.order === 5 && c.type === 6 && c.ward === true),
      'ward call for Zone-7 must be /5972?ward=true&geoOrder=5&geoType=6');
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
