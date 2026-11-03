// P2 second sweep (2026-11-03): admin-note leak closure, phone-search
// equivalence, Dhaka-day revenue, cancel reason, delivery visibility.
// Route tests for backend/routes/admin.js + backend/routes/user.js.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../utils/whatsapp', () => ({
  notifyOrderCompleted: jest.fn().mockResolvedValue({ ok: true }),
  notifyOrderDelivered: jest.fn().mockResolvedValue({ ok: true }),
  notifyOrderRefunded: jest.fn().mockResolvedValue({ ok: true }),
  notifyOrderFailed: jest.fn().mockResolvedValue({ ok: true }),
  notifyOrderCancelled: jest.fn().mockResolvedValue({ ok: true }),
  notifyDeliveryFileAdded: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../utils/push', () => ({
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
  notifyNewChatMessage: jest.fn().mockResolvedValue({ ok: true }),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const adminRouter = require('../../routes/admin');
const userRouter = require('../../routes/user');
const wa = require('../../utils/whatsapp');
const push = require('../../utils/push');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', adminRouter);
  a.use('/api', userRouter);
  return a;
}
const adminToken = (id = 'admin1') => auth.signAccess({ id, role: 'admin' });
const userToken = (id = 'u1') => auth.signAccess({ id, role: 'user' });
const withAdmin = (req, id) => req.set('Authorization', 'Bearer ' + adminToken(id));
const withUser = (req, id) => req.set('Authorization', 'Bearer ' + userToken(id));

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
});

describe('P2 item 1: admin note never reaches the customer', () => {
  test('status transition writes NULL to history (never the admin note)', async () => {
    db.__routeQuery([
      ['SELECT * FROM orders WHERE id', { rows: [{ id: 'o1', user_id: 'u1', status: 'processing', admin_note: 'old', documents: '[]' }] }],
      ['UPDATE orders SET status', { rows: [{ id: 'o1', user_id: 'u1', status: 'completed', admin_note: 'new-note', documents: '[]' }] }],
    ]);
    const r = await withAdmin(request(app()).put('/api/admin/orders/o1/status'))
      .send({ status: 'completed', admin_note: 'new-note' }).expect(200);
    expect(r.body.changed).toBe(true);
    expect(r.body.noteChanged).toBe(true);
    const allCalls = [...db.query.mock.calls, ...db.__client.query.mock.calls];
    const h = allCalls.find((c) => /order_status_history/.test(c[0]));
    expect(h).toBeDefined();
    // No free-text note travels: params are [id, from, to, admin].
    expect(h[1]).toEqual(['o1', 'processing', 'completed', 'admin1']);
  });

  test('same-status empty note save honestly reports no change', async () => {
    db.__routeQuery([
      ['SELECT * FROM orders WHERE id', { rows: [{ id: 'o1', user_id: 'u1', status: 'processing', admin_note: 'keep', documents: '[]' }] }],
    ]);
    const r = await withAdmin(request(app()).put('/api/admin/orders/o1/status'))
      .send({ status: 'processing', admin_note: '' }).expect(200);
    expect(r.body.changed).toBe(false);
    expect(r.body.noteChanged).toBe(false);
  });

  test('customer order detail uses explicit columns — no admin_note', async () => {
    db.__routeQuery([
      ['FROM orders o JOIN services', { rows: [{ id: 'o1', status: 'processing', admin_note: 'secret', documents: '[]', price: 100 }] }],
    ]);
    const r = await withUser(request(app()).get('/api/orders/o1')).expect(200);
    expect(r.body.order.admin_note).toBeUndefined();
    const q = db.query.mock.calls.find((c) => /FROM orders o JOIN services/.test(c[0]));
    expect(q[0]).not.toContain('o.*');
    expect(q[0]).not.toContain('admin_note');
  });

  test('customer history returns no note column at all', async () => {
    db.__routeQuery([
      ['SELECT id FROM orders', { rows: [{ id: 'o1' }] }],
      ['FROM order_status_history', { rows: [{ from_status: 'new', to_status: 'processing', note: 'secret-old', created_at: '2026-11-01T00:00:00Z' }] }],
    ]);
    const r = await withUser(request(app()).get('/api/orders/o1/history')).expect(200);
    expect(r.body.history).toHaveLength(1);
    expect(r.body.history[0].note).toBeUndefined();
    expect(r.body.history[0].to_status).toBe('processing');
  });
});

describe('P2 item 2: cancel reason reaches the customer notice', () => {
  test('cancelled → WhatsApp + push carry cancel_reason, not admin_note', async () => {
    db.__routeQuery([
      ['SELECT * FROM orders WHERE id', { rows: [{ id: 'o1', user_id: 'u1', status: 'processing', price: 100, admin_note: null, documents: '[]' }] }],
      // Prior refund exists → auto-refund credit is skipped, but the
      // cancel itself + its notifications still go through.
      ['FROM transactions', { rows: [{ id: 't1' }] }],
      ['UPDATE orders SET status', { rows: [{ id: 'o1', user_id: 'u1', status: 'cancelled', price: 100, documents: '[]' }] }],
    ]);
    const r = await withAdmin(request(app()).put('/api/admin/orders/o1/status'))
      .send({ status: 'cancelled', admin_note: 'internal: fraud?', cancel_reason: 'তথ্য ভুল ছিল' }).expect(200);
    expect(r.body.order.status).toBe('cancelled');
    expect(wa.notifyOrderCancelled).toHaveBeenCalledTimes(1);
    expect(wa.notifyOrderCancelled.mock.calls[0][2]).toMatchObject({ cancelReason: 'তথ্য ভুল ছিল' });
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
    expect(push.notifyUser.mock.calls[0][3]).toContain('কারণ: তথ্য ভুল ছিল');
  });
});

describe('P2 item 8: phone search is digit-only + 01/880 equivalent', () => {
  test('spaced/dashed 01 query matches via regexp_replace digits param', async () => {
    db.__routeQuery([
      ['FROM orders o JOIN users', { rows: [{ count: '1' }] }],
      ['JOIN services s ON s.id = o.service_id', { rows: [{ id: 'o1' }] }],
    ]);
    await withAdmin(request(app()).get('/api/admin/orders?q=0171-123%2045')).expect(200);
    const q = db.query.mock.calls.find((c) => /regexp_replace\(u\.phone/.test(c[0]));
    expect(q).toBeDefined();
    // Digits-only param (spaces/dashes stripped); raw param kept for name/service.
    expect(q[1]).toContain('%017112345%');
    expect(q[1]).toContain('%0171-123 45%');
  });
});

describe('P2 item 9: stats on the Dhaka day + manual-order badge count', () => {
  test('stats SQL uses Dhaka-day revenue and counts manual orders', async () => {
    db.__routeQuery([
      ['FROM manual_submissions', { rows: [{ c: '0' }] }],
    ]);
    const r = await withAdmin(request(app()).get('/api/admin/stats')).expect(200);
    expect(r.body.manual_new).toBe(0);
    const q = db.query.mock.calls.find((c) => /FROM orders/.test(c[0]) && /revenue_today/.test(c[0]));
    expect(q).toBeDefined();
    expect(q[0]).toContain("timezone('Asia/Dhaka', now())");
    expect(q[0]).toContain('orders_manual');
  });
});

describe('P2 item 6: delivery visibility by order status', () => {
  test('admin file on a processing order → 403 NOT_DELIVERED_YET', async () => {
    const docs = JSON.stringify([
      { filename: 'del.pdf', originalname: 'cert.pdf', uploaded_by: 'admin' },
      { filename: 'own.jpg', originalname: 'nid.jpg', uploaded_by: 'customer' },
    ]);
    db.__routeQuery([
      ['FROM orders WHERE id=$1 AND user_id=$2', { rows: [{ status: 'processing', documents: docs }] }],
    ]);
    const r = await withUser(request(app()).get('/api/orders/o1/documents/del.pdf')).expect(403);
    expect(r.body.error).toBe('NOT_DELIVERED_YET');
    // The customer's own file on the same order still downloads
    // (past the gate — it then 404s only because no file is on disk).
    const r2 = await withUser(request(app()).get('/api/orders/o1/documents/own.jpg')).expect(404);
    expect(r2.body.error).toBe('FILE_MISSING');
  });

  test('history lists admin files only from completed/delivered/refunded orders', async () => {
    db.__routeQuery([
      ['FROM orders o LEFT JOIN services', { rows: [
        { id: 'oProc', documents: JSON.stringify([{ filename: 'early.pdf', uploaded_by: 'admin' }]), created_at: '2026-11-02T00:00:00Z', service_name: 'S', service_name_bn: 'সেবা' },
        { id: 'oDone', documents: JSON.stringify([{ filename: 'done.pdf', uploaded_by: 'admin' }]), created_at: '2026-11-01T00:00:00Z', service_name: 'S', service_name_bn: 'সেবা' },
      ] }],
      ['FROM manual_submissions m LEFT JOIN services', { rows: [] }],
      ['FROM engine_jobs', { rows: [] }],
    ]);
    // The SQL filter is what enforces this in production; the mock
    // returns both rows, so assert the query itself carries the
    // status gate (the route cannot be proven by mock rows alone).
    const r = await withUser(request(app()).get('/api/history')).expect(200);
    expect(r.body.ok).toBe(true);
    const q = db.query.mock.calls.find((c) => /FROM orders o LEFT JOIN services/.test(c[0]));
    expect(q[0]).toContain("o.status IN ('completed', 'delivered', 'refunded')");
    const mq = db.query.mock.calls.find((c) => /FROM manual_submissions m LEFT JOIN services/.test(c[0]));
    expect(mq[0]).toContain("m.status = 'completed'");
  });
});

describe('P2 item 12: single-order fetch', () => {
  test('GET /admin/orders/:id returns one list-shaped row; 404 when missing', async () => {
    db.__routeQuery([
      ['FROM orders o JOIN users', { rows: [{ id: 'o1', status: 'delivered', user_name: 'Rahim' }] }],
    ]);
    const r = await withAdmin(request(app()).get('/api/admin/orders/o1')).expect(200);
    expect(r.body.order.id).toBe('o1');
    expect(r.body.order.status).toBe('delivered');
    db.__reset();
    db.__routeQuery([
      ['FROM orders o JOIN users', { rows: [] }],
    ]);
    await withAdmin(request(app()).get('/api/admin/orders/nope')).expect(404);
  });
});
