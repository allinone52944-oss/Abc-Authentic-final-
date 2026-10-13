// Route tests for backend/routes/push.js (web push subscription API).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const pushRouter = require('../../routes/push');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/push', pushRouter);
  return a;
}
const token = (id = 'u1') => auth.signAccess({ id, role: 'user' });
const withUser = (req, id) => req.set('Authorization', 'Bearer ' + token(id));

const GOOD_SUB = {
  endpoint: 'https://push.example/ep1',
  keys: { p256dh: 'p1', auth: 'a1' },
};

beforeEach(() => { db.__reset(); });

describe('GET /api/push/vapid-public-key (public)', () => {
  test('returns publicKey string without auth', async () => {
    const saved = process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    const r = await request(app()).get('/api/push/vapid-public-key').expect(200);
    expect(r.body.publicKey).toBe('');
    if (saved !== undefined) process.env.VAPID_PUBLIC_KEY = saved;
  });
});

describe('POST /api/push/subscribe', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/push/subscribe').send(GOOD_SUB).expect(401);
  });
  test('invalid subscription → 400 INVALID_SUBSCRIPTION', async () => {
    const r = await withUser(request(app()).post('/api/push/subscribe')).send({}).expect(400);
    expect(r.body.error).toBe('INVALID_SUBSCRIPTION');
  });
  test('valid subscription → 200 ok:true', async () => {
    const r = await withUser(request(app()).post('/api/push/subscribe')).send(GOOD_SUB).expect(200);
    expect(r.body).toEqual({ ok: true });
    const ins = db.query.mock.calls.find((c) => /INSERT INTO push_subscriptions/.test(c[0]));
    expect(ins[1][0]).toBe('u1');
  });
});

describe('POST /api/push/unsubscribe (security fix: ownership)', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/push/unsubscribe').send({ endpoint: 'e' }).expect(401);
  });
  test('missing endpoint → 400 MISSING_ENDPOINT', async () => {
    const r = await withUser(request(app()).post('/api/push/unsubscribe')).send({}).expect(400);
    expect(r.body.error).toBe('MISSING_ENDPOINT');
  });
  test('DELETE is scoped to the requesting user (cannot remove others)', async () => {
    const r = await withUser(request(app()).post('/api/push/unsubscribe'), 'victim-user')
      .send({ endpoint: 'https://push.example/ep1' }).expect(200);
    expect(r.body).toEqual({ ok: true });
    const del = db.query.mock.calls.find((c) => /DELETE FROM push_subscriptions/.test(c[0]));
    expect(del).toBeDefined();
    expect(del[0]).toMatch(/endpoint = \$1 AND user_id = \$2/);
    expect(del[1]).toEqual(['https://push.example/ep1', 'victim-user']);
  });
});

describe('GET /api/push/status', () => {
  test('subscribed true/false from COUNT', async () => {
    db.__routeQuery([['FROM push_subscriptions WHERE user_id', { rows: [{ count: '2' }] }]]);
    const r1 = await withUser(request(app()).get('/api/push/status')).expect(200);
    expect(r1.body).toEqual({ subscribed: true });
    db.__reset();
    db.__routeQuery([['FROM push_subscriptions WHERE user_id', { rows: [{ count: '0' }] }]]);
    const r2 = await withUser(request(app()).get('/api/push/status')).expect(200);
    expect(r2.body).toEqual({ subscribed: false });
  });
});
