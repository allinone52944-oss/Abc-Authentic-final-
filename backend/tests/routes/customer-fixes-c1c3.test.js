// Customer-facing fixes C1 + C3 (2026-11-03 audit).
// Route tests for backend/routes/user.js.
// NOTE on the download-goodwill cases: the test sandbox has no
// /opt/all-in-one-abc-authentic/uploads/orders files, so a gate
// that PASSES surfaces as 404 FILE_MISSING, not 200. The
// assertion that matters is 403-vs-not-403: a blocked file must
// be 403 NOT_DELIVERED_YET, a delivered-then-refunded file must
// NOT be 403 (it reaches the file-exists check instead).
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
const withUser = (req, id = 'u1') => req.set('Authorization', 'Bearer ' + auth.signAccess({ id, role: 'user' }));

const ADMIN_DOCS = JSON.stringify([{ type: 'delivery', filename: 'deliv.pdf', originalname: 'deliv.pdf', uploaded_by: 'admin' }]);
const CUSTOMER_DOCS = JSON.stringify([{ type: 'document', filename: 'mine.pdf', originalname: 'mine.pdf', uploaded_by: 'customer' }]);

beforeEach(() => { db.__reset(); });

describe('C1: duplicate-submit path strips admin_note', () => {
  function serviceHandlers(insertRow) {
    return [
      ['FROM services WHERE id', { rows: [{ id: 's1', name: 'NID', name_bn: 'এনআইডি', type: 'manual', price: 100, serial: 0, status: 'active', documents_required: [], fields_required: [], schedule: null, rules_text: null, engine_id: null }] }],
      ['FROM user_services WHERE user_id', { rows: [] }],
      ['INSERT INTO orders', { rows: [insertRow] }],
      ['users WHERE id = $1 FOR UPDATE', { rows: [{ balance: 10000 }] }],
      ['wallet_apply', { rows: [{ new_balance: 9900, tx_id: 'tx9' }] }],
      ['SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2',
        (text, params) => ({ rows: params[1] === 'test-key' ? [{ id: 'o_orig', idempotency_key: 'test-key', admin_note: 'internal: fraud?', status: 'new' }] : [] })],
    ];
  }

  test('duplicate order row carries no admin_note', async () => {
    // payForService runs on the transaction CLIENT, so the
    // DUPLICATE_TRANSACTION throw must be on the client mock;
    // the duplicate lookup itself runs on db.query.
    const service = { id: 's1', name: 'NID', name_bn: 'এনআইডি', type: 'manual', price: 100, serial: 0, status: 'active', documents_required: [], fields_required: [], schedule: null, rules_text: null, engine_id: null };
    const impl = async (text) => {
      if (/wallet_apply/.test(text)) throw new Error('DUPLICATE_TRANSACTION on ref');
      if (String(text).includes('SELECT balance FROM users WHERE id')) return { rows: [{ balance: 10000 }] };
      if (String(text).includes('FROM services WHERE id')) return { rows: [service] };
      if (String(text).includes('FROM user_services WHERE user_id')) return { rows: [] };
      if (String(text).includes('SELECT * FROM orders WHERE user_id')) {
        return { rows: [{ id: 'o_orig', idempotency_key: 'test-key', admin_note: 'internal: fraud?', status: 'new' }] };
      }
      return { rows: [] };
    };
    db.query.mockImplementation(impl);
    db.__client.query.mockImplementation(impl);
    const r = await withUser(request(app()).post('/api/orders'))
      .send({ service_id: 's1', idempotency_key: 'test-key' }).expect(200);
    expect(r.body.duplicate).toBe(true);
    expect(r.body.order.id).toBe('o_orig');
    expect(r.body.order.admin_note).toBeUndefined();
  });

  test('fresh 201 create also strips admin_note from RETURNING *', async () => {
    db.__routeQuery(serviceHandlers(
      { id: 'o1', user_id: 'u1', service_id: 's1', status: 'new', price: 100, admin_note: 'should-not-leave' }
    ));
    const r = await withUser(request(app()).post('/api/orders'))
      .send({ service_id: 's1', data: {} }).expect(201);
    expect(r.body.order.id).toBe('o1');
    expect(r.body.order.admin_note).toBeUndefined();
  });
});

describe('C3: refunded over-grant closed, delivered goodwill kept', () => {
  // historyRows here are the SQL-FILTERED result: the mock cannot
  // apply the helper's WHERE clause, so a never-delivered order
  // (whose real query returns zero rows) is mocked as [].
  function downloadHandlers(status, docs, historyRows) {
    return [
      ['SELECT status, documents FROM orders', { rows: [{ status, documents: docs }] }],
      ['FROM order_status_history', { rows: historyRows }],
    ];
  }

  test('hand-refunded failed order: admin file → 403, never exposed', async () => {
    db.__routeQuery(downloadHandlers('refunded', ADMIN_DOCS, []));
    const r = await withUser(request(app()).get('/api/orders/o1/documents/deliv.pdf')).expect(403);
    expect(r.body.error).toBe('NOT_DELIVERED_YET');
  });

  test('hand-refunded cancelled order: admin file → 403', async () => {
    db.__routeQuery(downloadHandlers('refunded', ADMIN_DOCS, []));
    await withUser(request(app()).get('/api/orders/o1/documents/deliv.pdf')).expect(403);
  });

  test('delivered→refunded goodwill: admin file passes the gate (404 = file absent in test env, not 403)', async () => {
    db.__routeQuery(downloadHandlers('refunded', ADMIN_DOCS, [
      { from_status: 'processing', to_status: 'completed' },
      { from_status: 'completed', to_status: 'delivered' },
      { from_status: 'delivered', to_status: 'refunded' },
    ]));
    const r = await withUser(request(app()).get('/api/orders/o1/documents/deliv.pdf')).expect(404);
    expect(r.body.error).toBe('FILE_MISSING');
  });

  test('completed→refunded auto order (refund row FROM completed): gate passes', async () => {
    db.__routeQuery(downloadHandlers('refunded', ADMIN_DOCS, [
      { from_status: 'completed', to_status: 'refunded' },
    ]));
    const r = await withUser(request(app()).get('/api/orders/o1/documents/deliv.pdf')).expect(404);
    expect(r.body.error).toBe('FILE_MISSING');
  });

  test('refunded order, customer own upload: still downloadable path (not 403)', async () => {
    db.__routeQuery(downloadHandlers('refunded', CUSTOMER_DOCS, []));
    const r = await withUser(request(app()).get('/api/orders/o1/documents/mine.pdf')).expect(404);
    expect(r.body.error).toBe('FILE_MISSING');
  });

  test('detail flag: refunded + delivered history → true; refunded + failed-only → false', async () => {
    db.__routeQuery([
      ['FROM orders o JOIN services', { rows: [{ id: 'o1', status: 'refunded', documents: '[]', price: 100 }] }],
      ['FROM order_status_history', { rows: [
        { from_status: 'completed', to_status: 'delivered' },
        { from_status: 'delivered', to_status: 'refunded' },
      ] }],
    ]);
    const good = await withUser(request(app()).get('/api/orders/o1')).expect(200);
    expect(good.body.order.delivered_before_refund).toBe(true);

    db.__reset();
    db.__routeQuery([
      ['FROM orders o JOIN services', { rows: [{ id: 'o1', status: 'refunded', documents: '[]', price: 100 }] }],
      // SQL-filtered result for a failed→refunded row: zero rows.
      ['FROM order_status_history', { rows: [] }],
    ]);
    const bad = await withUser(request(app()).get('/api/orders/o1')).expect(200);
    expect(bad.body.order.delivered_before_refund).toBe(false);
  });

  test('History SQL gates refunded rows on the timeline (mock cannot enforce SQL, so assert the SQL)', async () => {
    db.__routeQuery([
      ['FROM orders o LEFT JOIN services', { rows: [] }],
      ['FROM manual_submissions m LEFT JOIN services', { rows: [] }],
      ['FROM engine_jobs', { rows: [] }],
    ]);
    await withUser(request(app()).get('/api/history')).expect(200);
    const q = db.query.mock.calls.find((c) => /FROM orders o LEFT JOIN services/.test(c[0]));
    expect(q).toBeDefined();
    expect(q[0]).toContain('order_status_history');
    expect(q[0]).toContain('EXISTS');
    // Never-delivered statuses still excluded outright.
    expect(q[0]).not.toContain("o.status IN ('completed', 'delivered', 'refunded')");
  });
});
