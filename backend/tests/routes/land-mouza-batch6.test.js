// Mouza batch 6 (Rangpur division, 2025-2026): 61 office entries covering
// 61 checklist offices (0 blocked), 6934 source rows -> 6930 entries
// (4 identical Biral pouro reprints collapsed to one entry each, 3 class-rates),
// 16947 class-rates, machine-transcribed from reader JSON and verified
// 0-mismatch by an independent lookup pass (36066 checks, kept out of the repo).
// Same-name offices kept strictly separate: pirganj-rangpur +
// pirganj-thakurgaon (district-qualified), nawabganj-dinajpur (Dhaka's
// nawabganj from batch 4 already holds the bare key). Collision encodings:
// pouro pair -> " (পৌর)" suffix on the pouro row (66 groups, first-clause
// pouro only); distinct JL -> " (JL <jl>)" suffix (25 groups); distinct union
// -> " (<union>)" suffix (8 groups, Bengali-digit নং stripped). Tests:
// data shape + totals + pouro/JL/union suffix lookups + pirganj separation +
// haripur zero-rate card + mithapukur blacked-out cell + jaldhaka banijjik +
// pre-suffixed names verbatim + POST /mouza verification of suffix lines.
// Open flags for Pankaj (reader mapping decisions preserved as transcribed,
// NOT re-adjudicated): Dinajpur Sadar truncation + provisional star rule,
// Thakurgaon bastu/danga/dala ref-only + Haripur 0-rate book, Rangpur-district
// bastu rulings, Atwari/Debiganj vita-from-bastuvita (55 + 111 rates),
// Sadullapur JL 65 starred-column ambiguity, Palashbari pouro reprint dedupe,
// Tushbhandar dedicated-bagan vs group, Nilphamari group columns, Kaimari
// banijjik label. See land-service/rates-rangpur-batch6.md.
// No portal, no real money — mocked DB like land-mouza-batch5.test.js.
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

const BATCH6 = ['pirganj-rangpur', 'badarganj', 'kaunia', 'mithapukur',
  'rangpur-sadar', 'pirgachha', 'gangachara', 'taraganj',
  'haripur', 'ranishankail', 'bhullibazar', 'thakurgaon-sadar', 'lahirihat',
  'pirganj-thakurgaon',
  'ghoraghat', 'kaharole', 'khansama', 'dinajpur-sadar', 'chirirbandar',
  'biral', 'bochaganj', 'fulbari-dinajpur', 'nawabganj-dinajpur', 'hakimpur',
  'birampur', 'birganj', 'parbatipur',
  'panchagarh-sadar', 'tetulia', 'boda', 'atwari', 'debiganj',
  'tunirhat-panchagarh-sadar',
  'kurigram-sadar', 'rajibpur', 'bhurungamari', 'chilmari', 'rajarhat',
  'roumari', 'ulipur', 'nageshwari', 'fulbari-kurigram',
  'sadullapur', 'gobindaganj', 'gaibandha-sadar', 'fulchhari', 'sundarganj',
  'palashbari', 'saghat',
  'lalmonirhat-sadar', 'patgram', 'aditmari', 'tushbhandar', 'hatibandha',
  'kishoreganj', 'chilahati-domar', 'saidpur', 'domar', 'nilphamari-sadar',
  'dimla', 'jaldhaka'];
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

describe('batch 6 shape + totals', () => {
  test('61 new offices, all 2025-2026, 6930 entries, 16947 class-rates, 315 total', () => {
    expect(BATCH6).toHaveLength(61);
    let entries = 0, rates = 0;
    for (const key of BATCH6) {
      const o = OFFICES[key];
      expect(o).toBeTruthy();
      expect(o.period).toBe('2025-2026');
      for (const rec of Object.values(o.mouzas)) {
        entries++;
        const variants = Array.isArray(rec.variants) ? rec.variants : [rec];
        for (const v of variants) rates += Object.keys(v.rates).length;
      }
    }
    expect(entries).toBe(6930);
    expect(rates).toBe(16947);
    expect(Object.keys(OFFICES)).toHaveLength(488);
    expect(OFFICES.pirganj).toBeUndefined();
    expect(OFFICES.nawabganj).toBeTruthy();
    expect(OFFICES['nawabganj-dinajpur']).toBeTruthy();
  });
  test('earlier batches untouched', () => {
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'নাল', null).rate).toBe(121425);
    expect(lookupMouzaRate('patiya', 'কেশাগাঁও (JL 16)', 'নাল', null).rate).toBe(106622);
    expect(lookupMouzaRate('araihazar', 'শালমদী', 'ভিটা', null)).toMatchObject({ rate: 1388000, p: true });
    expect(lookupMouzaRate('bogura-sadar', 'নামুজা', 'নাল', null).rate).toBe(55011);
  });
});

describe('batch 6 sample lookups', () => {
  test('plain offices return printed rates', async () => {
    const cases = [
      ['pirganj-thakurgaon', 'চাপাপাড়া', 'ভিটা', 6667, true],
      ['dinajpur-sadar', 'বড়ইল (পৌর)', 'বাড়ী', 52154, true],
    ];
    for (const [office, mouza, cls, rate, p] of cases) {
      const r = await withUser(request(app()).get(rateQ(office, mouza, cls))).expect(200);
      expect(r.body).toMatchObject({ found: true, rate, p, period: '2025-2026' });
    }
  });
  test('pouro-suffix names resolve directly, base name keeps union rate', async () => {
    const a = await withUser(request(app()).get(rateQ('ghoraghat', 'কালুপুকুর (পৌর)', 'ভিটা'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 20554 });
    const b = await withUser(request(app()).get(rateQ('ghoraghat', 'কালুপুকুর', 'ভিটা'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 21240 });
  });
  test('JL-suffix names resolve directly', async () => {
    const a = await withUser(request(app()).get(rateQ('boda', 'ডাবরভাঙ্গা (JL 56)', 'ভিটা'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 8000, p: true });
    const b = await withUser(request(app()).get(rateQ('boda', 'ডাবরভাঙ্গা (JL 119)', 'ভিটা'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 5145, p: true });
  });
  test('union-suffix names resolve directly, bare name is a miss', async () => {
    const a = await withUser(request(app()).get(rateQ('pirganj-rangpur', 'নছিমনপুর (মদনখালী)', 'ভিটা'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 5100 });
    const b = await withUser(request(app()).get(rateQ('pirganj-rangpur', 'নছিমনপুর (টুকুরিয়া)', 'ভিটা'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 5300 });
    const c = await withUser(request(app()).get(rateQ('pirganj-rangpur', 'নছিমনপুর', 'ভিটা'))).expect(200);
    expect(c.body.found).toBe(false);
  });
  test('pirganj-rangpur and pirganj-thakurgaon are separate offices', async () => {
    const a = await withUser(request(app()).get(rateQ('pirganj-rangpur', 'নছিমনপুর (মদনখালী)', 'ভিটা'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 5100 });
    const b = await withUser(request(app()).get(rateQ('pirganj-thakurgaon', 'চাপাপাড়া', 'ভিটা'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 6667, p: true });
    expect(OFFICES['pirganj-rangpur'].name).toBe('পীরগঞ্জ');
    expect(OFFICES['pirganj-thakurgaon'].name).toBe('পীরগঞ্জ');
  });
  test('haripur zero-rate rows yield an all-null card, not not-in-table', async () => {
    const c = await withUser(request(app()).get(cardQ('haripur', 'গেদুরা কিসমত'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    for (const cls of ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']) {
      expect(c.body.rates[cls].rate).toBeNull();
    }
  });
  test('mithapukur blacked-out doba cell is null, bagan stays', async () => {
    const c = await withUser(request(app()).get(cardQ('mithapukur', 'লালচন্দ্রপুর'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    expect(c.body.rates['বাগান'].rate).toBe(142133);
    expect(c.body.rates['ডোবা'].rate).toBeNull();
  });
  test('jaldhaka kaimari banijjik from labelled dhani cell', async () => {
    const r = await withUser(request(app()).get(rateQ('jaldhaka', 'কৈমারী', 'বাণিজ্যিক'))).expect(200);
    expect(r.body).toMatchObject({ found: true, rate: 240000 });
  });
  test('pre-suffixed names kept verbatim', async () => {
    const a = await withUser(request(app()).get(rateQ('saidpur', 'বোতলাগাড়ী (পৌরসভা)', 'বাণিজ্যিক'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 11231 });
    const b = await withUser(request(app()).get(rateQ('pirganj-thakurgaon', 'কৃষ্ণপুর (JL 33)', 'ভিটা'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 11658 });
  });
});

describe('POST /api/land/mouza: batch 6 lines', () => {
  test('union-suffix line → 200', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'pirganj-rangpur', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'নছিমনপুর (মদনখালী)', class: 'ভিটা', rate: '5100', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'pirganj-rangpur' }],
      idempotency_key: 't-batch6-pirganj-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 5100 });
  });
  test('union-suffix line with wrong union rate → 400', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'pirganj-rangpur', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'নছিমনপুর (মদনখালী)', class: 'ভিটা', rate: '5300', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'pirganj-rangpur' }],
      idempotency_key: 't-batch6-pirganj-tamper',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
  });
  test('JL-suffix line → 200 (no thana needed)', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'boda', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'ডাবরভাঙ্গা (JL 56)', class: 'ভিটা', rate: '8000', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'boda' }],
      idempotency_key: 't-batch6-boda-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 8000 });
  });
  test('pouro-suffix line → 200', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'ghoraghat', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'কালুপুকুর (পৌর)', class: 'ভিটা', rate: '20554', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'ghoraghat' }],
      idempotency_key: 't-batch6-ghoraghat-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 20554 });
  });
});
