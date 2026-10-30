// Mouza batch 1 (Chattogram, 2025-2026): 5 offices, 174 mouza
// rows machine-transcribed from rates-chattogram-batch1.md and
// verified 0-mismatch by /tmp/batch1-verify.js (kept out of the
// repo). Tests: data shape + thana qualifier flow + Sandwip
// pouro note + X/n/a no-rate behaviour + Boalkhali regression
// + POST /mouza verification of qualified lines. No portal,
// no real money — mocked DB like land-mouza-lookup.test.js.
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
const { OFFICES, lookupMouzaRate, listLookupClasses } = require('../../../engines/land-mouza-value/rates');

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

function countRows(officeId) {
  let n = 0;
  for (const rec of Object.values(OFFICES[officeId].mouzas)) {
    n += rec.variants ? rec.variants.length : 1;
  }
  return n;
}

describe('batch-1 data shape (machine-transcribed, 0-mismatch verified)', () => {
  test('row counts: 11 + 36 + 44 + 72 + 11 = 174 mouza rows, 6 offices total', () => {
    expect(Object.keys(OFFICES).sort()).toEqual(
      ['boalkhali', 'chandgaon', 'gachbaria', 'pahartali', 'rangunia', 'sandwip'].sort());
    expect(countRows('chandgaon')).toBe(11);
    expect(countRows('sandwip')).toBe(36);
    expect(countRows('gachbaria')).toBe(44);
    expect(countRows('rangunia')).toBe(72);
    expect(countRows('pahartali')).toBe(11);
    for (const o of Object.values(OFFICES)) expect(o.period).toBe('2025-2026');
  });
  test('no zero rates, no joint-class mapping, no plot rows, no empty row', () => {
    const walk = (rec) => {
      const variants = rec.variants ? rec.variants : [rec];
      for (const v of variants) {
        for (const [c, r] of Object.entries(v.rates)) {
          expect(r.rate).toBeGreaterThan(0);
          expect(c).not.toBe('বাড়ীভিটি');
        }
      }
    };
    for (const [oid, o] of Object.entries(OFFICES)) {
      for (const [name, rec] of Object.entries(o.mouzas)) walk(rec);
      expect(Object.keys(o.mouzas)).not.toContain('জঙ্গল শ্রীনগর');
    }
    expect(OFFICES.pahartali.mouzas['ফৌজদারহাট সিডিএ প্লট']).toBeUndefined();
    expect(OFFICES.pahartali.mouzas['বিসিক শিল্প নগরী প্লট']).toBeUndefined();
  });
  test('spot rates across offices (incl. P flags and JL strings)', () => {
    expect(lookupMouzaRate('chandgaon', 'মোহরা', 'নাল')).toMatchObject({ rate: 687088, jl: '11', p: false });
    expect(lookupMouzaRate('sandwip', 'হরামিয়া', 'বাগান')).toMatchObject({ rate: 137381 });
    expect(lookupMouzaRate('gachbaria', 'জামিরজুরী', 'বাগান')).toMatchObject({ rate: 1000000 });
    expect(lookupMouzaRate('rangunia', 'সৈয়দবাড়ী', 'নাল')).toMatchObject({ rate: 361736 });
    expect(lookupMouzaRate('pahartali', 'উত্তর কাট্টলী', 'নাল')).toMatchObject({ rate: 544977, jl: '01' });
    expect(lookupMouzaRate('gachbaria', 'উত্তর আটিয়া', 'ভিটা')).toMatchObject({ rate: 6000, p: true });
    expect(lookupMouzaRate('pahartali', 'সরাইপাড়া', 'বাগান')).toMatchObject({ rate: 680000, p: true });
  });
  test('Chandgaon qualified names: 3 variants for বাকলিয়া, 2 each for চান্দগাঁও/চর মোহরা', () => {
    expect(OFFICES.chandgaon.mouzas['বাকলিয়া'].variants.map((v) => v.thana).sort())
      .toEqual(['চান্দগাঁও', 'বদর', 'পাঁচলাইশ'].sort());
    expect(OFFICES.chandgaon.mouzas['চান্দগাঁও'].variants.map((v) => v.thana).sort())
      .toEqual(['চান্দগাঁও', 'বদর'].sort());
    expect(OFFICES.chandgaon.mouzas['চর মোহরা'].variants.map((v) => v.thana).sort())
      .toEqual(['চান্দগাঁও', 'বদর'].sort());
    // Unambiguous names are plain entries (no thana stored).
    expect(OFFICES.chandgaon.mouzas['মোহরা'].variants).toBeUndefined();
    expect(OFFICES.chandgaon.mouzas['চর বাকলিয়া'].variants).toBeUndefined();
    // Qualified class union includes ডোবা (only the চান্দগাঁও variant has it).
    expect(listLookupClasses('chandgaon', 'বাকলিয়া').sort())
      .toEqual(['নাল', 'বাড়ী', 'ভিটা', 'পুকুর', 'ডোবা'].sort());
  });
  test('Sandwip pouro rows: gram stays the rate, pouro kept separately (6 rows)', () => {
    const pouro = [];
    for (const [name, rec] of Object.entries(OFFICES.sandwip.mouzas)) {
      if (rec.pouroPukur) pouro.push([name, rec.rates['পুকুর'].rate, rec.pouroPukur]);
    }
    expect(pouro).toEqual([
      ['কাহিয়াপাড়', 39902, 59266],
      ['কুহিয়ামোড়া', 46378, 37614],
      ['বাউরিয়া', 46817, 31291],
      ['রহমতপুর', 11576, 51600],
      ['হরিশপুর', 58718, 36441],
      ['হরামিয়া', 45188, 63257],
    ]);
  });
});

describe('GET /api/land/mouza-rate: thana qualifier', () => {
  const q = (office, mouza, cls, thana) =>
    '/api/land/mouza-rate?office=' + encodeURIComponent(office) +
    '&mouza=' + encodeURIComponent(mouza) + '&class=' + encodeURIComponent(cls) +
    (thana ? '&thana=' + encodeURIComponent(thana) : '');
  test('ambiguous → 200 found:false, ambiguous:true, thana options, Bengali message', async () => {
    const r = await withUser(request(app()).get(q('chandgaon', 'বাকলিয়া', 'নাল'))).expect(200);
    expect(r.body).toMatchObject({ ok: true, found: false, ambiguous: true });
    expect(r.body.options.sort()).toEqual(['চান্দগাঁও', 'বদর', 'পাঁচলাইশ'].sort());
    expect(r.body.message).toMatch('থানা বাছুন');
  });
  test('thana resolves to the right variant (বদর বাকলিয়া নাল = 693896, JL 8)', async () => {
    const r = await withUser(request(app()).get(q('chandgaon', 'বাকলিয়া', 'নাল', 'বদর'))).expect(200);
    expect(r.body).toMatchObject({ found: true, rate: 693896, thana: 'বদর', jl: '8' });
  });
  test('wrong thana → found:false (চর বাকলিয়া exists only in বদর)', async () => {
    const r = await withUser(request(app()).get(q('chandgaon', 'চর বাকলিয়া', 'নাল', 'চান্দগাঁও'))).expect(200);
    expect(r.body.found).toBe(false);
    expect(r.body.ambiguous).toBeUndefined();
  });
  test('single-variant class needs no thana (বাকলিয়া ডোবা → চান্দগাঁও variant only)', async () => {
    const r = await withUser(request(app()).get(q('chandgaon', 'বাকলিয়া', 'ডোবা'))).expect(200);
    expect(r.body).toMatchObject({ found: true, rate: 939613, thana: 'চান্দগাঁও', jl: '15' });
  });
  test('unambiguous Chandgaon row works without thana', async () => {
    const r = await withUser(request(app()).get(q('chandgaon', 'মোহরা', 'নাল'))).expect(200);
    expect(r.body).toMatchObject({ found: true, rate: 687088 });
    expect(r.body.thana).toBeUndefined();
  });
});

describe('GET /api/land/mouza-rate: pouro note + no-rate classes + Boalkhali regression', () => {
  const q = (office, mouza, cls) =>
    '/api/land/mouza-rate?office=' + encodeURIComponent(office) +
    '&mouza=' + encodeURIComponent(mouza) + '&class=' + encodeURIComponent(cls);
  test('Sandwip পুকুর with pouro → gram rate + pouro note; other classes carry no note', async () => {
    const r = await withUser(request(app()).get(q('sandwip', 'কাহিয়াপাড়', 'পুকুর'))).expect(200);
    expect(r.body).toMatchObject({ found: true, rate: 39902, pouroPukur: 59266 });
    expect(r.body.pouroNote).toMatch('পৌর এলাকার হার: 59266 টাকা');
    const r2 = await withUser(request(app()).get(q('sandwip', 'কাহিয়াপাড়', 'নাল'))).expect(200);
    expect(r2.body.pouroNote).toBeUndefined();
  });
  test('X / n/a class → found:false while sibling classes of the same mouza work', async () => {
    const x = await withUser(request(app()).get(q('pahartali', 'লতিফপুর', 'বাগান'))).expect(200);
    expect(x.body.found).toBe(false);
    const na = await withUser(request(app()).get(q('rangunia', 'পদুয়া', 'বাড়ী'))).expect(200);
    expect(na.body.found).toBe(false);
    const sib = await withUser(request(app()).get(q('rangunia', 'পদুয়া', 'ভিটা'))).expect(200);
    expect(sib.body).toMatchObject({ found: true, rate: 81478 });
    const sib2 = await withUser(request(app()).get(q('pahartali', 'লতিফপুর', 'নাল'))).expect(200);
    expect(sib2.body).toMatchObject({ found: true, rate: 514650 });
  });
  test('Boalkhali regression: rates unchanged', async () => {
    const r = await withUser(request(app()).get(q('boalkhali', 'কধুরখীল', 'নাল'))).expect(200);
    expect(r.body).toMatchObject({ found: true, rate: 121421, period: '2025-2026', p: false });
    const d = await withUser(request(app()).get(q('boalkhali', 'কধুরখীল', 'ডোবা'))).expect(200);
    expect(d.body).toMatchObject({ found: true, rate: 100000, p: true });
  });
});

describe('POST /api/land/mouza: qualified lookup lines', () => {
  test('qualified line match → 200, thana stamped on the line', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'chandgaon', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'বাকলিয়া', class: 'নাল', rate: '693896', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'chandgaon', lookupThana: 'বদর' }],
      idempotency_key: 't-batch1-qual-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 693896 });
    expect(r.body.lines[0]).toMatchObject({ source: 'lookup', lookupThana: 'বদর', value: 693896 });
  });
  test('qualified line with tampered rate → 400, wallet untouched, no charge', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'chandgaon', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'বাকলিয়া', class: 'নাল', rate: '693897', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'chandgaon', lookupThana: 'বদর' }],
      idempotency_key: 't-batch1-qual-tamper',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
    const walletCalls = db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
    expect(walletCalls).toHaveLength(0);
  });
  test('qualified line with wrong thana → 400 (right rate, wrong variant)', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'chandgaon', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'বাকলিয়া', class: 'নাল', rate: '693896', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'chandgaon', lookupThana: 'পাঁচলাইশ' }],
      idempotency_key: 't-batch1-qual-thana',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
  });
  test('qualified line with NO thana for an ambiguous class → 400 (must resolve first)', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'chandgaon', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'বাকলিয়া', class: 'নাল', rate: '693896', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'chandgaon' }],
      idempotency_key: 't-batch1-qual-nothana',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
  });
});
