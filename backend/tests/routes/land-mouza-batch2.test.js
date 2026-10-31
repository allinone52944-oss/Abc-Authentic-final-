// Mouza batch 2 (Chattogram district remaining, 2025-2026): 11 office
// entries, 862 source rows, 857 entries, 4254 class-rates, machine-transcribed
// from rates-chattogram-batch2.md and verified 0-mismatch by
// /tmp/mouza-allbd-verify.js (6097 checks, kept out of the repo).
// Tests: data shape + totals + Sadar thana variants + JL/kromik suffix names
// + combined schedules + zero-rate cards + text-cell no-rates + POST /mouza
// verification of qualified and suffix lines. No portal, no real money —
// mocked DB like land-mouza-batch1.test.js.
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
const { OFFICES, lookupMouzaRate } = require('../../../engines/land-mouza-value/rates');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/land', landRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

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

const BATCH2 = ['adhunagar', 'banshkhali', 'ctg-sadar', 'mirsharai-jorarganj', 'anowara',
  'fatikchhari', 'hathazari-fateyabad', 'satkania', 'sitakunda', 'patiya', 'raozan'];
const rateQ = (office, mouza, cls, thana) => {
  const p = new URLSearchParams({ office, mouza, class: cls });
  if (thana) p.set('thana', thana);
  return `/api/land/mouza-rate?${p}`;
};
const cardQ = (office, mouza, thana) => {
  const p = new URLSearchParams({ office, mouza });
  if (thana) p.set('thana', thana);
  return `/api/land/mouza-rates?${p}`;
};

describe('batch 2 shape + totals', () => {
  test('11 new offices, all 2025-2026, 857 entries, 4254 class-rates', () => {
    let entries = 0, rates = 0;
    for (const key of BATCH2) {
      const o = OFFICES[key];
      expect(o).toBeTruthy();
      expect(o.period).toBe('2025-2026');
      for (const rec of Object.values(o.mouzas)) {
        entries++;
        const variants = Array.isArray(rec.variants) ? rec.variants : [rec];
        for (const v of variants) rates += Object.keys(v.rates).length;
      }
    }
    expect(entries).toBe(857);
    expect(rates).toBe(4254);
    // Was 17 at batch-2 time; batch 3 added 63 more (80 total).
    expect(Object.keys(OFFICES)).toHaveLength(80);
  });
  test('batch 1 offices untouched', () => {
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'নাল', null).rate).toBe(121421);
    expect(lookupMouzaRate('chandgaon', 'বাকলিয়া', 'নাল', 'বদর').rate).toBe(693896);
  });
});

describe('batch 2 sample lookups', () => {
  test('plain offices return printed rates', async () => {
    const cases = [
      ['adhunagar', 'আধুনগর', 'নাল', 109212],
      ['banshkhali', 'উত্তর জলদী (পৌর)', 'বাড়ী', 437905],
      ['anowara', 'আনোয়ারা', 'বাড়ী', 567213],
      ['anowara', 'বৈরাগ', 'ডোবা', 100000],
      ['fatikchhari', 'আজিম নগর', 'নাল', 119168],
      ['satkania', 'আজিমপুর', 'নাল', 93191],
      ['sitakunda', 'আমিনাবাদ (পৌর)', 'নাল', 273037],
      ['patiya', 'আশিয়া', 'নাল', 58786],
      ['raozan', 'পূর্ব বিছাম', 'নাল', 4555],
    ];
    for (const [office, mouza, cls, rate] of cases) {
      const r = await withUser(request(app()).get(rateQ(office, mouza, cls))).expect(200);
      expect(r.body).toMatchObject({ found: true, rate, period: '2025-2026' });
    }
  });
  test('Sadar thana variants: ambiguous without thana, exact with thana', async () => {
    const amb = await withUser(request(app()).get(rateQ('ctg-sadar', 'পূর্ব নাছিরাবাদ', 'নাল'))).expect(200);
    expect(amb.body.ambiguous).toBe(true);
    expect(amb.body.options).toEqual(expect.arrayContaining(['পাঁচলাইশ', 'খুলশী']));
    const q = await withUser(request(app()).get(rateQ('ctg-sadar', 'পূর্ব নাছিরাবাদ', 'নাল', 'খুলশী'))).expect(200);
    expect(q.body).toMatchObject({ found: true, rate: 322026, thana: 'খুলশী' });
  });
  test('JL/kromik suffix names resolve directly', async () => {
    const p = await withUser(request(app()).get(rateQ('patiya', 'কেশাগাঁও (JL 16)', 'নাল'))).expect(200);
    expect(p.body).toMatchObject({ found: true, rate: 106622 });
    const r = await withUser(request(app()).get(rateQ('raozan', 'আফজাল (JL 51)', 'নাল'))).expect(200);
    expect(r.body).toMatchObject({ found: true, rate: 55182 });
    const s = await withUser(request(app()).get(rateQ('sitakunda', 'লতিফপুর (ক্রম ৫৫)', 'নাল'))).expect(200);
    expect(s.body).toMatchObject({ found: true, rate: 454407 });
  });
  test('no-rate behaviour: banijjik nowhere, text cells never converted', async () => {
    for (const key of BATCH2) {
      const first = Object.keys(OFFICES[key].mouzas)[0];
      const b = await withUser(request(app()).get(rateQ(key, first, 'বাণিজ্যিক'))).expect(200);
      expect(b.body.found).toBe(false);
    }
    const d1 = await withUser(request(app()).get(rateQ('satkania', 'চিকবাড়ী', 'ডোবা'))).expect(200);
    expect(d1.body.found).toBe(false);
    const d2 = await withUser(request(app()).get(rateQ('satkania', 'চূড়ামণি', 'ডোবা'))).expect(200);
    expect(d2.body.found).toBe(false);
  });
  test('zero-rate rows yield an all-null card, not not-in-table', async () => {
    const c = await withUser(request(app()).get(cardQ('mirsharai-jorarganj', 'রামগড় সীতাকুণ্ড-করৈ'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    for (const cls of ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']) {
      expect(c.body.rates[cls].rate).toBeNull();
    }
  });
});

describe('POST /api/land/mouza: batch 2 lines', () => {
  test('Sadar qualified line → 200', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'ctg-sadar', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'পূর্ব নাছিরাবাদ', class: 'নাল', rate: '322026', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'ctg-sadar', lookupThana: 'খুলশী' }],
      idempotency_key: 't-batch2-sadar-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 322026 });
    expect(r.body.lines[0]).toMatchObject({ source: 'lookup', lookupThana: 'খুলশী', value: 322026 });
  });
  test('Sadar qualified line with wrong thana → 400', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'ctg-sadar', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'পূর্ব নাছিরাবাদ', class: 'নাল', rate: '322026', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'ctg-sadar', lookupThana: 'পাঁচলাইশ' }],
      idempotency_key: 't-batch2-sadar-thana',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
  });
  test('Patiya JL-suffix line → 200 (no thana needed)', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'patiya', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'কেশাগাঁও (JL 16)', class: 'নাল', rate: '106622', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'patiya' }],
      idempotency_key: 't-batch2-patiya-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 106622 });
  });
  test('Patiya suffix line with tampered rate → 400, wallet untouched', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'patiya', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'কেশাগাঁও (JL 16)', class: 'নাল', rate: '106623', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'patiya' }],
      idempotency_key: 't-batch2-patiya-tamper',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
    const walletCalls = db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
    expect(walletCalls).toHaveLength(0);
  });
});
