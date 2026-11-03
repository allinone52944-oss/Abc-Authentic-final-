// Backend fixes B2–B5 (2026-11-03 audit):
// B2 manual PUT locking, B3 manual delivery-docs status gate,
// B4 completed-order late-file notify, B5 already-refunded delete.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../utils/whatsapp', () => ({
  notifyServiceCompleted: jest.fn().mockResolvedValue({ ok: true }),
  notifyServiceRejected: jest.fn().mockResolvedValue({ ok: true }),
  notifyDeliveryFileAdded: jest.fn().mockResolvedValue({ ok: true }),
  notifyOrderRefunded: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../utils/push', () => ({
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
}));

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const db = require('../../db');
const auth = require('../../auth');
const { adminManual } = require('../../routes/manual');
const adminRouter = require('../../routes/admin');
const wa = require('../../utils/whatsapp');
const push = require('../../utils/push');

const MANUAL_DIR = '/opt/all-in-one-abc-authentic/uploads/manual';
const ORDER_DIR = '/opt/all-in-one-abc-authentic/uploads/orders';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin/manual', adminManual);
  a.use('/api/admin', adminRouter);
  return a;
}
const adminTok = () => auth.signAccess({ id: 'a1', role: 'admin' });
const asAdmin = (r) => r.set('Authorization', 'Bearer ' + adminTok());

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
});

function allCalls() {
  return [...db.query.mock.calls, ...db.__client.query.mock.calls];
}
function dropUpload(dir, filename) {
  if (filename) { try { fs.unlinkSync(path.join(dir, filename)); } catch (_) {} }
}

describe('B2: manual PUT locks the row and notifies only once', () => {
  const putHandlers = (prevStatus, newStatus) => [
    ['SELECT user_id, service_id, status, documents, admin_note FROM manual_submissions', {
      rows: [{ user_id: 'u1', service_id: 7, status: prevStatus, documents: [] }],
    }],
    ['UPDATE manual_submissions SET', { rows: [{ id: 'm1', status: newStatus }] }],
    ['SELECT name_bn, name FROM services', { rows: [{ name_bn: 'পাসপোর্ট সেবা', name: 'Passport' }] }],
  ];

  test('PUT uses FOR UPDATE + guarded UPDATE and notifies once', async () => {
    db.__routeQuery(putHandlers('new', 'completed'));
    const r = await asAdmin(request(app()).put('/api/admin/manual/m1'))
      .send({ status: 'completed' }).expect(200);
    expect(r.body.status).toBe('completed');
    const lock = allCalls().find((c) => /FROM manual_submissions WHERE id/.test(c[0]));
    expect(lock[0]).toContain('FOR UPDATE');
    const upd = allCalls().find((c) => /UPDATE manual_submissions SET/.test(c[0]));
    expect(upd[0]).toContain('AND status =');
    expect(wa.notifyServiceCompleted).toHaveBeenCalledTimes(1);
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
  });

  test('a second PUT after the first sees the new status and does NOT re-notify', async () => {
    // First PUT: new → completed notifies.
    db.__routeQuery(putHandlers('new', 'completed'));
    await asAdmin(request(app()).put('/api/admin/manual/m1'))
      .send({ status: 'completed' }).expect(200);
    expect(wa.notifyServiceCompleted).toHaveBeenCalledTimes(1);
    // Second PUT (the concurrent twin, now serialized behind the
    // lock): the row is already completed, so the same transition
    // is a silent same-status save — no second notification.
    jest.clearAllMocks();
    db.__reset();
    db.__routeQuery(putHandlers('completed', 'completed'));
    const r = await asAdmin(request(app()).put('/api/admin/manual/m1'))
      .send({ status: 'completed' }).expect(200);
    expect(r.body.status).toBe('completed');
    expect(wa.notifyServiceCompleted).not.toHaveBeenCalled();
    expect(push.notifyUser).not.toHaveBeenCalled();
    expect(allCalls().find((c) => /UPDATE manual_submissions SET status/.test(c[0]))).toBeUndefined();
  });

  test('same-status re-save with an UNCHANGED note → no UPDATE at all, no notify', async () => {
    // Covers the admin_note comparison: the PUT SELECT must carry
    // admin_note, or an unchanged note would rewrite every time.
    db.__routeQuery([
      ['SELECT user_id, service_id, status, documents, admin_note FROM manual_submissions', {
        rows: [{ user_id: 'u1', service_id: 7, status: 'completed', documents: [], admin_note: 'note' }],
      }],
      ['UPDATE manual_submissions SET', { rows: [{ id: 'm1', status: 'completed' }] }],
    ]);
    const r = await asAdmin(request(app()).put('/api/admin/manual/m1'))
      .send({ status: 'completed', admin_note: 'note' }).expect(200);
    expect(r.body.status).toBe('completed');
    expect(allCalls().find((c) => /UPDATE manual_submissions SET/.test(c[0]))).toBeUndefined();
    expect(wa.notifyServiceCompleted).not.toHaveBeenCalled();
    expect(push.notifyUser).not.toHaveBeenCalled();
  });

  test('illegal jump under the lock → 400 INVALID_TRANSITION, no update, no notify', async () => {
    db.__routeQuery(putHandlers('completed', 'new'));
    const r = await asAdmin(request(app()).put('/api/admin/manual/m1'))
      .send({ status: 'new' }).expect(400);
    expect(r.body.error).toBe('INVALID_TRANSITION');
    expect(r.body.allowed).toEqual([]);
    expect(allCalls().find((c) => /UPDATE manual_submissions SET/.test(c[0]))).toBeUndefined();
    expect(wa.notifyServiceCompleted).not.toHaveBeenCalled();
    expect(push.notifyUser).not.toHaveBeenCalled();
  });

  test('missing submission → 404', async () => {
    db.__routeQuery([
      ['SELECT user_id, service_id, status, documents, admin_note FROM manual_submissions', { rows: [] }],
    ]);
    await asAdmin(request(app()).put('/api/admin/manual/nope'))
      .send({ status: 'completed' }).expect(404);
  });
});

describe('B3: manual delivery-docs status gate', () => {
  const deliveryHandlers = (row) => [
    ['SELECT user_id, service_id, status, documents FROM manual_submissions', { rows: row ? [row] : [] }],
    ['UPDATE manual_submissions SET documents', { rows: [] }],
  ];

  test('rejected submission → 400 INVALID_STATUS, no doc saved, upload cleaned up', async () => {
    db.__routeQuery(deliveryHandlers({ user_id: 'u1', service_id: 7, status: 'rejected', documents: [] }));
    const before = fs.existsSync(MANUAL_DIR) ? fs.readdirSync(MANUAL_DIR).length : 0;
    const r = await asAdmin(request(app()).post('/api/admin/manual/m1/delivery-docs'))
      .attach('file', Buffer.from('%PDF-1.4 delivery'), 'result.pdf')
      .expect(400);
    expect(r.body.error).toBe('INVALID_STATUS');
    expect(r.body.status).toBe('rejected');
    expect(allCalls().find((c) => /UPDATE manual_submissions SET documents/.test(c[0]))).toBeUndefined();
    const after = fs.existsSync(MANUAL_DIR) ? fs.readdirSync(MANUAL_DIR).length : 0;
    expect(after).toBe(before);
  });

  test('completed submission → file saved AND customer notified (late-file branch)', async () => {
    let saved = null;
    db.__routeQuery([
      ['SELECT user_id, service_id, status, documents FROM manual_submissions', {
        rows: [{ user_id: 'u1', service_id: 7, status: 'completed', documents: [] }],
      }],
      ['UPDATE manual_submissions SET documents', (text, params) => { saved = JSON.parse(params[0]); return { rows: [] }; }],
    ]);
    const r = await asAdmin(request(app()).post('/api/admin/manual/m1/delivery-docs'))
      .attach('file', Buffer.from('%PDF-1.4 delivery'), 'result.pdf')
      .expect(200);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ uploaded_by: 'admin', type: 'delivery' });
    expect(wa.notifyDeliveryFileAdded).toHaveBeenCalledTimes(1);
    expect(wa.notifyDeliveryFileAdded.mock.calls[0][1]).toMatchObject({ user_id: 'u1' });
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
    expect(push.notifyUser.mock.calls[0][2]).toContain('নতুন ডেলিভারি ফাইল');
    dropUpload(MANUAL_DIR, r.body.filename);
  });

  test('processing submission → file saved, NO notify (completion transition notifies later)', async () => {
    let saved = null;
    db.__routeQuery([
      ['SELECT user_id, service_id, status, documents FROM manual_submissions', {
        rows: [{ user_id: 'u1', service_id: 7, status: 'processing', documents: [] }],
      }],
      ['UPDATE manual_submissions SET documents', (text, params) => { saved = JSON.parse(params[0]); return { rows: [] }; }],
    ]);
    const r = await asAdmin(request(app()).post('/api/admin/manual/m1/delivery-docs'))
      .attach('file', Buffer.from('%PDF-1.4 delivery'), 'result.pdf')
      .expect(200);
    expect(saved).toHaveLength(1);
    expect(wa.notifyDeliveryFileAdded).not.toHaveBeenCalled();
    expect(push.notifyUser).not.toHaveBeenCalled();
    dropUpload(MANUAL_DIR, r.body.filename);
  });
});

describe('B4: completed (not just delivered) order late-file notify', () => {
  test('file added to a completed order notifies the customer', async () => {
    db.__routeQuery([
      ['SELECT * FROM orders WHERE id', {
        rows: [{ id: 'o1', user_id: 'u1', service_id: 's1', status: 'completed', documents: '[]' }],
      }],
      ['UPDATE orders SET documents', { rows: [] }],
    ]);
    const r = await asAdmin(request(app()).post('/api/admin/orders/o1/delivery-docs'))
      .attach('file', Buffer.from('%PDF-1.4 delivery'), 'result.pdf')
      .expect(200);
    expect(r.body.ok).toBe(true);
    expect(wa.notifyDeliveryFileAdded).toHaveBeenCalledTimes(1);
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
    expect(push.notifyUser.mock.calls[0][2]).toContain('নতুন ডেলিভারি ফাইল');
    dropUpload(ORDER_DIR, r.body.filename);
  });

  test('file added to a delivered order still notifies (existing behaviour)', async () => {
    db.__routeQuery([
      ['SELECT * FROM orders WHERE id', {
        rows: [{ id: 'o2', user_id: 'u1', service_id: 's1', status: 'delivered', documents: '[]' }],
      }],
      ['UPDATE orders SET documents', { rows: [] }],
    ]);
    const r = await asAdmin(request(app()).post('/api/admin/orders/o2/delivery-docs'))
      .attach('file', Buffer.from('%PDF-1.4 delivery'), 'result.pdf')
      .expect(200);
    expect(r.body.ok).toBe(true);
    expect(wa.notifyDeliveryFileAdded).toHaveBeenCalledTimes(1);
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
    dropUpload(ORDER_DIR, r.body.filename);
  });
});

describe('B5: delete of an already-refunded order with refund=yes', () => {
  test("status 'refunded' order → NOT refunded:false; refundedAlready + explanation, no second credit, row deleted", async () => {
    db.__routeQuery([
      ['SELECT * FROM orders WHERE id', {
        rows: [{ id: 'o9', user_id: 'u1', price: '200', status: 'refunded', documents: '[]' }],
      }],
      ['DELETE FROM orders WHERE id', { rowCount: 1 }],
    ]);
    const r = await asAdmin(request(app()).delete('/api/admin/orders/o9?confirm=yes&refund=yes')).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.refunded).not.toBe(false);
    expect(r.body.refundedAlready).toBe(true);
    expect(typeof r.body.refundMessage).toBe('string');
    expect(r.body.refundMessage.length).toBeGreaterThan(0);
    expect(r.body.refund).toEqual({ alreadyRefunded: true });
    expect(allCalls().find((c) => /wallet_apply/.test(c[0]))).toBeUndefined();
    expect(allCalls().find((c) => /DELETE FROM orders WHERE id/.test(c[0]))).toBeDefined();
    expect(wa.notifyOrderRefunded).not.toHaveBeenCalled();
    expect(push.notifyUser).not.toHaveBeenCalled();
  });

  test('cancelled order with a prior refund tx → refundedAlready + explanation, no second credit', async () => {
    const guardHit = (text) => text.includes('SELECT 1 FROM transactions');
    db.__routeQuery([
      [guardHit, { rows: [{ one: 1 }] }],
      ['SELECT * FROM orders WHERE id', {
        rows: [{ id: 'o7', user_id: 'u1', price: '200', status: 'cancelled', documents: '[]' }],
      }],
      ['DELETE FROM orders WHERE id', { rowCount: 1 }],
    ]);
    const r = await asAdmin(request(app()).delete('/api/admin/orders/o7?confirm=yes&refund=yes')).expect(200);
    expect(r.body.refundedAlready).toBe(true);
    expect(typeof r.body.refundMessage).toBe('string');
    expect(r.body.refundMessage.length).toBeGreaterThan(0);
    expect(r.body.refund).toEqual({ alreadyRefunded: true });
    expect(allCalls().find((c) => /wallet_apply/.test(c[0]))).toBeUndefined();
    expect(wa.notifyOrderRefunded).not.toHaveBeenCalled();
  });
});
