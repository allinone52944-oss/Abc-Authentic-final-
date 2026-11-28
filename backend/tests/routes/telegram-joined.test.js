/**
 * Telegram join banner — server-side flag endpoints (user.js).
 *
 * GET  /api/user/telegram-joined — reads the per-user flag.
 * POST /api/user/telegram-joined — sets it (idempotent).
 * Both are user-scoped (requireAuth + req.user.id). The flag is the
 * cross-device source of truth for the banner; localStorage is the
 * same-device fast path.
 */

jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const router = require('../../routes/user');

function app() { const a = express(); a.use(express.json()); a.use('/api', router); return a; }
function authed(method, path) {
  return request(app())[method]('/api' + path)
    .set('Authorization', 'Bearer ' + auth.signAccess({ id: 'u1', role: 'user' }));
}

beforeEach(() => {
  db.__reset();
});

describe('GET /api/user/telegram-joined', () => {
  test('returns joined:false when the flag is false', async () => {
    db.__routeQuery([['FROM users WHERE id', { rows: [{ telegram_joined: false }] }]]);
    const r = await authed('get', '/user/telegram-joined').expect(200);
    expect(r.body).toEqual({ joined: false });
  });

  test('returns joined:true when the flag is true', async () => {
    db.__routeQuery([['FROM users WHERE id', { rows: [{ telegram_joined: true }] }]]);
    const r = await authed('get', '/user/telegram-joined').expect(200);
    expect(r.body).toEqual({ joined: true });
  });

  test('returns 404 when the user row is missing', async () => {
    db.__routeQuery([['FROM users WHERE id', { rows: [] }]]);
    await authed('get', '/user/telegram-joined').expect(404);
  });

  test('is scoped to the authenticated user id', async () => {
    db.__routeQuery([['FROM users WHERE id', { rows: [{ telegram_joined: false }] }]]);
    await authed('get', '/user/telegram-joined').expect(200);
    const call = db.query.mock.calls.find(([sql]) => sql.includes('FROM users WHERE id'));
    expect(call).toBeDefined();
    expect(call[1]).toEqual(['u1']);
  });

  test('requires auth', async () => {
    await request(app()).get('/api/user/telegram-joined').expect(401);
  });
});

describe('POST /api/user/telegram-joined', () => {
  test('sets the flag and returns joined:true', async () => {
    const r = await authed('post', '/user/telegram-joined').expect(200);
    expect(r.body).toEqual({ joined: true });
    const call = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE users SET telegram_joined'));
    expect(call).toBeDefined();
    expect(call[0]).toContain('telegram_joined = TRUE');
    expect(call[1]).toEqual(['u1']);
  });

  test('is idempotent: a second POST still returns joined:true', async () => {
    await authed('post', '/user/telegram-joined').expect(200);
    const r = await authed('post', '/user/telegram-joined').expect(200);
    expect(r.body).toEqual({ joined: true });
  });

  test('requires auth', async () => {
    await request(app()).post('/api/user/telegram-joined').expect(401);
  });
});
