// Mouza batch 4 (Dhaka division, 2025-2026): 104 office entries
// covering 104 checklist offices (3 checklist offices BLOCKED — no
// schedule usable on the site: Dhaka Sadar serves a Munshiganj Sadar
// document, Kalukhali serves the Pangsha document, Kishoreganj Sadar
// offers only a 2024-2025 book; each proven twice), 11998 source rows
// -> 11992 entries (6 rows collapse into thana/union variants),
// 54222 class-rates, machine-transcribed from reader JSON and verified
// 0-mismatch by an independent lookup pass (180337 checks, kept out of
// the repo). Correction (2026-10-31): +24 Araihazar বাণিজ্যিক rates from
// a targeted re-read of the 'চান্দিনা ভিটি ও বাণিজ্যিক ভূমি' column
// (Nangalkot precedent: combined বাণিজ্যিক-bearing column → বাণিজ্যিক),
// total now 54246. Tests: data shape + totals + thana/union variants +
// JL/poura/kromik suffix names + Dhaka city x100 conversions +
// Barangaol exact decimals + Hossainpur placeholders + Baidyer Bazar
// 31-row Sonargaon filter + Mirzapur dedupe + zero-rate cards +
// POST /mouza verification of qualified and suffix lines.
// No portal, no real money — mocked DB like land-mouza-batch3.test.js.
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

const BATCH4 = ['palash', 'raipura', 'shibpur', 'manohardi', 'belabo', 'narsingdi-sadar',
  'delduar', 'basail', 'ghatail', 'tangail-sadar', 'bhuapur', 'dhanbari', 'nagarpur',
  'madhupur', 'gopalpur', 'kalihati', 'sakhipur', 'mirzapur',
  'pallabi', 'uttara', 'demra', 'keraniganj-dakshin', 'nawabganj', 'khilgaon', 'tejgaon',
  'sutrapur', 'kalampur-dhamrai', 'gulshan', 'badda', 'ashulia', 'keraniganj', 'mirpur',
  'dohar', 'dhanmondi', 'mohammadpur', 'shyampur', 'savar',
  'alfadanga', 'saltha', 'charbhadrasan', 'madhukhali', 'nagarkanda', 'boalmari',
  'faridpur-sadar', 'bhanga', 'sadarpur',
  'kotalipara', 'kashiani', 'tungipara', 'muksudpur', 'gopalganj-sadar',
  'harirampur', 'saturia', 'daulatpur', 'manikganj-sadar', 'singair',
  'barangaol-shibloya', 'ghior',
  'munshiganj-sadar', 'sirajdikhan', 'gazaria', 'lauhajang', 'tongibari', 'srinagar',
  'pangsha', 'baliakandi', 'rajbari-sadar', 'goalanda',
  'karimganj', 'bajitpur', 'austagram', 'katiadi', 'pakundia', 'nikli', 'bhairab',
  'mithamain', 'kuliarchar', 'tarail', 'hossainpur', 'itna',
  'rajoir', 'shibchar', 'madaripur-sadar', 'kalkini',
  'gosairhat', 'shariatpur-sadar', 'naria', 'bhedarganj', 'damudya', 'zajira',
  'kapasia', 'tongi', 'gazipur-sadar', 'sripur', 'kaliganj', 'gazipur-2nd-joint', 'kaliakair',
  'fatulla-narayanganj-sadar', 'rupganj-east', 'rupganj', 'bandar', 'araihazar',
  'narayanganj-sadar', 'baidyer-bazar'];
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

describe('batch 4 shape + totals', () => {
  test('104 new offices, all 2025-2026, 11992 entries, 54246 class-rates, 254 total', () => {
    expect(BATCH4).toHaveLength(104);
    let entries = 0, rates = 0;
    for (const key of BATCH4) {
      const o = OFFICES[key];
      expect(o).toBeTruthy();
      expect(o.period).toBe('2025-2026');
      for (const rec of Object.values(o.mouzas)) {
        entries++;
        const variants = Array.isArray(rec.variants) ? rec.variants : [rec];
        for (const v of variants) rates += Object.keys(v.rates).length;
      }
    }
    expect(entries).toBe(11992);
    expect(rates).toBe(54246);
    expect(Object.keys(OFFICES)).toHaveLength(373);
    expect(OFFICES['dhaka-sadar']).toBeUndefined();
    expect(OFFICES.kalukhali).toBeUndefined();
    expect(OFFICES['kishoreganj-sadar']).toBeUndefined();
  });
  test('earlier batches untouched', () => {
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'নাল', null).rate).toBe(121421);
    expect(lookupMouzaRate('patiya', 'কেশাগাঁও (JL 16)', 'নাল', null).rate).toBe(106622);
    expect(lookupMouzaRate('begumganj', 'আবদুল্যাপুর (JL 199)', 'নাল', null).rate).toBe(37312);
  });
});

describe('Araihazar correction (re-read 2026-10-31)', () => {
  test('চান্দিনা ভিটি ও বাণিজ্যিক ভূমি column maps to বাণিজ্যিক (Nangalkot precedent)', () => {
    expect(lookupMouzaRate('araihazar', 'দেয়াবৈ', 'বাণিজ্যিক', null)).toMatchObject({ rate: 2052000, p: false });
    expect(lookupMouzaRate('araihazar', 'বড় নোয়াগাঁও', 'বাণিজ্যিক', null)).toMatchObject({ rate: 440100, p: true });
    expect(lookupMouzaRate('araihazar', 'গোপালদী', 'বাণিজ্যিক', null)).toMatchObject({ rate: 4703600, p: true });
    expect(lookupMouzaRate('araihazar', 'শালমদী', 'বাণিজ্যিক', null)).toMatchObject({ rate: 1388900, p: false });
    // Zoom-verified 2026-10-31: first read dropped an 8 (138000*); printed value is 1388000*.
    expect(lookupMouzaRate('araihazar', 'শালমদী', 'ভিটা', null)).toMatchObject({ rate: 1388000, p: true });
    expect(lookupMouzaRate('araihazar', 'নিজ কালাপাহাড়িয়া', 'বাণিজ্যিক', null)).toMatchObject({ rate: 975700, p: true });
  });
  test('blank চান্দিনা cells stay missing, never zero', () => {
    expect(lookupMouzaRate('araihazar', 'চারিগাঁও', 'বাণিজ্যিক', null)).toBeNull();
  });
  test('Sreepur ভিটাবাড়ী stays joint ref-only: no বাড়ী/ভিটা rates', () => {
    expect(lookupMouzaRate('sripur', 'আতালভা', 'বাড়ী', null)).toBeNull();
    expect(lookupMouzaRate('sripur', 'আতালভা', 'ভিটা', null)).toBeNull();
    expect(lookupMouzaRate('sripur', 'শ্রীপুর', 'বাড়ী', null)).toBeNull();
    expect(lookupMouzaRate('sripur', 'শ্রীপুর', 'ভিটা', null)).toBeNull();
  });
});

describe('batch 4 sample lookups', () => {
  test('plain offices return printed rates', async () => {
    const cases = [
      ['palash', 'ঘোড়াশাল', 'নাল', 263035],
      ['narsingdi-sadar', 'বেলাব', 'নাল', 56083],
      ['munshiganj-sadar', 'ইমাম চর', 'নাল', 104451],
      ['shariatpur-sadar', 'পশ্চিম কোটাপাড়া', 'নাল', 248325],
    ];
    for (const [office, mouza, cls, rate] of cases) {
      const r = await withUser(request(app()).get(rateQ(office, mouza, cls))).expect(200);
      expect(r.body).toMatchObject({ found: true, rate, period: '2025-2026' });
    }
  });
  test('Rupganj thana variants: ambiguous without thana, exact with thana', async () => {
    const amb = await withUser(request(app()).get(rateQ('rupganj', 'ব্রাহ্মণগাঁও', 'নাল'))).expect(200);
    expect(amb.body.ambiguous).toBe(true);
    expect(amb.body.options).toEqual(expect.arrayContaining(['রূপগঞ্জ', 'মুড়াপাড়া']));
    const q = await withUser(request(app()).get(rateQ('rupganj', 'ব্রাহ্মণগাঁও', 'নাল', 'রূপগঞ্জ'))).expect(200);
    expect(q.body).toMatchObject({ found: true, rate: 422700, thana: 'রূপগঞ্জ' });
    const q2 = await withUser(request(app()).get(rateQ('rupganj', 'ব্রাহ্মণগাঁও', 'নাল', 'মুড়াপাড়া'))).expect(200);
    expect(q2.body).toMatchObject({ found: true, rate: 201800 });
  });
  test('Union variants resolve by union thana', async () => {
    const amb = await withUser(request(app()).get(rateQ('nawabganj', 'ছোট নবগ্রাম', 'নাল'))).expect(200);
    expect(amb.body.ambiguous).toBe(true);
    const q = await withUser(request(app()).get(rateQ('nawabganj', 'ছোট নবগ্রাম', 'নাল', 'যন্ত্রাইল'))).expect(200);
    expect(q.body).toMatchObject({ found: true, rate: 20936 });
    const j = await withUser(request(app()).get(rateQ('gazipur-2nd-joint', 'ভেমরা (ক্রম ৪)', 'নাল', 'কাশিমপুর'))).expect(200);
    expect(j.body).toMatchObject({ found: true, rate: 10200, p: true });
    const j2 = await withUser(request(app()).get(rateQ('gazipur-2nd-joint', 'ভেমরা (ক্রম ৪)', 'নাল', 'বাসন'))).expect(200);
    expect(j2.body).toMatchObject({ found: true, rate: 48000, p: true });
  });
  test('JL/poura/kromik suffix names resolve directly', async () => {
    const j = await withUser(request(app()).get(rateQ('kalampur-dhamrai', 'পাঁচলক্ষী (JL 14)', 'নাল'))).expect(200);
    expect(j.body).toMatchObject({ found: true, rate: 34265 });
    const j2 = await withUser(request(app()).get(rateQ('kalampur-dhamrai', 'পাঁচলক্ষী (JL 40)', 'নাল'))).expect(200);
    expect(j2.body).toMatchObject({ found: true, rate: 21244 });
    const p = await withUser(request(app()).get(rateQ('rajoir', 'নাগরদী (পৌর)', 'নাল'))).expect(200);
    expect(p.body).toMatchObject({ found: true, rate: 38194, p: true });
    const g = await withUser(request(app()).get(rateQ('rajoir', 'নাগরদী', 'নাল'))).expect(200);
    expect(g.body).toMatchObject({ found: true, rate: 70818 });
    const k = await withUser(request(app()).get(rateQ('harirampur', 'বাসুদেবপুর (ক্রম 42)', 'নাল'))).expect(200);
    expect(k.body).toMatchObject({ found: true, rate: 38200 });
    const k2 = await withUser(request(app()).get(rateQ('harirampur', 'বাসুদেবপুর (ক্রম 197)', 'নাল'))).expect(200);
    expect(k2.body).toMatchObject({ found: true, rate: 1500, p: true });
  });
  test('Dhaka city x100: per-ayutangsha values stored per-shatangsho', async () => {
    const g = await withUser(request(app()).get(rateQ('gulshan', 'জোয়ার সাহারা', 'বাড়ী'))).expect(200);
    expect(g.body).toMatchObject({ found: true, rate: 3141900 });
    const s = await withUser(request(app()).get(rateQ('sutrapur', 'ব্রাহ্মণচিরণ', 'নাল'))).expect(200);
    expect(s.body).toMatchObject({ found: true, rate: 769300 });
    const b = await withUser(request(app()).get(rateQ('gulshan', 'জোয়ার সাহারা', 'বাণিজ্যিক'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 18419700 });
  });
  test('Barangaol decimals kept exact', async () => {
    const r = await withUser(request(app()).get(rateQ('barangaol-shibloya', 'লৌলারা বিরি', 'নাল'))).expect(200);
    expect(r.body).toMatchObject({ found: true, rate: 2068.38, p: true });
  });
  test('Hossainpur placeholder names carry legible values', async () => {
    const c = await withUser(request(app()).get(cardQ('hossainpur', '[নাম অপঠনীয় — ক্রম ১৬]'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    expect(c.body.rates['নাল'].rate).toBe(24250);
    expect(c.body.rates['ডোবা'].rate).toBeNull();
    expect(c.body.rates['বাণিজ্যিক'].rate).toBeNull();
  });
  test('Baidyer Bazar is exactly the 31-row section; Sonargaon rows excluded', async () => {
    expect(Object.keys(OFFICES['baidyer-bazar'].mouzas)).toHaveLength(31);
    expect(OFFICES['baidyer-bazar'].mouzas['আমিনপুর']).toBeUndefined();
    const r = await withUser(request(app()).get(rateQ('baidyer-bazar', 'আমিনপুর', 'নাল'))).expect(200);
    expect(r.body.found).toBe(false);
  });
  test('Mirzapur dedupe: single গাড়াইল (পৌর), JL pair kept', async () => {
    expect(Object.keys(OFFICES.mirzapur.mouzas).filter((k) => k === 'গাড়াইল (পৌর)')).toHaveLength(1);
    const g = await withUser(request(app()).get(rateQ('mirzapur', 'গাড়াইল (পৌর)', 'বাড়ী'))).expect(200);
    expect(g.body).toMatchObject({ found: true, rate: 554634 });
    const a = await withUser(request(app()).get(rateQ('mirzapur', 'সরিষাদাইড় (JL 145)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 146350 });
    const b = await withUser(request(app()).get(rateQ('mirzapur', 'সরিষাদাইড় (JL 146)', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 146350 });
  });
  test('zero-rate rows yield an all-null card, not not-in-table', async () => {
    const c = await withUser(request(app()).get(cardQ('gazipur-2nd-joint', 'শ্রীপুর সদর'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    for (const cls of ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']) {
      expect(c.body.rates[cls].rate).toBeNull();
    }
  });
});

describe('POST /api/land/mouza: batch 4 lines', () => {
  test('Rupganj qualified line → 200', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'rupganj', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'ব্রাহ্মণগাঁও', class: 'নাল', rate: '422700', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'rupganj', lookupThana: 'রূপগঞ্জ' }],
      idempotency_key: 't-batch4-rupganj-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 422700 });
    expect(r.body.lines[0]).toMatchObject({ source: 'lookup', lookupThana: 'রূপগঞ্জ', value: 422700 });
  });
  test('Rupganj qualified line with wrong thana → 400', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'rupganj', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'ব্রাহ্মণগাঁও', class: 'নাল', rate: '422700', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'rupganj', lookupThana: 'মুড়াপাড়া' }],
      idempotency_key: 't-batch4-rupganj-thana',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
  });
  test('Kalampur JL-suffix line → 200 (no thana needed)', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'kalampur-dhamrai', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'পাঁচলক্ষী (JL 14)', class: 'নাল', rate: '34265', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'kalampur-dhamrai' }],
      idempotency_key: 't-batch4-kalampur-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 34265 });
  });
  test('Kalampur suffix line with tampered rate → 400, wallet untouched', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'kalampur-dhamrai', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'পাঁচলক্ষী (JL 14)', class: 'নাল', rate: '34266', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'kalampur-dhamrai' }],
      idempotency_key: 't-batch4-kalampur-tamper',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
    const walletCalls = db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
    expect(walletCalls).toHaveLength(0);
  });
});
