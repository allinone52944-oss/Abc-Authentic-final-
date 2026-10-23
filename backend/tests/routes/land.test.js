// Route tests for backend/routes/land.js (DLRMS land services).
// The DLRMS client is mocked — no real portal calls, no real
// money. Money rules under test (same discipline as QR verify):
//   - charged ONLY when a record is found
//   - "not found" → 422, ৳0, no wallet movement
//   - insufficient balance blocks BEFORE any portal lookup
//   - an idempotency_key replay never looks up or charges twice
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/land-core/client', () => ({
  divisions: jest.fn(), districts: jest.fn(), upazilas: jest.fn(),
  surveys: jest.fn(), upazilaSurveys: jest.fn(), jlNumbers: jest.fn(),
  indexList: jest.fn(), indexByKhatianNo: jest.fn(), detail: jest.fn(),
  halSabek: jest.fn(),
  ownerMatches: (owners, name) => String(owners || '').includes(String(name || '').trim()),
  sumLand: (ds) => Math.round(ds.reduce((a, d) => a + (parseFloat(d.TOTAL_LAND) || 0), 0) * 10000) / 10000,
}));
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
const landRouter = require('../../routes/land');
const client = require('../../../engines/land-core/client');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/land', landRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

const AREA = {
  division_bbs: '30', district_bbs: '26', upazila_bbs: '48', mouza_id: '72400',
  division_name: 'ঢাকা', district_name: 'ঢাকা', upazila_name: 'মিরপুর রাজস্ব সার্কেল',
  mouza_name: 'মিরপুর', jl_no: '33',
};
const PRICES = { 'land-search': { id: 31, price: 20 }, 'land-scan': { id: 32, price: 50 }, 'land-verify': { id: 33, price: 100 } };

function baseRoutes(extra = []) {
  return [
    ...extra, // per-test overrides win over the defaults below
    ['status, data, documents FROM orders', { rows: [] }],
    ['FROM services WHERE', (t, p) => ({ rows: [PRICES[p[0]] || { id: 31, price: 20 }] })],
    ['FROM user_services WHERE', { rows: [] }],
    ['FROM users WHERE', { rows: [{ balance: 500 }] }],
    ['FROM service_credits', { rows: [] }],
    ['FROM transactions WHERE', { rows: [] }],
    ['wallet_apply', { rows: [{ balance: 480 }] }],
    ['INSERT INTO orders', { rows: [{ id: 'o1' }] }],
    ['SELECT documents FROM orders', { rows: [{ documents: '[]' }] }],
    ['UPDATE orders SET documents', { rows: [] }],
  ];
}

function portalFound() {
  client.surveys.mockResolvedValue([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
  client.upazilaSurveys.mockResolvedValue([{ SURVEY_ID: 2, LOCAL_NAME: 'আর এস' }]);
  client.jlNumbers.mockResolvedValue([{ ID: 238686, MOUZA_ID: 72400, MOUZA_NAME: 'মিরপুর', JL_NUMBER: '33' }]);
  client.indexByKhatianNo.mockResolvedValue([{ ID: 900, KHATIAN_NO: '8', OWNERS: 'আকবর আলী' }]);
  client.detail.mockResolvedValue({
    ID: 900, KHATIAN_NO: '8', OWNERS: 'আকবর আলী', DAGS: '1237', TOTAL_LAND: '0.0544',
  });
}

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
  db.__routeQuery(baseRoutes());
});

describe('GET /api/land/price', () => {
  test('requires auth → 401', async () => {
    await request(app()).get('/api/land/price?mode=scan').expect(401);
  });
  test('scan price + balance → 200', async () => {
    const r = await withUser(request(app()).get('/api/land/price?mode=scan')).expect(200);
    expect(r.body).toMatchObject({ ok: true, mode: 'scan', price: 50, balance: 500, serviceId: 32 });
  });
});

describe('GET /api/land/geo/divisions', () => {
  test('maps BBS codes + names', async () => {
    client.divisions.mockResolvedValue([{ BBS_CODE: '30', NAME: 'ঢাকা' }]);
    const r = await withUser(request(app()).get('/api/land/geo/divisions')).expect(200);
    expect(r.body.items).toEqual([{ bbs: '30', name: 'ঢাকা' }]);
  });
});

describe('POST /api/land/search', () => {
  test('found → 200, charged 20, record returned', async () => {
    portalFound();
    const r = await withUser(request(app()).post('/api/land/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 't-search-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 20, orderId: 'o1' });
    expect(r.body.records).toHaveLength(1);
    expect(r.body.records[0]).toMatchObject({ KHATIAN_NO: '8', OWNERS: 'আকবর আলী', DAGS: '1237' });
  });

  test('not found → 422 NOT_FOUND, charged 0, wallet untouched', async () => {
    portalFound();
    client.indexByKhatianNo.mockResolvedValue([]);
    const r = await withUser(request(app()).post('/api/land/search'))
      .send({ ...AREA, khatian_no: '999', idempotency_key: 't-search-2' }).expect(422);
    expect(r.body).toMatchObject({ error: 'NOT_FOUND', charged: 0 });
    const walletCalls = db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
    expect(walletCalls).toHaveLength(0);
  });

  test('insufficient balance → 402 BEFORE any portal lookup', async () => {
    db.__routeQuery(baseRoutes([['FROM users WHERE', { rows: [{ balance: 5 }] }]]));
    portalFound();
    const r = await withUser(request(app()).post('/api/land/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 't-search-3' }).expect(402);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(client.indexByKhatianNo).not.toHaveBeenCalled();
  });

  test('Bengali-digit khatian number is normalised before the portal lookup', async () => {
    portalFound();
    const r = await withUser(request(app()).post('/api/land/search'))
      .send({ ...AREA, khatian_no: '৮', idempotency_key: 't-search-bn' }).expect(200);
    expect(r.body.ok).toBe(true);
    expect(client.indexByKhatianNo).toHaveBeenCalledWith('RS', 238686, '8');
  });

  test('bad area → 400', async () => {
    const r = await withUser(request(app()).post('/api/land/search'))
      .send({ khatian_no: '8' }).expect(400);
    expect(r.body.error).toBe('BAD_INPUT');
  });

  test('replay of a completed key → stored outcome, no new lookup', async () => {
    db.__routeQuery(baseRoutes([
      ['status, data, documents FROM orders', {
        rows: [{ id: 'o9', price: 20, status: 'completed', data: JSON.stringify({ records: [{ KHATIAN_NO: '8' }] }), documents: '[]' }],
      }],
    ]));
    portalFound();
    const r = await withUser(request(app()).post('/api/land/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 't-search-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: true, charged: 20, orderId: 'o9' });
    expect(client.indexByKhatianNo).not.toHaveBeenCalled();
  });
});

describe('POST /api/land/scan', () => {
  test('name matches → details + total land, charged 50', async () => {
    portalFound();
    client.indexList.mockResolvedValue([
      { ID: 900, KHATIAN_NO: '8', OWNERS: 'আকবর আলী' },
      { ID: 901, KHATIAN_NO: '9', OWNERS: 'অন্য কেউ' },
      { ID: 902, KHATIAN_NO: '10', OWNERS: 'আকবর আলী গং' },
    ]);
    client.detail.mockImplementation(async (key, id) => ({
      ID: id, KHATIAN_NO: id === 900 ? '8' : '10', OWNERS: 'আকবর আলী', DAGS: '1237', TOTAL_LAND: id === 900 ? '0.0544' : '0.1000',
    }));
    const r = await withUser(request(app()).post('/api/land/scan'))
      .send({ ...AREA, owner_name: 'আকবর আলী', idempotency_key: 't-scan-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 50 });
    expect(r.body.records).toHaveLength(2);
    expect(r.body.totalLand).toBeCloseTo(0.1544, 4);
  });

  test('no name match → 422, charged 0', async () => {
    portalFound();
    client.indexList.mockResolvedValue([{ ID: 901, KHATIAN_NO: '9', OWNERS: 'অন্য কেউ' }]);
    const r = await withUser(request(app()).post('/api/land/scan'))
      .send({ ...AREA, owner_name: 'আকবর আলী', idempotency_key: 't-scan-2' }).expect(422);
    expect(r.body).toMatchObject({ error: 'NOT_FOUND', charged: 0 });
  });
});

describe('POST /api/land/verify', () => {
  test('claim vs record verdicts, charged 100', async () => {
    portalFound();
    const r = await withUser(request(app()).post('/api/land/verify'))
      .send({ ...AREA, khatian_no: '8', claim: { owner: 'আকবর আলী', dag: '1237', total_land: '0.0544' }, idempotency_key: 't-verify-1' })
      .expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 100 });
    expect(r.body.verdicts).toHaveLength(3);
    expect(r.body.verdicts.every((v) => v.match)).toBe(true);
  });

  test('Bengali-digit claims are normalised (dag + land match)', async () => {
    portalFound();
    const r = await withUser(request(app()).post('/api/land/verify'))
      .send({ ...AREA, khatian_no: '৮', claim: { dag: '১২৩৭', total_land: '০.০৫৪৪' }, idempotency_key: 't-verify-bn' })
      .expect(200);
    expect(r.body.verdicts).toHaveLength(2);
    expect(r.body.verdicts.every((v) => v.match)).toBe(true);
  });

  test('mismatched land claim → verdict match=false but still a delivered report', async () => {
    portalFound();
    const r = await withUser(request(app()).post('/api/land/verify'))
      .send({ ...AREA, khatian_no: '8', claim: { total_land: '9.99' }, idempotency_key: 't-verify-2' })
      .expect(200);
    expect(r.body.verdicts[0].match).toBe(false);
  });

  test('no claim at all → full record report, no verdicts (owner, 2026-10-23)', async () => {
    portalFound();
    const r = await withUser(request(app()).post('/api/land/verify'))
      .send({ ...AREA, khatian_no: '8', claim: {}, idempotency_key: 't-verify-noclaim' })
      .expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 100 });
    expect(r.body.verdicts).toHaveLength(0);
    expect(r.body.records).toHaveLength(1);
  });

  test('no khatian number → 400', async () => {
    const r = await withUser(request(app()).post('/api/land/verify'))
      .send({ ...AREA, claim: {} }).expect(400);
    expect(r.body.error).toBe('BAD_INPUT');
  });
});
