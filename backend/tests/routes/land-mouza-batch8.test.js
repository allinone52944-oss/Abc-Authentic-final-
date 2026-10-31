// Mouza batch 8 (Barishal division, 2025-2026): 42 office entries covering
// 42 checklist entries (3 blocked site-side: Taltali/Barguna no schedule,
// Rangabali/Patuakhali no schedule, Daulatkhan/Bhola no schedule (site
// shows schedule not found / work ongoing for all three) — nothing
// entered for the blocked 3; Radhaballab-Daulatkhan is a
// separate office, entered as its own entry, never used for Daulatkhan),
// 3240 source rows -> 3240 entries, 16573 class-rates, machine-transcribed
// from reader JSON + the Barishal-district adjudicated JSON and verified
// 0-mismatch by an independent lookup pass (67505 checks + frontend
// 415/415, kept out of the repo).
// Barishal district uses ONLY batch8-barishal-adjudicated.json: the redo and
// prior readings disagreed and were adjudicated (428 disputed items, 2
// undecidable cells left no-rate: Chakhar ভিতরকুল JL 34 নাল, সোনার JL 64
// ডোবা). Collision encodings: distinct JL -> " (JL <jl>)" suffix; pouro
// pair, same JL -> " (পৌর)" on the pouro row only (Barguna-sadar সংলগ্ন
// rows -> " (পৌর সংলগ্ন)"); hat row -> " (<hat name>)" from "হাট: X" in
// notes (Barguna only, 105 hat rows); serial in notes / MD-verified serial
// -> " (ক্রম <n>)" (Kathalia রঘুয়ারচর 36/37, Rajapur রাজাঃ আবাসিক
// 50/51/52/53, Muladi উত্তর পাতারচর 24/25, Patarhat কোলচরী 37/119);
// pre-suffixed JSON names kept verbatim ("(পৌরসভা)", "(২য় সিরিজ)",
// "(সিটি)", "(ইউ.পি)", "(পৌর এলাকা)", "(পৌর বাহির)"). thana is null
// throughout, so variants[] is NOT used. Zero-rate rows (2) kept as entries
// with rates:{} (Bauphal আমিরাবাদ (পৌরসভা তালিকা), Manpura 1 row) rather
// than dropped or reported not-in-table. No unit conversion anywhere:
// সহস্রাংশ rows (Jhalokathi Sadar serials 153/171/172, Lalmohan বাণিজ্যিক,
// Charfassion pouro চান্দিনা ভিটা) entered as printed, flagged for Pankaj.
// Bare "সদর" office names expanded to the district-qualified form used by
// every existing sadar office (পটুয়াখালী সদর, পিরোজপুর সদর, ঝালকাঠি সদর).
// Open flags for Pankaj (reader/adjudicator mapping decisions preserved as
// transcribed, NOT re-adjudicated): Barguna hat ভিটা (বাণিজ্যিক) -> ভিটা
// only vs also বাণিজ্যিক, pouro আবাসিক -> বাড়ী, fractional-JL first
// elements duplicating plain JLs, Betagi পুকুর p:false exception;
// Patuakhali Dashmina বানিজ্যিক ref-only (2 rows), split-JL overlaps,
// Khepupara JL-16 correction mark + "এস, এ ৪৮", Patuakhali-sadar star
// footnote not found (p:false) + missing book p.06 / JL 89; Pirojpur
// Bhandaria JL21 (ক)/(খ)/(গ), Nesarabad stacked JL, Mathbaria ** rows,
// Indurkani S.A./B.S. JL systems; Jhalokathi Kathalia বাণিজ্যিক-group
// পুকুর ref-only, Sadar সহস্রাংশ, Rajapur sub-rows ref-only, Nalchity
// pouro serial inference; Bhola Lalmohan/Charfassion সহস্রাংশ units,
// Radhaballab দোকান/বাণিজ্যিক ref-only, Charfassion বাড়ীর ভিটা /
// বাণিজ্যিক ভিটা rulings, Tazumuddin ** rows; Barishal adjudication
// group interpretations (Hijla/Uzirpur বাড়ী/ভিটা, Patarhat ভিটা/বাড়ী/
// পুকুর, Sadar বাড়ী/বাগান/ভিটা, Bakerganj বাগান/পুকুর, Patarhat
// হেলিচর/ডোবা -> ডোবা only, Gournadi বেড়/ডোবা -> ডোবা only), Agailjhara
// missing book p.2 + dropped p.05 placeholders, Chakhar serials 1-16
// untranscribed, Rahmatpur serial-78 JL ৭৮৪ left null. See
// land-service/rates-barishal-batch8.md.
// No portal, no real money — mocked DB like land-mouza-batch7.test.js.
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

const BATCH8 = ['bamna', 'patharghata', 'betagi', 'barguna-sadar', 'amtali',
  'dashmina', 'galachipa', 'mirzaganj', 'dumki', 'khepupara-kalapara',
  'bauphal', 'patuakhali-sadar',
  'nazirpur', 'bhandaria', 'indurkani', 'pirojpur-sadar', 'mathbaria',
  'kaukhali', 'nesarabad',
  'nalchity', 'kathalia', 'jhalokathi-sadar', 'rajapur',
  'radhaballab-daulatkhan', 'lalmohan', 'borhanuddin', 'bhola-sadar',
  'charfassion', 'manpura', 'tazumuddin', 'shashibhushan-charfassion',
  'dakshin-aicha-charfassion',
  'hijla', 'muladi', 'patarhat-mehendiganj', 'barishal-sadar', 'uzirpur',
  'gournadi', 'agailjhara', 'bakerganj', 'rahmatpur-babuganj',
  'chakhar-banaripara'];
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

describe('batch 8 shape + totals', () => {
  test('42 new offices, all 2025-2026, 3240 entries, 16573 class-rates, 415 total', () => {
    expect(BATCH8).toHaveLength(42);
    let entries = 0, rates = 0;
    for (const key of BATCH8) {
      const o = OFFICES[key];
      expect(o).toBeTruthy();
      expect(o.period).toBe('2025-2026');
      for (const rec of Object.values(o.mouzas)) {
        entries++;
        const variants = Array.isArray(rec.variants) ? rec.variants : [rec];
        for (const v of variants) rates += Object.keys(v.rates).length;
      }
    }
    expect(entries).toBe(3240);
    expect(rates).toBe(16573);
    expect(Object.keys(OFFICES)).toHaveLength(488);
    expect(Object.keys(OFFICES.bamna.mouzas)).toHaveLength(40);
    expect(Object.keys(OFFICES.bauphal.mouzas)).toHaveLength(151);
    expect(Object.keys(OFFICES['chakhar-banaripara'].mouzas)).toHaveLength(63);
    expect(OFFICES['patuakhali-sadar'].name).toBe('পটুয়াখালী সদর');
    expect(OFFICES['pirojpur-sadar'].name).toBe('পিরোজপুর সদর');
    expect(OFFICES['jhalokathi-sadar'].name).toBe('ঝালকাঠি সদর');
    expect(OFFICES['radhaballab-daulatkhan'].name).toBe('রাধাবল্লভ (বাংলাবাজার)');
  });
  test('earlier batches untouched', () => {
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'নাল', null).rate).toBe(121421);
    expect(lookupMouzaRate('patiya', 'কেশাগাঁও (JL 16)', 'নাল', null).rate).toBe(106622);
    expect(lookupMouzaRate('araihazar', 'শালমদী', 'ভিটা', null)).toMatchObject({ rate: 1388000, p: true });
    expect(lookupMouzaRate('bogura-sadar', 'নামুজা', 'নাল', null).rate).toBe(55011);
    expect(lookupMouzaRate('pirganj-rangpur', 'নছিমনপুর (মদনখালী)', 'ভিটা', null).rate).toBe(5100);
  });
});

describe('batch 8 sample lookups', () => {
  test('plain offices return printed rates', async () => {
    const a = await withUser(request(app()).get(rateQ('bamna', 'লক্ষ্মীপুরা', 'নাল'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 19839, period: '2025-2026' });
    const b = await withUser(request(app()).get(rateQ('nalchity', 'নাচুনী', 'নাল'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 29023 });
  });
  test('JL-suffix names resolve directly', async () => {
    const a = await withUser(request(app()).get(rateQ('khepupara-kalapara', 'নজরকাটা (JL 16)', 'নাল'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 73000, p: true });
    const b = await withUser(request(app()).get(rateQ('khepupara-kalapara', 'নজরকাটা (JL 24)', 'নাল'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 31451 });
  });
  test('pouro-suffix names resolve directly, base name keeps union rate', async () => {
    const a = await withUser(request(app()).get(rateQ('bakerganj', 'রুনশি (পৌর)', 'নাল'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 415624 });
    const b = await withUser(request(app()).get(rateQ('bakerganj', 'রুনশি', 'নাল'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 39285 });
  });
  test('pouro-songlogno suffix resolves directly', async () => {
    const a = await withUser(request(app()).get(rateQ('barguna-sadar', 'খাজুরতলা (পৌর সংলগ্ন)', 'নাল'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 245068 });
    const b = await withUser(request(app()).get(rateQ('barguna-sadar', 'খাজুরতলা', 'নাল'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 61057 });
  });
  test('hat-suffix names resolve directly, base name keeps main rate', async () => {
    const a = await withUser(request(app()).get(rateQ('patharghata', 'রায়হানপুর (মিয়ারহাট)', 'ভিটা'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 30000, p: true });
    const b = await withUser(request(app()).get(rateQ('patharghata', 'রায়হানপুর', 'ভিটা'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 11256 });
  });
  test('krom-suffix names resolve directly, bare name is a miss', async () => {
    const a = await withUser(request(app()).get(rateQ('kathalia', 'রঘুয়ারচর (ক্রম 36)', 'নাল'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 9098 });
    const b = await withUser(request(app()).get(rateQ('kathalia', 'রঘুয়ারচর (ক্রম 37)', 'নাল'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 6659, p: true });
    const c = await withUser(request(app()).get(rateQ('kathalia', 'রঘুয়ারচর', 'নাল'))).expect(200);
    expect(c.body.found).toBe(false);
  });
  test('pre-suffixed names resolve verbatim, city/UP pair stays separate', async () => {
    const a = await withUser(request(app()).get(rateQ('patuakhali-sadar', 'দক্ষিণ বিঘাই (২য় সিরিজ)', 'নাল'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 18919 });
    const b = await withUser(request(app()).get(rateQ('barishal-sadar', 'চরবদনা (সিটি)', 'নাল'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 80223 });
    const c = await withUser(request(app()).get(rateQ('barishal-sadar', 'চরবদনা (ইউ.পি)', 'নাল'))).expect(200);
    expect(c.body).toMatchObject({ found: true, rate: 30261 });
  });
  test('adjudicated undecidable cells are misses, not guesses', async () => {
    const a = await withUser(request(app()).get(rateQ('chakhar-banaripara', 'ভিতরকুল', 'নাল'))).expect(200);
    expect(a.body.found).toBe(false);
    const b = await withUser(request(app()).get(rateQ('chakhar-banaripara', 'সোনার', 'ডোবা'))).expect(200);
    expect(b.body.found).toBe(false);
    const c = await withUser(request(app()).get(rateQ('chakhar-banaripara', 'ভিতরকুল', 'বাড়ী'))).expect(200);
    expect(c.body).toMatchObject({ found: true, rate: 49696 });
  });
  test('zero-rate row yields an all-null card, not not-in-table', async () => {
    const c = await withUser(request(app()).get(cardQ('bauphal', 'আমিরাবাদ (পৌরসভা তালিকা)'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    for (const cls of ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']) {
      expect(c.body.rates[cls].rate).toBeNull();
    }
  });
});

describe('POST /api/land/mouza: batch 8 lines', () => {
  test('hat-suffix line → 200', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'patharghata', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'রায়হানপুর (মিয়ারহাট)', class: 'ভিটা', rate: '30000', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'patharghata' }],
      idempotency_key: 't-batch8-patharghata-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 30000 });
  });
  test('hat-suffix line with the main rate → 400', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'patharghata', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'রায়হানপুর (মিয়ারহাট)', class: 'ভিটা', rate: '11256', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'patharghata' }],
      idempotency_key: 't-batch8-patharghata-tamper',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
  });
  test('pouro-suffix line → 200', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'bakerganj', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'রুনশি (পৌর)', class: 'নাল', rate: '415624', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'bakerganj' }],
      idempotency_key: 't-batch8-bakerganj-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 415624 });
  });
});
