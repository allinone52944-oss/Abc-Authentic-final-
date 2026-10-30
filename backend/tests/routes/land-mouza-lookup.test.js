// Mouza schedule-rate lookup (PROOF: Boalkhali / কধুরখীল only).
// Unit tests for the data file + calc dual convention + route
// tests for GET /mouza-rate and lookup-line verification on
// POST /mouza. No portal, no real money — mocked DB like
// land.test.js. Rates below are the proof data, transcribed
// from the office schedule scan (per shatangsho).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/land-core/client', () => ({
  divisions: jest.fn(), districts: jest.fn(), upazilas: jest.fn(),
  surveys: jest.fn(), upazilaSurveys: jest.fn(), jlNumbers: jest.fn(),
  indexList: jest.fn(), indexByKhatianNo: jest.fn(), detail: jest.fn(),
  halSabek: jest.fn(),
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
const { lookupMouzaRate, listLookupClasses } = require('../../../engines/land-mouza-value/rates');
const { calcMouzaReport } = require('../../../engines/land-mouza-value/calc');

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
const PRICES = { 'land-mouza-value': { id: 34, price: 30 } };

function baseRoutes(extra = []) {
  return [
    ...extra,
    ['status, data, documents FROM orders', { rows: [] }],
    ['FROM services WHERE', (t, p) => ({ rows: [PRICES[p[0]] || { id: 31, price: 20 }] })],
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

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
  db.__routeQuery(baseRoutes());
});

describe('lookupMouzaRate (data file)', () => {
  test('found rate: কধুরখীল নাল = 121421 per shatangsho, period 2025-2026', () => {
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'নাল')).toMatchObject({
      rate: 121421, period: '2025-2026', p: false,
    });
  });
  test('P-flag rate: কধুরখীল ডোবা = 100000 with p:true', () => {
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'ডোবা')).toMatchObject({
      rate: 100000, period: '2025-2026', p: true,
    });
  });
  test('all six lookup classes present, বাণিজ্যিক absent', () => {
    expect(listLookupClasses('boalkhali', 'কধুরখীল').sort()).toEqual(
      ['নাল', 'বাগান', 'বাড়ী', 'ভিটা', 'পুকুর', 'ডোবা'].sort());
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'বাণিজ্যিক')).toBeNull();
  });
  test('no-rate: unknown mouza, unknown office, unmapped column', () => {
    expect(lookupMouzaRate('boalkhali', 'অজানা মৌজা', 'নাল')).toBeNull();
    expect(lookupMouzaRate('no-office', 'কধুরখীল', 'নাল')).toBeNull();
    // দোকান is stored as an unmapped column — never a lookup rate,
    // and never mapped to বাণিজ্যিক.
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'দোকান')).toBeNull();
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'খাল')).toBeNull();
  });
});

describe('calc dual convention', () => {
  test('lookup line: schedule rate × shatangsho qty (2.5 gonda নাল = 5 × 121421)', () => {
    const r = calcMouzaReport({
      lines: [{ mouza: 'কধুরখীল', class: 'নাল', rate: 121421, amount: 2.5, unit: 'gonda', source: 'lookup' }],
    });
    expect(r.lines[0]).toMatchObject({ source: 'lookup', qtyShatangsho: 5, value: 607105 });
    expect(r.totalMinimum).toBe(607105);
  });
  test('lookup P line keeps the P rate as the applicable rate', () => {
    const r = calcMouzaReport({
      lines: [{ mouza: 'কধুরখীল', class: 'ডোবা', rate: 100000, amount: 10, unit: 'shatangsho', source: 'lookup' }],
    });
    expect(r.lines[0].value).toBe(1000000);
  });
  test('mixed lookup + manual lines use their own rule each', () => {
    const r = calcMouzaReport({
      lines: [
        { mouza: 'কধুরখীল', class: 'নাল', rate: 121421, amount: 2.5, unit: 'gonda', source: 'lookup' },
        { mouza: 'নমুনা মৌজা', class: 'নাল', rate: 100000, amount: 10, unit: 'katha', source: 'manual' },
      ],
    });
    expect(r.lines[0].value).toBe(607105); // lookup: 121421 × 5
    expect(r.lines[1].value).toBe(1000000); // manual: 100000 × 10
    expect(r.totalMinimum).toBe(1607105);
  });
  test('lookup oldRate is per shatangsho like the lookup rate', () => {
    const r = calcMouzaReport({
      lines: [{ mouza: 'কধুরখীল', class: 'নাল', rate: 121421, amount: 2.5, unit: 'gonda', source: 'lookup', oldRate: 100000 }],
    });
    expect(r.lines[0].oldValue).toBe(500000); // 100000 × 5, not × 2.5
  });
});

describe('GET /api/land/mouza-rate', () => {
  test('requires auth → 401', async () => {
    await request(app()).get('/api/land/mouza-rate?office=boalkhali&mouza=কধুরখীল&class=নাল').expect(401);
  });
  test('found → rate + period + p flag', async () => {
    const r = await withUser(request(app()).get('/api/land/mouza-rate?office=boalkhali&mouza=কধুরখীল&class=ডোবা')).expect(200);
    expect(r.body).toMatchObject({ ok: true, found: true, rate: 100000, period: '2025-2026', p: true });
  });
  test('no-rate → 200 found:false with a Bengali message (no error, no charge)', async () => {
    const r = await withUser(request(app()).get('/api/land/mouza-rate?office=boalkhali&mouza=কধুরখীল&class=বাণিজ্যিক')).expect(200);
    expect(r.body.found).toBe(false);
    expect(r.body.message).toMatch('পাওয়া যায়নি');
  });
  test('missing param → 400', async () => {
    await withUser(request(app()).get('/api/land/mouza-rate?office=boalkhali&mouza=কধুরখীল')).expect(400);
  });
});

describe('POST /api/land/mouza with lookup lines', () => {
  const BODY = {
    ...AREA,
    office_name: 'বোয়ালখালী সাব-রেজিস্ট্রি অফিস',
    schedule_version: '2025-2026',
    declared_price: '',
    lookup_office: 'boalkhali',
  };
  test('valid lookup line → 200, value = rate × shatangsho qty, source + period stamped', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza'))
      .send({
        ...BODY,
        lines: [{ mouza: 'কধুরখীল', class: 'নাল', rate: '121421', amount: '2.5', unit: 'gonda', source: 'lookup' }],
        idempotency_key: 't-lookup-1',
      }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 607105, deedBasis: 607105 });
    expect(r.body.lines[0]).toMatchObject({ source: 'lookup', lookupPeriod: '2025-2026', value: 607105 });
  });
  test('tampered lookup rate → 400, wallet untouched, no charge', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza'))
      .send({
        ...BODY,
        lines: [{ mouza: 'কধুরখীল', class: 'নাল', rate: '121422', amount: '2.5', unit: 'gonda', source: 'lookup' }],
        idempotency_key: 't-lookup-tamper',
      }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
    const walletCalls = db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
    expect(walletCalls).toHaveLength(0);
  });
  test('lookup line with unknown office → 400', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza'))
      .send({
        ...BODY, lookup_office: 'no-office',
        lines: [{ mouza: 'কধুরখীল', class: 'নাল', rate: '121421', amount: '1', unit: 'shatangsho', source: 'lookup' }],
        idempotency_key: 't-lookup-office',
      }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
  });
  test('lookup line with unmapped class (বাণিজ্যিক) → 400', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza'))
      .send({
        ...BODY,
        lines: [{ mouza: 'কধুরখীল', class: 'বাণিজ্যিক', rate: '100000', amount: '1', unit: 'shatangsho', source: 'lookup' }],
        idempotency_key: 't-lookup-class',
      }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
  });
});
