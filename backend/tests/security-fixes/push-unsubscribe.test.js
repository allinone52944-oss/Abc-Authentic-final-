// FIX-4 regression: push unsubscribe must be ownership-scoped.
// DELETE is constrained by BOTH endpoint and user_id, so one user can never
// remove another user's push subscription.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const pushRouter = require('../../routes/push');
const pushUtil = require('../../utils/push');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/push', pushRouter);
  return a;
}
const token = (id) => auth.signAccess({ id, role: 'user' });
const asUser = (req, id) => req.set('Authorization', 'Bearer ' + token(id));

beforeEach(() => { db.__reset(); });

describe('FIX-4 push unsubscribe ownership', () => {
  test('util: removeSubscription refuses without a user id', async () => {
    await expect(pushUtil.removeSubscription(db, 'https://push.example/ep', null))
      .resolves.toEqual({ ok: false, error: 'MISSING_USER' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('util: DELETE carries both endpoint and user_id params', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(pushUtil.removeSubscription(db, 'https://push.example/ep', 'u1'))
      .resolves.toEqual({ ok: true });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM push_subscriptions/);
    expect(sql).toMatch(/endpoint = \$1 AND user_id = \$2/);
    expect(params).toEqual(['https://push.example/ep', 'u1']);
  });

  test('route: attacker cannot delete the victim endpoint as their own', async () => {
    // attacker posts the VICTIM's endpoint; the DELETE must still be
    // scoped to the attacker's user id, deleting 0 rows.
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const r = await asUser(
      request(app()).post('/api/push/unsubscribe'), 'attacker-id'
    ).send({ endpoint: 'https://push.example/victim-ep' }).expect(200);
    expect(r.body).toEqual({ ok: true });
    const [sql, params] = db.query.mock.calls[0];
    expect(params[0]).toBe('https://push.example/victim-ep');
    expect(params[1]).toBe('attacker-id'); // ownership enforced — victim untouched
    expect(params[1]).not.toBe('victim-id');
  });

  test('route: missing endpoint → 400', async () => {
    const r = await asUser(request(app()).post('/api/push/unsubscribe'), 'u1')
      .send({}).expect(400);
    expect(r.body.error).toBe('MISSING_ENDPOINT');
  });
});
