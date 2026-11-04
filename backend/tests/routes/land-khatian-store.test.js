// Route tests for the khatian LIVE-ONLY pivot (2026-11-04):
// backend/routes/land-khatian.js serves the live DLRMS
// portal and nothing else. The collection store, the batch
// import route, and both coverage routes are gone, so:
//   - live failure → plain 502, no charge, no order, and
//     NO storeEmpty field (no alternative data exists)
//   - /admin/import, /admin/coverage, /coverage → 404
// Portal + DB are mocked — no real portal calls, no real
// money. Synthetic data only.
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

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
  db.__routeQuery(baseRoutes());
});

describe('search: live-only, no alternative data', () => {
  test('live success charges once, source live, stale false', async () => {
    portalFound();
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 's-live-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 30, source: 'live', stale: false });
    expect(walletCalls()).toHaveLength(1);
  });

  test('live failure → plain 502, no storeEmpty, no charge, no order', async () => {
    portalFound();
    const e = new Error('LAND_UNREACHABLE: boom');
    e.code = 'LAND_UNREACHABLE';
    client.indexByKhatianNo.mockRejectedValue(e);
    const r = await withUser(request(app()).post('/api/land-khatian/search'))
      .send({ ...AREA, khatian_no: '8', idempotency_key: 's-down-1' }).expect(502);
    expect(r.body).toMatchObject({ error: 'LAND_UNREACHABLE' });
    expect(r.body.storeEmpty).toBeUndefined();
    expect(r.body.ok).toBeUndefined();
    expect(r.body.records).toBeUndefined();
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });
});

describe('collection machinery removed', () => {
  test('admin import route is gone → 404', async () => {
    const r = await withAdmin(request(app()).post('/api/land-khatian/admin/import'))
      .send({ division_bbs: 30, district_bbs: 26, upazila_bbs: 48, survey_id: '1' }).expect(404);
    expect(r.body).not.toHaveProperty('ok', true);
  });

  test('admin coverage route is gone → 404', async () => {
    await withAdmin(request(app()).get('/api/land-khatian/admin/coverage?district_bbs=26')).expect(404);
  });

  test('public coverage route is gone → 404', async () => {
    await withUser(request(app()).get('/api/land-khatian/coverage')).expect(404);
  });
});
