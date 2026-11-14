// Route tests for POST /api/passport/pdf (direct real-PDF download
// from Create, 2026-11-14).
//
// The client POSTs the document-only HTML (snapshotHTML) as text/html
// and the server renders a real 1-page A4 PDF (headless Chromium)
// and returns the bytes. Money rules under test:
//   - POST /pdf NEVER charges and NEVER creates an order — it only
//     verifies the paid order for the idempotency key (POST /create
//     already charged and recorded it).
//   - No completed order for the key → 402 NOT_PAID (the PDF can
//     never be used to bypass payment).
//   - Same idempotency key twice → same PDF, still one order/charge.
//   - Render failure → 500 PDF_FAILED with a Bengali message.
//   - Unauthenticated → 401; bad input → 400.
// The Chromium render itself is mocked here (jest.mock of
// lib/passportPdf) — the REAL render is verified in the browser
// check (real Chromium, real document HTML, real PDF bytes).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../utils/whatsapp', () => ({
  notifyServiceCompleted: jest.fn().mockResolvedValue({ ok: true }),
  notifyServiceFailed: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../utils/push', () => ({
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../lib/passportPdf', () => ({
  renderPassportPdf: jest.fn(async () => Buffer.from('%PDF-1.4\n%fake passport pdf\n')),
  ensurePageRule: (html) => html,
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const { renderPassportPdf } = require('../../lib/passportPdf');
const passportRouter = require('../../routes/passport');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/passport', passportRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

const PDF_HTML = '<!doctype html><html><head><style>@page{size:A4;margin:0}</style></head><body><div class="page-shell">passport</div></body></html>';
const PAID_ORDER = [{ id: 'o1', price: 30, status: 'completed' }];

function baseRoutes(extra = []) {
  return [
    ...extra, // per-test overrides win over the defaults below
    ['FROM orders WHERE', { rows: [] }],
    ['FROM services WHERE', { rows: [{ id: 13, price: 30 }] }],
    ['FROM user_services WHERE', { rows: [] }],
    ['FROM users WHERE', { rows: [{ balance: 500 }] }],
    ['FROM service_credits', { rows: [] }],
    ['FROM transactions WHERE', { rows: [] }],
    ['wallet_apply', { rows: [{ balance: 470 }] }],
    ['INSERT INTO orders', { rows: [{ id: 'o1' }] }],
  ];
}

const orderInserts = () => db.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO orders'));
const walletCalls = () => db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
  db.__routeQuery(baseRoutes());
});

function pdfBytes(res) {
  const body = res.body;
  if (Buffer.isBuffer(body)) return body;
  if (body && body.type === 'Buffer' && Array.isArray(body.data)) return Buffer.from(body.data);
  return Buffer.from(res.text || '', 'latin1');
}

describe('POST /api/passport/pdf', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/passport/pdf?passport_no=EJ0762655&idempotency_key=k1')
      .set('Content-Type', 'text/html').send(PDF_HTML).expect(401);
  });

  test('missing passport_no → 400', async () => {
    await withUser(request(app()).post('/api/passport/pdf?idempotency_key=k1'))
      .set('Content-Type', 'text/html').send(PDF_HTML).expect(400);
  });

  test('missing idempotency_key → 400', async () => {
    await withUser(request(app()).post('/api/passport/pdf?passport_no=EJ0762655'))
      .set('Content-Type', 'text/html').send(PDF_HTML).expect(400);
  });

  test('missing/empty HTML → 400', async () => {
    await withUser(request(app()).post('/api/passport/pdf?passport_no=EJ0762655&idempotency_key=k1'))
      .set('Content-Type', 'text/html').send('').expect(400);
  });

  test('no completed order for the key → 402 NOT_PAID, no render, no charge', async () => {
    const r = await withUser(request(app()).post('/api/passport/pdf?passport_no=EJ0762655&idempotency_key=unpaid-1'))
      .set('Content-Type', 'text/html').send(PDF_HTML).expect(402);
    expect(r.body.error).toBe('NOT_PAID');
    expect(r.body.message).toContain('আগে Create করে');
    expect(renderPassportPdf).not.toHaveBeenCalled();
    expect(orderInserts()).toHaveLength(0);
    expect(walletCalls()).toHaveLength(0);
  });

  test('order exists but not completed → 402 NOT_PAID', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM orders WHERE', { rows: [{ id: 'o1', price: 30, status: 'pending' }] }],
    ]));
    const r = await withUser(request(app()).post('/api/passport/pdf?passport_no=EJ0762655&idempotency_key=pending-1'))
      .set('Content-Type', 'text/html').send(PDF_HTML).expect(402);
    expect(r.body.error).toBe('NOT_PAID');
    expect(renderPassportPdf).not.toHaveBeenCalled();
  });

  test('paid order → 200 real PDF bytes, Content-Disposition .pdf, no charge, no new order', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM orders WHERE', { rows: PAID_ORDER }],
    ]));
    const r = await withUser(request(app()).post('/api/passport/pdf?passport_no=EJ0762655&idempotency_key=paid-1'))
      .set('Content-Type', 'text/html').send(PDF_HTML).buffer(true).expect(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('Passport-EJ0762655.pdf');
    const bytes = pdfBytes(r);
    expect(bytes.slice(0, 5).toString()).toBe('%PDF-');
    // The render got the document HTML (editor chrome is stripped
    // client-side by snapshotHTML — the route renders what it gets).
    expect(renderPassportPdf).toHaveBeenCalledTimes(1);
    expect(renderPassportPdf.mock.calls[0][0]).toContain('page-shell');
    // No money moved: no order insert, no wallet charge.
    expect(orderInserts()).toHaveLength(0);
    expect(walletCalls()).toHaveLength(0);
  });

  test('same idempotency key twice → same PDF, still one order, no second charge', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM orders WHERE', { rows: PAID_ORDER }],
    ]));
    const url = '/api/passport/pdf?passport_no=EJ0762655&idempotency_key=paid-retry';
    const r1 = await withUser(request(app()).post(url)).set('Content-Type', 'text/html').send(PDF_HTML).buffer(true).expect(200);
    const r2 = await withUser(request(app()).post(url)).set('Content-Type', 'text/html').send(PDF_HTML).buffer(true).expect(200);
    expect(pdfBytes(r1).slice(0, 5).toString()).toBe('%PDF-');
    expect(pdfBytes(r2).slice(0, 5).toString()).toBe('%PDF-');
    expect(renderPassportPdf).toHaveBeenCalledTimes(2); // render is pure; no side effects
    expect(orderInserts()).toHaveLength(0);
    expect(walletCalls()).toHaveLength(0);
  });

  test('render failure → 500 PDF_FAILED with a Bengali message, no charge', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM orders WHERE', { rows: PAID_ORDER }],
    ]));
    renderPassportPdf.mockRejectedValueOnce(new Error('Chromium চালু করা যায়নি।'));
    const r = await withUser(request(app()).post('/api/passport/pdf?passport_no=EJ0762655&idempotency_key=paid-fail'))
      .set('Content-Type', 'text/html').send(PDF_HTML).expect(500);
    expect(r.body.error).toBe('PDF_FAILED');
    expect(r.body.message).toContain('PDF তৈরি করা যায়নি');
    expect(orderInserts()).toHaveLength(0);
    expect(walletCalls()).toHaveLength(0);
  });
});
