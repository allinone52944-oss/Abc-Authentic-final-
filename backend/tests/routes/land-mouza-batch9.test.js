// Mouza batch 9 (Sylhet division, 2025-2026): 36 office entries covering
// 36 checklist entries (3 blocked site-side: Gowainghat/Sylhet 2024 book only,
// Bishwanath/Sylhet 2023-Oct-2024 book only, Golapganj/Sylhet Dhakadakshin
// document served for this selection — nothing entered for the blocked 3;
// Jaintapur + Bharan were proven by all-pages re-check and ARE entered),
// 4773 source rows -> 4773 entries, 12159 class-rates, machine-transcribed
// from reader JSON and verified 0-mismatch by an independent lookup pass
// (74116 checks + frontend 451/451, kept out of the repo).
// Collision encodings: distinct JL -> " (JL <jl>)" suffix (incl. dual-JL
// strings kept verbatim: Baniachong "SA x, Hal y", Kulaura "SA x / RS y",
// Dakshin Surma "SAx/BSy"); pouro pair, same JL -> " (পৌর)" on the pouro
// row only, other row bare (Jagannathpur, Sunamganj Sadar, Derai, Kanaighat,
// Beanibazar, Bharan, Chunarghat, Habiganj Sadar, Sreemangal, Kamalganj,
// Kulaura); union pair, same JL -> " (<union short>)" on every occurrence
// (Barlekha only; "বড়লেখা পৌরসভা" -> "পৌর"); JL-null pair -> " (ক্রম <n>)"
// (Nabiganj only, leading zero kept as printed: ক্রম 05/07); manual:
// Companiganj বিজয়পাড়া (ক্রম 8)/(ক্রম 27) from MD-verified serials, and
// Habiganj Sadar সুলতানমামুদপুর x3 (main bare, P10 pouro, P10b pouro
// sub-row " (পৌর উপসারি)" kept separate, zero-rate). thana is null
// throughout, so variants[] is NOT used. Zero-rate rows (201) kept as
// entries with rates:{} rather than dropped or reported not-in-table.
// No unit conversion anywhere. বাণিজ্যিক has no rate anywhere in Sylhet
// (দোকান columns never mapped). Dharmapasha cover names ধর্মপাশা
// (checklist Badshaganj — table headers say বাদশাগঞ্জ, ধর্মপাশা);
// keyed by the cover name, checklist_match false, flagged for Pankaj.
// Open flags for Pankaj (reader mapping decisions preserved as transcribed,
// NOT re-adjudicated): Chhatak partial file (only book p10, ক্রম 177-188;
// rows 1-176 and 189+ missing), Jagannathpur missing book p.(৮) ক্রম 63-80
// (+ possible p.(১৯) undecided; approval 262 vs table already to ক্রম 241),
// Tajpur illegible book p11 serials 119-130 (136 of 148 serials present);
// Derai/Tahirpur period tensions (2025-2026 title vs 2023-2024 closing
// lines, both recorded); Moulvibazar ও-groups (Juri বরজী ও বাগান -> বাগান
// 33, ছাড়াবাড়ী ও ভিটা -> ভিটা 10; Kulaura same treatment) and ভীট/ভীটা ->
// ভিটা (Sreemangal 11, Sadar 16) rulings; Habiganj slash-suffix cells
// (Nabiganj 15 + Chunarghat 22, first number taken); Baniachong
// খাল/বিল/নালা -> নাল (109 rates); Sadar ভিটি open (separate column,
// ref-only); Lakhai JL==row-order, ভিটা text cells ref-only (0 ভিটা rates);
// Fenchuganj JL-vs-serial, Sadar-M/Kamalganj/Sreemangal serial-vs-JL,
// Jaintapur চারা == বাগান duplication, and all cross-section varianting.
// See land-service/rates-sylhet-batch9.md.
// No portal, no real money — mocked DB like land-mouza-batch8.test.js.
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

const BATCH9 = ['jagannathpur', 'chhatak', 'tahirpur', 'sunamganjsadar',
  'jamalganj', 'dakshinsunamganj', 'derai', 'dharmapasha', 'doarabazar',
  'bishwambharpur', 'shalla',
  'sylhet_balaganj', 'sylhet_sadar', 'sylhet_fenchuganj', 'sylhet_companiganj',
  'sylhet_dakshin_surma', 'sylhet_kanaighat', 'sylhet_tajpur',
  'sylhet_beanibazar', 'sylhet_jaintapur', 'sylhet_bharan_zakiganj',
  'nabiganj', 'jalsukha-azmiriganj', 'chunarghat', 'baniachong',
  'charbhanga-madhabpur', 'habiganj-sadar', 'bahubal', 'lakhai',
  'juri', 'sreemangal', 'moulvibazar_sadar', 'barlekha', 'rajnagar',
  'kulaura', 'kamalganj'];
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

describe('batch 9 shape + totals', () => {
  test('36 new offices, all 2025-2026, 4773 entries, 12159 class-rates, 451 total', () => {
    expect(BATCH9).toHaveLength(36);
    let entries = 0, rates = 0;
    for (const key of BATCH9) {
      const o = OFFICES[key];
      expect(o).toBeTruthy();
      expect(o.period).toBe('2025-2026');
      for (const rec of Object.values(o.mouzas)) {
        entries++;
        const variants = Array.isArray(rec.variants) ? rec.variants : [rec];
        for (const v of variants) rates += Object.keys(v.rates).length;
      }
    }
    expect(entries).toBe(4773);
    expect(rates).toBe(12159);
    expect(Object.keys(OFFICES)).toHaveLength(488);
    expect(Object.keys(OFFICES.jagannathpur.mouzas)).toHaveLength(250);
    expect(Object.keys(OFFICES.sylhet_kanaighat.mouzas)).toHaveLength(261);
    expect(Object.keys(OFFICES.barlekha.mouzas)).toHaveLength(178);
    expect(Object.keys(OFFICES.nabiganj.mouzas)).toHaveLength(232);
    expect(OFFICES.dharmapasha.name).toBe('ধর্মপাশা');
    expect(OFFICES.sunamganjsadar.name).toBe('সদর, সুনামগঞ্জ');
    expect(OFFICES.sylhet_bharan_zakiganj.name).toBe('ভরণ, জকিগঞ্জ, সিলেট');
    expect(OFFICES['jalsukha-azmiriganj'].name).toBe('জলসুখা, আজমিরীগঞ্জ');
  });
  test('earlier batches untouched', () => {
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'নাল', null).rate).toBe(121421);
    expect(lookupMouzaRate('patiya', 'কেশাগাঁও (JL 16)', 'নাল', null).rate).toBe(106622);
    expect(lookupMouzaRate('araihazar', 'শালমদী', 'ভিটা', null)).toMatchObject({ rate: 1388000, p: true });
    expect(lookupMouzaRate('bogura-sadar', 'নামুজা', 'নাল', null).rate).toBe(55011);
    expect(lookupMouzaRate('pirganj-rangpur', 'নছিমনপুর (মদনখালী)', 'ভিটা', null).rate).toBe(5100);
    expect(lookupMouzaRate('chakhar-banaripara', 'ভিতরকুল', 'বাড়ী', null).rate).toBe(49696);
  });
});

describe('batch 9 sample lookups', () => {
  test('plain offices return printed rates', async () => {
    const a = await withUser(request(app()).get(rateQ('jagannathpur', 'শেরপুর', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 34182, period: '2025-2026' });
  });
  test('JL-suffix names resolve directly', async () => {
    const a = await withUser(request(app()).get(rateQ('sunamganjsadar', 'আহমদপুর (JL 111)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 362354 });
    const b = await withUser(request(app()).get(rateQ('sunamganjsadar', 'আহমদপুর (JL 22)', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 40983 });
  });
  test('pouro-suffix names resolve directly, base name keeps union rate', async () => {
    const a = await withUser(request(app()).get(rateQ('jagannathpur', 'শ্রীরামপুর (পৌর)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 28258 });
    const b = await withUser(request(app()).get(rateQ('jagannathpur', 'শ্রীরামপুর', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 2519, p: true });
    const c = await withUser(request(app()).get(rateQ('derai', 'ভরারগাঁও (পৌর)', 'বাড়ী'))).expect(200);
    expect(c.body).toMatchObject({ found: true, rate: 1433, p: true });
    const d = await withUser(request(app()).get(rateQ('derai', 'ভরারগাঁও', 'বাড়ী'))).expect(200);
    expect(d.body).toMatchObject({ found: true, rate: 27826 });
  });
  test('krom-suffix names resolve directly, bare name is a miss', async () => {
    const a = await withUser(request(app()).get(rateQ('nabiganj', 'ফতেপুর (ক্রম 05)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 25206 });
    const b = await withUser(request(app()).get(rateQ('nabiganj', 'ফতেপুর (ক্রম 48)', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 13300, p: true });
    const c = await withUser(request(app()).get(rateQ('nabiganj', 'ফতেপুর', 'বাড়ী'))).expect(200);
    expect(c.body.found).toBe(false);
  });
  test('union-suffix names resolve directly (Barlekha duplicate-print pair)', async () => {
    const a = await withUser(request(app()).get(rateQ('barlekha', 'বজনপুর (বর্ণি)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 7679, p: true });
    const b = await withUser(request(app()).get(rateQ('barlekha', 'বজনপুর (দাসেরবাজার)', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 7679, p: true });
  });
  test('manual krom names resolve directly (Companiganj duplicate entry)', async () => {
    const a = await withUser(request(app()).get(rateQ('sylhet_companiganj', 'বিজয়পাড়া (ক্রম 8)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 4927, p: true });
    const b = await withUser(request(app()).get(rateQ('sylhet_companiganj', 'বিজয়পাড়া (ক্রম 27)', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 5063 });
  });
  test('manual pouro sub-row resolves, zero-rate sub-row yields an all-null card', async () => {
    const a = await withUser(request(app()).get(rateQ('habiganj-sadar', 'সুলতানমামুদপুর (পৌর)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 622684 });
    const c = await withUser(request(app()).get(cardQ('habiganj-sadar', 'সুলতানমামুদপুর (পৌর উপসারি)'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    for (const cls of ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']) {
      expect(c.body.rates[cls].rate).toBeNull();
    }
  });
  test('zero-rate cross-section row yields an all-null card, pouro row keeps its rate', async () => {
    const c = await withUser(request(app()).get(cardQ('sylhet_kanaighat', 'উত্তর দলই মাটি'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    for (const cls of ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']) {
      expect(c.body.rates[cls].rate).toBeNull();
    }
    const a = await withUser(request(app()).get(rateQ('sylhet_kanaighat', 'উত্তর দলই মাটি (পৌর)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 23166, p: true });
  });
});
