// Mouza wizard rate-card download (GET /api/land/mouza-rate-card):
// FREE PDF of exactly the card on step 2, in the picked unit.
// Rates come from rates.js through lookupMouzaCard — the SAME
// source as GET /mouza-rates — so card and PDF cannot disagree.
// No portal, no real money — mocked DB like land-mouza-wizard.
// No order/charge record may be created by the download.
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
const auth = require('../../auth');
const db = require('../../db');
const landRouter = require('../../routes/land');
const { lookupMouzaCard } = require('../../../engines/land-mouza-value/rates');
const {
  convertCardRate, rateCardRows, groupBn, buildMouzaRateCardPdf, rateCardDisclaimer,
} = require('../../lib/mouzaRateCardPdf');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/land', landRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());
// Binary PDF answers need explicit buffering, else superagent
// leaves res.body empty for application/pdf.
const pdfGet = (url) => withUser(request(app()).get(url).buffer(true));
const dl = (office, mouza, thana, unit) =>
  '/api/land/mouza-rate-card?office=' + encodeURIComponent(office) +
  '&mouza=' + encodeURIComponent(mouza) +
  (thana ? '&thana=' + encodeURIComponent(thana) : '') +
  (unit ? '&unit=' + encodeURIComponent(unit) : '');
const cardUrl = (office, mouza, thana) =>
  '/api/land/mouza-rates?office=' + encodeURIComponent(office) +
  '&mouza=' + encodeURIComponent(mouza) +
  (thana ? '&thana=' + encodeURIComponent(thana) : '');

// Audit #13 — the rate card IS the manual table's copy: the
// disclaimer must say so, and that no portal lookup verified it.
describe('rateCardDisclaimer', () => {
  test('names the manual table and the missing portal verification', () => {
    const d = rateCardDisclaimer();
    expect(d).toContain('ম্যানুয়াল হার-টেবিল');
    expect(d).toContain('সরকারি পোর্টাল থেকে যাচাই করা হয়নি');
    expect(d).toContain('সার্টিফাইড কপি নয়');
    expect(d).toContain('সাব-রেজিস্ট্রার অফিসে যাচাই করুন');
  });
});

describe('rate-card unit conversion (same factors as calc.js)', () => {
  test('every unit against the Boalkhali proof rate 121421', () => {
    expect(convertCardRate(121421, 'shatangsho')).toBe(121421);
    expect(convertCardRate(121421, 'katha')).toBe(200344.65);
    expect(convertCardRate(121421, 'bigha')).toBe(4006893);
    expect(convertCardRate(121421, 'gonda')).toBe(242842);
  });
  test('every unit against the live-card rate 687088 (chandgaon মোহরা নাল)', () => {
    expect(convertCardRate(687088, 'shatangsho')).toBe(687088);
    expect(convertCardRate(687088, 'katha')).toBe(1133695.2);
    expect(convertCardRate(687088, 'bigha')).toBe(22673904);
    expect(convertCardRate(687088, 'gonda')).toBe(1374176);
  });
  test('null stays null (no rate) — never 0 — in every unit', () => {
    for (const u of ['shatangsho', 'katha', 'bigha', 'gonda']) {
      expect(convertCardRate(null, u)).toBeNull();
      expect(convertCardRate(undefined, u)).toBeNull();
    }
  });
  test('rows keep card order, P flag and pouro note ride along', () => {
    const card = lookupMouzaCard('sandwip', 'কাহিয়াপাড়');
    const rows = rateCardRows(card, 'gonda');
    expect(rows.map((r) => r.cls)).toEqual(['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']);
    const puk = rows.find((r) => r.cls === 'পুকুর');
    expect(puk.rate).toBe(39902 * 2);
    expect(puk.pouroNote).toContain('59266');
    expect(rows.find((r) => r.cls === 'বাণিজ্যিক').rate).toBeNull();
  });
  test('grouped Bengali digits match the wizard card format', () => {
    expect(groupBn(121421)).toBe('১,২১,৪২১');
    expect(groupBn(687088)).toBe('৬,৮৭,০৮৮');
    expect(groupBn(1133695.2)).toBe('১১,৩৩,৬৯৫.২');
  });
});

describe('GET /api/land/mouza-rate-card', () => {
  test('PDF for the live card: chandgaon মোহরা, নাল 687088 per শতাংশ', async () => {
    const r = await pdfGet(dl('chandgaon', 'মোহরা', null, 'shatangsho'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(r.headers['content-disposition']).toMatch(/attachment/);
    expect(Buffer.isBuffer(r.body) || r.body instanceof Uint8Array).toBe(true);
    expect(Buffer.from(r.body).slice(0, 4).toString()).toBe('%PDF');
    expect(Buffer.from(r.body).length).toBeGreaterThan(1000);
    // Consistency with the on-screen card: the SAME card object
    // the /mouza-rates endpoint returns, run through the SAME
    // converter the PDF builder uses.
    const c = await withUser(request(app()).get(cardUrl('chandgaon', 'মোহরা')));
    expect(c.body.found).toBe(true);
    expect(c.body.rates['নাল'].rate).toBe(687088);
    expect(rateCardRows(c.body, 'shatangsho').find((x) => x.cls === 'নাল').rate).toBe(687088);
    expect(rateCardRows(c.body, 'gonda').find((x) => x.cls === 'নাল').rate).toBe(1374176);
  });
  test('PDF in another unit (gonda) still comes back a PDF', async () => {
    const r = await pdfGet(dl('chandgaon', 'মোহরা', null, 'gonda'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(Buffer.from(r.body).slice(0, 4).toString()).toBe('%PDF');
  });
  test('thana-qualified card downloads (chandgaon বাকলিয়া, চান্দগাঁও variant)', async () => {
    const r = await pdfGet(dl('chandgaon', 'বাকলিয়া', 'চান্দগাঁও', 'katha'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
  });
  test('builder alone returns a valid PDF buffer for a real card', async () => {
    const card = lookupMouzaCard('boalkhali', 'কধুরখীল');
    const pdf = await buildMouzaRateCardPdf({ card, unit: 'bigha', when: '৩১ অক্টোবর, ২০২৬' });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(1000);
  });
  test('unknown unit → 400, never a PDF', async () => {
    const r = await withUser(request(app()).get(dl('chandgaon', 'মোহরা', null, 'acre')));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('BAD_UNIT');
  });
  test('unknown office / mouza → miss JSON, not a crash', async () => {
    const noOffice = await withUser(request(app()).get(dl('no-such-office', 'মোহরা')));
    expect(noOffice.status).toBe(200);
    expect(noOffice.body.found).toBe(false);
    expect(noOffice.body.miss).toBe('OFFICE_NOT_COVERED');
    const noMouza = await withUser(request(app()).get(dl('chandgaon', 'নেই-এমন-মৌজা')));
    expect(noMouza.status).toBe(200);
    expect(noMouza.body.found).toBe(false);
    expect(noMouza.body.miss).toBe('MOUZA_NOT_IN_TABLE');
  });
  test('missing office/mouza → 400; no token → 401', async () => {
    const bad = await withUser(request(app()).get('/api/land/mouza-rate-card?office=chandgaon'));
    expect(bad.status).toBe(400);
    const anon = await request(app()).get(dl('chandgaon', 'মোহরা'));
    expect(anon.status).toBe(401);
  });
  test('no order / charge / wallet record is created by the download', async () => {
    db.query.mockClear();
    const r = await pdfGet(dl('chandgaon', 'মোহরা', null, 'shatangsho'));
    expect(r.status).toBe(200);
    const sqls = db.query.mock.calls.map((c) => String(c[0] || ''));
    expect(sqls.filter((s) => /orders|wallet|charge/i.test(s))).toEqual([]);
    expect(sqls).toEqual([]);
  });
});
