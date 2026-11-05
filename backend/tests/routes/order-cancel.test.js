// Audit #48 — the customer cancels their OWN new/pending order, with
// auto-refund in the same transaction (refundOrderPrice, the helper
// the admin PUT uses). Only new/pending are cancellable here; the
// cancel policy past that point is the owner's call.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../lib/serviceCredits', () => ({
  payForService: jest.fn(),
  refundOrderPrice: jest.fn(),
  addServiceCredit: jest.fn(),
  availableFor: jest.fn(),
  lockedCreditRows: jest.fn(),
  reconstructChargeSplit: jest.fn(),
  releaseHold: jest.fn(),
}));
jest.mock('../../utils/push', () => ({
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../utils/whatsapp', () => ({
  notifyOrderCancelled: jest.fn().mockResolvedValue({ ok: true }),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const userRouter = require('../../routes/user');
const serviceCredits = require('../../lib/serviceCredits');
const push = require('../../utils/push');
const wa = require('../../utils/whatsapp');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api', userRouter);
  return a;
}
const token = (id = 'u1') => auth.signAccess({ id, role: 'user' });
const withUser = (req, id) => req.set('Authorization', 'Bearer ' + token(id));

const ORDER = { id: 'o1', user_id: 'u1', service_id: 's1', status: 'new', price: 100, cancel_reason: null };

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
  serviceCredits.refundOrderPrice.mockResolvedValue({ refunded: true, creditPart: 30, balancePart: 70 });
});

function routeOrder(order, priorRefundRows = []) {
  db.__routeQuery([
    ['SELECT * FROM orders WHERE id = $1 FOR UPDATE', { rows: [order] }],
    ["UPDATE orders SET status = 'cancelled'", { rows: [{ ...order, status: 'cancelled' }] }],
    ['SELECT 1 FROM transactions', { rows: priorRefundRows }],
  ]);
}

describe('POST /api/orders/:id/cancel (audit #48)', () => {
  test('cancel a new order → cancelled + auto-refund split + history row + notices', async () => {
    routeOrder(ORDER);
    const r = await withUser(request(app()).post('/api/orders/o1/cancel')).send({}).expect(200);
    expect(r.body).toMatchObject({ ok: true, refunded: true });
    expect(r.body.order.status).toBe('cancelled');
    expect(r.body.refund).toEqual({ balancePart: 70, creditPart: 30 });
    expect(serviceCredits.refundOrderPrice).toHaveBeenCalledTimes(1);
    const upd = db.__client.query.mock.calls.find((c) => /UPDATE orders SET status = 'cancelled'/.test(c[0]));
    expect(upd[1][2]).toBe('new'); // guarded by the locked from-status
    const hist = db.__client.query.mock.calls.find((c) => /INSERT INTO order_status_history/.test(c[0]));
    expect(hist).toBeDefined();
    expect(hist[1]).toEqual(['o1', 'new', 'u1']);
    const split = db.__client.query.mock.calls.find((c) => /refund_balance = \$1/.test(c[0]));
    expect(split[1]).toEqual([70, 30, 'o1']);
    expect(push.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
    expect(wa.notifyOrderCancelled).toHaveBeenCalledTimes(1);
  });

  test('cancel a pending order with a reason stores the reason', async () => {
    routeOrder({ ...ORDER, status: 'pending' });
    const r = await withUser(request(app()).post('/api/orders/o1/cancel'))
      .send({ reason: 'ভুল সেবা' }).expect(200);
    expect(r.body.order.status).toBe('cancelled');
    const upd = db.__client.query.mock.calls.find((c) => /UPDATE orders SET status = 'cancelled'/.test(c[0]));
    expect(upd[1][0]).toBe('ভুল সেবা');
  });

  test('cancel a processing order → 409 CANNOT_CANCEL with the current status', async () => {
    routeOrder({ ...ORDER, status: 'processing' });
    const r = await withUser(request(app()).post('/api/orders/o1/cancel')).send({}).expect(409);
    expect(r.body).toEqual({ error: 'CANNOT_CANCEL', status: 'processing' });
    expect(serviceCredits.refundOrderPrice).not.toHaveBeenCalled();
    expect(push.notifyAdmins).not.toHaveBeenCalled();
  });

  test("cancel someone else's order → 404 (no leak)", async () => {
    routeOrder({ ...ORDER, user_id: 'u2' });
    await withUser(request(app()).post('/api/orders/o1/cancel')).send({}).expect(404);
    expect(serviceCredits.refundOrderPrice).not.toHaveBeenCalled();
  });

  test('cancel an already-cancelled order → 200 already:true, no second refund, no re-notify', async () => {
    routeOrder({ ...ORDER, status: 'cancelled' });
    const r = await withUser(request(app()).post('/api/orders/o1/cancel')).send({}).expect(200);
    expect(r.body).toMatchObject({ ok: true, already: true, refunded: false });
    expect(serviceCredits.refundOrderPrice).not.toHaveBeenCalled();
    expect(push.notifyAdmins).not.toHaveBeenCalled();
    expect(push.notifyUser).not.toHaveBeenCalled();
  });

  test('price-0 order → cancelled, refund helper reports no refund', async () => {
    serviceCredits.refundOrderPrice.mockResolvedValue({ refunded: false, creditPart: 0, balancePart: 0 });
    routeOrder({ ...ORDER, price: 0 });
    const r = await withUser(request(app()).post('/api/orders/o1/cancel')).send({}).expect(200);
    expect(r.body).toMatchObject({ ok: true, refunded: false });
    expect(r.body.refund).toEqual({ balancePart: 0, creditPart: 0 });
  });

  test('money already refunded (legacy edge) → cancel goes through, refund skipped', async () => {
    routeOrder(ORDER, [{ '1': 1 }]);
    const r = await withUser(request(app()).post('/api/orders/o1/cancel')).send({}).expect(200);
    expect(r.body.order.status).toBe('cancelled');
    expect(serviceCredits.refundOrderPrice).not.toHaveBeenCalled();
  });

  test('requires auth → 401', async () => {
    await request(app()).post('/api/orders/o1/cancel').send({}).expect(401);
  });
});
