// DOCUMENTED BUGS (fix pending) found by the general suite (task #1).
// Each test below asserts the CORRECT behavior and is marked test.failing:
// it passes while the bug is present, and Jest will loudly report it as
// "expected to fail but passed" the moment the fix lands — that's the
// signal to convert it into a normal passing test.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const adminRouter = require('../../routes/admin');
const userRouter = require('../../routes/user');
const { adminInvites } = require('../../routes/invites');

function adminApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', adminRouter);
  return a;
}
function userApp() {
  const a = express();
  a.use(express.json());
  a.use('/api', userRouter);
  return a;
}
function invitesApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin/invites', adminInvites);
  return a;
}
const adminToken = () => auth.signAccess({ id: 'admin1', role: 'admin' });
const userToken = () => auth.signAccess({ id: 'u1', role: 'user' });
const withAdmin = (req) => req.set('Authorization', 'Bearer ' + adminToken());
const withUser = (req) => req.set('Authorization', 'Bearer ' + userToken());

const SERVICE = {
  id: 's1', name: 'NID Service', name_bn: 'এনআইডি', type: 'manual',
  price: 100, serial: 0, status: 'active', documents_required: [],
  fields_required: [], schedule: null, rules_text: null, engine_id: null,
};

beforeEach(() => { db.__reset(); });

test('FIXED(a) — PUT /api/admin/services/reorder works (registered before /services/:id)', async () => {
  // Regression guard: /services/reorder must be registered BEFORE /services/:id,
  // otherwise "reorder" is captured as :id and the handler is dead code.
  const r = await withAdmin(request(adminApp()).put('/api/admin/services/reorder'))
    .send({ order: ['s1', 's2'] });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true });
});

test('FIXED(b) — POST /orders wallet ref is idempotent with idempotency_key', async () => {
  const handlers = () => [
    ['FROM services WHERE id', { rows: [SERVICE] }],
    ['FROM user_services WHERE user_id', { rows: [] }],
    ['INSERT INTO orders', { rows: [{ id: 'o1' }] }],
  ];
  const walletRefs = () => db.__client.query.mock.calls
    .filter((c) => /wallet_apply/.test(c[0]))
    .map((c) => c[1][3]);

  // Same key twice → same ref (double submit deduped by wallet_apply)
  db.__routeQuery(handlers());
  await withUser(request(userApp()).post('/api/orders'))
    .send({ service_id: 's1', idempotency_key: 'key-abc' }).expect(201);
  db.__routeQuery(handlers());
  await withUser(request(userApp()).post('/api/orders'))
    .send({ service_id: 's1', idempotency_key: 'key-abc' }).expect(201);
  const refs = walletRefs();
  expect(refs).toEqual(['order-key-abc-u1', 'order-key-abc-u1']);

  // Key longer than 64 chars → truncated
  db.__reset(); db.__routeQuery(handlers());
  await withUser(request(userApp()).post('/api/orders'))
    .send({ service_id: 's1', idempotency_key: 'k'.repeat(100) }).expect(201);
  expect(walletRefs()[0]).toBe('order-' + 'k'.repeat(64) + '-u1');

  // No key → old Date.now() fallback behavior
  db.__reset(); db.__routeQuery(handlers());
  const now = jest.spyOn(Date, 'now').mockReturnValue(7777);
  try {
    await withUser(request(userApp()).post('/api/orders'))
      .send({ service_id: 's1' }).expect(201);
    expect(walletRefs()[0]).toBe('order-7777-u1');
  } finally {
    now.mockRestore();
  }
});

test('FIXED(c) — invite max_uses fraction "2.5" rejected with INVALID_MAX_USES', async () => {
  // Fraction must be rejected, not silently truncated to 2.
  await withAdmin(request(invitesApp()).post('/api/admin/invites'))
    .send({ max_uses: '2.5' }).expect(400)
    .then((r) => expect(r.body.error).toBe('INVALID_MAX_USES'));
  // Valid integers still accepted.
  db.__routeQuery([['INSERT INTO invite_links', { rows: [{ code: 'INV-X' }] }]]);
  await withAdmin(request(invitesApp()).post('/api/admin/invites'))
    .send({ max_uses: '10' }).expect(201);
  db.__routeQuery([['INSERT INTO invite_links', { rows: [{ code: 'INV-Y' }] }]]);
  await withAdmin(request(invitesApp()).post('/api/admin/invites'))
    .send({ max_uses: 5 }).expect(201);
});

test('FIXED(d) — /reports/transactions validates dates (mirrors /reports/orders)', async () => {
  db.__routeQuery([['FROM transactions t JOIN users', { rows: [] }]]);
  await withAdmin(request(adminApp())
    .get('/api/admin/reports/transactions?from=not-a-date&to=also-bad')).expect(200);
  const params = db.query.mock.calls.flatMap((c) => c[1] || []);
  // invalid dates must never reach the SQL (mirrors the /reports/orders fix)
  expect(params).not.toContain('not-a-date');
  expect(params).not.toContain('also-bad');
  // NOTE: the guard is format-only (same as /reports/orders): '2026-13-99'
  // matches /^\d{4}-\d{2}-\d{2}$/ and is passed through as a parameter
  // (parameterized → no SQLi; PG rejects it if truly invalid).
  // valid dates still filter
  db.__reset();
  db.__routeQuery([['FROM transactions t JOIN users', { rows: [] }]]);
  await withAdmin(request(adminApp())
    .get('/api/admin/reports/transactions?from=2026-10-01&to=2026-10-13')).expect(200);
  const params2 = db.query.mock.calls.flatMap((c) => c[1] || []);
  expect(params2).toContain('2026-10-01');
  expect(params2).toContain('2026-10-13');
});

test('FIXED(e) — tx type allowlist matches schema CHECK (bonus/cashback/promo filterable)', async () => {
  for (const t of ['bonus', 'cashback', 'promo', 'recharge', 'debit', 'refund']) {
    db.__reset();
    db.__routeQuery([
      ['SELECT COUNT(*) FROM transactions', { rows: [{ count: '0' }] }],
      ['FROM transactions t JOIN', { rows: [] }],
    ]);
    await withAdmin(request(adminApp()).get('/api/admin/transactions?type=' + t)).expect(200);
    const countCall = db.query.mock.calls.find((c) => /SELECT COUNT\(\*\) FROM transactions/.test(c[0]));
    expect(countCall[1]).toContain(t); // filter must be applied, not ignored
  }
  // unknown types are still ignored (never reach SQL)
  db.__reset();
  db.__routeQuery([
    ['SELECT COUNT(*) FROM transactions', { rows: [{ count: '0' }] }],
    ['FROM transactions t JOIN', { rows: [] }],
  ]);
  await withAdmin(request(adminApp()).get('/api/admin/transactions?type=hacked')).expect(200);
  const countCall = db.query.mock.calls.find((c) => /SELECT COUNT\(\*\) FROM transactions/.test(c[0]));
  expect(countCall[1]).not.toContain('hacked');
});

test('FIXED(f) — PUT /services/:id rejects a 1-char name (mirrors POST)', async () => {
  const r = await withAdmin(request(adminApp()).put('/api/admin/services/s1'))
    .send({ name: 'x' });
  expect(r.status).toBe(400);
  expect(r.body.error).toBe('INVALID_NAME');
  // valid name still updates
  db.__routeQuery([['UPDATE services SET', { rows: [{ id: 's1', name: 'NID সেবা' }] }]]);
  const r2 = await withAdmin(request(adminApp()).put('/api/admin/services/s1'))
    .send({ name: 'NID সেবা' });
  expect(r2.status).toBe(200);
});
