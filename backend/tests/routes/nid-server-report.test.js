// Route tests for backend/routes/nid-server-report.js (NID Server
// Copy Report engine: upload PDF -> v1 + v2 reports, one charge).
// The engine adapter is mocked — no Python, no real PDFs.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/nid-server-report/adapter', () => ({
  extractFields: jest.fn(),
  buildReports: jest.fn(),
  validateJob: jest.fn(),
  hasCoreData: jest.fn(),
  missingCoreGroups: jest.fn(() => []),
  outputBase: jest.fn(() => '1010101010'),
  NO_CORE_DATA_MESSAGE: 'তথ্য অসম্পূর্ণ — নাম, জাতীয় পরিচয়পত্র নম্বর ও জন্মতারিখ ছাড়া সার্ভার কপি রিপোর্ট তৈরি করা যাবে না। সঠিক NID ফর্ম PDF আপলোড করুন। কোনো টাকা কাটা হয়নি।',
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
const reportRouter = require('../../routes/nid-server-report');
const adapter = require('../../../engines/nid-server-report/adapter');
const wa = require('../../utils/whatsapp');
const push = require('../../utils/push');
const serviceCredits = require('../../lib/serviceCredits');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/nid-server-report', reportRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());
const PDF_BUF = Buffer.from('%PDF-1.4 fake-bytes');
const FIELDS = { 'Name(Bangla)': 'পরীক্ষা নাম', 'National ID': '1010101010', 'Date of Birth': '01/01/1990' };

beforeEach(() => {
  db.__reset();
  adapter.extractFields.mockReset();
  adapter.buildReports.mockReset();
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
    ['FROM services WHERE', { rows: [{ id: 16, price }] }],
    ['FROM user_services WHERE', { rows: [] }],
    ['FROM users WHERE', { rows: [{ balance: 120 }] }],
  ];
}

describe('GET /api/nid-server-report/price', () => {
  test('requires auth → 401', async () => {
    await request(app()).get('/api/nid-server-report/price').expect(401);
  });

  test('no service row → free (price 0, allowed)', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
    ]);
    const r = await withUser(request(app()).get('/api/nid-server-report/price')).expect(200);
    expect(r.body).toEqual({ ok: true, engineId: 'nid-server-report', allowed: true, price: 0, balance: 120, serviceId: null });
  });

  test('service price → 200', async () => {
    db.__routeQuery(priceRows(50));
    const r = await withUser(request(app()).get('/api/nid-server-report/price')).expect(200);
    expect(r.body).toEqual({ ok: true, engineId: 'nid-server-report', allowed: true, price: 50, balance: 120, serviceId: 16 });
  });

  test('access disabled in user_services → 200 with allowed: false', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 16, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [{ custom_price: null, access_enabled: false }] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
    ]);
    const r = await withUser(request(app()).get('/api/nid-server-report/price')).expect(200);
    expect(r.body.allowed).toBe(false);
  });
});

describe('POST /api/nid-server-report/extract', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/nid-server-report/extract').expect(401);
  });

  test('no file → 400 NO_FILE', async () => {
    const r = await withUser(request(app()).post('/api/nid-server-report/extract')).expect(400);
    expect(r.body.error).toBe('NO_FILE');
  });

  test('non-PDF extension → 400 NOT_A_PDF', async () => {
    const r = await withUser(request(app()).post('/api/nid-server-report/extract'))
      .attach('pdf', PDF_BUF, 'evil.exe').expect(400);
    expect(r.body.error).toBe('NOT_A_PDF');
    expect(adapter.extractFields).not.toHaveBeenCalled();
  });

  test('adapter NO_CORE_DATA → 422 with the Bengali reason', async () => {
    adapter.extractFields.mockResolvedValue({ ok: false, error: 'NO_CORE_DATA' });
    const r = await withUser(request(app()).post('/api/nid-server-report/extract'))
      .attach('pdf', PDF_BUF, 'form.pdf').expect(422);
    expect(r.body.error).toBe('NO_CORE_DATA');
    expect(r.body.message).toMatch(/তথ্য অসম্পূর্ণ/);
  });

  test('valid PDF → 200 with jobId/fields/images', async () => {
    adapter.extractFields.mockResolvedValue({
      ok: true, jobId: 'job1', fields: FIELDS, images: [{ name: 'photo.png', dataUrl: 'data:image/png;base64,x' }],
    });
    const r = await withUser(request(app()).post('/api/nid-server-report/extract'))
      .attach('pdf', PDF_BUF, 'form.pdf').expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.jobId).toBe('job1');
    expect(r.body.fields).toEqual(FIELDS);
    expect(adapter.extractFields).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/nid-server-report/create', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/nid-server-report/create').send({}).expect(401);
  });

  test('missing jobId/fields → 400', async () => {
    const r = await withUser(request(app()).post('/api/nid-server-report/create').send({})).expect(400);
    expect(r.body.error).toBe('INVALID_REQUEST');
  });

  test('stale job → 404, no charge', async () => {
    adapter.validateJob.mockResolvedValue({ ok: false, error: 'JOB_NOT_FOUND' });
    const r = await withUser(request(app()).post('/api/nid-server-report/create')
      .send({ jobId: 'gone', fields: FIELDS })).expect(404);
    expect(r.body.error).toBe('JOB_NOT_FOUND');
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('blanked-out fields → 422 NO_CORE_DATA, no charge', async () => {
    adapter.hasCoreData.mockReturnValue(false);
    const r = await withUser(request(app()).post('/api/nid-server-report/create')
      .send({ jobId: 'job1', fields: {} })).expect(422);
    expect(r.body.error).toBe('NO_CORE_DATA');
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('free service → 200, order recorded, both filenames, no charge', async () => {
    db.__routeQuery([
      ['FROM orders WHERE', { rows: [] }],
      ['FROM services WHERE', { rows: [{ id: 16, price: 0 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['INSERT INTO orders', { rows: [{ id: 77 }] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-server-report/create')
      .send({ jobId: 'job1', fields: FIELDS, idempotency_key: 'nidsr-test-1' })).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.charged).toBe(0);
    expect(r.body.orderId).toBe(77);
    expect(r.body.filenames).toEqual(['1010101010-v1.pdf', '1010101010-v2.pdf']);
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
    expect(wa.notifyServiceCompleted).toHaveBeenCalled();
  });

  test('duplicate idempotency key replays without a second charge', async () => {
    db.__routeQuery([
      ['FROM orders WHERE', { rows: [{ id: 77, price: 50, status: 'completed' }] }],
      ['FROM users WHERE', { rows: [{ balance: 70 }] }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-server-report/create')
      .send({ jobId: 'job1', fields: FIELDS, idempotency_key: 'nidsr-test-1' })).expect(200);
    expect(r.body.duplicate).toBe(true);
    expect(r.body.charged).toBe(50);
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('insufficient balance → 402, no order', async () => {
    db.__routeQuery([
      ['FROM orders WHERE', { rows: [] }],
      ['FROM services WHERE', { rows: [{ id: 16, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 10 }] }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-server-report/create')
      .send({ jobId: 'job1', fields: FIELDS, idempotency_key: 'nidsr-test-2' })).expect(402);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });
});

describe('POST /api/nid-server-report/pdf', () => {
  const V1 = Buffer.from('%PDF-1.4 v1-bytes');
  const V2 = Buffer.from('%PDF-1.4 v2-bytes');

  function paidOrder() {
    db.__routeQuery([
      ['FROM orders WHERE', { rows: [{ id: 77, price: 0, status: 'completed' }] }],
    ]);
  }

  test('requires auth → 401', async () => {
    await request(app()).post('/api/nid-server-report/pdf?kind=v1&idempotency_key=k').send({}).expect(401);
  });

  test('bad kind → 400', async () => {
    const r = await withUser(request(app())
      .post('/api/nid-server-report/pdf?kind=v3&idempotency_key=k')
      .send({ jobId: 'job1', fields: FIELDS })).expect(400);
    expect(r.body.error).toBe('INVALID_REQUEST');
  });

  test('missing idempotency key → 400', async () => {
    const r = await withUser(request(app())
      .post('/api/nid-server-report/pdf?kind=v1')
      .send({ jobId: 'job1', fields: FIELDS })).expect(400);
    expect(r.body.error).toBe('BAD_INPUT');
  });

  test('no paid order → 402 NOT_PAID, build never runs', async () => {
    db.__routeQuery([['FROM orders WHERE', { rows: [] }]]);
    const r = await withUser(request(app())
      .post('/api/nid-server-report/pdf?kind=v1&idempotency_key=k')
      .send({ jobId: 'job1', fields: FIELDS })).expect(402);
    expect(r.body.error).toBe('NOT_PAID');
    expect(adapter.buildReports).not.toHaveBeenCalled();
  });

  test('build failure → 422, nothing downloaded', async () => {
    paidOrder();
    adapter.buildReports.mockResolvedValue({ ok: false, error: 'BUILD_FAILED' });
    const r = await withUser(request(app())
      .post('/api/nid-server-report/pdf?kind=v1&idempotency_key=k')
      .send({ jobId: 'job1', fields: FIELDS })).expect(422);
    expect(r.body.error).toBe('BUILD_FAILED');
    expect(wa.notifyServiceFailed).toHaveBeenCalled();
  });

  test('paid order → 200 v1 PDF bytes with the right filename', async () => {
    paidOrder();
    adapter.buildReports.mockResolvedValue({ ok: true, v1Buffer: V1, v2Buffer: V2, nid: '1010101010', base: '1010101010' });
    const r = await withUser(request(app())
      .post('/api/nid-server-report/pdf?kind=v1&idempotency_key=k')
      .send({ jobId: 'job1', fields: FIELDS })).expect(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(r.headers['content-disposition']).toContain('1010101010-v1.pdf');
    expect(Buffer.compare(Buffer.from(r.body), V1)).toBe(0);
  });

  test('paid order → 200 v2 PDF bytes with the right filename', async () => {
    paidOrder();
    adapter.buildReports.mockResolvedValue({ ok: true, v1Buffer: V1, v2Buffer: V2, nid: '1010101010', base: '1010101010' });
    const r = await withUser(request(app())
      .post('/api/nid-server-report/pdf?kind=v2&idempotency_key=k')
      .send({ jobId: 'job1', fields: FIELDS })).expect(200);
    expect(r.headers['content-disposition']).toContain('1010101010-v2.pdf');
    expect(Buffer.compare(Buffer.from(r.body), V2)).toBe(0);
  });
});
