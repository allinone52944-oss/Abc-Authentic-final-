// Route tests for backend/routes/land-khatian.js (SPEC
// Phase 1: login-free khatian search + summary).
// The DLRMS client is mocked — no real portal calls, no
// real money. Money rules under test (same discipline as
// land.js / QR verify):
//   - charged ONLY when >= 1 record is found
//   - "not found" → 422, ৳0, no wallet movement (but a ৳0
//     failed order + receipt, exactly like land.js)
//   - insufficient balance blocks BEFORE any portal lookup
//   - an idempotency_key replay never looks up or charges twice
//   - portal failure → 502, no charge, no order
//   - delivery exists ONLY on the completed order's
//     documents (History mechanism, like land.js) — there is
//     no standalone PDF endpoint to bypass the charge with.
// Price 30 below is a TEST FIXTURE ONLY, not a decided
// service price (the migration deliberately sets price 0;
// Pankaj sets the price in Admin → Services).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/land-core/client', () => ({
  divisions: jest.fn(), districts: jest.fn(), upazilas: jest.fn(),
  surveys: jest.fn(), upazilaSurveys: jest.fn(), jlNumbers: jest.fn(),
  indexList: jest.fn(), indexByKhatianNo: jest.fn(), detail: jest.fn(),
  halSabek: jest.fn(),
  ownerMatches: (owners, name) => String(owners || '').includes(String(name || '').trim()),
  sumLand: (ds) => Math.round(ds.reduce((a, d) => a + (parseFloat(d.TOTAL_LAND) || 0), 0) * 10000) / 10000,
}));
// Live-only (2026-11-04 pivot): the route no longer imports
// the collection store at all, so "portal failure → 502"
// holds unconditionally — no store mock is needed here.
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
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

const AREA = {
  division_bbs: '30', district_bbs: '26', upazila_bbs: '48', mouza_id: '72400',
  division_name: 'ঢাকা', district_name: 'ঢাকা', upazila_name: 'মিরপুর রাজস্ব সার্কেল',
  mouza_name: 'পরীক্ষা মৌজা', jl_no: '33',
};

function baseRoutes(extra = []) {
  return [
    ...extra, // per-test overrides win over the defaults below
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
  client.surveys.mockResolvedValue([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
  client.upazilaSurveys.mockResolvedValue([{ SURVEY_ID: 2, LOCAL_NAME: 'আর এস' }]);
  client.jlNumbers.mockResolvedValue([{ ID: 238686, MOUZA_ID: 72400, MOUZA_NAME: 'পরীক্ষা মৌজা', JL_NUMBER: '33' }]);
  client.indexByKhatianNo.mockResolvedValue([{ ID: 900, KHATIAN_NO: '8', OWNERS: 'পরীক্ষক এক' }]);
  client.detail.mockResolvedValue({
    ID: 900, KHATIAN_NO: '8', OWNERS: 'পরীক্ষক এক', DAGS: '1237', TOTAL_LAND: '0.0544',
  });
  client.halSabek.mockResolvedValue([]);
}

const walletCalls = () => db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
const orderInserts = () => db.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO orders'));

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
  db.__routeQuery(baseRoutes());
});

describe('GET /api/land-khatian/price', () => {
  test('requires auth → 401', async () => {
    await request(app()).get('/api/land-khatian/price').expect(401);
  });
  test('price + balance → 200 (land.js shape)', async () => {
    const r = await withUser(request(app()).get('/api/land-khatian/price')).expect(200);
    expect(r.body).toMatchObject({ ok: true, engineId: 'land-khatian', price: 30, balance: 500, serviceId: 41, allowed: true });
  });
  test('per-user override price wins', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM user_services WHERE', { rows: [{ custom_price: 15, access_enabled: true }] }],
    ]));
    const r = await withUser(request(app()).get('/api/land-khatian/price')).expect(200);
    expect(r.body.price).toBe(15);
  });
  test('access disabled → allowed false (search then 403s)', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM user_services WHERE', { rows: [{ custom_price: null, access_enabled: false }] }],
    ]));
    const r = await withUser(request(app()).get('/api/land-khatian/price')).expect(200);
    expect(r.body.allowed).toBe(false);
  });
});

describe('POST /api/land-khatian/search', () => {
  test('found → 200, charged 30, order + History receipt', async () => {
    portalFound();
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 't-kh-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 30, orderId: 'o1' });
    expect(r.body.records).toHaveLength(1);
    expect(r.body.records[0]).toMatchObject({ khatianNo: '8', owners: 'পরীক্ষক এক', dags: '1237' });
    expect(r.body.receipt).toBe('/api/orders/o1/documents/delivery-land-khatian-t-kh-1.pdf');
    expect(walletCalls()).toHaveLength(1);
    // Delivery is stored on the order (History mechanism) —
    // the documents UPDATE is what makes it downloadable.
    expect(db.query.mock.calls.some((c) => String(c[0]).includes('UPDATE orders SET documents'))).toBe(true);
  });

  test('Bengali digits normalized: ৮ → portal sees 8', async () => {
    portalFound();
    await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '৮', idempotency_key: 't-kh-bn' }).expect(200);
    expect(client.indexByKhatianNo).toHaveBeenCalledWith('RS', 238686, '8');
  });

  test('not found → 422 NOT_FOUND, charged 0, wallet untouched, ৳0 failed order', async () => {
    portalFound();
    client.indexByKhatianNo.mockResolvedValue([]);
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '999', idempotency_key: 't-kh-2' }).expect(422);
    expect(r.body).toMatchObject({ error: 'NOT_FOUND', charged: 0 });
    expect(walletCalls()).toHaveLength(0);
    const failed = orderInserts().filter((c) => c[1] && c[1].includes('failed'));
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toContain(0); // price 0
  });

  test('idempotency replay → stored outcome, no second lookup or charge', async () => {
    db.__routeQuery(baseRoutes([
      ['status, data, documents FROM orders', { rows: [{
        id: 'o1', price: 30, status: 'completed',
        data: JSON.stringify({ records: [{ khatianNo: '8' }], totalLand: '0.0544' }),
        documents: JSON.stringify([{ type: 'delivery', filename: 'delivery-land-khatian-t-kh-1.pdf' }]),
      }] }],
    ]));
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 't-kh-1' }).expect(200);
    expect(r.body).toMatchObject({ duplicate: true, charged: 30, orderId: 'o1' });
    expect(r.body.receipt).toBe('/api/orders/o1/documents/delivery-land-khatian-t-kh-1.pdf');
    expect(client.indexByKhatianNo).not.toHaveBeenCalled();
    expect(walletCalls()).toHaveLength(0);
  });

  test('failed replay → 422 duplicate, still no charge', async () => {
    db.__routeQuery(baseRoutes([
      ['status, data, documents FROM orders', { rows: [{
        id: 'o9', price: 0, status: 'failed', data: JSON.stringify({ found: false }),
        documents: JSON.stringify([{ type: 'delivery', filename: 'delivery-land-khatian-failed-t-kh-9.pdf' }]),
      }] }],
    ]));
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '999', idempotency_key: 't-kh-9' }).expect(422);
    expect(r.body).toMatchObject({ error: 'NOT_FOUND', duplicate: true, charged: 0 });
    expect(walletCalls()).toHaveLength(0);
  });

  test('insufficient balance → 402, no portal call, no order', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM users WHERE', { rows: [{ balance: 10 }] }],
    ]));
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 't-kh-402' }).expect(402);
    expect(r.body).toMatchObject({ error: 'INSUFFICIENT_BALANCE' });
    expect(client.indexByKhatianNo).not.toHaveBeenCalled();
    expect(orderInserts()).toHaveLength(0);
  });

  test('access disabled → 403, no portal call', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM user_services WHERE', { rows: [{ custom_price: null, access_enabled: false }] }],
    ]));
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 't-kh-403' }).expect(403);
    expect(r.body).toMatchObject({ error: 'SERVICE_ACCESS_DISABLED' });
    expect(client.indexByKhatianNo).not.toHaveBeenCalled();
  });

  test('per-user override charged, not the table price', async () => {
    portalFound();
    db.__routeQuery(baseRoutes([
      ['FROM user_services WHERE', { rows: [{ custom_price: 15, access_enabled: true }] }],
    ]));
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 't-kh-ovr' }).expect(200);
    expect(r.body.charged).toBe(15);
  });

  test('portal failure → 502 LAND_UNREACHABLE, no charge, no order', async () => {
    portalFound();
    const e = new Error('LAND_UNREACHABLE: boom');
    e.code = 'LAND_UNREACHABLE';
    client.indexByKhatianNo.mockRejectedValue(e);
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 't-kh-502' }).expect(502);
    expect(r.body).toMatchObject({ error: 'LAND_UNREACHABLE' });
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });

  test('BAD_INPUT: no search criterion → 400, no portal call', async () => {
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, idempotency_key: 't-kh-bad' }).expect(400);
    expect(r.body).toMatchObject({ error: 'BAD_INPUT' });
    expect(client.indexByKhatianNo).not.toHaveBeenCalled();
    expect(client.indexList).not.toHaveBeenCalled();
  });

  test('BAD_INPUT: non-digit area → 400', async () => {
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, district_bbs: 'xx', khatian_no: '8', idempotency_key: 't-kh-bad2' }).expect(400);
    expect(r.body).toMatchObject({ error: 'BAD_INPUT' });
  });

  test('owner-name search via adapter, no khatian number needed', async () => {
    portalFound();
    client.indexList.mockResolvedValue([
      { ID: 1, KHATIAN_NO: '1', OWNERS: 'পরীক্ষক এক' },
      { ID: 2, KHATIAN_NO: '2', OWNERS: 'পরীক্ষক দুই' },
    ]);
    client.detail.mockImplementation(async (key, id) => ({
      ID: id, KHATIAN_NO: String(id), OWNERS: id === 1 ? 'পরীক্ষক এক' : 'পরীক্ষক দুই',
      DAGS: '10', TOTAL_LAND: '0.5',
    }));
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, owner_name: 'পরীক্ষক এক', idempotency_key: 't-kh-own' }).expect(200);
    expect(r.body.records).toHaveLength(1);
    expect(r.body.records[0]).toMatchObject({ khatianNo: '1' });
  });
});
