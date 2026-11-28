'use strict';

jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../lib/serviceCredits', () => ({
  availableFor: jest.fn(),
  payForService: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const { availableFor, payForService } = require('../../lib/serviceCredits');
const { decryptReport, storageKey } = require('../../lib/autoNidReportStore');
const { requireAuth, signAccess } = require('../../auth');

const app = express();
app.use(express.json());
app.use('/auto-tin', requireAuth, require('../../routes/auto-tin'));

const id = '7551f674-9a69-4ed7-935b-e8ca7794e4f6';
const userId = '771c6759-0ccc-4dc8-927e-0dd6ca9d10f7';
const serviceId = '911dc623-2361-4100-b24e-e845e9d5f1dc';
const lookup = { tin: '000000000000', idempotencyKey: id, price: 42, authorized: true };
const originalFetch = global.fetch;
const originalKey = process.env.BDX_TIN_API_KEY;
const originalStorageKey = process.env.BDX_NID_STORAGE_KEY;
let service;
let balance;
let savedOrder;
let savedPdf;

const auth = req => req.set('Authorization', 'Bearer ' + signAccess({ id: userId, role: 'user' }));
const submit = overrides => auth(request(app).post('/auto-tin/lookup')).send({ ...lookup, ...overrides });
const reply = (response, httpStatus = 200, charged = true) => new Response(JSON.stringify({
  http_status: httpStatus, charged, amount: charged ? 28 : 0, from_cache: !charged,
  response,
}));

beforeEach(() => {
  process.env.BDX_TIN_API_KEY = 'test-only-key';
  process.env.BDX_NID_STORAGE_KEY = '2e'.repeat(32);
  service = { id: serviceId, type: 'automated', status: 'active', schedule: {}, price: '42' };
  balance = 80;
  savedOrder = savedPdf = undefined;
  availableFor.mockReset().mockResolvedValue(0);
  payForService.mockReset().mockResolvedValue({});
  global.fetch = jest.fn().mockImplementation(async () => reply({
    requestId: 'mock-request',
    data: { TIN: lookup.tin, nameEn: 'Example Taxpayer', presentAddress: 'Sample address' },
  }));
  db.__reset();
  db.__routeQuery([
    ['pg_try_advisory_xact_lock', { rows: [{ acquired: true }] }],
    ['SELECT id, data, status, price FROM orders', () => ({ rows: savedOrder ? [savedOrder] : [] })],
    ['SELECT balance FROM users', () => ({ rows: [{ balance }] })],
    ['FROM services s', () => ({ rows: [service] })],
    ['INSERT INTO orders', (_, [, , status, data, price]) => {
      savedOrder = { id, status, data: JSON.parse(data), price };
      return { rows: [savedOrder] };
    }],
    ['INSERT INTO auto_nid_reports', (_, [, , , encrypted]) => {
      savedPdf = encrypted;
      return { rows: [] };
    }],
  ], sql => { throw new Error('Unexpected SQL: ' + sql); });
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.BDX_TIN_API_KEY;
  else process.env.BDX_TIN_API_KEY = originalKey;
  if (originalStorageKey === undefined) delete process.env.BDX_NID_STORAGE_KEY;
  else process.env.BDX_NID_STORAGE_KEY = originalStorageKey;
});

test('quotes the configured price and produces one encrypted PDF and debit on a replay', async () => {
  await auth(request(app).get('/auto-tin/options')).expect(200, { price: 42 });
  expect(global.fetch).not.toHaveBeenCalled();
  const first = await submit({ tin: '০০০০০০০০০০০০' }).expect('Cache-Control', 'private, no-store').expect(200);
  service.status = 'disabled';
  await submit().expect(200, first.body);
  expect(first.body.downloadUrl).toBe(`/api/orders/${id}/documents/tin-verification-report.pdf`);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [[url, options]] = global.fetch.mock.calls;
  expect(url.origin + url.pathname).toBe('https://api.bd-x.com/api-portal/api/tin-download.php');
  expect(Object.fromEntries(url.searchParams)).toEqual({ key: 'test-only-key', tin: lookup.tin });
  expect(options.redirect).toBe('error');
  expect(payForService).toHaveBeenCalledTimes(1);
  expect(payForService.mock.calls[0][1]).toMatchObject({ amount: 42, serviceId, userId });
  expect(JSON.stringify(savedOrder)).not.toContain(lookup.tin);
  expect(decryptReport(storageKey(), id, savedPdf).subarray(0, 5).toString()).toBe('%PDF-');
  await submit({ tin: '111111111111' }).expect(409, { error: 'IDEMPOTENCY_CONFLICT' });
});

test('rejects unauthenticated, unapproved, stale and unfunded requests before the provider call', async () => {
  await request(app).post('/auto-tin/lookup').send(lookup).expect(401);
  await submit({ authorized: false }).expect(400);
  await submit({ price: 41 }).expect(409, { error: 'PRICE_CHANGED' });
  balance = 0;
  await submit().expect(402);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(payForService).not.toHaveBeenCalled();
});

test('a free miss and a mismatched result do not deliver a report or charge', async () => {
  global.fetch.mockResolvedValueOnce(reply({}, 404, false));
  global.fetch.mockResolvedValueOnce(reply({ TIN: '111111111111', name: 'Other record' }, 200, false));
  await submit().expect(422, { error: 'RECORD_NOT_FOUND' });
  await submit().expect(502, { error: 'PROVIDER_UNAVAILABLE' });
  expect(payForService).not.toHaveBeenCalled();
  expect(savedOrder).toBeUndefined();
});

test('a confirmed paid miss is charged once and replays the same outcome', async () => {
  global.fetch.mockResolvedValueOnce(reply({}, 404));
  const first = await submit().expect(422, { error: 'CHARGED_NO_REPORT', chargedAmount: 42, orderId: id });
  await submit().expect(422, first.body);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(payForService).toHaveBeenCalledTimes(1);
  expect(savedPdf).toBeUndefined();
});
