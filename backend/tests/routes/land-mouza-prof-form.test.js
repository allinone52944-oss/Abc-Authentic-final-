// Mouza professional single-flow redesign (mouza mode only).
// Route tests for the area-less POST /mouza + the header-area
// derivation, and unit tests for the PDF header-mouza helper.
// The old form asked mouza 3 times and headed the report from
// the top cascade while lines carried their own mouza — the
// new form sends office + lines only, and the header mouza
// must always equal the line mouzas. No portal, no real money
// — mocked DB like land-mouza-lookup.test.js. Calc rules and
// rates data are UNCHANGED (dual convention still applies).
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
const { headerMouzaFor } = require('../../lib/landReportPdf');

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

const walletCalls = () =>
  db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));

describe('deriveMouzaReportArea (route helper)', () => {
  const derive = landRouter.deriveMouzaReportArea;
  test('area-less + Boalkhali office + two line mouzas → geo from office, mouza joined from lines', () => {
    const a = derive({ office: 'boalkhali' }, [{ mouza: 'কধুরখীল' }, { mouza: 'শাকপুরা' }]);
    expect(a).toMatchObject({
      division: 'চট্টগ্রাম', district: 'চট্টগ্রাম', upazila: 'বোয়ালখালী',
      mouza: 'কধুরখীল, শাকপুরা', officeName: 'বোয়ালখালী',
    });
  });
  test('old full cascade + different line mouza → geo/JL kept, mouza still from the lines', () => {
    const a = derive({ ...AREA }, [{ mouza: 'কধুরখীল' }]);
    expect(a).toMatchObject({
      division: 'ঢাকা', district: 'ঢাকা', upazila: 'মিরপুর রাজস্ব সার্কেল',
      mouza: 'কধুরখীল', jl: '33',
    });
  });
  test('duplicate line mouzas appear once in the header', () => {
    const a = derive({ office: 'boalkhali' }, [{ mouza: 'কধুরখীল' }, { mouza: 'কধুরখীল' }]);
    expect(a.mouza).toBe('কধুরখীল');
  });
  test('unknown office → geo empty but the report still derives from the lines', () => {
    const a = derive({ office: 'no-office' }, [{ mouza: 'শাকপুরা' }]);
    expect(a).toMatchObject({ division: '', district: '', upazila: '', mouza: 'শাকপুরা', officeName: '' });
  });
  test('old free-text office_name is kept when no office id is sent', () => {
    const a = derive({ ...AREA, office_name: 'সদর সাব-রেজিস্ট্রি অফিস' }, [{ mouza: 'মিরপুর' }]);
    expect(a.officeName).toBe('সদর সাব-রেজিস্ট্রি অফিস');
  });
});

describe('headerMouzaFor (PDF helper)', () => {
  test('mouza kind + lines → joined distinct line mouzas, ignoring a stale cascade mouza', () => {
    expect(headerMouzaFor('mouza', { mouza: 'শাকপুরা' },
      [{ mouza: 'কধুরখীল' }, { mouza: 'শাকপুরা' }, { mouza: 'কধুরখীল' }]))
      .toBe('কধুরখীল, শাকপুরা');
  });
  test('mouza kind + no lines → cascade mouza fallback', () => {
    expect(headerMouzaFor('mouza', { mouza: 'শাকপুরা' }, [])).toBe('শাকপুরা');
  });
  test('other kinds ignore the lines and keep the cascade mouza', () => {
    expect(headerMouzaFor('search', { mouza: 'মিরপুর' }, [{ mouza: 'কধুরখীল' }])).toBe('মিরপুর');
  });
});

describe('POST /api/land/mouza without the area cascade (new form)', () => {
  test('manual Shakpura line, per-unit rule: 400000/gonda × 2.5 gonda = 1000000', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza'))
      .send({
        office: 'boalkhali', schedule_version: '2025-2026', declared_price: '',
        lines: [{ mouza: 'শাকপুরা', class: 'নাল', rate: '400000', amount: '2.5', unit: 'gonda', source: 'manual' }],
        idempotency_key: 't-prof-manual-1',
      }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 1000000, deedBasis: 1000000, charged: 30 });
    expect(r.body.lines[0]).toMatchObject({ mouza: 'শাকপুরা', source: 'manual', value: 1000000 });
  });
  test('valid lookup line without cascade → 200, period stamped, schedule rule (121421 × 5)', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza'))
      .send({
        office: 'boalkhali', schedule_version: '2025-2026', declared_price: '',
        lines: [{ mouza: 'কধুরখীল', class: 'নাল', rate: '121421', amount: '2.5', unit: 'gonda', source: 'lookup', lookupOffice: 'boalkhali' }],
        idempotency_key: 't-prof-lookup-1',
      }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 607105 });
    expect(r.body.lines[0]).toMatchObject({ source: 'lookup', lookupPeriod: '2025-2026', value: 607105 });
  });
  test('old-style body.lookup_office still verifies a lookup line (old client compat)', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza'))
      .send({
        office: 'boalkhali', lookup_office: 'boalkhali', schedule_version: '2025-2026', declared_price: '',
        lines: [{ mouza: 'কধুরখীল', class: 'নাল', rate: '121421', amount: '1', unit: 'shatangsho', source: 'lookup' }],
        idempotency_key: 't-prof-lookup-old',
      }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 121421 });
  });
  test('tampered lookup rate, area-less → 400, wallet untouched, no charge', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza'))
      .send({
        office: 'boalkhali', schedule_version: '2025-2026', declared_price: '',
        lines: [{ mouza: 'কধুরখীল', class: 'নাল', rate: '121422', amount: '2.5', unit: 'gonda', source: 'lookup', lookupOffice: 'boalkhali' }],
        idempotency_key: 't-prof-tamper',
      }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
    expect(walletCalls()).toHaveLength(0);
  });
  test('multi-mouza lines (lookup + manual) sum under their own rules', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza'))
      .send({
        office: 'boalkhali', schedule_version: '2025-2026', declared_price: '',
        lines: [
          { mouza: 'কধুরখীল', class: 'নাল', rate: '121421', amount: '2.5', unit: 'gonda', source: 'lookup', lookupOffice: 'boalkhali' },
          { mouza: 'শাকপুরা', class: 'নাল', rate: '100000', amount: '10', unit: 'katha', source: 'manual' },
        ],
        idempotency_key: 't-prof-multi',
      }).expect(200);
    // lookup: 121421 × 5 = 607105; manual: 100000 × 10 = 1000000
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 1607105 });
  });
  test('no lines, area-less → 400, wallet untouched', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza'))
      .send({ office: 'boalkhali', lines: [], idempotency_key: 't-prof-empty' })
      .expect(400);
    expect(r.body.error).toBe('BAD_INPUT');
    expect(walletCalls()).toHaveLength(0);
  });
});

describe('POST /api/land/mouza backward compat (old full-cascade client)', () => {
  const LINES = [{ mouza: 'কধুরখীল', class: 'নাল', rate: '121421', amount: '2.5', unit: 'gonda', source: 'lookup', lookupOffice: 'boalkhali' }];
  test('old full-area payload accepted with identical totals to the area-less one', async () => {
    const oldRes = await withUser(request(app()).post('/api/land/mouza'))
      .send({ ...AREA, office_name: 'বোয়ালখালী সাব-রেজিস্ট্রি অফিস', schedule_version: '2025-2026', declared_price: '', lookup_office: 'boalkhali', lines: LINES, idempotency_key: 't-prof-old-1' })
      .expect(200);
    const newRes = await withUser(request(app()).post('/api/land/mouza'))
      .send({ office: 'boalkhali', schedule_version: '2025-2026', declared_price: '', lines: LINES, idempotency_key: 't-prof-new-1' })
      .expect(200);
    expect(oldRes.body.totalMinimum).toBe(newRes.body.totalMinimum);
    expect(oldRes.body.deedBasis).toBe(newRes.body.deedBasis);
    expect(oldRes.body.totalMinimum).toBe(607105);
  });
  test('old client, line mouza left empty → still defaults to the cascade mouza', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza'))
      .send({ ...AREA, schedule_version: '2025-2026', declared_price: '', lines: [{ mouza: '', class: 'নাল', rate: '100000', amount: '10', unit: 'shatangsho', source: 'manual' }], idempotency_key: 't-prof-old-empty' })
      .expect(200);
    expect(r.body.lines[0].mouza).toBe('মিরপুর');
    expect(r.body.totalMinimum).toBe(1000000);
  });
});
