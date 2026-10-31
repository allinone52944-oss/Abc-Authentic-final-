// Mouza batch 7 (Khulna division, 2025-2026): 58 office entries covering
// 58 checklist entries (3 blocked site-side: Kushtia Sadar 2024-2025 book
// only, Aranghata no list, Islamkati-Tala served a Kolaroa document),
// 6711 source rows -> 6711 entries, 24968 class-rates, machine-transcribed
// from reader JSON and verified 0-mismatch by an independent lookup pass
// (80764 checks + frontend 373/373, kept out of the repo).
// Same-name offices kept strictly separate: kachua-bagerhat (Chattogram's
// kachua already holds the bare key) + mirpur-kushtia (Dhaka's mirpur
// already holds the bare key), daulatpur-kushtia + daulatpur-thana-khulna,
// jhenaidah-kaliganj + satkhira-kaliganj. Collision encodings: distinct
// JL -> " (JL <jl>)" suffix (35 groups); pouro pair, same JL ->
// " (পৌর)" on the pouro row only, first-clause pouro only (Shyamnagar
// 4 groups); section pair -> " (কেসিসি)" / " (মহানগর)"
// (Daulatpur-thana-khulna দেয়ানা, same JL 6); serial-only ->
// " (ক্রম <n>)" suffix (Jashore Sadar মৌজা নং, NOT JL, converted to
// ক্রম; Khulna Sadar Thana index-krom, verified against md
// cross-references 07/11, 08/12); pre-suffixed JSON names kept verbatim.
// Zero-rate rows (84) kept as entries with rates:{} (Koyra 66, Khulna
// Sadar Thana 2, Terokhada 5, Satkhira Kaliganj 4, Assasuni 4, Satkhira
// Sadar 2, Mongla 1) rather than dropped or reported not-in-table.
// Mohammadpur p-07 names re-read by the merger at 400dpi from the source
// PDF (কৈব->কৈবটি, কুম->কুমরাইল, অর->অরকুশপুর, মহ->মহসপুর,
// লক->লকীপুর, গোপালপুর (JL 125)->বর্জিয়া গোপালপুর (JL 125),
// হাসি->হাসিনা, চেক->চেকনালা; ক্রম 89 কম retained, re-read disagreed).
// Tests: data shape + totals + JL/pouro/krom/section suffix lookups +
// kachua/mirpur separation + koyra zero-rate card + p-07 corrected name
// + POST /mouza verification of suffix lines.
// Open flags for Pankaj (reader mapping decisions preserved as transcribed,
// NOT re-adjudicated): Nowapara-vs-Abhaynagar checklist item, Jashore
// Sadar period inconsistency, Mohammadpur p-08 fragment + বিল ডোবা
// ruling, Paikgachha বাড়ী-column ruling, Jhenaidah Kaliganj
// বাজার-সংলগ্ন বাণিজ্যিক ruling, Harinakunda বাস্তুভিটা ruling,
// Satkhira বাগান/বাঁশঝাড় + বাস্তু→ভিটা rulings, Narail ditto-chain +
// no-footnote stars + JL 28 ডোবা 111111, Chuadanga ফসলী + `**`
// rulings, Bagerhat বাজার-বাণিজ্য rulings, Meherpur বাণিজ্যিক-প্লট
// ruling. See land-service/rates-khulna-batch7.md.
// No portal, no real money — mocked DB like land-mouza-batch6.test.js.
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

const BATCH7 = ['chowgachha', 'nowapara', 'jhikargachha', 'jashore-sadar',
  'manirampur', 'sharsha', 'keshabpur', 'bagharpara',
  'khoksa', 'daulatpur-kushtia', 'bheramara', 'mirpur-kushtia', 'kumarkhali',
  'alamdanga', 'jibannagar', 'chuadanga-sadar', 'damurhuda',
  'jhenaidah-kaliganj', 'jhenaidah-sadar', 'jhenaidah-maheshpur',
  'jhenaidah-shailkupa', 'jhenaidah-kotchandpur', 'jhenaidah-harinakunda',
  'dakop', 'khulna-sadar-thana', 'koyra', 'rupsa', 'daulatpur-thana-khulna',
  'dumuria', 'fultala', 'botiaghata', 'dighalia', 'paikgachha', 'terokhada',
  'kalia', 'lakshmipasha', 'narail-sadar',
  'satkhira-kaliganj', 'satkhira-shyamnagar', 'satkhira-assasuni',
  'satkhira-sakhipur-debhata', 'satkhira-sadar',
  'fakirhat', 'mongla', 'morrelganj', 'mollahat', 'bagerhat-sadar', 'rampal',
  'kachua-bagerhat', 'sharankhola', 'chitalmari',
  'gangni', 'meherpur-sadar', 'mujibnagar',
  'mohammadpur-magura', 'magura-sadar', 'shalikha', 'sreepur-magura'];
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

describe('batch 7 shape + totals', () => {
  test('58 new offices, all 2025-2026, 6711 entries, 24968 class-rates, 373 total', () => {
    expect(BATCH7).toHaveLength(58);
    let entries = 0, rates = 0;
    for (const key of BATCH7) {
      const o = OFFICES[key];
      expect(o).toBeTruthy();
      expect(o.period).toBe('2025-2026');
      for (const rec of Object.values(o.mouzas)) {
        entries++;
        const variants = Array.isArray(rec.variants) ? rec.variants : [rec];
        for (const v of variants) rates += Object.keys(v.rates).length;
      }
    }
    expect(entries).toBe(6711);
    expect(rates).toBe(24968);
    expect(Object.keys(OFFICES)).toHaveLength(451);
    expect(Object.keys(OFFICES.kachua.mouzas)).toHaveLength(166);
    expect(Object.keys(OFFICES['kachua-bagerhat'].mouzas)).toHaveLength(76);
    expect(Object.keys(OFFICES.mirpur.mouzas)).toHaveLength(22);
    expect(Object.keys(OFFICES['mirpur-kushtia'].mouzas)).toHaveLength(124);
    expect(OFFICES.kachua.name).toBe('কচুয়া');
    expect(OFFICES['kachua-bagerhat'].name).toBe('কচুয়া');
    expect(OFFICES.mirpur.name).toBe('মিরপুর');
    expect(OFFICES['mirpur-kushtia'].name).toBe('মিরপুর');
  });
  test('earlier batches untouched', () => {
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'নাল', null).rate).toBe(121421);
    expect(lookupMouzaRate('patiya', 'কেশাগাঁও (JL 16)', 'নাল', null).rate).toBe(106622);
    expect(lookupMouzaRate('araihazar', 'শালমদী', 'ভিটা', null)).toMatchObject({ rate: 1388000, p: true });
    expect(lookupMouzaRate('bogura-sadar', 'নামুজা', 'নাল', null).rate).toBe(55011);
    expect(lookupMouzaRate('pirganj-rangpur', 'নছিমনপুর (মদনখালী)', 'ভিটা', null).rate).toBe(5100);
  });
});

describe('batch 7 sample lookups', () => {
  test('plain offices return printed rates', async () => {
    const a = await withUser(request(app()).get(rateQ('chowgachha', 'হোগলডাঙ্গা', 'ভিটা'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 30250, period: '2025-2026' });
    const b = await withUser(request(app()).get(rateQ('nowapara', 'ধনিরগাতী', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 16969 });
  });
  test('JL-suffix names resolve directly', async () => {
    const a = await withUser(request(app()).get(rateQ('alamdanga', 'সোনাতনপুর (JL 44)', 'নাল'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 26000 });
    const b = await withUser(request(app()).get(rateQ('alamdanga', 'সোনাতনপুর (JL 89)', 'নাল'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 18000 });
  });
  test('pouro-suffix names resolve directly, base name keeps union rate', async () => {
    const a = await withUser(request(app()).get(rateQ('satkhira-shyamnagar', 'ইছাকুড় (পৌর)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 40605 });
    const b = await withUser(request(app()).get(rateQ('satkhira-shyamnagar', 'ইছাকুড়', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 29519, p: true });
  });
  test('krom-suffix names resolve directly, bare name is a miss', async () => {
    const a = await withUser(request(app()).get(rateQ('jashore-sadar', 'এনায়েতপুর (ক্রম 5)', 'ভিটা'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 10246 });
    const b = await withUser(request(app()).get(rateQ('jashore-sadar', 'এনায়েতপুর (ক্রম 157)', 'ভিটা'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 21802 });
    const c = await withUser(request(app()).get(rateQ('jashore-sadar', 'এনায়েতপুর', 'ভিটা'))).expect(200);
    expect(c.body.found).toBe(false);
  });
  test('section-suffix names resolve directly', async () => {
    const a = await withUser(request(app()).get(rateQ('daulatpur-thana-khulna', 'দেয়ানা (কেসিসি)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 522491 });
    const b = await withUser(request(app()).get(rateQ('daulatpur-thana-khulna', 'দেয়ানা (মহানগর)', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 299364 });
  });
  test('kachua-bagerhat and mirpur-kushtia are separate from the bare-key offices', async () => {
    const a = await withUser(request(app()).get(rateQ('kachua-bagerhat', 'আলীপুর', 'ভিটা'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 19781, p: true });
    const b = await withUser(request(app()).get(rateQ('mirpur-kushtia', 'লক্ষ্মণদিয়াড়', 'নাল'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 27795 });
  });
  test('koyra zero-rate rows yield an all-null card, not not-in-table', async () => {
    const c = await withUser(request(app()).get(cardQ('koyra', 'অজ্ঞুনিয়া'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    for (const cls of ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']) {
      expect(c.body.rates[cls].rate).toBeNull();
    }
    const d = await withUser(request(app()).get(cardQ('koyra', 'আমাদী'))).expect(200);
    expect(d.body.notInTable).toBeUndefined();
    expect(d.body.rates['পুকুর']).toMatchObject({ rate: 195220, p: true });
  });
  test('mohammadpur p-07 corrected name resolves, old fragment is a miss', async () => {
    const a = await withUser(request(app()).get(rateQ('mohammadpur-magura', 'কৈবটি', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 14889 });
    const b = await withUser(request(app()).get(rateQ('mohammadpur-magura', 'কৈব', 'বাড়ী'))).expect(200);
    expect(b.body.found).toBe(false);
  });
});

describe('POST /api/land/mouza: batch 7 lines', () => {
  test('JL-suffix line → 200', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'alamdanga', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'সোনাতনপুর (JL 44)', class: 'নাল', rate: '26000', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'alamdanga' }],
      idempotency_key: 't-batch7-alamdanga-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 26000 });
  });
  test('JL-suffix line with the other JL rate → 400', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'alamdanga', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'সোনাতনপুর (JL 44)', class: 'নাল', rate: '18000', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'alamdanga' }],
      idempotency_key: 't-batch7-alamdanga-tamper',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
  });
  test('pouro-suffix line → 200', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'satkhira-shyamnagar', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'ইছাকুড় (পৌর)', class: 'বাড়ী', rate: '40605', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'satkhira-shyamnagar' }],
      idempotency_key: 't-batch7-shyamnagar-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 40605 });
  });
});
