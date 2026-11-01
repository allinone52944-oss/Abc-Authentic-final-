// Mouza batch 10 (Mymensingh division, 2025-2026) — the FINAL division:
// 37 office entries covering 37 checklist entries (0 blocked: Dewanganj was
// NOT blocked — its mirrored-viewer document was downloaded, flipped offline,
// and office + period proven from flipped content), 5258 source rows ->
// 5258 entries, 12762 class-rates (engine classes only), machine-transcribed
// from reader JSON and verified 0-mismatch by an independent lookup pass
// (80320 checks + frontend 488/488, kept out of the repo).
// Input adjudications (see land-service/rates-mymensingh-batch10.md):
// - Mymensingh district file = the reader's RECONCILED build (2268/5712),
//   verified per-office against the MD table + class breakdown; NOT the
//   parallel worker's pure file (2268/5732): Kandipara kept first reader's
//   (73/163) and Tarakanda kept first reader's (176/416), Gafargaon +
//   Phulbaria + Nandail adopted from the parallel worker (incl. Gafargaon
//   ক্রম 88 দোগাছিয়া with the crop-verified কান্দা correction).
// - Netrokona file = batch10-netrokona-COMPETING-1638.json, PROVEN to be the
//   MD author's build (build-netrokona.py reproduces it byte-identically;
//   work-netrokona.md's fresh transcriptions match its names). The file named
//   batch10-netrokona.json (3610 rates) is a superseded earlier build.
// - Sherpur normalisation: reader rates hold ALL book classes (45 keys).
//   Expanded to engine classes only: bare engine classes kept; slash groups
//   expanded at the SAME rate to each engine member (standing group rule;
//   0 group+bare conflicts); groups with no engine member and all other
//   non-engine classes dropped to ref-only (1419 cells, kept in reader JSON
//   + data file). Sherpur engine total 943 (542 bare + 401 group-expanded),
//   NOT the reader's all-classes 2186 — so the division class-rate total is
//   12762, not 14025.
// - Durgapur collision: existing rates.js 'durgapur' is Rajshahi's office, so
//   Netrokona's Durgapur enters as 'durgapur-netrokona' (name_bn stays
//   দুর্গাপুর, following pirganj-rangpur/pirganj-thakurgaon precedent).
// - Dewanganj null names (11): entered as JL-suffixed keys, rates preserved,
//   names NOT invented — p2 rows "(JL 47)", "(JL 40, ক্রম 8)",
//   "(JL 40, ক্রম 7)", "(JL 01/07/08/41/49/50)"; p4 rows "চর (JL 23)" /
//   "চর (JL 24)" (first word only). A second 400dpi name pass failed: the
//   embedded scan is only ~258ppi, so no sharper source exists in the PDF.
// Collision encodings: distinct JL -> " (JL <jl>)" suffix (Dewanganj stacked
// JL "02/24" kept verbatim where it occurs); pouro pair, same JL ->
// " (পৌর)" on the pouro row only, other row bare (Sreebardi, Nalitabari,
// Sherpur Sadar, Islampur, Bakshiganj, Netrokona Sadar, Durgapur-Netrokona);
// krom pair -> " (ক্রম <n>)" (Nakla, Nandail same-JL pairs); thana is null
// throughout, so variants[] is NOT used. Zero-rate rows (140) kept as
// entries with rates:{} rather than dropped. No unit conversion anywhere.
// নামা/কান্দা are NOT mapped to নাল (Mymensingh + Sherpur + Netrokona
// books use কান্দা/নামা instead of নাল; promotion is an open ruling for
// Pankaj, mechanically reversible). No portal, no real money — mocked DB
// like land-mouza-batch9.test.js.
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

const BATCH10 = ['ishwarganj', 'pagla', 'haluaghat', 'dhobaura', 'phulpur',
  'gafargaon', 'trishal', 'gouripur', 'muktagachha', 'mymensingh-sadar',
  'bhaluka', 'phulbaria', 'kandipara', 'nandail', 'tarakanda',
  'sreebardi', 'nalitabari', 'sherpur_sadar', 'nakla', 'jhenaigati',
  'islampur', 'jamalpur-sadar', 'melandaha', 'madarganj', 'bakshiganj',
  'sarishabari',
  'netrokona_sadar', 'atpara', 'kendua', 'mohanganj', 'purbadhala',
  'durgapur-netrokona', 'madan', 'barhatta', 'khaliajuri', 'kalmakanda',
  'jamalpur_dewanganj'];
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

describe('batch 10 shape + totals', () => {
  test('37 new offices, all 2025-2026, 5258 entries, 12762 class-rates, 488 total', () => {
    expect(BATCH10).toHaveLength(37);
    let entries = 0, rates = 0;
    for (const key of BATCH10) {
      const o = OFFICES[key];
      expect(o).toBeTruthy();
      expect(o.period).toBe('2025-2026');
      for (const rec of Object.values(o.mouzas)) {
        entries++;
        const variants = Array.isArray(rec.variants) ? rec.variants : [rec];
        for (const v of variants) rates += Object.keys(v.rates).length;
      }
    }
    expect(entries).toBe(5258);
    expect(rates).toBe(12762);
    expect(Object.keys(OFFICES)).toHaveLength(488);
    expect(Object.keys(OFFICES['mymensingh-sadar'].mouzas)).toHaveLength(136);
    expect(Object.keys(OFFICES['jamalpur-sadar'].mouzas)).toHaveLength(323);
    expect(Object.keys(OFFICES['netrokona_sadar'].mouzas)).toHaveLength(278);
    expect(Object.keys(OFFICES['jamalpur_dewanganj'].mouzas)).toHaveLength(50);
    expect(OFFICES['durgapur-netrokona'].name).toBe('দুর্গাপুর');
    expect(OFFICES.durgapur.name).toBe('দুর্গাপুর');
    expect(OFFICES['mymensingh-sadar'].name).toBe('ময়মনসিংহ সদর');
  });
  test('earlier batches untouched', () => {
    expect(lookupMouzaRate('boalkhali', 'কধুরখীল', 'নাল', null).rate).toBe(121425);
    expect(lookupMouzaRate('araihazar', 'শালমদী', 'ভিটা', null)).toMatchObject({ rate: 1388000, p: true });
    expect(lookupMouzaRate('bogura-sadar', 'নামুজা', 'নাল', null).rate).toBe(55011);
    expect(lookupMouzaRate('chakhar-banaripara', 'ভিতরকুল', 'বাড়ী', null).rate).toBe(49696);
    expect(lookupMouzaRate('jagannathpur', 'শেরপুর', 'বাড়ী', null).rate).toBe(34182);
  });
});

describe('batch 10 sample lookups', () => {
  test('plain offices return printed rates', async () => {
    const a = await withUser(request(app()).get(rateQ('ishwarganj', 'কাকনহাটী', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 104229, period: '2025-2026' });
  });
  test('JL-suffix names resolve directly', async () => {
    const a = await withUser(request(app()).get(rateQ('jamalpur-sadar', 'মির্জাপুর (JL 19)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 72552 });
    const b = await withUser(request(app()).get(rateQ('jamalpur-sadar', 'মির্জাপুর (JL 128)', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 73625 });
  });
  test('pouro-suffix names resolve directly (Sreebardi + Durgapur-Netrokona)', async () => {
    const a = await withUser(request(app()).get(rateQ('sreebardi', 'শ্রীবরদী (পৌর)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 357838 });
    const b = await withUser(request(app()).get(rateQ('sreebardi', 'শ্রীবরদী', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 49026 });
    const c = await withUser(request(app()).get(rateQ('durgapur-netrokona', 'শৈলাডহর (পৌর)', 'বাড়ী'))).expect(200);
    expect(c.body).toMatchObject({ found: true, rate: 54776 });
    const d = await withUser(request(app()).get(rateQ('durgapur-netrokona', 'শৈলাডহর', 'বাড়ী'))).expect(200);
    expect(d.body).toMatchObject({ found: true, rate: 2400, p: true });
  });
  test('krom-suffix names resolve directly (Nakla)', async () => {
    const a = await withUser(request(app()).get(rateQ('nakla', 'মাউড়া (ক্রম 66)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 1400, p: true });
    const b = await withUser(request(app()).get(rateQ('nakla', 'মাউড়া (ক্রম 93)', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 17910, p: true });
  });
  test('Dewanganj JL-suffixed null-name entries resolve (names never invented)', async () => {
    const a = await withUser(request(app()).get(rateQ('jamalpur_dewanganj', '(JL 47)', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 37445 });
    const b = await withUser(request(app()).get(rateQ('jamalpur_dewanganj', 'চর (JL 23)', 'বাড়ী'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 707, p: true });
    const c = await withUser(request(app()).get(rateQ('jamalpur_dewanganj', '(JL 40, ক্রম 8)', 'বাড়ী'))).expect(200);
    expect(c.body).toMatchObject({ found: true, rate: 54535 });
  });
  test('Sherpur slash-group expansion: same rate on both engine members', async () => {
    const a = await withUser(request(app()).get(rateQ('nalitabari', 'অভয়পুর', 'বাড়ী'))).expect(200);
    expect(a.body).toMatchObject({ found: true, rate: 830, p: true });
    const b = await withUser(request(app()).get(rateQ('nalitabari', 'অভয়পুর', 'ভিটা'))).expect(200);
    expect(b.body).toMatchObject({ found: true, rate: 830, p: true });
  });
  test('zero-rate row yields an all-null card', async () => {
    const c = await withUser(request(app()).get(cardQ('ishwarganj', 'ঈশ্বরপুর গোবিন্দপুর'))).expect(200);
    expect(c.body.notInTable).toBeUndefined();
    for (const cls of ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']) {
      expect(c.body.rates[cls].rate).toBeNull();
    }
  });
});
