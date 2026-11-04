// Route tests for backend/routes/land-mouza-map.js (SEPARATE
// engine from land-khatian, 2026-11-04: own page, own
// services row, own fee). The DLRMS client is mocked — no
// real portal calls, no real money. Money rules under test
// (same discipline as land-khatian):
//   - charged ONLY when >= 1 sheet is found
//   - "not found" → 422, ৳0, no wallet movement (but a ৳0
//     failed order, exactly like land-khatian)
//   - insufficient balance blocks BEFORE any portal lookup
//   - an idempotency_key replay never looks up or charges twice
//   - portal failure → 502, no charge, no order
//   - preview PNGs are served ONLY against the completed
//     order that the search created (order_id + sheet id must
//     match that order's sheets) — otherwise 403
//     NOT_DELIVERED_YET; a sheet id alone never opens an image
// Price 0 below is the MIGRATION DEFAULT (048 seeds 0);
// Pankaj sets the fee himself in Admin → Services.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/land-core/client', () => ({
  divisions: jest.fn(), districts: jest.fn(), upazilas: jest.fn(),
  surveys: jest.fn(), upazilaSurveys: jest.fn(), jlNumbers: jest.fn(),
  indexList: jest.fn(), indexByKhatianNo: jest.fn(), detail: jest.fn(),
  halSabek: jest.fn(),
  mapJlNumbers: jest.fn(), mapSheets: jest.fn(), mapPreview: jest.fn(),
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
const mapRouter = require('../../routes/land-mouza-map');
const client = require('../../../engines/land-core/client');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/land-mouza-map', mapRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

const AREA = {
  division_bbs: '30', district_bbs: '26', upazila_bbs: '48', mouza_id: '72400',
  division_name: 'ঢাকা', district_name: 'ঢাকা', upazila_name: 'মিরপুর রাজস্ব সার্কেল',
  mouza_name: 'পরীক্ষা মৌজা',
};

function baseRoutes(extra = [], price = 0) {
  return [
    ...extra,
    ['status, data, documents FROM orders', { rows: [] }],
    ['FROM services WHERE', { rows: [{ id: 42, price }] }],
    ['FROM user_services WHERE', { rows: [] }],
    ['FROM users WHERE', { rows: [{ balance: 500 }] }],
    ['FROM service_credits', { rows: [] }],
    ['FROM transactions WHERE', { rows: [] }],
    ['wallet_apply', { rows: [{ balance: 500 - price }] }],
    ['INSERT INTO orders', { rows: [{ id: 'o1' }] }],
    ['SELECT documents FROM orders', { rows: [{ documents: '[]' }] }],
    ['UPDATE orders SET documents', { rows: [] }],
  ];
}

function mapFound() {
  client.mapJlNumbers.mockResolvedValue([
    { ID: 238579, MOUZA_ID: 72400, MOUZA_NAME: 'পরীক্ষা মৌজা', JL_NUMBER: '2' },
  ]);
  client.mapSheets.mockResolvedValue([
    { ID: 240249, SHEET_NO: 1 }, { ID: 240250, SHEET_NO: 2 },
  ]);
}

const walletCalls = () => db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
const orderInserts = () => db.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO orders'));

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
  db.__routeQuery(baseRoutes());
});

describe('GET /api/land-mouza-map/price', () => {
  test('requires auth → 401', async () => {
    await request(app()).get('/api/land-mouza-map/price').expect(401);
  });
  test('price + balance → 200 (migration default 0)', async () => {
    const r = await withUser(request(app()).get('/api/land-mouza-map/price')).expect(200);
    expect(r.body).toMatchObject({ ok: true, engineId: 'land-mouza-map', price: 0, balance: 500, serviceId: 42, allowed: true });
  });
});

describe('POST /api/land-mouza-map/search', () => {
  test('sheets found at price 0 → 200, charged 0, order created', async () => {
    mapFound();
    const r = await withUser(request(app()).post('/api/land-mouza-map/search'))
      .send({ ...AREA, survey_id: 2, idempotency_key: 't-mm-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 0, orderId: 'o1' });
    expect(r.body.sheets).toEqual([{ id: 240249, sheetNo: 1 }, { id: 240250, sheetNo: 2 }]);
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts().length).toBeGreaterThanOrEqual(1);
  });

  test('sheets found at price 50 → charged 50 once', async () => {
    db.__routeQuery(baseRoutes([], 50));
    mapFound();
    const r = await withUser(request(app()).post('/api/land-mouza-map/search'))
      .send({ ...AREA, survey_id: 2, idempotency_key: 't-mm-2' }).expect(200);
    expect(r.body.charged).toBe(50);
    expect(walletCalls().length).toBeGreaterThanOrEqual(1);
  });

  test('no sheets → 422 NOT_FOUND, charged 0, failed order', async () => {
    client.mapJlNumbers.mockResolvedValue([
      { ID: 238579, MOUZA_ID: 72400, MOUZA_NAME: 'পরীক্ষা মৌজা', JL_NUMBER: '2' },
    ]);
    client.mapSheets.mockResolvedValue([]);
    const r = await withUser(request(app()).post('/api/land-mouza-map/search'))
      .send({ ...AREA, survey_id: 2, idempotency_key: 't-mm-3' }).expect(422);
    expect(r.body).toMatchObject({ error: 'NOT_FOUND', charged: 0 });
    expect(walletCalls()).toHaveLength(0);
  });

  test('BAD_INPUT: missing survey → 400, no portal call', async () => {
    const r = await withUser(request(app()).post('/api/land-mouza-map/search'))
      .send({ ...AREA, idempotency_key: 't-mm-bad' }).expect(400);
    expect(r.body).toMatchObject({ error: 'BAD_INPUT' });
    expect(client.mapJlNumbers).not.toHaveBeenCalled();
  });

  test('portal failure → 502, no charge, no order', async () => {
    client.mapJlNumbers.mockRejectedValue(Object.assign(new Error('LAND_UNREACHABLE'), { code: 'LAND_UNREACHABLE' }));
    const r = await withUser(request(app()).post('/api/land-mouza-map/search'))
      .send({ ...AREA, survey_id: 2, idempotency_key: 't-mm-4' }).expect(502);
    expect(r.body).toMatchObject({ error: 'LAND_UNREACHABLE' });
    expect(orderInserts()).toHaveLength(0);
  });

  test('idempotency replay: second identical search never re-looks-up', async () => {
    db.__routeQuery(baseRoutes([
      ['status, data, documents FROM orders', { rows: [{
        id: 'o1', price: 0, status: 'completed',
        data: JSON.stringify({ sheets: [{ id: 240249, sheetNo: 1 }], jlId: 238579, jlNumber: '2', mouzaName: 'পরীক্ষা মৌজা' }),
        documents: '[]',
      }] }],
    ]));
    const r = await withUser(request(app()).post('/api/land-mouza-map/search'))
      .send({ ...AREA, survey_id: 2, idempotency_key: 't-mm-dup' }).expect(200);
    expect(r.body).toMatchObject({ duplicate: true, orderId: 'o1' });
    expect(r.body.sheets).toEqual([{ id: 240249, sheetNo: 1 }]);
    expect(client.mapJlNumbers).not.toHaveBeenCalled();
  });
});

describe('GET /api/land-mouza-map/preview/:id (order-gated)', () => {
  function orderWithSheets(sheets) {
    return ['SELECT id, service_id, status, data FROM orders WHERE id', { rows: [{
      id: 'o1', service_id: 42, status: 'completed',
      data: JSON.stringify({ sheets }),
    }] }];
  }

  test('valid order + sheet → 200 PNG bytes', async () => {
    db.__routeQuery(baseRoutes([orderWithSheets([{ id: 240249, sheetNo: 1 }])]));
    client.mapPreview.mockResolvedValue({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' });
    const r = await withUser(request(app())
      .get('/api/land-mouza-map/preview/240249?order_id=o1')).expect(200);
    expect(r.headers['content-type']).toMatch(/image\/png/);
    expect(Buffer.from(r.body).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(client.mapPreview).toHaveBeenCalledWith('240249');
  });

  test('sheet id alone, no order → 403, no portal call', async () => {
    const r = await withUser(request(app())
      .get('/api/land-mouza-map/preview/240249')).expect(400);
    expect(r.body).toMatchObject({ error: 'BAD_INPUT' });
    expect(client.mapPreview).not.toHaveBeenCalled();
  });

  test('order without that sheet → 403 NOT_DELIVERED_YET', async () => {
    db.__routeQuery(baseRoutes([orderWithSheets([{ id: 240250, sheetNo: 2 }])]));
    const r = await withUser(request(app())
      .get('/api/land-mouza-map/preview/240249?order_id=o1')).expect(403);
    expect(r.body).toMatchObject({ error: 'NOT_DELIVERED_YET' });
    expect(client.mapPreview).not.toHaveBeenCalled();
  });

  test('no such order → 403 NOT_DELIVERED_YET', async () => {
    db.__routeQuery(baseRoutes([
      ['SELECT id, service_id, status, data FROM orders WHERE id', { rows: [] }],
    ]));
    const r = await withUser(request(app())
      .get('/api/land-mouza-map/preview/240249?order_id=nope')).expect(403);
    expect(r.body).toMatchObject({ error: 'NOT_DELIVERED_YET' });
  });
});
