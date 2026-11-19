// Route tests for backend/routes/nid-smart-card.js (NID Smart Card
// engine: upload PDF -> smart card PDF, one charge).
// The engine adapter is mocked — no Python, no real PDFs.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/nid-smart-card/adapter', () => ({
  extractFields: jest.fn(),
  buildCard: jest.fn(),
  validateJob: jest.fn(),
  hasCoreData: jest.fn(),
  missingCoreGroups: jest.fn(() => []),
  outputBase: jest.fn(() => '1010101010'),
  NO_CORE_DATA_MESSAGE: 'তথ্য অসম্পূর্ণ — নাম, জাতীয় পরিচয়পত্র নম্বর ও জন্মতারিখ ছাড়া কার্ড তৈরি করা যাবে না। সঠিক NID ফর্ম PDF আপলোড করুন। কোনো টাকা কাটা হয়নি।',
}));
jest.mock('../../utils/whatsapp', () => ({
  notifyServiceCompleted: jest.fn().mockResolvedValue({ ok: true }),
  notifyServiceFailed: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../utils/push', () => ({
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../lib/serviceCredits', () => ({
  availableFor: jest.fn().mockResolvedValue(0),
  payForService: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../lib/missingPriceAlert', () => ({
  alertMissingPrice: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const cardRouter = require('../../routes/nid-smart-card');
const adapter = require('../../../engines/nid-smart-card/adapter');
const wa = require('../../utils/whatsapp');
const push = require('../../utils/push');
const serviceCredits = require('../../lib/serviceCredits');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/nid-smart-card', cardRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());
const PDF_BUF = Buffer.from('%PDF-1.4 fake-bytes');
const FIELDS = { 'নাম:': 'পরীক্ষা নাম', 'ID NO:': '1010101010', 'Date of Birth:': '01/01/1990' };

beforeEach(() => {
  db.__reset();
  adapter.extractFields.mockReset();
  adapter.buildCard.mockReset();
  adapter.validateJob.mockReset();
  adapter.hasCoreData.mockReset();
  adapter.outputBase.mockReset();
  adapter.validateJob.mockResolvedValue({ ok: true });
  adapter.hasCoreData.mockReturnValue(true);
  adapter.outputBase.mockReturnValue('1010101010');
  wa.notifyServiceCompleted.mockClear();
  wa.notifyServiceFailed.mockClear();
  push.notifyAdmins.mockClear();
  push.notifyUser.mockClear();
  serviceCredits.availableFor.mockClear();
  serviceCredits.payForService.mockClear();
});

function priceRows(price) {
  return [
    ['FROM services WHERE', { rows: [{ id: 17, price }] }],
    ['FROM user_services WHERE', { rows: [] }],
    ['FROM users WHERE', { rows: [{ balance: 120 }] }],
  ];
}

describe('GET /api/nid-smart-card/price', () => {
  test('requires auth → 401', async () => {
    await request(app()).get('/api/nid-smart-card/price').expect(401);
  });

  test('no service row → free (price 0, allowed)', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
    ]);
    const r = await withUser(request(app()).get('/api/nid-smart-card/price')).expect(200);
    expect(r.body).toEqual({ ok: true, engineId: 'nid-smart-card', allowed: true, price: 0, balance: 120, serviceId: null });
  });

  test('service price → 200', async () => {
    db.__routeQuery(priceRows(50));
    const r = await withUser(request(app()).get('/api/nid-smart-card/price')).expect(200);
    expect(r.body).toEqual({ ok: true, engineId: 'nid-smart-card', allowed: true, price: 50, balance: 120, serviceId: 17 });
  });

  test('access disabled in user_services → 200 with allowed: false', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 17, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [{ custom_price: null, access_enabled: false }] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
    ]);
    const r = await withUser(request(app()).get('/api/nid-smart-card/price')).expect(200);
    expect(r.body.allowed).toBe(false);
  });
});

describe('POST /api/nid-smart-card/extract', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/nid-smart-card/extract').expect(401);
  });

  test('no file → 400 NO_FILE', async () => {
    const r = await withUser(request(app()).post('/api/nid-smart-card/extract')).expect(400);
    expect(r.body.error).toBe('NO_FILE');
  });

  test('non-PDF extension → 400 NOT_A_PDF', async () => {
    const r = await withUser(request(app()).post('/api/nid-smart-card/extract'))
      .attach('pdf', PDF_BUF, 'evil.exe').expect(400);
    expect(r.body.error).toBe('NOT_A_PDF');
    expect(adapter.extractFields).not.toHaveBeenCalled();
  });

  test('adapter NO_CORE_DATA → 422 with the Bengali reason', async () => {
    adapter.extractFields.mockResolvedValue({ ok: false, error: 'NO_CORE_DATA' });
    const r = await withUser(request(app()).post('/api/nid-smart-card/extract'))
      .attach('pdf', PDF_BUF, 'form.pdf').expect(422);
    expect(r.body.error).toBe('NO_CORE_DATA');
    expect(r.body.message).toMatch(/তথ্য অসম্পূর্ণ/);
  });

  test('valid PDF → 200 with jobId/fields/images', async () => {
    adapter.extractFields.mockResolvedValue({
      ok: true, jobId: 'job1', fields: FIELDS, images: [{ name: 'photo.png', dataUrl: 'data:image/png;base64,x' }],
    });
    const r = await withUser(request(app()).post('/api/nid-smart-card/extract'))
      .attach('pdf', PDF_BUF, 'form.pdf').expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.jobId).toBe('job1');
    expect(r.body.fields).toEqual(FIELDS);
    expect(adapter.extractFields).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/nid-smart-card/create', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/nid-smart-card/create').send({}).expect(401);
  });

  test('missing jobId/fields → 400', async () => {
    const r = await withUser(request(app()).post('/api/nid-smart-card/create').send({})).expect(400);
    expect(r.body.error).toBe('INVALID_REQUEST');
  });

  test('stale job → 404, no charge', async () => {
    adapter.validateJob.mockResolvedValue({ ok: false, error: 'JOB_NOT_FOUND' });
    const r = await withUser(request(app()).post('/api/nid-smart-card/create')
      .send({ jobId: 'gone', fields: FIELDS })).expect(404);
    expect(r.body.error).toBe('JOB_NOT_FOUND');
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('blanked-out fields → 422 NO_CORE_DATA, no charge', async () => {
    adapter.hasCoreData.mockReturnValue(false);
    const r = await withUser(request(app()).post('/api/nid-smart-card/create')
      .send({ jobId: 'job1', fields: {} })).expect(422);
    expect(r.body.error).toBe('NO_CORE_DATA');
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('free service → 200, order recorded, single filename, no charge', async () => {
    db.__routeQuery([
      ['FROM orders WHERE', { rows: [] }],
      ['FROM services WHERE', { rows: [{ id: 17, price: 0 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['INSERT INTO orders', { rows: [{ id: 77 }] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-smart-card/create')
      .send({ jobId: 'job1', fields: FIELDS, idempotency_key: 'nidsc-test-1' })).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.charged).toBe(0);
    expect(r.body.orderId).toBe(77);
    expect(r.body.filename).toBe('1010101010.pdf');
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
    expect(wa.notifyServiceCompleted).toHaveBeenCalled();
  });

  test('duplicate idempotency key replays without a second charge', async () => {
    db.__routeQuery([
      ['FROM orders WHERE', { rows: [{ id: 77, price: 50, status: 'completed' }] }],
      ['FROM users WHERE', { rows: [{ balance: 70 }] }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-smart-card/create')
      .send({ jobId: 'job1', fields: FIELDS, idempotency_key: 'nidsc-test-1' })).expect(200);
    expect(r.body.duplicate).toBe(true);
    expect(r.body.charged).toBe(50);
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('insufficient balance → 402, no order', async () => {
    db.__routeQuery([
      ['FROM orders WHERE', { rows: [] }],
      ['FROM services WHERE', { rows: [{ id: 17, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 10 }] }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-smart-card/create')
      .send({ jobId: 'job1', fields: FIELDS, idempotency_key: 'nidsc-test-2' })).expect(402);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });
});

describe('POST /api/nid-smart-card/pdf', () => {
  const CARD = Buffer.from('%PDF-1.4 card-bytes');

  function paidOrder() {
    db.__routeQuery([
      ['FROM orders WHERE', { rows: [{ id: 77, price: 0, status: 'completed' }] }],
    ]);
  }

  test('requires auth → 401', async () => {
    await request(app()).post('/api/nid-smart-card/pdf?idempotency_key=k').send({}).expect(401);
  });

  test('missing idempotency key → 400', async () => {
    const r = await withUser(request(app())
      .post('/api/nid-smart-card/pdf')
      .send({ jobId: 'job1', fields: FIELDS })).expect(400);
    expect(r.body.error).toBe('BAD_INPUT');
  });

  test('no paid order → 402 NOT_PAID, build never runs', async () => {
    db.__routeQuery([['FROM orders WHERE', { rows: [] }]]);
    const r = await withUser(request(app())
      .post('/api/nid-smart-card/pdf?idempotency_key=k')
      .send({ jobId: 'job1', fields: FIELDS })).expect(402);
    expect(r.body.error).toBe('NOT_PAID');
    expect(adapter.buildCard).not.toHaveBeenCalled();
  });

  test('build failure → 422, nothing downloaded', async () => {
    paidOrder();
    adapter.buildCard.mockResolvedValue({ ok: false, error: 'BUILD_FAILED' });
    const r = await withUser(request(app())
      .post('/api/nid-smart-card/pdf?idempotency_key=k')
      .send({ jobId: 'job1', fields: FIELDS })).expect(422);
    expect(r.body.error).toBe('BUILD_FAILED');
    expect(wa.notifyServiceFailed).toHaveBeenCalled();
  });

  test('build failure with a Bengali detail surfaces the real reason', async () => {
    paidOrder();
    adapter.buildCard.mockResolvedValue({
      ok: false, error: 'BUILD_FAILED',
      detail: 'ছবি পাওয়া যায়নি — টেমপ্লেটের ছবি রেখে কার্ড তৈরি করা যাবে না।',
    });
    const r = await withUser(request(app())
      .post('/api/nid-smart-card/pdf?idempotency_key=k')
      .send({ jobId: 'job1', fields: FIELDS })).expect(422);
    expect(r.body.error).toBe('BUILD_FAILED');
    expect(r.body.message).toMatch(/ছবি পাওয়া যায়নি/);
  });

  test('paid order → 200 card PDF bytes with the right filename', async () => {
    paidOrder();
    adapter.buildCard.mockResolvedValue({ ok: true, pdfBuffer: CARD });
    const r = await withUser(request(app())
      .post('/api/nid-smart-card/pdf?idempotency_key=k')
      .send({ jobId: 'job1', fields: FIELDS })).expect(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(r.headers['content-disposition']).toContain('1010101010.pdf');
    expect(Buffer.compare(Buffer.from(r.body), CARD)).toBe(0);
  });
});
