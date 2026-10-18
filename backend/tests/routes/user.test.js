// Route tests for backend/routes/user.js (user-scoped API).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const userRouter = require('../../routes/user');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api', userRouter);
  return a;
}
const token = (id = 'u1') => auth.signAccess({ id, role: 'user' });
const withUser = (req, id) => req.set('Authorization', 'Bearer ' + token(id));

const SERVICE = {
  id: 's1', name: 'NID Service', name_bn: 'এনআইডি', type: 'manual',
  price: 100, serial: 0, status: 'active', documents_required: [], fields_required: [],
  schedule: null, rules_text: null, engine_id: null,
  cat_id: null, cat_name: null, cat_name_bn: null, cat_icon: null, cat_serial: null,
};

beforeEach(() => { db.__reset(); });

describe('auth gate', () => {
  test('all routes require auth → 401', async () => {
    await request(app()).get('/api/services').expect(401);
    await request(app()).get('/api/wallet').expect(401);
    await request(app()).post('/api/orders').send({}).expect(401);
  });
});

describe('GET /api/services', () => {
  test('empty → { services: [] }', async () => {
    db.__routeQuery([['FROM services s', { rows: [] }]]);
    const r = await withUser(request(app()).get('/api/services')).expect(200);
    expect(r.body.services).toEqual([]);
  });

  test('returns services with effective price; access_enabled=false excluded', async () => {
    const s1 = { ...SERVICE, id: 's1' };
    const s2 = { ...SERVICE, id: 's2', price: 200 };
    db.__routeQuery([
      ['FROM services s', { rows: [s1, s2] }],
      ['FROM user_services WHERE user_id', (text, params) => {
        if (params[1] === 's1') return { rows: [{ custom_price: 80, access_enabled: true }] };
        if (params[1] === 's2') return { rows: [{ custom_price: null, access_enabled: false }] };
        return { rows: [] };
      }],
    ]);
    const r = await withUser(request(app()).get('/api/services')).expect(200);
    expect(r.body.services).toHaveLength(1);
    expect(r.body.services[0]).toMatchObject({ id: 's1', price: 80 });
  });

  test('DB error → 500 FAILED', async () => {
    db.query.mockImplementation(async () => { throw new Error('x'); });
    const r = await withUser(request(app()).get('/api/services')).expect(500);
    expect(r.body.error).toBe('FAILED');
  });
});

describe('GET /api/services/:id', () => {
  test('not found → 404 NOT_FOUND', async () => {
    db.__routeQuery([['FROM services s', { rows: [] }]]);
    await withUser(request(app()).get('/api/services/nope')).expect(404);
  });
  test('access disabled → 403 NO_ACCESS', async () => {
    db.__routeQuery([
      ['FROM services s', { rows: [{ ...SERVICE }] }],
      ['FROM user_services WHERE user_id', { rows: [{ custom_price: null, access_enabled: false }] }],
    ]);
    const r = await withUser(request(app()).get('/api/services/s1')).expect(403);
    expect(r.body.error).toBe('NO_ACCESS');
  });
});

describe('POST /api/orders', () => {
  function serviceHandlers(service = SERVICE) {
    return [
      ['FROM services WHERE id', { rows: [service] }],
      ['FROM user_services WHERE user_id', { rows: [] }],
      ['INSERT INTO orders', { rows: [{ id: 'o1', user_id: 'u1', service_id: service.id, status: 'new', price: service.price }] }],
    ];
  }

  test('happy path → 201', async () => {
    db.__routeQuery(serviceHandlers());
    const r = await withUser(request(app()).post('/api/orders'))
      .send({ service_id: 's1', data: { a: 1 } }).expect(201);
    expect(r.body.order.id).toBe('o1');
    expect(db.withTransaction).toHaveBeenCalled();
  });

  test('missing service_id → 400 MISSING_SERVICE', async () => {
    const r = await withUser(request(app()).post('/api/orders')).send({}).expect(400);
    expect(r.body.error).toBe('MISSING_SERVICE');
  });

  test('unknown service → 404 SERVICE_NOT_FOUND', async () => {
    db.__routeQuery([['FROM services WHERE id', { rows: [] }]]);
    const r = await withUser(request(app()).post('/api/orders')).send({ service_id: 'nope' }).expect(404);
    expect(r.body.error).toBe('SERVICE_NOT_FOUND');
  });

  test('closed service (schedule) → 403 SERVICE_CLOSED', async () => {
    const closed = { ...SERVICE, schedule: { open: '23:00', close: '23:59' } };
    db.__routeQuery(serviceHandlers(closed));
    const r = await withUser(request(app()).post('/api/orders')).send({ service_id: 's1' }).expect(403);
    expect(r.body.error).toBe('SERVICE_CLOSED');
  });

  test('missing required documents → 400 MISSING_DOCUMENTS', async () => {
    const withDocs = { ...SERVICE, documents_required: ['nid_front', 'nid_back'] };
    db.__routeQuery(serviceHandlers(withDocs));
    const r = await withUser(request(app()).post('/api/orders'))
      .send({ service_id: 's1', documents: [{ type: 'nid_front' }] }).expect(400);
    expect(r.body.error).toBe('MISSING_DOCUMENTS');
    expect(r.body.missing).toEqual(['nid_back']);
  });

  test('insufficient balance → 402 INSUFFICIENT_BALANCE', async () => {
    db.__routeQuery([
      ...serviceHandlers(),
      ['wallet_apply', () => { throw new Error('INSUFFICIENT_BALANCE by wallet_apply'); }],
    ]);
    const r = await withUser(request(app()).post('/api/orders')).send({ service_id: 's1' }).expect(402);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
  });

  test("duplicate submit (DUPLICATE_TRANSACTION) returns existing order without clientKey scope crash", async () => {
    db.__routeQuery([
      ...serviceHandlers(),
      ["wallet_apply", () => { throw new Error("DUPLICATE_TRANSACTION: order-test-key-u1"); }],
      ["SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2", { rows: [{ id: "o_orig", idempotency_key: "test-key" }] }],
    ]);
    const r = await withUser(request(app()).post("/api/orders"))
      .send({ service_id: "s1", idempotency_key: "test-key" })
      .expect(200);
    expect(r.body.duplicate).toBe(true);
    expect(r.body.order.id).toBe("o_orig");
  });

});

describe('orders read + chat', () => {
  test('GET /api/orders paginates', async () => {
    db.__routeQuery([
      ['SELECT COUNT(*) FROM orders o', { rows: [{ count: '3' }] }],
      ['FROM orders o JOIN services', { rows: [{ id: 'o1' }] }],
    ]);
    const r = await withUser(request(app()).get('/api/orders?page=2&limit=5')).expect(200);
    expect(r.body.total).toBe(3);
    expect(r.body.page).toBe(2);
    expect(r.body.limit).toBe(5);
  });

  test('GET /api/orders/:id of another user → 404 NOT_FOUND', async () => {
    db.__routeQuery([['WHERE o.id = $1 AND o.user_id = $2', { rows: [] }]]);
    await withUser(request(app()).get('/api/orders/other-id')).expect(404);
  });

  test('POST /api/orders/:id/chat: empty/too-long → 400 INVALID_MESSAGE', async () => {
    const r1 = await withUser(request(app()).post('/api/orders/o1/chat')).send({ message: '  ' }).expect(400);
    expect(r1.body.error).toBe('INVALID_MESSAGE');
    const r2 = await withUser(request(app()).post('/api/orders/o1/chat')).send({ message: 'x'.repeat(2001) }).expect(400);
    expect(r2.body.error).toBe('INVALID_MESSAGE');
  });

  test('POST /api/orders/:id/chat happy → 201', async () => {
    db.__routeQuery([
      ['FROM orders WHERE id = $1 AND user_id', { rows: [{ id: 'o1' }] }],
      ['INSERT INTO chat_messages', { rows: [{ id: 'm1', sender: 'user', message: 'hi' }] }],
    ]);
    const r = await withUser(request(app()).post('/api/orders/o1/chat')).send({ message: 'hi' }).expect(201);
    expect(r.body.message.id).toBe('m1');
  });

  test('GET /api/orders/:id/messages → 200', async () => {
    db.__routeQuery([
      ['FROM orders WHERE id = $1 AND user_id', { rows: [{ id: 'o1' }] }],
      ['FROM order_support_messages m', { rows: [] }],
    ]);
    const r = await withUser(request(app()).get('/api/orders/o1/messages')).expect(200);
    expect(r.body.messages).toEqual([]);
  });
});

describe('wallet', () => {
  test('GET /api/wallet → balance + transactions', async () => {
    db.__routeQuery([
      ['SELECT balance FROM users WHERE id', { rows: [{ balance: '250.5' }] }],
      ['SELECT COUNT(*) FROM transactions WHERE user_id', { rows: [{ count: '1' }] }],
      ['FROM transactions WHERE user_id', { rows: [{ id: 't1' }] }],
    ]);
    const r = await withUser(request(app()).get('/api/wallet')).expect(200);
    expect(r.body.balance).toBe(250.5);
    expect(r.body.total).toBe(1);
  });

  describe('POST /api/wallet/recharge validation', () => {
    const GOOD = { method: 'bkash_personal', sender_no: '01712345678', trxid: 'TRX12345', amount: 500 };
    test.each([
      ['bad method', { ...GOOD, method: 'paypal' }, 'INVALID_METHOD'],
      ['bad sender', { ...GOOD, sender_no: '123' }, 'INVALID_SENDER'],
      ['amount too small', { ...GOOD, amount: 5 }, 'INVALID_AMOUNT'],
      ['amount too big', { ...GOOD, amount: 100001 }, 'INVALID_AMOUNT'],
      ['amount NaN', { ...GOOD, amount: 'abc' }, 'INVALID_AMOUNT'],
      ['short trxid', { ...GOOD, trxid: 'ab' }, 'INVALID_TRXID'],
    ])('%s → 400 %s', async (_l, body, code) => {
      const r = await withUser(request(app()).post('/api/wallet/recharge')).send(body).expect(400);
      expect(r.body.error).toBe(code);
    });

    test('3 pending already → 400 TOO_MANY_PENDING', async () => {
      db.__routeQuery([['type = \'recharge\' AND status = \'pending\'', { rows: [{ count: '3' }] }]]);
      const r = await withUser(request(app()).post('/api/wallet/recharge')).send(GOOD).expect(400);
      expect(r.body.error).toBe('TOO_MANY_PENDING');
    });

    test('duplicate trxid → 409 DUP_TRXID', async () => {
      db.__routeQuery([
        ['type = \'recharge\' AND status = \'pending\'', { rows: [{ count: '0' }] }],
        ['FROM transactions WHERE trxid', { rows: [{ id: 't9' }] }],
      ]);
      const r = await withUser(request(app()).post('/api/wallet/recharge')).send(GOOD).expect(409);
      expect(r.body.error).toBe('DUP_TRXID');
    });

    test('happy path → 201', async () => {
      db.__routeQuery([
        ['type = \'recharge\' AND status = \'pending\'', { rows: [{ count: '0' }] }],
        ['FROM transactions WHERE trxid', { rows: [] }],
        ['INSERT INTO transactions', { rows: [{ id: 't1', status: 'pending' }] }],
      ]);
      const r = await withUser(request(app()).post('/api/wallet/recharge')).send(GOOD).expect(201);
      expect(r.body.transaction.id).toBe('t1');
    });
  });
});

describe('POST /api/wallet/coupon (security fix: transaction + CODE_TOO_LONG)', () => {
  function couponHandlers(coupon) {
    return [
      ['FROM coupons WHERE code', { rows: coupon ? [coupon] : [] }],
      ['SELECT COALESCE(SUM(ABS(amount)),0) AS s FROM transactions', { rows: [{ s: '1000' }] }],
      ['INSERT INTO daily_cashback_redemptions', { rows: [] }],
      ['SELECT balance FROM users WHERE id', { rows: [{ balance: '150' }] }],
    ];
  }
  const post = (code) => withUser(request(app()).post('/api/wallet/coupon')).send(code === undefined ? {} : { code });

  test('missing code → 400 MISSING_CODE', async () => {
    const r = await post(undefined).expect(400);
    expect(r.body.error).toBe('MISSING_CODE');
  });

  test('overlong code → 400 CODE_TOO_LONG (no DB hit)', async () => {
    const r = await post('X'.repeat(41)).expect(400);
    expect(r.body.error).toBe('CODE_TOO_LONG');
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('unknown code → 404 INVALID_CODE', async () => {
    db.__routeQuery(couponHandlers(null));
    const r = await post('NOPE').expect(404);
    expect(r.body.error).toBe('INVALID_CODE');
  });

  test('expired code → 400 EXPIRED_CODE', async () => {
    db.__routeQuery(couponHandlers({
      id: 'c1', code: 'OLD', type: 'cashback', percent: 0, amount: 50,
      expires_at: new Date(Date.now() - 1000).toISOString(), user_id: null, status: 'active',
    }));
    const r = await post('OLD').expect(400);
    expect(r.body.error).toBe('EXPIRED_CODE');
  });

  test("another user's code → 403 NOT_YOUR_CODE", async () => {
    db.__routeQuery(couponHandlers({
      id: 'c1', code: 'THEIRS', type: 'cashback', percent: 0, amount: 50,
      expires_at: null, user_id: 'someone-else', status: 'active',
    }));
    const r = await post('THEIRS').expect(403);
    expect(r.body.error).toBe('NOT_YOUR_CODE');
  });

  test('zero-value coupon → 400 ZERO_VALUE', async () => {
    db.__routeQuery(couponHandlers({
      id: 'c1', code: 'ZERO', type: 'cashback', percent: 0, amount: 0,
      expires_at: null, user_id: null, status: 'active',
    }));
    const r = await post('ZERO').expect(400);
    expect(r.body.error).toBe('ZERO_VALUE');
  });

  test('fixed-amount coupon → 200 credited', async () => {
    db.__routeQuery(couponHandlers({
      id: 'c1', code: 'SAVE50', type: 'cashback', percent: 0, amount: 50,
      expires_at: null, user_id: null, status: 'active',
    }));
    const r = await post('save50').expect(200);
    expect(r.body).toMatchObject({ ok: true, credited: 50, balance: 150 });
    expect(db.withTransaction).toHaveBeenCalled(); // race-safe path
  });

  test('percent coupon computes from approved debits', async () => {
    db.__routeQuery(couponHandlers({
      id: 'c2', code: 'P10', type: 'cashback', percent: 10, amount: 0,
      expires_at: null, user_id: null, status: 'active',
    }));
    const r = await post('P10').expect(200);
    expect(r.body.credited).toBe(100); // 10% of 1000
  });

  test('DUPLICATE_TRANSACTION → 409 ALREADY_REDEEMED', async () => {
    db.__routeQuery([
      ['FROM coupons WHERE code', { rows: [{ id: 'c1', code: 'D', type: 'cashback', percent: 0, amount: 10, expires_at: null, user_id: null, status: 'active' }] }],
      ['wallet_apply', () => { throw new Error('DUPLICATE_TRANSACTION on ref'); }],
    ]);
    const r = await post('D').expect(409);
    expect(r.body.error).toBe('ALREADY_REDEEMED');
  });

  test('coupon SELECT uses FOR UPDATE row lock', async () => {
    db.__routeQuery(couponHandlers({
      id: 'c1', code: 'L', type: 'cashback', percent: 0, amount: 10,
      expires_at: null, user_id: null, status: 'active',
    }));
    await post('L').expect(200);
    const sel = db.__client.query.mock.calls.find((c) => /FROM coupons WHERE code/.test(c[0]));
    expect(sel[0]).toMatch(/FOR UPDATE/);
  });
});

describe('notices + banners', () => {
  test('GET /api/notices → 200', async () => {
    db.__routeQuery([['FROM notices', { rows: [{ id: 'n1' }] }]]);
    const r = await withUser(request(app()).get('/api/notices')).expect(200);
    expect(r.body.notices).toHaveLength(1);
  });
  test('GET /api/banners?type=banner filters; invalid type ignored', async () => {
    db.__routeQuery([['FROM banners', { rows: [] }]]);
    await withUser(request(app()).get('/api/banners?type=banner')).expect(200);
    const q = db.query.mock.calls.find((c) => /FROM banners/.test(c[0]));
    expect(q[0]).toContain('AND type = $1');
    db.__reset();
    db.__routeQuery([['FROM banners', { rows: [] }]]);
    await withUser(request(app()).get('/api/banners?type=evil')).expect(200);
    const q2 = db.query.mock.calls.find((c) => /FROM banners/.test(c[0]));
    expect(q2[0]).not.toContain('evil');
  });
});

describe('order document download (2026-10-15)', () => {
  const docsJson = JSON.stringify([
    { filename: 'delivery-abc123.pdf', originalname: 'certificate.pdf', uploaded_by: 'admin' },
    { filename: 'order-xyz789.jpg', originalname: 'nid.jpg', uploaded_by: 'customer' },
  ]);
  test('GET /orders/:id/documents/:filename → 404 when order not owned', async () => {
    db.__routeQuery([['FROM orders WHERE id=$1 AND user_id=$2', { rows: [] }]]);
    await withUser(request(app()).get('/api/orders/o1/documents/delivery-abc123.pdf')).expect(404);
    db.__reset();
  });
  test('GET /orders/:id/documents/:filename → 404 when filename not in order docs', async () => {
    db.__routeQuery([['FROM orders WHERE id=$1 AND user_id=$2', { rows: [{ documents: docsJson }] }]]);
    await withUser(request(app()).get('/api/orders/o1/documents/evil.pdf')).expect(404);
    db.__reset();
  });
  test('GET /orders/:id/documents/:filename → 404 when file missing on disk', async () => {
    db.__routeQuery([['FROM orders WHERE id=$1 AND user_id=$2', { rows: [{ documents: docsJson }] }]]);
    await withUser(request(app()).get('/api/orders/o1/documents/delivery-abc123.pdf')).expect(404);
    db.__reset();
  });
});
