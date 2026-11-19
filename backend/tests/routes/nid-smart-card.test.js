// Route tests for backend/routes/nid-smart-card.js (NID Smart Card
// engine: upload PDF -> smart card PDF, one charge).
// Single-step flow, like nid-replica: POST /build builds FIRST and
// charges AFTER a successful build — a build failure never takes
// money. The engine adapter is mocked — no Python, no real PDFs.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/nid-smart-card/adapter', () => ({
  extractFields: jest.fn(),
  buildCard: jest.fn(),
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
  adapter.outputBase.mockReset();
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
    db.__routeQuery(priceRows(30));
    const r = await withUser(request(app()).get('/api/nid-smart-card/price')).expect(200);
    expect(r.body).toEqual({ ok: true, engineId: 'nid-smart-card', allowed: true, price: 30, balance: 120, serviceId: 17 });
  });

  test('access disabled in user_services → 200 with allowed: false', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 17, price: 30 }] }],
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

describe('POST /api/nid-smart-card/build', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/nid-smart-card/build').send({}).expect(401);
  });

  test.each([
    ['missing jobId', { fields: {} }],
    ['missing fields', { jobId: 'j1' }],
    ['fields not object', { jobId: 'j1', fields: 'nope' }],
    ['empty body', {}],
  ])('%s → 400 INVALID_REQUEST', async (_l, body) => {
    const r = await withUser(request(app()).post('/api/nid-smart-card/build')).send(body).expect(400);
    expect(r.body.error).toBe('INVALID_REQUEST');
  });

  test('service access disabled → 403 SERVICE_ACCESS_DISABLED', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 17, price: 30 }] }],
      ['FROM user_services WHERE', { rows: [{ access_enabled: false }] }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: FIELDS }).expect(403);
    expect(r.body.error).toBe('SERVICE_ACCESS_DISABLED');
  });

  test('insufficient balance → 402 INSUFFICIENT_BALANCE, build never runs', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 17, price: 30 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 10 }] }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: FIELDS }).expect(402);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(adapter.buildCard).not.toHaveBeenCalled();
  });

  test('JOB_NOT_FOUND → 404', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 0 }] }],
    ]);
    adapter.buildCard.mockResolvedValue({ ok: false, error: 'JOB_NOT_FOUND' });
    const r = await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: FIELDS }).expect(404);
    expect(r.body.error).toBe('JOB_NOT_FOUND');
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('NOT_YOUR_JOB → 403', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 0 }] }],
    ]);
    adapter.buildCard.mockResolvedValue({ ok: false, error: 'NOT_YOUR_JOB' });
    const r = await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: FIELDS }).expect(403);
    expect(r.body.error).toBe('NOT_YOUR_JOB');
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('build failure → 422, NO charge (charge count 0), no order, no success notification', async () => {
    let orderInsertCalled = false;
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 17, price: 30 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
      ['INSERT INTO orders', () => { orderInsertCalled = true; return { rows: [] }; }],
    ]);
    adapter.buildCard.mockResolvedValue({ ok: false, error: 'BUILD_FAILED' });
    const r = await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: FIELDS }).expect(422);
    expect(r.body.error).toBe('BUILD_FAILED');
    // the build never succeeded, so the charge + order steps never ran
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
    expect(orderInsertCalled).toBe(false);
    // the failure is notified, but the success notification never fires
    expect(wa.notifyServiceFailed).toHaveBeenCalledTimes(1);
    expect(wa.notifyServiceCompleted).not.toHaveBeenCalled();
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
  });

  test('build failure with a Bengali detail surfaces the real reason', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 0 }] }],
    ]);
    adapter.buildCard.mockResolvedValue({
      ok: false, error: 'BUILD_FAILED',
      detail: 'ছবি পাওয়া যায়নি — টেমপ্লেটের ছবি রেখে কার্ড তৈরি করা যাবে না।',
    });
    const r = await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: FIELDS }).expect(422);
    expect(r.body.error).toBe('BUILD_FAILED');
    expect(r.body.message).toMatch(/ছবি পাওয়া যায়নি/);
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('blank build → 422 NO_CORE_DATA, no charge attempted', async () => {
    let orderInsertCalled = false;
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 17, price: 30 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
      ['INSERT INTO orders', () => { orderInsertCalled = true; return { rows: [] }; }],
    ]);
    adapter.buildCard.mockResolvedValue({ ok: false, error: 'NO_CORE_DATA' });
    const r = await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: {} }).expect(422);
    expect(r.body.error).toBe('NO_CORE_DATA');
    expect(r.body.message).toMatch(/নাম/);
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
    expect(orderInsertCalled).toBe(false);
  });

  test('happy path → 200 PDF, ONE charge, order recorded, delivery copy stored, success notified', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 card');
    adapter.buildCard.mockResolvedValue({ ok: true, pdfBuffer: pdfBytes });
    let orderInsertCalled = false;
    let orderData = null;
    let orderKey = null;
    let updatedDocs = null;
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 17, price: 30 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
      ['FROM transactions WHERE', { rows: [] }],
      ['INSERT INTO orders', (text, params) => {
        orderInsertCalled = true; orderData = params[2]; orderKey = params[4];
        return { rows: [{ id: 77 }] };
      }],
      ['SELECT id, documents FROM orders WHERE', { rows: [{ id: 77, documents: '[]' }] }],
      ['UPDATE orders SET documents', (text, params) => { updatedDocs = params[0]; return { rows: [] }; }],
    ]);

    const r = await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: FIELDS, images: [{ name: 'photo.png', dataUrl: 'data:image/png;base64,x' }] }).expect(200);

    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('1010101010.pdf');
    expect(Buffer.compare(Buffer.from(r.body), pdfBytes)).toBe(0);
    // the build ran with the job + fields + images, then ONE charge
    expect(adapter.buildCard).toHaveBeenCalledTimes(1);
    expect(adapter.buildCard.mock.calls[0][0]).toBe('j1');
    expect(adapter.buildCard.mock.calls[0][3]).toBe('u1');
    expect(serviceCredits.payForService).toHaveBeenCalledTimes(1);
    expect(serviceCredits.payForService.mock.calls[0][1]).toMatchObject({ userId: 'u1', serviceId: 17, amount: 30, ref: 'nid-card-j1' });
    // order recorded with the full fields + the replica-style key
    expect(orderInsertCalled).toBe(true);
    expect(orderKey).toBe('nid-j1');
    expect(JSON.parse(orderData)).toEqual(FIELDS);
    // delivery copy stored on the order for History re-download
    expect(updatedDocs).toBeTruthy();
    const docs = JSON.parse(updatedDocs);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ filename: 'delivery-nid-smart-card-j1.pdf', uploaded_by: 'admin', type: 'delivery', originalname: '1010101010.pdf' });
    const fs = require('fs');
    const path = require('path');
    const fp = path.join('/opt/all-in-one-abc-authentic/uploads/orders', 'delivery-nid-smart-card-j1.pdf');
    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.readFileSync(fp).toString()).toBe('%PDF-1.4 card');
    fs.unlinkSync(fp);
    // success notification fires only now — after the build + order
    expect(wa.notifyServiceCompleted).toHaveBeenCalledTimes(1);
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
  });

  test('already paid job → no double charge on repeated build', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 card');
    adapter.buildCard.mockResolvedValue({ ok: true, pdfBuffer: pdfBytes });
    let txCalls = 0;
    let insertCalls = 0;
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 17, price: 30 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
      ['FROM transactions WHERE', () => (++txCalls === 1 ? { rows: [] } : { rows: [{ id: 99 }] })],
      ['INSERT INTO orders', () => { insertCalls += 1; return { rows: insertCalls === 1 ? [{ id: 77 }] : [] }; }],
      ['SELECT id, documents FROM orders WHERE', { rows: [{ id: 77, documents: JSON.stringify([{ filename: 'delivery-nid-smart-card-j1.pdf', uploaded_by: 'admin', type: 'delivery' }]) }] }],
      ['UPDATE orders SET documents', () => { throw new Error('delivery must not duplicate'); }],
    ]);

    const r1 = await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: FIELDS }).expect(200);
    expect(r1.headers['content-type']).toContain('application/pdf');
    const r2 = await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: FIELDS }).expect(200);
    expect(r2.headers['content-type']).toContain('application/pdf');
    // ONE charge across both builds; the success notification fires once
    expect(serviceCredits.payForService).toHaveBeenCalledTimes(1);
    expect(wa.notifyServiceCompleted).toHaveBeenCalledTimes(1);
  });

  test('free service (price 0) → 200 PDF, order recorded, no charge', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 card');
    adapter.buildCard.mockResolvedValue({ ok: true, pdfBuffer: pdfBytes });
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 17, price: 0 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['SELECT id, documents FROM orders WHERE', { rows: [{ id: 77, documents: '[]' }] }],
      ['INSERT INTO orders', { rows: [{ id: 77 }] }],
      ['UPDATE orders SET documents', { rows: [] }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: FIELDS }).expect(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
    expect(wa.notifyServiceCompleted).toHaveBeenCalledTimes(1);
    const fs = require('fs');
    const path = require('path');
    const fp = path.join('/opt/all-in-one-abc-authentic/uploads/orders', 'delivery-nid-smart-card-j1.pdf');
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });

  test('non-10/13/17-digit ID → fallback filename smart-card.pdf', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 card');
    adapter.buildCard.mockResolvedValue({ ok: true, pdfBuffer: pdfBytes });
    adapter.outputBase.mockReturnValue('smart-card');
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 17, price: 0 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['SELECT id, documents FROM orders WHERE', { rows: [{ id: 77, documents: '[]' }] }],
      ['INSERT INTO orders', { rows: [{ id: 77 }] }],
      ['UPDATE orders SET documents', { rows: [] }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: { 'নাম:': 'x', 'ID NO:': '12345', 'Date of Birth:': '01/01/1990' } }).expect(200);
    expect(r.headers['content-disposition']).toContain('smart-card.pdf');
    const fs = require('fs');
    const path = require('path');
    const fp = path.join('/opt/all-in-one-abc-authentic/uploads/orders', 'delivery-nid-smart-card-j1.pdf');
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });

  test('order insert targets the PARTIAL idempotency index (migration 019)', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 card');
    adapter.buildCard.mockResolvedValue({ ok: true, pdfBuffer: pdfBytes });
    let insertSql = null;
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 17, price: 30 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
      ['FROM transactions WHERE', { rows: [] }],
      ['INSERT INTO orders', (text) => { insertSql = text; return { rows: [] }; }],
      ['SELECT id, documents FROM orders WHERE', { rows: [{ id: 77, documents: '[]' }] }],
      ['UPDATE orders SET documents', { rows: [] }],
    ]);
    await withUser(request(app()).post('/api/nid-smart-card/build'))
      .send({ jobId: 'j1', fields: FIELDS }).expect(200);
    expect(insertSql).toBeTruthy();
    expect(insertSql).toMatch(/ON CONFLICT \(user_id, idempotency_key\) WHERE idempotency_key IS NOT NULL DO NOTHING/);
    const fs = require('fs');
    const path = require('path');
    const fp = path.join('/opt/all-in-one-abc-authentic/uploads/orders', 'delivery-nid-smart-card-j1.pdf');
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
});
