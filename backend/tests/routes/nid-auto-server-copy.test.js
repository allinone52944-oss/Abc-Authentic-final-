'use strict';

jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../lib/serviceCredits', () => ({
  availableFor: jest.fn(),
  payForService: jest.fn(),
}));
jest.mock('../../lib/bdxNidClient', () => ({ lookupBdxNid: jest.fn() }));
jest.mock('../../lib/autoNidReportPdf', () => ({ buildAutoNidReportPdf: jest.fn() }));

const express = require('express');
const request = require('supertest');
const { requireAuth, signAccess } = require('../../auth');
const db = require('../../db');
const { availableFor, payForService } = require('../../lib/serviceCredits');
const { lookupBdxNid } = require('../../lib/bdxNidClient');
const { buildAutoNidReportPdf } = require('../../lib/autoNidReportPdf');
const { decryptReport, encryptReport, fingerprint, storageKey } = require('../../lib/autoNidReportStore');
const router = require('../../routes/nid-auto-server-copy');
const userRouter = require('../../routes/user');

const app = express();
app.use(express.json());
app.use('/api/nid-auto-server-copy', requireAuth, router);
app.use('/api', userRouter);

const userId = '771c6759-0ccc-4dc8-927e-0dd6ca9d10f7';
const orderId = '7551f674-9a69-4ed7-935b-e8ca7794e4f6';
const idempotencyKey = '911dc623-2361-4100-b24e-e845e9d5f1dc';
const storageSecret = '2e'.repeat(32);
const apiKey = 'mock-provider-token';
const route = '/api/nid-auto-server-copy';
const pdf = Buffer.from('%PDF-1.4\n% Synthetic test report\n%%EOF');
const syntheticRecord = { nameBn: 'নমুনা', nationalId: '0000000000', dateOfBirth: '2000-02-29' };
const lookup = { type: 'backup', nid: syntheticRecord.nationalId, dob: syntheticRecord.dateOfBirth, authorized: true, price: 45, idempotencyKey };
const premiumLookup = { type: 'premium', price: 85, acceptPremiumChargeOnLookup: true };
const products = [
  ['backup', 'nid-auto-server-copy', 45, 'Server Copy (SV Backup)'],
  ['premium', 'nid-auto-server-copy-premium', 85, 'SV Copy Premium'],
  ['half', 'nid-auto-server-copy-half', 35, 'Half Server Copy'],
];

function serviceFixture() {
  return products.map(([type, engineId, price]) => ({
    id: 'service-' + type,
    engine_id: engineId,
    type: 'automated',
    status: 'active',
    schedule: {},
    price: String(price),
    access_enabled: type === 'backup' ? true : null,
  }));
}

function readOrderInsert([, [user, service, data, price, key, documents, status]]) {
  return { user, service, status, data: JSON.parse(data), price, key, documents: JSON.parse(documents) };
}

function mockQueries({ services = serviceFixture(), balance = 100, acquired = true } = {}) {
  const orders = new Map();
  let insertedOrder;
  db.__routeQuery([
    ['pg_try_advisory_xact_lock', { rows: [{ acquired }] }],
    ['LEFT JOIN auto_nid_reports', (_, [user, key]) => {
      const row = orders.get(user + ':' + key);
      return { rows: row ? [row] : [] };
    }],
    ['FROM services s', typeof services === 'function' ? services : { rows: services }],
    ['SELECT balance FROM users', { rows: [{ balance }] }],
    ['INSERT INTO orders', (sql, params) => {
      const order = readOrderInsert([sql, params]);
      insertedOrder = {
        id: orderId,
        status: order.status,
        price: order.price,
        paid_failure: order.data.auto_nid_paid_failure === true,
        request_hash: order.data.auto_nid_request_hash || null,
        address_limited: order.data.auto_nid_address_limited === true,
        filename: null,
      };
      orders.set(order.user + ':' + order.key, insertedOrder);
      return { rows: [{ id: orderId }] };
    }],
    ['INSERT INTO auto_nid_reports', (_, [, requestHash, filename]) => {
      insertedOrder.request_hash = requestHash;
      insertedOrder.filename = filename;
      return { rows: [] };
    }],
  ], (sql) => { throw new Error('Unexpected SQL: ' + sql); });
}

function withUser(req, id = userId) {
  return req.set('Authorization', 'Bearer ' + signAccess({ id, role: 'user' }));
}

function postLookup(input = {}) {
  return withUser(request(app).post(route + '/lookup')).send({ ...lookup, ...input });
}

function inserts() {
  return db.__client.query.mock.calls.filter(([sql]) => sql.trimStart().startsWith('INSERT'));
}

const originalApiKey = process.env.BDX_NID_API_KEY;
const originalStorageKey = process.env.BDX_NID_STORAGE_KEY;
beforeEach(() => {
  process.env.BDX_NID_API_KEY = apiKey;
  process.env.BDX_NID_STORAGE_KEY = storageSecret;
  db.__reset();
  mockQueries();
  availableFor.mockReset().mockResolvedValue(0);
  payForService.mockReset().mockResolvedValue({});
  lookupBdxNid.mockReset().mockResolvedValue(syntheticRecord);
  buildAutoNidReportPdf.mockReset().mockResolvedValue(pdf);
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.BDX_NID_API_KEY;
  else process.env.BDX_NID_API_KEY = originalApiKey;
  if (originalStorageKey === undefined) delete process.env.BDX_NID_STORAGE_KEY;
  else process.env.BDX_NID_STORAGE_KEY = originalStorageKey;
});

test('all three products quote separately without exposing internal service IDs', async () => {
  const result = await withUser(request(app).get(route + '/options'))
    .expect('Cache-Control', 'private, no-store')
    .expect(200);
  expect(result.body).toEqual({
    balance: 100,
    options: products.map(([type, , price, label]) => ({ type, label, price, available: true })),
  });
  expect(lookupBdxNid).not.toHaveBeenCalled();
  expect(payForService).not.toHaveBeenCalled();
});

test.each(products)('%s generates one private report and pays only its quoted price', async (type, _, price, label) => {
  const record = type === 'premium' ? {
    ...syntheticRecord,
    presentAddress: 'Current Sample Address',
    permanentAddress: 'Permanent Sample Address',
  } : syntheticRecord;
  lookupBdxNid.mockResolvedValueOnce(record);
  const consent = type === 'premium' ? { acceptPremiumChargeOnLookup: true } : {};
  const result = await postLookup({ type, price, ...consent, nid: '০০০০০০০০০০', dob: '২০০০-০২-২৯' })
    .expect('Cache-Control', 'private, no-store')
    .expect(200);
  const filename = 'nid-' + type + '-report.pdf';
  expect(result.body).toEqual({ orderId, downloadUrl: '/api/orders/' + orderId + '/documents/' + filename });
  expect(lookupBdxNid).toHaveBeenCalledTimes(1);
  expect(lookupBdxNid).toHaveBeenCalledWith({ type, nid: lookup.nid, dob: lookup.dob, apiKey });
  expect(buildAutoNidReportPdf).toHaveBeenCalledWith({ type, label, record });
  const [orderInsert, [, reportParams]] = inserts();
  expect(readOrderInsert(orderInsert)).toMatchObject({
    user: userId, service: 'service-' + type, status: 'completed',
    data: { auto_nid_type: type }, price, key: 'nid-auto-server-copy:' + idempotencyKey,
  });
  expect(reportParams.slice(0, 3)).toEqual([orderId, expect.stringMatching(/^[a-f0-9]{64}$/), filename]);
  expect(reportParams[3]).not.toEqual(pdf);
  expect(decryptReport(storageKey(), orderId, reportParams[3])).toEqual(pdf);
  expect(payForService).toHaveBeenCalledTimes(1);
  expect(payForService).toHaveBeenCalledWith(db.__client, {
    userId, serviceId: 'service-' + type, amount: price,
    ref: 'order-nid-auto-server-copy:' + idempotencyKey + '-' + userId,
  });
});

test('unconfigured and unauthorized accounts cannot start paid lookups', async () => {
  const services = serviceFixture();
  services[0].access_enabled = null;
  mockQueries({ services });
  const { body } = await withUser(request(app).get(route + '/options')).expect(200);
  expect(body.options.map(({ available, price }) => [available, price])).toEqual(Array(3).fill([false, null]));
  await postLookup(premiumLookup).expect(403, { error: 'SERVICE_UNAVAILABLE' });

  mockQueries();
  delete process.env.BDX_NID_API_KEY;
  await postLookup().expect(403, { error: 'SERVICE_UNAVAILABLE' });
  delete process.env.BDX_NID_STORAGE_KEY;
  await postLookup().expect(403, { error: 'SERVICE_UNAVAILABLE' });
  expect(lookupBdxNid).not.toHaveBeenCalled();
  expect(payForService).not.toHaveBeenCalled();
  expect(inserts()).toEqual([]);
});

test('requires authentication, authorization acknowledgement and a real calendar date', async () => {
  await request(app).post(route + '/lookup').send(lookup).expect(401);
  await postLookup({ authorized: false }).expect(400, { error: 'INVALID_INPUT' });
  await postLookup({ dob: '2001-02-29' }).expect(400, { error: 'INVALID_INPUT' });
  await postLookup({ type: ['backup'] }).expect(400, { error: 'INVALID_INPUT' });
  expect(db.withTransaction).not.toHaveBeenCalled();
  expect(lookupBdxNid).not.toHaveBeenCalled();
  expect(payForService).not.toHaveBeenCalled();
});

test('blocks initial stale price, insufficient balance, and a simultaneous purchase before provider access', async () => {
  await postLookup({ price: 44 }).expect(409, { error: 'PRICE_CHANGED' });
  mockQueries({ balance: 44 });
  await postLookup().expect(402, { error: 'INSUFFICIENT_BALANCE' });
  mockQueries({ acquired: false });
  await postLookup().expect(409, { error: 'LOOKUP_BUSY' });
  expect(lookupBdxNid).not.toHaveBeenCalled();
  expect(payForService).not.toHaveBeenCalled();
  expect(inserts()).toEqual([]);
});

test('a price change during lookup never charges the new amount or creates an order', async () => {
  const services = serviceFixture();
  mockQueries({ services: () => ({ rows: services }) });
  lookupBdxNid.mockImplementationOnce(async () => {
    services[0].price = '50';
    return syntheticRecord;
  });
  await postLookup().expect(409, { error: 'PRICE_CHANGED' });
  expect(lookupBdxNid).toHaveBeenCalledTimes(1);
  expect(payForService).not.toHaveBeenCalled();
  expect(inserts()).toEqual([]);
});

test.each([
  ['record_not_found', 422, 'RECORD_NOT_FOUND'],
  ['provider_unavailable', 502, 'PROVIDER_UNAVAILABLE'],
])('provider outcome %s never creates an order or charges the user', async (code, status, error) => {
  lookupBdxNid.mockRejectedValueOnce(Object.assign(new Error('Mock details must remain private'), { code }));
  await postLookup().expect(status, { error });
  expect(buildAutoNidReportPdf).not.toHaveBeenCalled();
  expect(payForService).not.toHaveBeenCalled();
  expect(inserts()).toEqual([]);
});

test('a new Premium lookup requires consent to its terms, and a completed request remains replayable', async () => {
  const oldRequest = { type: 'premium', price: 85 };
  await postLookup(oldRequest).expect(409, { error: 'PREMIUM_TERMS_CHANGED' });
  expect(lookupBdxNid).not.toHaveBeenCalled();
  expect(payForService).not.toHaveBeenCalled();
  expect(inserts()).toEqual([]);

  const first = await postLookup(premiumLookup).expect(200);
  await postLookup(oldRequest).expect(200, first.body);
  expect(lookupBdxNid).toHaveBeenCalledTimes(1);
  expect(payForService).toHaveBeenCalledTimes(1);
});

test('a matching Premium record with missing addresses still produces a paid private PDF', async () => {
  const record = { ...syntheticRecord, presentAddress: 'Sample Present Address', permanentAddress: '' };
  lookupBdxNid.mockResolvedValueOnce(record);
  const first = await postLookup(premiumLookup).expect(200, {
    orderId, downloadUrl: '/api/orders/' + orderId + '/documents/nid-premium-report.pdf', addressLimited: true,
  });
  await postLookup(premiumLookup).expect(200, first.body);
  expect(buildAutoNidReportPdf).toHaveBeenCalledTimes(1);
  expect(buildAutoNidReportPdf).toHaveBeenCalledWith({ type: 'premium', label: 'SV Copy Premium', record });
  expect(lookupBdxNid).toHaveBeenCalledTimes(1);
  expect(payForService).toHaveBeenCalledTimes(1);
  expect(payForService).toHaveBeenCalledWith(db.__client, expect.objectContaining({ amount: 85 }));
});

test('Premium locks quoted service and covered funds before calling the provider, then settles the reviewed rate', async () => {
  const services = serviceFixture();
  mockQueries({ services: () => ({ rows: services }), balance: 55 });
  availableFor.mockResolvedValueOnce(30);
  lookupBdxNid.mockImplementationOnce(async () => {
    const providerCall = lookupBdxNid.mock.invocationCallOrder[0];
    const queryCalls = db.__client.query.mock.calls;
    expect(queryCalls.find(([sql]) => sql.includes('FOR SHARE OF s'))[1])
      .toEqual([userId, ['nid-auto-server-copy', 'nid-auto-server-copy-premium']]);
    for (const lock of [/FROM services[\s\S]+FOR SHARE OF s/, /SELECT balance FROM users[\s\S]+FOR UPDATE/]) {
      const index = queryCalls.findIndex(([sql]) => lock.test(sql));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(db.__client.query.mock.invocationCallOrder[index]).toBeLessThan(providerCall);
    }
    expect(availableFor).toHaveBeenCalledWith(db.__client, userId, 'service-premium', { lock: true });
    expect(availableFor.mock.invocationCallOrder[0]).toBeLessThan(providerCall);
    services[1].price = '99';
    return syntheticRecord;
  });

  await postLookup(premiumLookup).expect(200);
  expect(payForService).toHaveBeenCalledTimes(1);
  expect(payForService).toHaveBeenCalledWith(db.__client, expect.objectContaining({ amount: 85 }));
  expect(readOrderInsert(inserts()[0]).price).toBe(85);
});

test.each([
  ['record_not_found', 422, 'RECORD_NOT_FOUND'],
  ['provider_unavailable', 502, 'PROVIDER_UNAVAILABLE'],
])('unconfirmed Premium provider outcome %s cannot charge or create an order', async (code, status, error) => {
  lookupBdxNid.mockRejectedValueOnce(Object.assign(new Error('Mock failure'), { code }));
  await postLookup(premiumLookup).expect(status, { error });
  expect(buildAutoNidReportPdf).not.toHaveBeenCalled();
  expect(payForService).not.toHaveBeenCalled();
  expect(inserts()).toEqual([]);
});

test.each(['record_not_found', 'provider_unavailable'])('confirmed provider debit with %s pays once, stays private and replays without a PDF', async (code) => {
  lookupBdxNid.mockRejectedValueOnce(Object.assign(new Error('Mock sensitive details'), { code, providerCharged: true }));
  const first = await postLookup(premiumLookup).expect(422, {
    error: 'PREMIUM_CHARGED_NO_REPORT', orderId, chargedAmount: 85,
  });
  await postLookup(premiumLookup).expect(422, first.body);
  await postLookup({ ...premiumLookup, dob: '2000-02-28' }).expect(409, { error: 'IDEMPOTENCY_CONFLICT' });
  expect(lookupBdxNid).toHaveBeenCalledTimes(1);
  expect(buildAutoNidReportPdf).not.toHaveBeenCalled();
  expect(payForService).toHaveBeenCalledTimes(1);
  expect(payForService).toHaveBeenCalledWith(db.__client, expect.objectContaining({ amount: 85, serviceId: 'service-premium' }));
  const orderInserts = inserts();
  expect(orderInserts).toHaveLength(1);
  expect(readOrderInsert(orderInserts[0])).toEqual({
    user: userId, service: 'service-premium', status: 'failed', price: 85,
    key: 'nid-auto-server-copy:' + idempotencyKey,
    documents: [],
    data: {
      auto_nid_type: 'premium',
      auto_nid_paid_failure: true,
      auto_nid_request_hash: fingerprint(storageKey(), userId, { ...lookup, ...premiumLookup }),
    },
  });
});

test('PDF generation failure after verified Premium data remains a single paid failed order', async () => {
  buildAutoNidReportPdf.mockRejectedValueOnce(new Error('Mock PDF failure'));
  const first = await postLookup(premiumLookup).expect(422, {
    error: 'PREMIUM_CHARGED_NO_REPORT', orderId, chargedAmount: 85,
  });
  await postLookup(premiumLookup).expect(422, first.body);
  expect(lookupBdxNid).toHaveBeenCalledTimes(1);
  expect(buildAutoNidReportPdf).toHaveBeenCalledTimes(1);
  expect(payForService).toHaveBeenCalledTimes(1);
  expect(inserts()).toHaveLength(1);
  expect(readOrderInsert(inserts()[0])).toMatchObject({ status: 'failed', price: 85, documents: [] });
});

test('PDF generation failure creates no delivery and charges nothing', async () => {
  buildAutoNidReportPdf.mockRejectedValueOnce(new Error('Mock PDF failure'));
  await postLookup().expect(500, { error: 'LOOKUP_FAILED' });
  expect(payForService).not.toHaveBeenCalled();
  expect(inserts()).toEqual([]);
});

test('same lookup replays after closure, while a different request with the same key conflicts', async () => {
  const first = await postLookup().expect(200);
  delete process.env.BDX_NID_API_KEY;
  await postLookup().expect(200, first.body);
  await postLookup({ dob: '2000-02-28' }).expect(409, { error: 'IDEMPOTENCY_CONFLICT' });
  expect(inserts()).toHaveLength(2);
  expect(lookupBdxNid).toHaveBeenCalledTimes(1);
  expect(buildAutoNidReportPdf).toHaveBeenCalledTimes(1);
  expect(payForService).toHaveBeenCalledTimes(1);
});

test('private report downloads require the owning account and the matching document', async () => {
  const filename = 'nid-backup-report.pdf';
  const download = '/api/orders/' + orderId + '/documents/' + filename;
  const completedOrder = {
    status: 'completed',
    documents: [{ filename, uploaded_by: 'admin', storage: 'auto-nid-report' }],
  };
  db.__routeQuery([
    ['SELECT status, documents FROM orders', (_, params) => ({
      rows: params[0] === orderId && params[1] === userId ? [completedOrder] : [],
    })],
    ['SELECT r.encrypted_pdf', (_, params) => {
      expect(params).toEqual([orderId, userId, filename]);
      return { rows: [{ encrypted_pdf: encryptReport(storageKey(), orderId, pdf) }] };
    }],
  ]);

  await request(app).get(download).expect(401);
  await withUser(request(app).get(download), '8c1b2d3f-cbc7-4b86-867c-f5ddc5341814')
    .expect(404, { error: 'ORDER_NOT_FOUND' });
  await withUser(request(app).get(download.replace(filename, 'unlisted.pdf')))
    .expect(404, { error: 'DOCUMENT_NOT_FOUND' });
  const response = await withUser(request(app).get(download))
    .expect('Cache-Control', 'private, no-store')
    .expect('Content-Type', 'application/pdf')
    .expect(200);
  expect(response.body).toEqual(pdf);
});

test('the customer catalog shows one approved entry and direct order checkout cannot charge engine SKUs', async () => {
  const services = serviceFixture();
  db.__routeQuery([
    ['FROM services s', { rows: services }],
    ['SELECT * FROM services WHERE id', (_, params) => ({
      rows: services.filter(({ id }) => id === params[0]),
    })],
  ]);
  const catalog = await withUser(request(app).get('/api/services')).expect(200);
  expect(catalog.body.services.map(service => service.id)).toEqual(['service-backup']);
  services[0].access_enabled = null;
  await withUser(request(app).get('/api/services')).expect(200, { services: [] });
  for (const { id } of services) {
    await withUser(request(app).post('/api/orders')).send({ service_id: id })
      .expect(400, { error: 'USE_ENGINE' });
  }
  expect(payForService).not.toHaveBeenCalled();
});
