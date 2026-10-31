// Mouza batch 3 (Chattogram division remainder, 2025-2026): 63 office
// entries covering 64 checklist entries (chauddagram-gunabati is one
// combined schedule for চৌদ্দগ্রাম + গুণবতী; Bijoyanagar blocked — no
// schedule file on the site), 7001 source rows, 6904 entries, 37724
// class-rates, machine-transcribed from reader JSON + Noakhali notes and
// verified 0-mismatch by an independent lookup pass (104885 checks,
// kept out of the repo). Tests: data shape + totals + thana/union
// variants + JL/poura/kromik suffix names + Basurhat exact decimals +
// বাণিজ্যিক where printed + zero-rate cards + Chatkhil rate-less names
// + POST /mouza verification of qualified and suffix lines.
// No portal, no real money — mocked DB like land-mouza-batch2.test.js.
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

const BATCH3 = ['begumganj', 'chatkhil', 'hatiya', 'basurhat-companiganj', 'kabirhat',
  'senbagh', 'noakhali-sadar', 'subarnachar', 'sonaimuri',
  'kasba', 'brahmanbaria-sadar', 'sarail', 'akhaura', 'nasirnagar', 'ashuganj',
  'bancharampur', 'nabinagar',
  'kutubdia', 'pekua', 'maheshkhali', 'chakaria', 'coxsbazar-sadar', 'ramu', 'teknaf', 'ukhia',
  'chandraganj', 'ramgati', 'lakshmipur-sadar', 'ramganj', 'raipur', 'kamalnagar',
  'haimchar', 'faridganj', 'kachua', 'hajiganj', 'chandpur-sadar', 'matlab-dakshin',
  'matlab-uttar', 'chitoshi-shahrasti',
  'laksam', 'daudkandi', 'manoharganj', 'adarsha-sadar', 'brahmanpara', 'nangalkot',
  'chauddagram-gunabati', 'burichang', 'muradnagar', 'chandina', 'debidwar', 'titas',
  'barura', 'homna', 'meghna', 'cumilla-sadar-dakshin', 'gauripur',
  'lemua-feni-sadar', 'parshuram', 'chhagalnaiya', 'motiganj-sonagazi', 'feni-sadar',
  'daganbhuiyan', 'fulgazi'];
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

describe('batch 3 shape + totals', () => {
  test('63 new offices, all 2025-2026, 6904 entries, 37724 class-rates, 254 total', () => {
    expect(BATCH3).toHaveLength(63);
    let entries = 0, rates = 0;
    for (const key of BATCH3) {
      const o = OFFICES[key];
      expect(o).toBeTruthy();
      expect(o.period).toBe('2025-2026');
      for (const rec of Object.values(o.mouzas)) {
        entries++;
        const variants = Array.isArray(rec.variants) ? rec.variants : [rec];
        for (const v of variants) rates += Object.keys(v.rates).length;
      }
    }
    expect(entries).toBe(6904);
    expect(rates).toBe(37724);
    expect(Object.keys(OFFICES)).toHaveLength(254);
    expect(OFFICES.bijoyanagar).toBeUndefined();
  });
  test('earlier batches untouched', () => {
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'নাল', null).rate).toBe(121421);
    expect(lookupMouzaRate('patiya', 'কেশাগাঁও (JL 16)', 'নাল', null).rate).toBe(106622);
  });
});

describe('batch 3 sample lookups', () => {
  test('plain offices return printed rates', async () => {
    const cases = [
      ['begumganj', 'আলীপুর(১)', 'নাল', 475228],
      ['chatkhil', 'মানিকপুর', 'নাল', 15324],
      ['kutubdia', 'বড়ঘোপ', 'নাল', 54791],
      ['chandraganj', 'পশ্চিম শেরপুর', 'নাল', 35312],
      ['kasba', 'কসবা', 'নাল', 141043],
      ['teknaf', 'সাবরাং', 'নাল', 53497],
    ];
    for (const [office, mouza, cls, rate] of cases) {
      const r = await withUser(request(app()).get(rateQ(office, mouza, cls))).expect(200);
      expect(r.body).toMatchObject({ found: true, rate, period: '2025-2026' });
    }
  });
  test('Chauddagram thana variants: ambiguous without thana, exact with thana', async () => {
    const amb = await withUser(request(app()).get(rateQ('chauddagram-gunabati', 'শ্রীপুর', 'নাল'))).expect(200);
    expect(amb.body.ambiguous).toBe(true);
    expect(amb.body.options).toEqual(expect.arrayContaining(
      ['চৌদ্দগ্রাম পৌরসভা', '৩ নং কালিকাপুর', '৪ নং শ্রীপুর', '১২ নং গুণবতী']));
    const q = await withUser(request(app()).get(rateQ('chauddagram-gunabati', 'শ্রীপুর', 'নাল', 'চৌদ্দগ্রাম পৌরসভা'))).expect(200);
    expect(q.body).toMatchObject({ found: true, rate: 106009, thana: 'চৌদ্দগ্রাম পৌরসভা' });
    const q2 = await withUser(request(app()).get(rateQ('chauddagram-gunabati', 'শ্রীপুর', 'নাল', '৪ নং শ্রীপুর'))).expect(200);
    expect(q2.body).toMatchObject({ found: true, rate: 54373 });
  });
  test('Adarsha-sadar union variants resolve by union thana', async () => {
    const amb = await withUser(request(app()).get(rateQ('adarsha-sadar', 'আমতলী', 'নাল'))).expect(200);
    expect(amb.body.ambiguous).toBe(true);
    const q = await withUser(request(app()).get(rateQ('adarsha-sadar', 'আমতলী', 'নাল', 'সেনা এলাকা'))).expect(200);
    expect(q.body).toMatchObject({ found: true, rate: 646676 });
  });
  test('JL/poura/kromik suffix names resolve directly', async () => {
    const j = await withUser(request(app()).get(rateQ('begumganj', 'আবদুল্যাপুর (JL 199)', 'নাল'))).expect(200);
    expect(j.body).toMatchObject({ found: true, rate: 37312 });
    const p = await withUser(request(app()).get(rateQ('chakaria', 'কাকারা (পৌর)', 'নাল'))).expect(200);
    expect(p.body).toMatchObject({ found: true, rate: 59617 });
    const g = await withUser(request(app()).get(rateQ('chakaria', 'কাকারা', 'নাল'))).expect(200);
    expect(g.body).toMatchObject({ found: true, rate: 63855 });
    const k = await withUser(request(app()).get(rateQ('ramu', 'কাউয়ারখোপ (ক্রম 3)', 'নাল'))).expect(200);
    expect(k.body).toMatchObject({ found: true, rate: 15030 });
    const k2 = await withUser(request(app()).get(rateQ('ramu', 'কাউয়ারখোপ (ক্রম 6)', 'নাল'))).expect(200);
    expect(k2.body).toMatchObject({ found: true, rate: 20007 });
  });
  test('Basurhat decimals kept exact', async () => {
    const r = await withUser(request(app()).get(rateQ('basurhat-companiganj', 'করালিয়া', 'নাল'))).expect(200);
    expect(r.body).toMatchObject({ found: true, rate: 597365.52 });
    const b = await withUser(request(app()).get(rateQ('basurhat-companiganj', 'করালিয়া', 'বাগান'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 313333 });
  });
  test('বাণিজ্যিক only where the schedule prints it', async () => {
    const pos = await withUser(request(app()).get(rateQ('nangalkot', 'পূর্ব টৈয়ারা', 'বাণিজ্যিক'))).expect(200);
    expect(pos.body).toMatchObject({ found: true, rate: 33333 });
    for (const key of BATCH3) {
      if (['laksam', 'nangalkot', 'burichang'].includes(key)) continue;
      const first = Object.keys(OFFICES[key].mouzas)[0];
      const r = await withUser(request(app()).get(rateQ(key, first, 'বাণিজ্যিক'))).expect(200);
      expect(r.body.found).toBe(false);
    }
  });
  test('zero-rate rows yield an all-null card, not not-in-table', async () => {
    for (const [office, mouza] of [['muradnagar', 'তেতুইতলা'], ['debidwar', 'রন পাগল']]) {
      const c = await withUser(request(app()).get(cardQ(office, mouza))).expect(200);
      expect(c.body.notInTable).toBeUndefined();
      for (const cls of ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']) {
        expect(c.body.rates[cls].rate).toBeNull();
      }
    }
  });
  test('Chatkhil conflicting names: base rates:{} but JL-103 row recoverable', async () => {
    const c = await withUser(request(app()).get(cardQ('chatkhil', 'টবগা'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    for (const cls of ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা']) {
      expect(c.body.rates[cls].rate).toBeNull();
    }
    const g = await withUser(request(app()).get(rateQ('chatkhil', 'গোবিন্দপুর (JL 103)', 'নাল'))).expect(200);
    expect(g.body).toMatchObject({ found: true, rate: 20087 });
  });
});

describe('POST /api/land/mouza: batch 3 lines', () => {
  test('Chauddagram qualified line → 200', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'chauddagram-gunabati', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'শ্রীপুর', class: 'নাল', rate: '106009', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'chauddagram-gunabati', lookupThana: 'চৌদ্দগ্রাম পৌরসভা' }],
      idempotency_key: 't-batch3-chauddagram-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 106009 });
    expect(r.body.lines[0]).toMatchObject({ source: 'lookup', lookupThana: 'চৌদ্দগ্রাম পৌরসভা', value: 106009 });
  });
  test('Chauddagram qualified line with wrong thana → 400', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'chauddagram-gunabati', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'শ্রীপুর', class: 'নাল', rate: '106009', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'chauddagram-gunabati', lookupThana: '৪ নং শ্রীপুর' }],
      idempotency_key: 't-batch3-chauddagram-thana',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
  });
  test('Begumganj JL-suffix line → 200 (no thana needed)', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'begumganj', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'আবদুল্যাপুর (JL 199)', class: 'নাল', rate: '37312', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'begumganj' }],
      idempotency_key: 't-batch3-begumganj-ok',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalMinimum: 37312 });
  });
  test('Begumganj suffix line with tampered rate → 400, wallet untouched', async () => {
    const r = await withUser(request(app()).post('/api/land/mouza')).send({
      office: 'begumganj', schedule_version: '2025-2026', declared_price: '',
      lines: [{ mouza: 'আবদুল্যাপুর (JL 199)', class: 'নাল', rate: '37313', amount: '1', unit: 'shatangsho',
        source: 'lookup', lookupOffice: 'begumganj' }],
      idempotency_key: 't-batch3-begumganj-tamper',
    }).expect(400);
    expect(r.body.error).toBe('LOOKUP_RATE_MISMATCH');
    const walletCalls = db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
    expect(walletCalls).toHaveLength(0);
  });
});
