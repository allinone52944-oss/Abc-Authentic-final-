// Recharge Bug 6 (2026-11-11): on a successful manual approve the customer
// notification (WhatsApp) could silently fail — the endpoint was
// fire-and-forget (.catch(() => {})) and returned just {ok:true}, so the
// admin had no way to know the customer got nothing. The fix awaits the
// notification, logs a WhatsApp failure prominently, and returns the
// outcome in the response (notify.whatsapp / notify.push). A notification
// failure must NEVER fail the approve itself (money is correctly credited).
//
// These tests stub the notification modules (real WhatsApp/push are never
// called) and use fake fixture data only — no real TrxIDs, phones or amounts.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../utils/whatsapp', () => ({
  notifyRechargeApproved: jest.fn(async () => ({ ok: true })),
  notifyRechargeRejected: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../../utils/push', () => ({
  notifyUser: jest.fn(async () => ({ ok: true, sent: 1 })),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const adminRouter = require('../../routes/admin');
const wa = require('../../utils/whatsapp');
const push = require('../../utils/push');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', adminRouter);
  return a;
}
const adminToken = (id = 'admin1') => auth.signAccess({ id, role: 'admin' });
const withAdmin = (req, id) => req.set('Authorization', 'Bearer ' + adminToken(id));

// Fake pending recharge (TrxID-less, like the Bug 1 fixture — no SMS to check).
function routePendingTx() {
  db.__routeQuery([['SELECT * FROM transactions WHERE id', {
    rows: [{ id: 't1', status: 'pending', user_id: 'u1', amount: '100', type: 'recharge', trxid: null }],
  }]]);
}

beforeEach(() => {
  db.__reset();
  wa.notifyRechargeApproved.mockReset();
  wa.notifyRechargeApproved.mockResolvedValue({ ok: true });
  push.notifyUser.mockReset();
  push.notifyUser.mockResolvedValue({ ok: true, sent: 1 });
});

describe('approve: notification outcome (Bug 6)', () => {
  test('WhatsApp fails → approve still succeeds (money credited) AND response carries the failure', async () => {
    wa.notifyRechargeApproved.mockResolvedValue({ ok: false, error: 'FAILED' });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    routePendingTx();
    const r = await withAdmin(request(app()).put('/api/admin/transactions/t1/approve')).expect(200);
    expect(r.body.ok).toBe(true);
    // Money was credited — the approve itself succeeded.
    const w = db.__client.query.mock.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(w[1]).toEqual(['u1', 100, 'recharge', 'tx-t1', 't1']);
    // The response carries the notification failure (admin can see it).
    expect(r.body.notify).toEqual({ whatsapp: false, push: true, whatsapp_error: 'FAILED' });
    // And the failure is logged prominently server-side (tx id only, no phone/TrxID).
    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((s) => s.includes('approve tx t1') && s.includes('notification FAILED'))).toBe(true);
    logSpy.mockRestore();
  });

  test('WhatsApp succeeds → approve succeeds with notify.whatsapp true, no false warning', async () => {
    routePendingTx();
    const r = await withAdmin(request(app()).put('/api/admin/transactions/t1/approve')).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.notify).toEqual({ whatsapp: true, push: true });
    expect(r.body.notify.whatsapp_error).toBeUndefined();
  });

  test('failed approve (already processed) → notification is NOT attempted', async () => {
    db.__routeQuery([['SELECT * FROM transactions WHERE id', {
      rows: [{ id: 't1', status: 'approved', user_id: 'u1', amount: '100', type: 'recharge', trxid: null }],
    }]]);
    const r = await withAdmin(request(app()).put('/api/admin/transactions/t1/approve')).expect(400);
    expect(r.body.error).toBe('ALREADY_PROCESSED');
    expect(wa.notifyRechargeApproved).not.toHaveBeenCalled();
    expect(push.notifyUser).not.toHaveBeenCalled();
  });

  test('push fails but WhatsApp succeeds → approve succeeds, push tracked separately, no WhatsApp warning', async () => {
    push.notifyUser.mockResolvedValue({ ok: false });
    routePendingTx();
    const r = await withAdmin(request(app()).put('/api/admin/transactions/t1/approve')).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.notify).toEqual({ whatsapp: true, push: false });
    expect(r.body.notify.whatsapp_error).toBeUndefined();
  });
});
