// Unit tests for backend/utils/push.js (Web Push helpers).
// web-push is mocked; DB is a plain { query } stub (never the real DB).

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

// NOTE: freshPush() calls jest.resetModules(), which refreshes the mocked
// web-push module identity. Always re-require AFTER freshPush() (see wp()).
const wp = () => require('web-push');

function freshPush() {
  jest.resetModules();
  return require('../../utils/push');
}
function stubDb(impl) {
  return { query: jest.fn(impl || (async () => ({ rows: [], rowCount: 0 }))) };
}
const GOOD_SUB = {
  endpoint: 'https://push.example/ep1',
  keys: { p256dh: 'p256dh-1', auth: 'auth-1' },
};

describe('saveSubscription', () => {
  test('rejects invalid subscription shapes', async () => {
    const push = freshPush();
    const db = stubDb();
    expect(await push.saveSubscription(db, 'u1', null)).toEqual({ ok: false, error: 'INVALID_SUBSCRIPTION' });
    expect(await push.saveSubscription(db, 'u1', {})).toEqual({ ok: false, error: 'INVALID_SUBSCRIPTION' });
    expect(await push.saveSubscription(db, 'u1', { endpoint: 'e' })).toEqual({ ok: false, error: 'INVALID_SUBSCRIPTION' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('upserts a valid subscription', async () => {
    const push = freshPush();
    const db = stubDb();
    const r = await push.saveSubscription(db, 'u1', GOOD_SUB);
    expect(r).toEqual({ ok: true });
    const [text, params] = db.query.mock.calls[0];
    expect(text).toMatch(/INSERT INTO push_subscriptions/);
    expect(params).toEqual(['u1', GOOD_SUB.endpoint, 'p256dh-1', 'auth-1']);
  });

  test('never throws: DB error → SAVE_FAILED', async () => {
    const push = freshPush();
    const db = stubDb(async () => { throw new Error('db down'); });
    expect(await push.saveSubscription(db, 'u1', GOOD_SUB)).toEqual({ ok: false, error: 'SAVE_FAILED' });
  });
});

describe('removeSubscription (security fix: ownership check)', () => {
  test('rejects missing endpoint / missing user', async () => {
    const push = freshPush();
    const db = stubDb();
    expect(await push.removeSubscription(db, null, 'u1')).toEqual({ ok: false, error: 'MISSING_ENDPOINT' });
    expect(await push.removeSubscription(db, 'e', null)).toEqual({ ok: false, error: 'MISSING_USER' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('DELETE is scoped to endpoint + owner user_id', async () => {
    const push = freshPush();
    const db = stubDb();
    const r = await push.removeSubscription(db, 'https://push.example/ep1', 'u1');
    expect(r).toEqual({ ok: true });
    const [text, params] = db.query.mock.calls[0];
    expect(text).toMatch(/DELETE FROM push_subscriptions WHERE endpoint = \$1 AND user_id = \$2/);
    expect(params).toEqual(['https://push.example/ep1', 'u1']);
  });

  test('never throws: DB error → DELETE_FAILED', async () => {
    const push = freshPush();
    const db = stubDb(async () => { throw new Error('db down'); });
    expect(await push.removeSubscription(db, 'e', 'u1')).toEqual({ ok: false, error: 'DELETE_FAILED' });
  });
});

describe('vapidPublicKey / isConfigured', () => {
  test('vapidPublicKey returns env value or empty string', () => {
    const saved = process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    expect(freshPush().vapidPublicKey()).toBe('');
    process.env.VAPID_PUBLIC_KEY = 'test-pub';
    expect(freshPush().vapidPublicKey()).toBe('test-pub');
    if (saved === undefined) delete process.env.VAPID_PUBLIC_KEY; else process.env.VAPID_PUBLIC_KEY = saved;
  });

  test('isConfigured false without VAPID keys', () => {
    const sPub = process.env.VAPID_PUBLIC_KEY, sPriv = process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
    expect(freshPush().isConfigured()).toBe(false);
    if (sPub !== undefined) process.env.VAPID_PUBLIC_KEY = sPub;
    if (sPriv !== undefined) process.env.VAPID_PRIVATE_KEY = sPriv;
  });
});

describe('pushToSubscriptions', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
    wp().sendNotification.mockReset();
  });

  test('NOT_CONFIGURED without VAPID keys (never throws, no send)', async () => {
    delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
    const push = freshPush();
    const db = stubDb();
    const r = await push.pushToSubscriptions(db, [{ endpoint: 'e', p256dh: 'p', auth: 'a' }], { title: 't' });
    expect(r).toEqual({ ok: false, error: 'NOT_CONFIGURED' });
    expect(wp().sendNotification).not.toHaveBeenCalled();
  });

  test('sends to all, prunes dead (410) endpoints', async () => {
    process.env.VAPID_PUBLIC_KEY = 'pub'; process.env.VAPID_PRIVATE_KEY = 'priv';
    const push = freshPush();
    const db = stubDb();
    wp().sendNotification
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ statusCode: 410, message: 'Gone' });
    const subs = [
      { endpoint: 'live-ep', p256dh: 'p1', auth: 'a1' },
      { endpoint: 'dead-ep', p256dh: 'p2', auth: 'a2' },
    ];
    const r = await push.pushToSubscriptions(db, subs, { title: 'hi' });
    expect(r).toEqual({ ok: true, sent: 1 });
    expect(wp().sendNotification).toHaveBeenCalledTimes(2);
    const deletes = db.query.mock.calls.filter((c) => /DELETE FROM push_subscriptions/.test(c[0]));
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1]).toEqual(['dead-ep']);
  });

  test('empty subscription list → sent 0, no crash', async () => {
    process.env.VAPID_PUBLIC_KEY = 'pub'; process.env.VAPID_PRIVATE_KEY = 'priv';
    const push = freshPush();
    const r = await push.pushToSubscriptions(stubDb(), [], { title: 't' });
    expect(r).toEqual({ ok: true, sent: 0 });
  });
});

describe('notifyAdmins', () => {
  test('no admin subscriptions → sent 0', async () => {
    const push = freshPush();
    const r = await push.notifyAdmins(stubDb(), 't', 'b');
    expect(r).toEqual({ ok: true, sent: 0 });
  });

  test('never throws on DB error', async () => {
    const push = freshPush();
    const r = await push.notifyAdmins(stubDb(async () => { throw new Error('x'); }), 't', 'b');
    expect(r.ok).toBe(false);
  });
});
