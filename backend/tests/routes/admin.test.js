// Route tests for backend/routes/admin.js (admin panel API).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const adminRouter = require('../../routes/admin');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', adminRouter);
  return a;
}
const adminToken = (id = 'admin1') => auth.signAccess({ id, role: 'admin' });
const withAdmin = (req, id) => req.set('Authorization', 'Bearer ' + adminToken(id));

beforeEach(() => { db.__reset(); });

describe('auth gate', () => {
  test('anonymous → 401; non-admin → 403 ADMIN_ONLY', async () => {
    await request(app()).get('/api/admin/users').expect(401);
    const userTok = auth.signAccess({ id: 'u1', role: 'user' });
    const r = await request(app()).get('/api/admin/users')
      .set('Authorization', 'Bearer ' + userTok).expect(403);
    expect(r.body.error).toBe('ADMIN_ONLY');
  });
});

describe('users', () => {
  test('GET /users/:id: single user fetch by id → 200 or 404', async () => {
    db.__routeQuery([
      ['SELECT id, name, phone', { rows: [{ id: 'u1', name: 'Rahim', phone: '01711223344' }] }],
    ]);
    const r1 = await withAdmin(request(app()).get('/api/admin/users/u1')).expect(200);
    expect(r1.body.user.name).toBe('Rahim');

    db.__reset();
    db.__routeQuery([
      ['SELECT id, name, phone', { rows: [] }],
    ]);
    const r2 = await withAdmin(request(app()).get('/api/admin/users/u-missing')).expect(404);
    expect(r2.body.error).toBe('NOT_FOUND');
    db.__reset();
  });

  test('GET /users paginates; q becomes ILIKE param; invalid status ignored', async () => {
    db.__routeQuery([
      ['SELECT COUNT(*) FROM users', { rows: [{ count: '1' }] }],
      ['FROM users', { rows: [{ id: 'u1', name: 'Rahim' }] }],
    ]);
    const r = await withAdmin(request(app()).get('/api/admin/users?q=rahim&status=bogus&page=2')).expect(200);
    expect(r.body.total).toBe(1);
    expect(r.body.page).toBe(2);
    const countQ = db.query.mock.calls.find((c) => /SELECT COUNT\(\*\) FROM users/.test(c[0]));
    expect(countQ[0]).not.toContain('bogus');
    expect(countQ[1]).toEqual(['%rahim%']); // parameterized, not interpolated
  });

  test('POST /users validation', async () => {
    const base = { name: 'R', phone: '01712345678', whatsapp: '01812345678', password: 'secret123' };
    const r1 = await withAdmin(request(app()).post('/api/admin/users')).send({ ...base, name: '' }).expect(400);
    expect(r1.body.error).toBe('INVALID_INPUT');
    const r2 = await withAdmin(request(app()).post('/api/admin/users')).send({ ...base, whatsapp: 'bad' }).expect(400);
    expect(r2.body.error).toBe('INVALID_WHATSAPP');
    const r3 = await withAdmin(request(app()).post('/api/admin/users')).send({ ...base, password: '123' }).expect(400);
    expect(r3.body.error).toBe('WEAK_PASSWORD');
  });

  test('POST /users: duplicate phone → 409 PHONE_TAKEN', async () => {
    db.__routeQuery([['FROM users WHERE phone', { rows: [{ id: 'u9' }] }]]);
    const r = await withAdmin(request(app()).post('/api/admin/users'))
      .send({ name: 'R', phone: '01712345678', whatsapp: '01812345678', password: 'secret123' })
      .expect(409);
    expect(r.body.error).toBe('PHONE_TAKEN');
  });

  test('POST /users happy → 201, role forced to user unless admin', async () => {
    db.__routeQuery([
      ['FROM users WHERE phone', { rows: [] }],
      ['INSERT INTO users', { rows: [{ id: 'u5', name: 'R', role: 'user' }] }],
    ]);
    const r = await withAdmin(request(app()).post('/api/admin/users'))
      .send({ name: 'R', phone: '01711112222', whatsapp: '01811112222', password: 'secret123', role: 'superadmin' })
      .expect(201);
    expect(r.body.user.role).toBe('user');
    const ins = db.query.mock.calls.find((c) => /INSERT INTO users/.test(c[0]));
    expect(ins[1][6]).toBe('user'); // role param sanitized
  });

  test('PUT /users/:id: cannot change own role → 403', async () => {
    db.__routeQuery([['SELECT * FROM users WHERE id', { rows: [{ id: 'admin1', role: 'admin' }] }]]);
    const r = await withAdmin(request(app()).put('/api/admin/users/admin1'))
      .send({ role: 'user' }).expect(403);
    expect(r.body.error).toBe('ERR_CANNOT_CHANGE_OWN_ROLE');
  });

  test('PUT /users/:id: cannot disable self → 403', async () => {
    db.__routeQuery([['SELECT * FROM users WHERE id', { rows: [{ id: 'admin1', role: 'admin' }] }]]);
    const r = await withAdmin(request(app()).put('/api/admin/users/admin1'))
      .send({ status: 'disabled' }).expect(403);
    expect(r.body.error).toBe('ERR_CANNOT_DISABLE_SELF');
  });

  test('PUT /users/:id: not found → 404; happy → 200', async () => {
    db.__routeQuery([['SELECT * FROM users WHERE id', { rows: [] }]]);
    await withAdmin(request(app()).put('/api/admin/users/u9')).send({ name: 'X' }).expect(404);
    db.__reset();
    db.__routeQuery([
      ['SELECT * FROM users WHERE id', { rows: [{ id: 'u2', role: 'user' }] }],
      ['SELECT id, name, phone', { rows: [{ id: 'u2', name: 'New' }] }],
    ]);
    const r = await withAdmin(request(app()).put('/api/admin/users/u2')).send({ name: 'New' }).expect(200);
    expect(r.body.user.name).toBe('New');
  });

  test('POST /users/:id/unblock → 200', async () => {
    const r = await withAdmin(request(app()).post('/api/admin/users/u2/unblock')).expect(200);
    expect(r.body.ok).toBe(true);
  });

  test('POST /users/:id/verify-email → marks verified; 404 when missing', async () => {
    db.__routeQuery([
      ['UPDATE users SET email_verified = TRUE', { rows: [{ id: 'u2', email_verified: true }] }],
    ]);
    const r = await withAdmin(request(app()).post('/api/admin/users/u2/verify-email')).expect(200);
    expect(r.body.ok).toBe(true);
    db.__reset();
    db.__routeQuery([
      ['UPDATE users SET email_verified = TRUE', { rows: [] }],
    ]);
    await withAdmin(request(app()).post('/api/admin/users/nonexistent/verify-email')).expect(404);
    db.__reset();
  });

  test('DELETE /users/:id: self → 403; no confirm → 400; missing → 404; happy → 200', async () => {
    const r1 = await withAdmin(request(app()).delete('/api/admin/users/admin1?confirm=yes')).expect(403);
    expect(r1.body.error).toBe('ERR_CANNOT_DELETE_SELF');
    const r2 = await withAdmin(request(app()).delete('/api/admin/users/u2')).expect(400);
    expect(r2.body.error).toBe('CONFIRM_REQUIRED');
    db.__routeQuery([['SELECT id, phone, name, role FROM users WHERE id', { rows: [] }]]);
    await withAdmin(request(app()).delete('/api/admin/users/u2?confirm=yes')).expect(404);
    db.__reset();
    db.__routeQuery([
      ['SELECT id, phone, name, role FROM users WHERE id', { rows: [{ id: 'u2', phone: '0171', name: 'R', role: 'user' }] }],
      ['SELECT (SELECT COUNT(*) FROM orders', { rows: [{ orders: '1', transactions: '2', coupons: '0', notices: '0', chat: '0' }] }],
    ]);
    const r4 = await withAdmin(request(app()).delete('/api/admin/users/u2?confirm=yes')).expect(200);
    expect(r4.body.ok).toBe(true);
    expect(r4.body.deleted.orders).toBe('1');
  });

  test('H-9: deleting the last active admin → 403 LAST_ADMIN', async () => {
    db.__routeQuery([
      ['SELECT id, phone, name, role FROM users WHERE id', { rows: [{ id: 'u9', phone: '0171', name: 'A', role: 'admin' }] }],
      ["role = 'admin' AND status = 'active'", { rows: [{ c: '0' }] }],
    ]);
    const r = await withAdmin(request(app()).delete('/api/admin/users/u9?confirm=yes')).expect(403);
    expect(r.body.error).toBe('LAST_ADMIN');
  });
});

describe('orders', () => {
  test('GET /orders → 200 list', async () => {
    db.__routeQuery([
      ['SELECT COUNT(*) FROM orders o', { rows: [{ count: '0' }] }],
      ['FROM orders o JOIN users', { rows: [] }],
    ]);
    const r = await withAdmin(request(app()).get('/api/admin/orders')).expect(200);
    expect(r.body.orders).toEqual([]);
  });

  test('PUT /orders/:id/status: invalid status → 400 INVALID_STATUS', async () => {
    const r = await withAdmin(request(app()).put('/api/admin/orders/o1/status'))
      .send({ status: 'shipped' }).expect(400);
    expect(r.body.error).toBe('INVALID_STATUS');
  });

  test('PUT /orders/:id/status: not found → 404', async () => {
    db.__routeQuery([['SELECT * FROM orders WHERE id', { rows: [] }]]);
    await withAdmin(request(app()).put('/api/admin/orders/o1/status')).send({ status: 'completed' }).expect(404);
  });

  test('PUT /orders/:id/status → completed → 200', async () => {
    db.__routeQuery([
      ['SELECT * FROM orders WHERE id', { rows: [{ id: 'o1', user_id: 'u1', status: 'processing' }] }],
      ['UPDATE orders SET status', { rows: [{ id: 'o1', user_id: 'u1', status: 'completed' }] }],
    ]);
    const r = await withAdmin(request(app()).put('/api/admin/orders/o1/status'))
      .send({ status: 'completed' }).expect(200);
    expect(r.body.order.status).toBe('completed');
    // history recorded
    const h = db.query.mock.calls.find((c) => /order_status_history/.test(c[0]));
    expect(h).toBeDefined();
    expect(h[1].slice(0, 3)).toEqual(['o1', 'processing', 'completed']);
  });

  test('H-1: invalid transition (new → delivered) → 400 INVALID_TRANSITION', async () => {
    db.__routeQuery([
      ['SELECT * FROM orders WHERE id', { rows: [{ id: 'o1', user_id: 'u1', status: 'new' }] }],
    ]);
    const r = await withAdmin(request(app()).put('/api/admin/orders/o1/status'))
      .send({ status: 'delivered' }).expect(400);
    expect(r.body.error).toBe('INVALID_TRANSITION');
    expect(r.body.allowed).toEqual(['pending', 'processing', 'cancelled']);
  });

  test('H-1: refunded is terminal (refunded → new) → 400', async () => {
    db.__routeQuery([
      ['SELECT * FROM orders WHERE id', { rows: [{ id: 'o1', user_id: 'u1', status: 'refunded' }] }],
    ]);
    await withAdmin(request(app()).put('/api/admin/orders/o1/status'))
      .send({ status: 'new' }).expect(400);
  });

  test('refunded status credits wallet (idempotent refund ref)', async () => {
    db.__routeQuery([
      ['SELECT * FROM orders WHERE id', { rows: [{ id: 'o1', user_id: 'u1', price: '200', status: 'completed' }] }],
      ['UPDATE orders SET status', { rows: [{ id: 'o1', user_id: 'u1', price: '200', status: 'refunded' }] }],
    ]);
    await withAdmin(request(app()).put('/api/admin/orders/o1/status')).send({ status: 'refunded' }).expect(200);
    const w = db.query.mock.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(w).toBeDefined();
    expect(w[1]).toEqual(['u1', 200, 'refund', 'refund-o1']);
  });
});

describe('support messages', () => {
  test('GET /support-templates → 6 templates', async () => {
    const r = await withAdmin(request(app()).get('/api/admin/support-templates')).expect(200);
    expect(r.body.templates).toHaveLength(6);
  });
  test('POST message: empty/too long → 400; order missing → 404; happy → 201', async () => {
    const r1 = await withAdmin(request(app()).post('/api/admin/orders/o1/support-message'))
      .send({ message: '' }).expect(400);
    expect(r1.body.error).toBe('INVALID_MESSAGE');
    const r2 = await withAdmin(request(app()).post('/api/admin/orders/o1/support-message'))
      .send({ message: 'x'.repeat(501) }).expect(400);
    expect(r2.body.error).toBe('INVALID_MESSAGE');
    db.__routeQuery([['SELECT id FROM orders WHERE id', { rows: [] }]]);
    const r3 = await withAdmin(request(app()).post('/api/admin/orders/o1/support-message'))
      .send({ message: 'hello' }).expect(404);
    expect(r3.body.error).toBe('ORDER_NOT_FOUND');
    db.__reset();
    db.__routeQuery([
      ['SELECT id FROM orders WHERE id', { rows: [{ id: 'o1' }] }],
      ['INSERT INTO order_support_messages', { rows: [{ id: 'm1', message: 'hello' }] }],
    ]);
    const r4 = await withAdmin(request(app()).post('/api/admin/orders/o1/support-message'))
      .send({ message: 'hello' }).expect(201);
    expect(r4.body.message.id).toBe('m1');
  });
});

describe('services', () => {
  test('GET /services → 200', async () => {
    db.__routeQuery([['FROM services s LEFT JOIN', { rows: [{ id: 's1' }] }]]);
    const r = await withAdmin(request(app()).get('/api/admin/services')).expect(200);
    expect(r.body.services).toHaveLength(1);
  });

  test('POST /services: invalid type → 400; invalid category → 400; happy → 201', async () => {
    const base = { name: 'Test Service', type: 'manual' };
    const r1 = await withAdmin(request(app()).post('/api/admin/services')).send({ ...base, type: 'magic' }).expect(400);
    expect(r1.body.error).toBe('INVALID_TYPE');
    db.__routeQuery([['SELECT id FROM service_categories WHERE id', { rows: [] }]]);
    const r2 = await withAdmin(request(app()).post('/api/admin/services'))
      .send({ ...base, category_id: 'nope' }).expect(400);
    expect(r2.body.error).toBe('INVALID_CATEGORY');
    db.__reset();
    db.__routeQuery([
      ['SELECT id FROM service_categories WHERE id', { rows: [{ id: 'c1' }] }],
      ['SELECT COALESCE(MAX(serial)', { rows: [{ s: 3 }] }],
      ['INSERT INTO services', { rows: [{ id: 's9', name: 'Test Service' }] }],
    ]);
    const r3 = await withAdmin(request(app()).post('/api/admin/services'))
      .send({ ...base, category_id: 'c1' }).expect(201);
    expect(r3.body.service.id).toBe('s9');
  });

  test('PUT /services/:id: nothing → 400; missing → 404; happy → 200', async () => {
    await withAdmin(request(app()).put('/api/admin/services/s1')).send({}).expect(400);
    db.__routeQuery([['UPDATE services SET', { rows: [] }]]);
    await withAdmin(request(app()).put('/api/admin/services/s1')).send({ price: 5 }).expect(404);
    db.__reset();
    db.__routeQuery([['UPDATE services SET', { rows: [{ id: 's1', price: 5 }] }]]);
    const r = await withAdmin(request(app()).put('/api/admin/services/s1')).send({ price: 5 }).expect(200);
    expect(r.body.service.price).toBe(5);
  });

  test("POST /services/:id/duplicate clones service as disabled copy", async () => {
    db.__routeQuery([
      ["SELECT * FROM services WHERE id = $1", { rows: [{ id: "s1", name: "Doc Service", name_bn: "ডক সেবা", type: "manual", price: 50, serial: 1 }] }],
      ["SELECT COALESCE(MAX(serial), -1) + 1 AS s FROM services", { rows: [{ s: 2 }] }],
      ["INSERT INTO services", { rows: [{ id: "s1_copy", name: "Doc Service (Copy)", name_bn: "ডক সেবা (কপি)", status: "disabled" }] }],
      ["INSERT INTO audit_logs", { rows: [{ id: 1 }] }],
    ]);
    const r = await withAdmin(request(app()).post("/api/admin/services/s1/duplicate")).expect(201);
    expect(r.body.service.id).toBe("s1_copy");
    expect(r.body.service.status).toBe("disabled");
  });


  test('DELETE /services/:id requires confirm=yes', async () => {
    await withAdmin(request(app()).delete('/api/admin/services/s1')).expect(400);
    db.__routeQuery([
      ['SELECT COUNT(*) AS c FROM orders WHERE service_id', { rows: [{ c: '0' }] }],
      ['DELETE FROM services WHERE id', { rows: [{ id: 's1', name: 'S' }] }],
    ]);
    await withAdmin(request(app()).delete('/api/admin/services/s1?confirm=yes')).expect(200);
  });

  test('M-12: delete service with orders → 400 SERVICE_IN_USE', async () => {
    db.__routeQuery([
      ['SELECT COUNT(*) AS c FROM orders WHERE service_id', { rows: [{ c: '3' }] }],
    ]);
    const r = await withAdmin(request(app()).delete('/api/admin/services/s1?confirm=yes')).expect(400);
    expect(r.body.error).toBe('SERVICE_IN_USE');
    expect(r.body.orders).toBe(3);
  });

  // REGRESSION GUARD (fixed): PUT /services/reorder must be registered BEFORE
  // PUT /services/:id, otherwise Express matches 'reorder' as :id and the
  // handler becomes dead code returning 400 NOTHING_TO_UPDATE.
  test('PUT /services/reorder works (not shadowed by /services/:id)', async () => {
    const r1 = await withAdmin(request(app()).put('/api/admin/services/reorder'))
      .send({ order: 'nope' }).expect(400);
    expect(r1.body.error).toBe('INVALID_ORDER');
    expect(db.withTransaction).not.toHaveBeenCalled();
    const r2 = await withAdmin(request(app()).put('/api/admin/services/reorder'))
      .send({ order: ['s2', 's1'] }).expect(200);
    expect(r2.body).toEqual({ ok: true });
    expect(db.withTransaction).toHaveBeenCalled();
  });
});

describe('service categories', () => {
  test('POST: short name → 400; happy → 201', async () => {
    const r1 = await withAdmin(request(app()).post('/api/admin/service-categories'))
      .send({ name: 'A' }).expect(400);
    expect(r1.body.error).toBe('INVALID_NAME');
    db.__routeQuery([
      ['SELECT COALESCE(MAX(serial)', { rows: [{ s: 0 }] }],
      ['INSERT INTO service_categories', { rows: [{ id: 'c1', name: 'Docs' }] }],
    ]);
    const r2 = await withAdmin(request(app()).post('/api/admin/service-categories'))
      .send({ name: 'Docs' }).expect(201);
    expect(r2.body.category.id).toBe('c1');
  });
  test('PUT /service-categories/reorder → 200 via transaction', async () => {
    await withAdmin(request(app()).put('/api/admin/service-categories/reorder'))
      .send({ order: ['c1'] }).expect(200);
    expect(db.withTransaction).toHaveBeenCalled();
  });
  test('DELETE requires confirm; 404 when missing', async () => {
    await withAdmin(request(app()).delete('/api/admin/service-categories/c1')).expect(400);
    db.__routeQuery([['DELETE FROM service_categories WHERE id', { rows: [] }]]);
    await withAdmin(request(app()).delete('/api/admin/service-categories/c1?confirm=yes')).expect(404);
  });
});

describe('transactions (security fix: filter allowlist)', () => {
  test('invalid status/type are ignored, never interpolated', async () => {
    db.__routeQuery([
      ['SELECT COUNT(*) FROM transactions t', { rows: [{ count: '0' }] }],
      ['FROM transactions t JOIN users', { rows: [] }],
    ]);
    await withAdmin(request(app()).get('/api/admin/transactions?status=hacked&type=bogus')).expect(200);
    const q = db.query.mock.calls.find((c) => /SELECT COUNT\(\*\) FROM transactions t/.test(c[0]));
    expect(q[0]).not.toContain('hacked');
    expect(q[0]).not.toContain('bogus');
    expect(q[1]).toEqual([]);
  });

  test('valid status/type become parameters', async () => {
    db.__routeQuery([
      ['SELECT COUNT(*) FROM transactions t', { rows: [{ count: '0' }] }],
      ['FROM transactions t JOIN users', { rows: [] }],
    ]);
    await withAdmin(request(app()).get('/api/admin/transactions?status=pending&type=recharge')).expect(200);
    const q = db.query.mock.calls.find((c) => /SELECT COUNT\(\*\) FROM transactions t/.test(c[0]));
    expect(q[1]).toEqual(['pending', 'recharge']);
  });

  test('approve: not found → 404; not pending → 400 ALREADY_PROCESSED', async () => {
    db.__routeQuery([['SELECT * FROM transactions WHERE id', { rows: [] }]]);
    await withAdmin(request(app()).put('/api/admin/transactions/t1/approve')).expect(404);
    db.__reset();
    db.__routeQuery([['SELECT * FROM transactions WHERE id', {
      rows: [{ id: 't1', status: 'approved', user_id: 'u1', amount: '100', type: 'recharge', trxid: 'X' }],
    }]]);
    const r = await withAdmin(request(app()).put('/api/admin/transactions/t1/approve')).expect(400);
    expect(r.body.error).toBe('ALREADY_PROCESSED');
  });

  test('approve happy → 200, atomic via withTransaction', async () => {
    db.__routeQuery([['SELECT * FROM transactions WHERE id', {
      rows: [{ id: 't1', status: 'pending', user_id: 'u1', amount: '100', type: 'recharge', trxid: 'TRX1' }],
    }]]);
    const r = await withAdmin(request(app()).put('/api/admin/transactions/t1/approve')).expect(200);
    expect(r.body.ok).toBe(true);
    expect(db.withTransaction).toHaveBeenCalled();
    const w = db.__client.query.mock.calls.find((c) => /wallet_apply/.test(c[0]));
    // C-4 fix: 5th param reuses the existing pending row — no double ledger row
    expect(w[1]).toEqual(['u1', 100, 'recharge', 'TRX1', 't1']);
  });

  test('approve: DUPLICATE_TRANSACTION surfaces as 400 with the message', async () => {
    db.__routeQuery([
      ['SELECT * FROM transactions WHERE id', {
        rows: [{ id: 't1', status: 'pending', user_id: 'u1', amount: '100', type: 'recharge', trxid: 'TRX1' }],
      }],
      ['wallet_apply', () => { throw new Error('DUPLICATE_TRANSACTION'); }],
    ]);
    const r = await withAdmin(request(app()).put('/api/admin/transactions/t1/approve')).expect(400);
    expect(r.body.error).toBe('DUPLICATE_TRANSACTION');
  });

  test('reject: not pending → 400 NOT_PENDING; happy → 200', async () => {
    db.__routeQuery([['UPDATE transactions SET status = \'rejected\'', { rows: [] }]]);
    const r1 = await withAdmin(request(app()).put('/api/admin/transactions/t1/reject')).expect(400);
    expect(r1.body.error).toBe('NOT_PENDING');
    db.__reset();
    db.__routeQuery([['UPDATE transactions SET status = \'rejected\'', { rows: [{ id: 't1' }] }]]);
    const r2 = await withAdmin(request(app()).put('/api/admin/transactions/t1/reject')).expect(200);
    expect(r2.body.ok).toBe(true);
  });
});

describe('coupons / banners / notices', () => {
  test('POST /coupons: invalid → 400; duplicate code → 500 CODE_TAKEN; happy → 201', async () => {
    const r1 = await withAdmin(request(app()).post('/api/admin/coupons'))
      .send({ code: 'X', type: 'weird' }).expect(400);
    expect(r1.body.error).toBe('INVALID_INPUT');
    db.query.mockImplementation(async (text) => {
      if (/INSERT INTO coupons/.test(text)) { const e = new Error('dup'); e.code = '23505'; throw e; }
      return { rows: [], rowCount: 0 };
    });
    const r2 = await withAdmin(request(app()).post('/api/admin/coupons'))
      .send({ code: 'X', type: 'promo' }).expect(500);
    expect(r2.body.error).toBe('CODE_TAKEN');
    db.__reset();
    db.__routeQuery([['INSERT INTO coupons', { rows: [{ id: 'c1', code: 'X' }] }]]);
    const r3 = await withAdmin(request(app()).post('/api/admin/coupons'))
      .send({ code: 'x', type: 'promo' }).expect(201);
    expect(r3.body.coupon.code).toBe('X'); // uppercased
  });

  test('PUT /coupons/:id: invalid status → 400', async () => {
    const r = await withAdmin(request(app()).put('/api/admin/coupons/c1'))
      .send({ status: 'whatever' }).expect(400);
    expect(r.body.error).toBe('INVALID_STATUS');
  });

  test('banners: invalid type → 400; happy → 201; update nothing → 400; delete → 200', async () => {
    const r1 = await withAdmin(request(app()).post('/api/admin/banners'))
      .send({ type: 'nope', title: 'T' }).expect(400);
    expect(r1.body.error).toBe('INVALID_INPUT');
    db.__routeQuery([['INSERT INTO banners', { rows: [{ id: 'b1' }] }]]);
    await withAdmin(request(app()).post('/api/admin/banners'))
      .send({ type: 'banner', title: 'T' }).expect(201);
    const r3 = await withAdmin(request(app()).put('/api/admin/banners/b1')).send({}).expect(400);
    expect(r3.body.error).toBe('NOTHING_TO_UPDATE');
    await withAdmin(request(app()).delete('/api/admin/banners/b1')).expect(200);
  });

  test('notices: invalid → 400; happy → 201; delete → 200', async () => {
    const r1 = await withAdmin(request(app()).post('/api/admin/notices'))
      .send({ title: 'T' }).expect(400);
    expect(r1.body.error).toBe('INVALID_INPUT');
    db.__routeQuery([['INSERT INTO notices', { rows: [{ id: 'n1' }] }]]);
    await withAdmin(request(app()).post('/api/admin/notices'))
      .send({ title: 'T', message: 'M' }).expect(201);
    await withAdmin(request(app()).delete('/api/admin/notices/n1')).expect(200);
  });
});

describe('stats', () => {
  test('GET /stats → 200', async () => {
    db.__routeQuery([['SELECT', { rows: [{ users: '5', orders_total: '3' }] }]]);
    const r = await withAdmin(request(app()).get('/api/admin/stats')).expect(200);
    expect(r.body.users).toBe('5');
  });
  test('GET /stats/sms → count; DB error → 0 (never breaks)', async () => {
    db.__routeQuery([['FROM incoming_sms', { rows: [{ count: '7' }] }]]);
    const r1 = await withAdmin(request(app()).get('/api/admin/stats/sms')).expect(200);
    expect(r1.body.unmatched_sms).toBe(7);
    db.__reset();
    db.query.mockImplementation(async () => { throw new Error('no table'); });
    const r2 = await withAdmin(request(app()).get('/api/admin/stats/sms')).expect(200);
    expect(r2.body.unmatched_sms).toBe(0);
  });
  test('GET /activity-log → 200', async () => {
    db.__routeQuery([
      ['SELECT COUNT(*) FROM activity_log', { rows: [{ count: '1' }] }],
      ['FROM activity_log a', { rows: [{ id: 'l1' }] }],
    ]);
    const r = await withAdmin(request(app()).get('/api/admin/activity-log')).expect(200);
    expect(r.body.total).toBe(1);
  });
});

describe('settings (security: whatsapp token masking + rotation)', () => {
  test('GET /settings masks the WhatsApp access token', async () => {
    db.__routeQuery([['SELECT key, value FROM settings', {
      rows: [
        { key: 'whatsapp', value: { enabled: true, access_token: 'real-secret-token', phone_number_id: '1' } },
        { key: 'cashback', value: { percent: 5 } },
      ],
    }]]);
    const r = await withAdmin(request(app()).get('/api/admin/settings')).expect(200);
    expect(r.body.whatsapp.access_token).toBeUndefined();
    expect(r.body.whatsapp.access_token_set).toBe(true);
    expect(r.body.whatsapp.phone_number_id).toBe('1');
    expect(r.body.cashback.percent).toBe(5);
  });

  test('PUT whatsapp with NEW token but no admin_password → 403 WRONG_PASSWORD', async () => {
    db.__routeQuery([["SELECT value FROM settings WHERE key = 'whatsapp'", {
      rows: [{ value: { access_token: 'old-token' } }],
    }]]);
    const r = await withAdmin(request(app()).put('/api/admin/settings'))
      .send({ whatsapp: { access_token: 'brand-new-token' } }).expect(403);
    expect(r.body.error).toBe('WRONG_PASSWORD');
  });

  test('PUT whatsapp with NEW token + wrong password → 403', async () => {
    const pwHash = await auth.hashPassword('correct123');
    db.__routeQuery([
      ["SELECT value FROM settings WHERE key = 'whatsapp'", { rows: [{ value: { access_token: 'old-token' } }] }],
      ['SELECT password_hash FROM users WHERE id', { rows: [{ password_hash: pwHash }] }],
    ]);
    const r = await withAdmin(request(app()).put('/api/admin/settings'))
      .send({ whatsapp: { access_token: 'brand-new-token' }, admin_password: 'wrong' }).expect(403);
    expect(r.body.error).toBe('WRONG_PASSWORD');
  });

  test('PUT whatsapp with NEW token + correct password → stored', async () => {
    const pwHash = await auth.hashPassword('correct123');
    db.__routeQuery([
      ["SELECT value FROM settings WHERE key = 'whatsapp'", { rows: [{ value: { access_token: 'old-token' } }] }],
      ['SELECT password_hash FROM users WHERE id', { rows: [{ password_hash: pwHash }] }],
    ]);
    const r = await withAdmin(request(app()).put('/api/admin/settings'))
      .send({ whatsapp: { access_token: 'brand-new-token', enabled: true }, admin_password: 'correct123' })
      .expect(200);
    expect(r.body.updated).toContain('whatsapp');
    const ins = db.query.mock.calls.find((c) => /INSERT INTO settings/.test(c[0]) && c[1][0] === 'whatsapp');
    expect(JSON.parse(ins[1][1]).access_token).toBe('brand-new-token');
  });

  test('PUT whatsapp with masked token preserves the stored token', async () => {
    db.__routeQuery([
      ["SELECT value FROM settings WHERE key = 'whatsapp'", { rows: [{ value: { access_token: 'old-token' } }] }],
    ]);
    await withAdmin(request(app()).put('/api/admin/settings'))
      .send({ whatsapp: { access_token: '••••••••', enabled: true } }).expect(200);
    const ins = db.query.mock.calls.find((c) => /INSERT INTO settings/.test(c[0]) && c[1][0] === 'whatsapp');
    expect(JSON.parse(ins[1][1]).access_token).toBe('old-token');
  });

  test('disallowed settings keys are ignored', async () => {
    const r = await withAdmin(request(app()).put('/api/admin/settings'))
      .send({ jwt_secret: 'hack', unknown_key: 1 }).expect(200);
    expect(r.body.updated).toEqual([]);
  });
});

describe('reports (security fix: date regex validation)', () => {
  test('invalid from/to are dropped from the query (incl. SQLi-shaped)', async () => {
    db.__routeQuery([['FROM orders o JOIN users', { rows: [] }]]);
    const r = await withAdmin(request(app()).get(
      "/api/admin/reports/orders?from=not-a-date&to=2026-10-01' OR '1'='1"
    )).expect(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    const q = db.query.mock.calls.find((c) => /FROM orders o JOIN users/.test(c[0]));
    expect(q[1]).toEqual([]); // nothing passed as params
  });

  test('valid YYYY-MM-DD from/to are passed as params', async () => {
    db.__routeQuery([['FROM orders o JOIN users', { rows: [] }]]);
    await withAdmin(request(app()).get('/api/admin/reports/orders?from=2026-10-01&to=2026-10-31')).expect(200);
    const q = db.query.mock.calls.find((c) => /FROM orders o JOIN users/.test(c[0]));
    expect(q[1]).toEqual(['2026-10-01', '2026-10-31']);
  });

  test('format-valid but impossible date passes the regex (documented behavior)', async () => {
    db.__routeQuery([['FROM orders o JOIN users', { rows: [] }]]);
    await withAdmin(request(app()).get('/api/admin/reports/orders?from=2026-13-99')).expect(200);
    const q = db.query.mock.calls.find((c) => /FROM orders o JOIN users/.test(c[0]));
    expect(q[1]).toEqual(['2026-13-99']); // regex is format-only
  });

  test('GET /reports/transactions → 200 PDF', async () => {
    db.__routeQuery([['FROM transactions t JOIN users', { rows: [] }]]);
    const r = await withAdmin(request(app()).get('/api/admin/reports/transactions')).expect(200);
    expect(r.headers['content-type']).toContain('application/pdf');
  });
});

describe('recharge/pending (TTS notifier endpoint)', () => {
  test('returns list of pending recharges with user names', async () => {
    db.__routeQuery([
      ["WHERE t.status = 'pending' AND t.type = 'recharge'", { rows: [
        { id: 'tx1', amount: 100, user_name: 'করিম' },
      ] }],
    ]);
    const r = await withAdmin(request(app()).get('/api/admin/recharge/pending')).expect(200);
    expect(Array.isArray(r.body.list)).toBe(true);
    expect(r.body.list[0].user_name).toBe('করিম');
  });
});
