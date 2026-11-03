// Route tests for the khatian collection store integration
// (backend/routes/land-khatian.js + backend/lib/khatianStore.js
// contract + engines/land-khatian/adapter.js importMouza).
// Portal + store + DB are all mocked — no real portal calls,
// no real money, no real store. Synthetic data only.
let lastUpsertTotal = 0;
const mockStore = {
  upsert: jest.fn(async (args) => {
    lastUpsertTotal = (args.records || []).length;
    return { upserted: (args.records || []).length, updated: false, total: lastUpsertTotal };
  }),
  search: jest.fn(async () => ({ records: [], collectedAt: null, totalMatches: 0, mouzaCollected: false })),
  countForUnit: jest.fn(async () => ({ count: lastUpsertTotal })),
  ping: jest.fn(async () => ({ ok: true })),
};
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/land-core/client', () => ({
  divisions: jest.fn(), districts: jest.fn(), upazilas: jest.fn(),
  surveys: jest.fn(), upazilaSurveys: jest.fn(), jlNumbers: jest.fn(),
  indexList: jest.fn(), indexByKhatianNo: jest.fn(), detail: jest.fn(),
  halSabek: jest.fn(),
  ownerMatches: (owners, name) => String(owners || '').includes(String(name || '').trim()),
  sumLand: (ds) => Math.round(ds.reduce((a, d) => a + (parseFloat(d.TOTAL_LAND) || 0), 0) * 10000) / 10000,
}));
jest.mock('../../lib/khatianStore', () => ({ getStoreClient: () => mockStore, createStoreClient: () => mockStore }));
jest.mock('../../utils/whatsapp', () => ({
  notifyServiceCompleted: jest.fn().mockResolvedValue({ ok: true }),
  notifyServiceFailed: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../utils/push', () => ({
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const khatianRouter = require('../../routes/land-khatian');
const client = require('../../../engines/land-core/client');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/land-khatian', khatianRouter);
  return a;
}
const userToken = () => auth.signAccess({ id: 'u1', role: 'user' });
const adminToken = () => auth.signAccess({ id: 'a1', role: 'admin' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + userToken());
const withAdmin = (req) => req.set('Authorization', 'Bearer ' + adminToken());

const AREA = {
  division_bbs: '30', district_bbs: '26', upazila_bbs: '48', mouza_id: '72400',
  division_name: 'Dhaka', district_name: 'Dhaka', upazila_name: 'Test Upazila',
  mouza_name: 'Test Mouza', jl_no: '33',
};

function baseRoutes(extra = []) {
  return [
    ...extra,
    ['status, data, documents FROM orders', { rows: [] }],
    ['FROM services WHERE', { rows: [{ id: 41, price: 30 }] }],
    ['FROM user_services WHERE', { rows: [] }],
    ['FROM users WHERE', { rows: [{ balance: 500 }] }],
    ['FROM service_credits', { rows: [] }],
    ['FROM transactions WHERE', { rows: [] }],
    ['wallet_apply', { rows: [{ balance: 470 }] }],
    ['INSERT INTO orders', { rows: [{ id: 'o1' }] }],
    ['SELECT documents FROM orders', { rows: [{ documents: '[]' }] }],
    ['UPDATE orders SET documents', { rows: [] }],
  ];
}

function portalFound() {
  client.surveys.mockResolvedValue([{ ID: 2, KEY: 'RS', NAME: 'RS' }]);
  client.upazilaSurveys.mockResolvedValue([{ SURVEY_ID: 2, LOCAL_NAME: 'RS' }]);
  client.jlNumbers.mockResolvedValue([{ ID: 238686, MOUZA_ID: 72400, MOUZA_NAME: 'Test Mouza', JL_NUMBER: '33' }]);
  client.indexByKhatianNo.mockResolvedValue([{ ID: 900, KHATIAN_NO: '8', OWNERS: 'Test One' }]);
  client.detail.mockResolvedValue({ ID: 900, KHATIAN_NO: '8', OWNERS: 'Test One', DAGS: '1237', TOTAL_LAND: '0.0544' });
  client.halSabek.mockResolvedValue([]);
  client.upazilas.mockResolvedValue([]);
}

const walletCalls = () => db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
const orderInserts = () => db.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO orders'));
const indexInserts = () => db.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO land_khatian_index'));

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
  lastUpsertTotal = 0;
  // Restore default store behaviour (clearAllMocks does not
  // restore implementations replaced by mockRejectedValue).
  mockStore.upsert.mockImplementation(async (args) => {
    lastUpsertTotal = (args.records || []).length;
    return { upserted: (args.records || []).length, updated: false, total: lastUpsertTotal };
  });
  mockStore.search.mockResolvedValue({ records: [], collectedAt: null, totalMatches: 0, mouzaCollected: false });
  mockStore.countForUnit.mockImplementation(async () => ({ count: lastUpsertTotal }));
  db.__routeQuery(baseRoutes());
});

describe('search: live primary, store fallback', () => {
  test('live success never consults the store for its answer (search not called), charges once', async () => {
    portalFound();
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 's-live-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 30, source: 'live', stale: false });
    expect(mockStore.search).not.toHaveBeenCalled();
    expect(mockStore.upsert).toHaveBeenCalled();
    expect(mockStore.upsert.mock.calls[0][0]).toMatchObject({ merge: true });
    expect(walletCalls()).toHaveLength(1);
  });

  test('genuine live 0-result stays 422 not-found; store never consulted; uncollected mouza never shown as found', async () => {
    portalFound();
    client.indexByKhatianNo.mockResolvedValue([]);
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '999', idempotency_key: 's-nf-1' }).expect(422);
    expect(r.body).toMatchObject({ error: 'NOT_FOUND', charged: 0 });
    expect(mockStore.search).not.toHaveBeenCalled();
    expect(mockStore.upsert).not.toHaveBeenCalled();
    expect(walletCalls()).toHaveLength(0);
  });

  test('live failure → store hit returns stale flags + surveysPresent + charged once', async () => {
    portalFound();
    const e = new Error('LAND_UNREACHABLE: boom');
    e.code = 'LAND_UNREACHABLE';
    client.indexByKhatianNo.mockRejectedValue(e);
    mockStore.search.mockResolvedValue({
      records: [{ id: 900, khatianNo: '8', owners: 'Test One', dags: '1237', totalLand: '0.0544', surveyKey: 'RS', surveyName: 'RS', jlId: 238686, halSabek: [] }],
      collectedAt: '2026-11-02T10:00:00.000Z', totalMatches: 1, mouzaCollected: true,
    });
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 's-stale-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 30, source: 'store', stale: true, collectedAt: '2026-11-02T10:00:00.000Z' });
    expect(r.body.surveysPresent).toEqual(['RS']);
    expect(r.body.records).toHaveLength(1);
    expect(walletCalls()).toHaveLength(1);
    expect(orderInserts()[0][1][3]).toContain('"source":"store"');
  });

  test('live-down + store-empty NEVER returns 200/records/success: 502 + storeEmpty only, no charge, no order', async () => {
    portalFound();
    const e = new Error('LAND_UNREACHABLE: boom');
    e.code = 'LAND_UNREACHABLE';
    client.indexByKhatianNo.mockRejectedValue(e);
    mockStore.search.mockResolvedValue({ records: [], collectedAt: null, totalMatches: 0, mouzaCollected: false });
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 's-empty-1' }).expect(502);
    expect(r.body).toMatchObject({ error: 'LAND_UNREACHABLE', storeEmpty: true });
    expect(r.body.ok).toBeUndefined();
    expect(r.body.records).toBeUndefined();
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });

  test('live-down + stored data but no match → 502 storeEmpty:false, still no charge and no definitive not-found', async () => {
    portalFound();
    const e = new Error('LAND_UNREACHABLE: boom');
    e.code = 'LAND_UNREACHABLE';
    client.indexByKhatianNo.mockRejectedValue(e);
    mockStore.search.mockResolvedValue({ records: [], collectedAt: null, totalMatches: 0, mouzaCollected: true });
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 's-nomatch-1' }).expect(502);
    expect(r.body).toMatchObject({ error: 'LAND_UNREACHABLE', storeEmpty: false });
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });

  test('live-down + store itself unreachable → plain 502, no charge', async () => {
    portalFound();
    const e = new Error('LAND_UNREACHABLE: boom');
    e.code = 'LAND_UNREACHABLE';
    client.indexByKhatianNo.mockRejectedValue(e);
    const se = new Error('store down');
    se.code = 'STORE_UNREACHABLE';
    mockStore.search.mockRejectedValue(se);
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 's-down-1' }).expect(502);
    expect(r.body).toMatchObject({ error: 'LAND_UNREACHABLE' });
    expect(r.body.storeEmpty).toBeUndefined();
    expect(walletCalls()).toHaveLength(0);
  });

  test('store-write failure never breaks a live success', async () => {
    portalFound();
    mockStore.upsert.mockRejectedValue(new Error('disk full'));
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 's-writefail-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 30, source: 'live' });
    expect(walletCalls()).toHaveLength(1);
  });
});

describe('admin import', () => {
  function importMocks(mouzas, indexSize, detailFn) {
    client.surveys.mockResolvedValue([{ ID: 2, KEY: 'RS', NAME: 'RS' }]);
    client.upazilaSurveys.mockResolvedValue([{ SURVEY_ID: 2, LOCAL_NAME: 'RS' }]);
    client.jlNumbers.mockResolvedValue(mouzas.map((m, i) => ({ ID: 1000 + i, MOUZA_ID: m, MOUZA_NAME: 'Mouza ' + m, JL_NUMBER: String(i + 1) })));
    client.indexList.mockImplementation(async (key, jlId) => {
      const n = typeof indexSize === 'function' ? indexSize(jlId) : indexSize;
      return Array.from({ length: n }, (_, i) => ({ ID: jlId * 100 + i, KHATIAN_NO: String(i + 1), OWNERS: 'Owner ' + i }));
    });
    client.detail.mockImplementation(async (key, id) => (detailFn ? detailFn(key, id) : {
      ID: id, KHATIAN_NO: String(id % 100 + 1), OWNERS: 'Owner', DAGS: '1237', TOTAL_LAND: '0.5',
    }));
    client.halSabek.mockResolvedValue([]);
    client.upazilas.mockResolvedValue([]);
  }

  test('non-admin → 403', async () => {
    const r = await withUser(request(app()).post('/api/land-khatian/admin/import'))
      .send({ division_bbs: '30', district_bbs: '26', upazila_bbs: '48', survey_id: '2' }).expect(403);
    expect(r.body).toMatchObject({ error: 'ADMIN_ONLY' });
  });

  test('whole-country scope rejected (no area) → 400', async () => {
    await withAdmin(request(app()).post('/api/land-khatian/admin/import')).send({}).expect(400);
    await withAdmin(request(app()).post('/api/land-khatian/admin/import')).send({ scope: 'country' }).expect(400);
  });

  test('cap 5 mouzas + cursor continuation; index upsert called; upazila coverage honest', async () => {
    importMocks([11, 22, 33, 44, 55, 66, 77], 2);
    const r1 = await withAdmin(request(app()).post('/api/land-khatian/admin/import'))
      .send({ division_bbs: '30', district_bbs: '26', upazila_bbs: '48', survey_id: '2' }).expect(200);
    expect(r1.body).toMatchObject({ done: false, importedMouzas: 5, totalMouzasInScope: 7 });
    expect(r1.body.nextCursor).toBeTruthy();
    expect(r1.body.batch).toMatchObject({ mouzasAttempted: 5, mouzasCompleted: 5, khatiansExpected: 10, khatiansCollected: 10, dagsCollected: 10 });
    expect(r1.body.batchStatus).toBe('complete');
    expect(r1.body.reconciliation).toHaveLength(5);
    expect(r1.body.reconciliation[0]).toMatchObject({ expected: 2, collected: 2, status: 'complete' });
    expect(indexInserts().length).toBeGreaterThanOrEqual(5);
    // Upazila coverage: portal lists 7 mouza units, index rows mocked empty → 0 complete, 7 not started, 0%.
    expect(r1.body.coverage.upazila).toMatchObject({ totalUnits: 7, completeUnits: 0, notStartedUnits: 7, percentComplete: 0 });
    const r2 = await withAdmin(request(app()).post('/api/land-khatian/admin/import'))
      .send({ division_bbs: '30', district_bbs: '26', upazila_bbs: '48', survey_id: '2', cursor: r1.body.nextCursor }).expect(200);
    expect(r2.body).toMatchObject({ done: true, importedMouzas: 2 });
    expect(r2.body.nextCursor).toBeNull();
  });

  test('partial unit (mocked worked example): 3 expected, 1 detail failed → partial, open issue, batch partial', async () => {
    importMocks([11], 3, async (key, id) => {
      if (id === 100002) { const e = new Error('detail boom'); e.code = 'LAND_API_ERROR'; throw e; }
      return { ID: id, KHATIAN_NO: String(id % 100 + 1), OWNERS: 'Owner', DAGS: '1237', TOTAL_LAND: '0.5' };
    });
    const r = await withAdmin(request(app()).post('/api/land-khatian/admin/import'))
      .send({ division_bbs: '30', district_bbs: '26', upazila_bbs: '48', survey_id: '2' }).expect(200);
    expect(r.body.batch).toMatchObject({ mouzasAttempted: 1, mouzasPartial: 1, mouzasCompleted: 0, khatiansExpected: 3, khatiansCollected: 2, dagsCollected: 2 });
    expect(r.body.batchStatus).toBe('partial');
    expect(r.body.reconciliation[0]).toMatchObject({ expected: 3, collected: 2, status: 'partial' });
    expect(r.body.reconciliation[0].failedDetails).toHaveLength(1);
    expect(r.body.reconciliation[0].issues[0]).toMatchObject({ reason: 'LAND_API_ERROR' });
    expect(r.body.openUnitsTotal).toBeGreaterThanOrEqual(0);
    const ins = indexInserts()[0];
    expect(ins[1][15]).toBe('partial'); // status param
    expect(ins[1][13]).toBe(3); // expected_count param
    expect(ins[1][14]).toBe(2); // collected_count param
  });

  test('unparseable DAGS flags the record and forces partial, never a guessed dag count', async () => {
    importMocks([11], 2, async (key, id) => ({
      ID: id, KHATIAN_NO: String(id % 100 + 1), OWNERS: 'Owner',
      DAGS: id === 100001 ? '12A, 45' : '1237', TOTAL_LAND: '0.5',
    }));
    const r = await withAdmin(request(app()).post('/api/land-khatian/admin/import'))
      .send({ division_bbs: '30', district_bbs: '26', upazila_bbs: '48', survey_id: '2' }).expect(200);
    expect(r.body.reconciliation[0]).toMatchObject({ status: 'partial', dagsCollected: 1 });
    expect(r.body.reconciliation[0].issues.some((i) => i.reason === 'DAGS_UNPARSEABLE')).toBe(true);
    expect(r.body.batchStatus).toBe('partial');
  });

  test('record cap: 2500 + 1000 records stop starting the third mouza', async () => {
    importMocks([11, 22, 33], (jlId) => (jlId === 1000 ? 2500 : jlId === 1001 ? 1000 : 500));
    const r = await withAdmin(request(app()).post('/api/land-khatian/admin/import'))
      .send({ division_bbs: '30', district_bbs: '26', upazila_bbs: '48', survey_id: '2' }).expect(200);
    expect(r.body).toMatchObject({ importedMouzas: 2, recordsUpserted: 3500 });
    expect(r.body.batch).toMatchObject({ khatiansExpected: 3500, khatiansCollected: 3500 });
    expect(r.body.nextCursor).toBeTruthy();
    expect(r.body.done).toBe(false);
  });

  test('per-mouza failure counted, never aborts the call', async () => {
    client.surveys.mockResolvedValue([{ ID: 2, KEY: 'RS', NAME: 'RS' }]);
    client.upazilaSurveys.mockResolvedValue([{ SURVEY_ID: 2, LOCAL_NAME: 'RS' }]);
    client.jlNumbers.mockResolvedValue([
      { ID: 1000, MOUZA_ID: 11, MOUZA_NAME: 'M1', JL_NUMBER: '1' },
      { ID: 1001, MOUZA_ID: 22, MOUZA_NAME: 'M2', JL_NUMBER: '2' },
    ]);
    client.indexList.mockImplementation(async (key, jlId) => {
      if (jlId === 1000) { const e = new Error('index boom'); e.code = 'LAND_API_ERROR'; throw e; }
      return [{ ID: 100101, KHATIAN_NO: '1', OWNERS: 'Owner' }];
    });
    client.detail.mockResolvedValue({ ID: 100101, KHATIAN_NO: '1', OWNERS: 'Owner', DAGS: '1237', TOTAL_LAND: '0.5' });
    client.halSabek.mockResolvedValue([]);
    client.upazilas.mockResolvedValue([]);
    const r = await withAdmin(request(app()).post('/api/land-khatian/admin/import'))
      .send({ division_bbs: '30', district_bbs: '26', upazila_bbs: '48', survey_id: '2' }).expect(200);
    expect(r.body.batch).toMatchObject({ mouzasFailed: 1, mouzasCompleted: 1 });
    expect(r.body.failedMouzas).toHaveLength(1);
    expect(r.body.batchStatus).toBe('partial');
  });
});

describe('coverage endpoints', () => {
  const indexRows = [
    { division_bbs: '30', district_bbs: '26', upazila_bbs: '48', district_name: 'Dhaka', upazila_name: 'Test', mouza_id: '11', mouza_name: 'M1', jl_number: '1', jl_id: '1000', survey_key: 'RS', survey_name: 'RS', record_count: 10, expected_count: 10, collected_count: 10, status: 'complete', issues: [], first_collected_at: null, last_collected_at: '2026-11-02T00:00:00.000Z' },
    { division_bbs: '30', district_bbs: '26', upazila_bbs: '48', district_name: 'Dhaka', upazila_name: 'Test', mouza_id: '22', mouza_name: 'M2', jl_number: '2', jl_id: '1001', survey_key: 'RS', survey_name: 'RS', record_count: 7, expected_count: 10, collected_count: 7, status: 'partial', issues: [{ khatianNo: '5', reason: 'LAND_API_ERROR' }], first_collected_at: null, last_collected_at: '2026-11-02T00:00:00.000Z' },
  ];
  function coveragePortal(totalMouzas) {
    client.surveys.mockResolvedValue([{ ID: 2, KEY: 'RS', NAME: 'RS' }]);
    client.upazilaSurveys.mockResolvedValue([{ SURVEY_ID: 2, LOCAL_NAME: 'RS' }]);
    client.jlNumbers.mockResolvedValue(Array.from({ length: totalMouzas }, (_, i) => ({ ID: 2000 + i, MOUZA_ID: 300 + i, MOUZA_NAME: 'M' + i, JL_NUMBER: String(i + 1) })));
    client.upazilas.mockResolvedValue([]);
  }

  test('admin coverage: complete/partial/not-started + percent complete (partial NEVER counted complete) + open units', async () => {
    coveragePortal(3);
    db.__routeQuery(baseRoutes([
      ['FROM land_khatian_index WHERE', { rows: indexRows }],
    ]));
    const r = await withAdmin(request(app()).get('/api/land-khatian/admin/coverage?district_bbs=26&upazila_bbs=48')).expect(200);
    expect(r.body.rows).toHaveLength(2);
    expect(r.body.rows[0]).toMatchObject({ status: 'complete', expectedCount: 10, collectedCount: 10 });
    expect(r.body.coverage.upazila).toMatchObject({ totalUnits: 3, completeUnits: 1, partialUnits: 1, notStartedUnits: 1, percentComplete: 33.3 });
    expect(r.body.coverage.upazila.openUnits).toHaveLength(1);
    expect(r.body.coverage.upazila.openUnits[0]).toMatchObject({ expectedCount: 10, collectedCount: 7 });
    expect(r.body.launchGateNote).toContain('১০০%');
  });

  test('admin coverage with portal unreachable: counts only, percent unavailable, never invented', async () => {
    client.surveys.mockResolvedValue([{ ID: 2, KEY: 'RS', NAME: 'RS' }]);
    client.upazilaSurveys.mockResolvedValue([{ SURVEY_ID: 2, LOCAL_NAME: 'RS' }]);
    const e = new Error('portal down');
    e.code = 'LAND_UNREACHABLE';
    client.jlNumbers.mockRejectedValue(e);
    client.upazilas.mockResolvedValue([]);
    db.__routeQuery(baseRoutes([
      ['FROM land_khatian_index WHERE', { rows: indexRows }],
    ]));
    const r = await withAdmin(request(app()).get('/api/land-khatian/admin/coverage?district_bbs=26&upazila_bbs=48')).expect(200);
    expect(r.body.coverage.upazila).toMatchObject({ totalUnits: null, percentComplete: null, coverageAvailable: false, completeUnits: 1, partialUnits: 1 });
  });

  test('admin coverage requires admin → user gets 403', async () => {
    await withUser(request(app()).get('/api/land-khatian/admin/coverage?district_bbs=26')).expect(403);
  });

  test('public coverage (cheap, index only): any user may read; percent unavailable by design; NOT all-BD', async () => {
    db.__routeQuery(baseRoutes([
      ['GROUP BY district_bbs', { rows: [
        { district_bbs: '26', district_name: 'Dhaka', status: 'complete', units: '2', records: '50', last_collected_at: '2026-11-02T00:00:00.000Z' },
        { district_bbs: '26', district_name: 'Dhaka', status: 'partial', units: '1', records: '20', last_collected_at: '2026-11-02T00:00:00.000Z' },
      ] }],
    ]));
    const r = await withUser(request(app()).get('/api/land-khatian/coverage')).expect(200);
    expect(r.body.districts).toHaveLength(1);
    expect(r.body.districts[0]).toMatchObject({ districtBbs: '26', completeUnits: 2, partialUnits: 1, recordCount: 70 });
    expect(r.body).toMatchObject({ percentComplete: null, coverageAvailable: false, collectionPhase: true, isAllBd: false });
    expect(r.body.totalCompleteUnits).toBe(2);
    expect(r.body.totalPartialUnits).toBe(1);
  });

  test('public coverage scoped: full percent definition via portal walk', async () => {
    coveragePortal(4);
    db.__routeQuery(baseRoutes([
      ['FROM land_khatian_index WHERE', { rows: indexRows }],
    ]));
    const r = await withUser(request(app()).get('/api/land-khatian/coverage?district_bbs=26&upazila_bbs=48')).expect(200);
    expect(r.body.coverage).toMatchObject({ totalUnits: 4, completeUnits: 1, partialUnits: 1, notStartedUnits: 2, percentComplete: 25 });
    expect(r.body).toMatchObject({ collectionPhase: true, isAllBd: false });
  });
});
