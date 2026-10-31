// Mouza batch 5 (Rajshahi division, 2025-2026): 70 office entries
// covering 70 checklist offices (Naldanga BLOCKED — site has no file, so
// nothing entered for it), 12136 source rows -> 12133 entries (3 union-
// variant groups collapse 2 rows into 1 entry each), 48203 class-rates,
// machine-transcribed from reader JSON and verified 0-mismatch by an
// independent lookup pass (25064 checks, kept out of the repo). Tests:
// data shape + totals + JL/kromik/pouro suffix names + union variants +
// Godagari mixed pouro/JL + Baraigram/Banpara shared schedule + zero-rate
// cards + Nachole unreadable placeholders + POST /mouza verification of
// qualified and suffix lines.
// Khetlal period is ATTRIBUTED, not printed (cover letter + current-price
// columns, signed 11/12/24; cover says draft, p.2 says final) — flagged
// in rates-rajshahi-batch5.md; the period field stays 2025-2026.
// No portal, no real money — mocked DB like land-mouza-batch4.test.js.
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

const BATCH5 = ['bogura-sadar', 'adamdighi', 'kahalu', 'nandigram',
  'sariakandi', 'shibganj', 'gabtali', 'shajahanpur', 'sonatola',
  'dupchanchia', 'sherpur', 'dhunat',
  'porsha', 'prasadpur', 'patnitala', 'mahadebpur', 'raninagar',
  'naogaon-sadar', 'atrai', 'sapahar', 'niamatpur', 'badalgachhi',
  'dhamoirhat',
  'pabna-sadar', 'santhia', 'atgharia', 'sujanagar', 'faridpur', 'bera',
  'ishwardi', 'chatmohar', 'bhangura',
  'lalpur', 'singra', 'bagatipara', 'gurudaspur', 'natore-sadar',
  'baraigram', 'banpara',
  'kamarkhand', 'gandhail-kazipur', 'shahjadpur', 'sirajganj-sadar',
  'ullapara', 'belkuchi', 'chauhali', 'salanga-raiganj', 'kazipur',
  'raiganj', 'tarash',
  'chapainawabganj-shibganj', 'nachole', 'chapainawabganj-sadar',
  'bholahat', 'gomastapur',
  'bagmara', 'puthia', 'rajshahi-sadar', 'bagha', 'paba', 'durgapur',
  'tanore', 'charghat', 'godagari', 'mohanpur',
  'panchbibi', 'khetlal', 'kalai', 'akkelpur', 'joypurhat-sadar'];
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

describe('batch 5 shape + totals', () => {
  test('70 new offices, all 2025-2026, 12133 entries, 48203 class-rates, 254 total', () => {
    expect(BATCH5).toHaveLength(70);
    let entries = 0, rates = 0;
    for (const key of BATCH5) {
      const o = OFFICES[key];
      expect(o).toBeTruthy();
      expect(o.period).toBe('2025-2026');
      for (const rec of Object.values(o.mouzas)) {
        entries++;
        const variants = Array.isArray(rec.variants) ? rec.variants : [rec];
        for (const v of variants) rates += Object.keys(v.rates).length;
      }
    }
    expect(entries).toBe(12133);
    expect(rates).toBe(48203);
    expect(Object.keys(OFFICES)).toHaveLength(373);
    expect(OFFICES.naldanga).toBeUndefined();
  });
  test('earlier batches untouched', () => {
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'নাল', null).rate).toBe(121421);
    expect(lookupMouzaRate('patiya', 'কেশাগাঁও (JL 16)', 'নাল', null).rate).toBe(106622);
    expect(lookupMouzaRate('araihazar', 'শালমদী', 'ভিটা', null)).toMatchObject({ rate: 1388000, p: true });
  });
});

describe('batch 5 sample lookups', () => {
  test('plain offices return printed rates', async () => {
    const cases = [
      ['bogura-sadar', 'নামুজা', 'নাল', 55011],
      ['joypurhat-sadar', 'আমদই', 'বাড়ী', 22857],
    ];
    for (const [office, mouza, cls, rate] of cases) {
      const r = await withUser(request(app()).get(rateQ(office, mouza, cls))).expect(200);
      expect(r.body).toMatchObject({ found: true, rate, period: '2025-2026' });
    }
  });
  test('JL-suffix names resolve directly', async () => {
    const a = await withUser(request(app()).get(rateQ('shibganj', 'মাঝপাড়া (JL 60)', 'নাল'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 16645 });
    const b = await withUser(request(app()).get(rateQ('shibganj', 'মাঝপাড়া (JL 220)', 'নাল'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 28175 });
    const c = await withUser(request(app()).get(rateQ('baraigram', 'গোপালপুর (JL 86)', 'বাড়ী'))).expect(200);
    expect(c.body).toMatchObject({ found: true, rate: 47758 });
  });
  test('kromik-suffix names resolve directly (Khetlal, Kalai, Mahadebpur)', async () => {
    const a = await withUser(request(app()).get(rateQ('khetlal', 'কুশলদহ (ক্রম 9)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 77777, p: true });
    const b = await withUser(request(app()).get(rateQ('khetlal', 'কুশলদহ (ক্রম 16)', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 23333, p: true });
    const c = await withUser(request(app()).get(rateQ('kalai', 'বানগাঁও (ক্রম 106)', 'বাড়ী'))).expect(200);
    expect(c.body).toMatchObject({ found: true, rate: 76548 });
    const d = await withUser(request(app()).get(rateQ('mahadebpur', 'আদিপুর (ক্রম 7)', 'বাড়ী'))).expect(200);
    expect(d.body).toMatchObject({ found: true, rate: 13334 });
  });
  test('pouro-suffix names resolve directly', async () => {
    const a = await withUser(request(app()).get(rateQ('singra', 'নিংগাইন (পৌর)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 41024 });
  });
  test('union variants: ambiguous without union, exact with union', async () => {
    const amb = await withUser(request(app()).get(rateQ('panchbibi', 'খাসবাড়ী', 'বাড়ী'))).expect(200);
    expect(amb.body.ambiguous).toBe(true);
    expect(amb.body.options).toEqual(expect.arrayContaining(['বালিঘাটা', 'আয়মা রসুলপুর']));
    const q = await withUser(request(app()).get(rateQ('panchbibi', 'খাসবাড়ী', 'বাড়ী', 'বালিঘাটা'))).expect(200);
    expect(q.body).toMatchObject({ found: true, rate: 11040, p: true });
    const q2 = await withUser(request(app()).get(rateQ('panchbibi', 'খাসবাড়ী', 'বাড়ী', 'আয়মা রসুলপুর'))).expect(200);
    expect(q2.body).toMatchObject({ found: true, rate: 55693 });
  });
  test('Godagari mixed pouro + JL: pouro row and JL row are distinct', async () => {
    const a = await withUser(request(app()).get(rateQ('godagari', 'মহাদেবপুর (পৌর)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 10260 });
    const b = await withUser(request(app()).get(rateQ('godagari', 'মহাদেবপুর (JL 147)', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 1800, p: true });
  });
  test('Baraigram + Banpara share the same printed schedule', async () => {
    const a = await withUser(request(app()).get(rateQ('baraigram', 'গোপালপুর (JL 86)', 'বাড়ী'))).expect(200);
    const b = await withUser(request(app()).get(rateQ('banpara', 'গোপালপুর (JL 86)', 'বাড়ী'))).expect(200);
    expect(a.body.rate).toBe(b.body.rate);
    expect(a.body.rate).toBe(47758);
  });
  test('zero-rate rows yield an all-null card, not not-in-table', async () => {
    const c = await withUser(request(app()).get(cardQ('chauhali', 'স্থল'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    for (const cls of ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']) {
      expect(c.body.rates[cls].rate).toBeNull();
    }
  });
  test('Nachole unreadable placeholders are in-table with no rates', async () => {
    const c = await withUser(request(app()).get(cardQ('nachole', 'অপঠিত (JL 51)'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    for (const cls of ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']) {
      expect(c.body.rates[cls].rate).toBeNull();
    }
  });
  test('pre-suffixed Pabna names kept verbatim', async () => {
    const r = await withUser(request(app()).get(rateQ('pabna-sadar', 'কিসমতপ্রতাপপুর (ক্রম 3)', 'বাড়ী'))).expect(200);
    expect(r.body).toMatchObject({ found: true, rate: 218664 });
  });
});

describe('POST /api/land/mouza: batch 5 lines', () => {
  test('union-qualified line → 200', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'panchbibi', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'খাসবাড়ী', class: 'বাড়ী', rate: '11040', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'panchbibi', lookupThana: 'বালিঘাটা' }],
      idempotency_key: 't-batch5-panchbibi-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 11040 });
    expect(r.body.lines[0]).toMatchObject({ source: 'lookup', lookupThana: 'বালিঘাটা', value: 11040 });
  });
  test('union-qualified line with wrong union → 400', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'panchbibi', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'খাসবাড়ী', class: 'বাড়ী', rate: '11040', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'panchbibi', lookupThana: 'আয়মা রসুলপুর' }],
      idempotency_key: 't-batch5-panchbibi-thana',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
  });
  test('JL-suffix line → 200 (no thana needed)', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'shibganj', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'মাঝপাড়া (JL 60)', class: 'নাল', rate: '16645', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'shibganj' }],
      idempotency_key: 't-batch5-shibganj-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 16645 });
  });
  test('JL-suffix line with tampered rate → 400, wallet untouched', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'shibganj', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'মাঝপাড়া (JL 60)', class: 'নাল', rate: '16646', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'shibganj' }],
      idempotency_key: 't-batch5-shibganj-tamper',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
    const walletCalls = db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
    expect(walletCalls).toHaveLength(0);
  });
});
