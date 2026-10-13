// Route tests for backend/routes/invites.js
// (adminInvites + publicInvites routers, validateInvite, consumeInvite).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const invites = require('../../routes/invites');

const { adminInvites, publicInvites, validateInvite, consumeInvite } = invites;

function adminApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin/invites', adminInvites);
  return a;
}
function publicApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/invite', publicInvites);
  return a;
}
const adminToken = () => auth.signAccess({ id: 'admin1', role: 'admin' });
const userToken = () => auth.signAccess({ id: 'u1', role: 'user' });
const withAdmin = (req) => req.set('Authorization', 'Bearer ' + adminToken());

beforeEach(() => { db.__reset(); });

describe('validateInvite (shared)', () => {
  test('rejects malformed codes without touching the DB', async () => {
    for (const bad of [null, '', 'xyz', 'INV-ABC', 'INV-abcdefg!', 'INV-TOOLONG12345']) {
      expect(await validateInvite(bad)).toBeNull();
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  test('normalizes lowercase and returns the row when usable', async () => {
    const row = { code: 'INV-ABCDEF12', is_active: true, expires_at: null, max_uses: null, used_count: 0 };
    db.__routeQuery([['FROM invite_links WHERE code', { rows: [row] }]]);
    const inv = await validateInvite('inv-abcdef12');
    expect(inv).toBe(row);
    expect(db.query.mock.calls[0][1]).toEqual(['INV-ABCDEF12']);
  });

  test('inactive / expired / max-uses-exhausted → null', async () => {
    const cases = [
      { is_active: false, expires_at: null, max_uses: null, used_count: 0 },
      { is_active: true, expires_at: new Date(Date.now() - 1000).toISOString(), max_uses: null, used_count: 0 },
      { is_active: true, expires_at: null, max_uses: 5, used_count: 5 },
    ];
    for (const inv of cases) {
      db.__reset();
      db.__routeQuery([['FROM invite_links WHERE code', { rows: [{ code: 'INV-ABCDEF12', ...inv }] }]]);
      expect(await validateInvite('INV-ABCDEF12')).toBeNull();
    }
  });

  test('future expiry + remaining uses → valid', async () => {
    const row = {
      code: 'INV-ABCDEF12', is_active: true,
      expires_at: new Date(Date.now() + 3600000).toISOString(), max_uses: 5, used_count: 4,
    };
    db.__routeQuery([['FROM invite_links WHERE code', { rows: [row] }]]);
    expect(await validateInvite('INV-ABCDEF12')).toBe(row);
  });
});

describe('consumeInvite (security fix: rowCount check)', () => {
  test('returns true when a row was consumed', async () => {
    db.__routeQuery([['UPDATE invite_links SET used_count', { rows: [], rowCount: 1 }]]);
    expect(await consumeInvite('INV-ABCDEF12')).toBe(true);
  });

  test('returns false when nothing was consumed (expired / maxed out)', async () => {
    db.__routeQuery([['UPDATE invite_links SET used_count', { rows: [], rowCount: 0 }]]);
    expect(await consumeInvite('INV-ABCDEF12')).toBe(false);
  });

  test('code is normalized to uppercase in the UPDATE', async () => {
    db.__routeQuery([['UPDATE invite_links SET used_count', { rows: [], rowCount: 1 }]]);
    await consumeInvite('inv-abcdef12');
    expect(db.query.mock.calls[0][1]).toEqual(['INV-ABCDEF12']);
  });
});

describe('POST /api/admin/invites (admin only)', () => {
  test('non-admin → 403 ADMIN_ONLY; anonymous → 401', async () => {
    const r1 = await request(adminApp()).post('/api/admin/invites')
      .set('Authorization', 'Bearer ' + userToken()).send({}).expect(403);
    expect(r1.body.error).toBe('ADMIN_ONLY');
    await request(adminApp()).post('/api/admin/invites').send({}).expect(401);
  });

  test('happy path → 201 with generated code + link', async () => {
    db.__routeQuery([
      ['INSERT INTO invite_links', { rows: [{ code: 'INV-TEST1234' }] }],
    ]);
    const r = await withAdmin(request(adminApp()).post('/api/admin/invites'))
      .send({ max_uses: 10, expires_at: new Date(Date.now() + 86400000).toISOString(), note: 'promo' })
      .expect(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.code).toMatch(/^INV-[A-Z0-9]{8}$/);
    expect(r.body.link).toContain(encodeURIComponent(r.body.code));
  });

  test.each([
    ['zero', 0], ['negative', -3], ['string', 'abc'], ['too big', 100001],
  ])('invalid max_uses (%s) → 400 INVALID_MAX_USES', async (_l, v) => {
    db.__reset();
    const r = await withAdmin(request(adminApp()).post('/api/admin/invites')).send({ max_uses: v }).expect(400);
    expect(r.body.error).toBe('INVALID_MAX_USES');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('fractional max_uses is rejected (not truncated) → 400 INVALID_MAX_USES', async () => {
    db.__reset();
    const r = await withAdmin(request(adminApp()).post('/api/admin/invites'))
      .send({ max_uses: 2.5 }).expect(400);
    expect(r.body.error).toBe('INVALID_MAX_USES');
    expect(db.query).not.toHaveBeenCalled();
  });

  test.each([
    ['past date', new Date(Date.now() - 1000).toISOString()],
    ['garbage', 'not-a-date'],
  ])('invalid expires_at (%s) → 400 INVALID_EXPIRY', async (_l, v) => {
    db.__reset();
    const r = await withAdmin(request(adminApp()).post('/api/admin/invites')).send({ expires_at: v }).expect(400);
    expect(r.body.error).toBe('INVALID_EXPIRY');
  });

  test('unique collision retries then succeeds', async () => {
    let calls = 0;
    db.query.mockImplementation(async (text) => {
      if (/INSERT INTO invite_links/.test(text)) {
        calls += 1;
        if (calls === 1) { const e = new Error('dup'); e.code = '23505'; throw e; }
        return { rows: [{ code: 'INV-RETRY001' }] };
      }
      return { rows: [], rowCount: 0 };
    });
    const r = await withAdmin(request(adminApp()).post('/api/admin/invites')).send({}).expect(201);
    expect(r.body.code).toBe('INV-RETRY001');
    expect(calls).toBe(2);
  });

  test('non-unique DB error → 500 FAILED (no leak)', async () => {
    db.query.mockImplementation(async (text) => {
      if (/INSERT INTO invite_links/.test(text)) throw new Error('secret db failure');
      return { rows: [], rowCount: 0 };
    });
    const r = await withAdmin(request(adminApp()).post('/api/admin/invites')).send({}).expect(500);
    expect(r.body.error).toBe('FAILED');
    expect(JSON.stringify(r.body)).not.toContain('secret');
  });
});

describe('admin invite CRUD', () => {
  test('GET / → 200 list', async () => {
    db.__routeQuery([['FROM invite_links ORDER BY', { rows: [{ code: 'INV-A' }, { code: 'INV-B' }] }]]);
    const r = await withAdmin(request(adminApp()).get('/api/admin/invites')).expect(200);
    expect(r.body.invites).toHaveLength(2);
  });

  test('PUT /:id: non-boolean is_active → 400 INVALID_STATUS', async () => {
    const r = await withAdmin(request(adminApp()).put('/api/admin/invites/1'))
      .send({ is_active: 'yes' }).expect(400);
    expect(r.body.error).toBe('INVALID_STATUS');
  });

  test('PUT /:id: not found → 404; ok → 200', async () => {
    db.__routeQuery([['UPDATE invite_links SET is_active', { rows: [] }]]);
    await withAdmin(request(adminApp()).put('/api/admin/invites/9')).send({ is_active: false }).expect(404);
    db.__reset();
    db.__routeQuery([['UPDATE invite_links SET is_active', { rows: [{ code: 'INV-X' }] }]]);
    await withAdmin(request(adminApp()).put('/api/admin/invites/9')).send({ is_active: false }).expect(200);
  });

  test('DELETE /:id: not found → 404; ok → 200', async () => {
    db.__routeQuery([['DELETE FROM invite_links', { rows: [] }]]);
    await withAdmin(request(adminApp()).delete('/api/admin/invites/9')).expect(404);
    db.__reset();
    db.__routeQuery([['DELETE FROM invite_links', { rows: [{ code: 'INV-X' }] }]]);
    await withAdmin(request(adminApp()).delete('/api/admin/invites/9')).expect(200);
  });
});

describe('GET /api/invite/:code/validate (public)', () => {
  test('valid code → { valid:true }', async () => {
    db.__routeQuery([['FROM invite_links WHERE code', {
      rows: [{ code: 'INV-ABCDEF12', is_active: true, expires_at: null, max_uses: null, used_count: 0 }],
    }]]);
    const r = await request(publicApp()).get('/api/invite/INV-ABCDEF12/validate').expect(200);
    expect(r.body).toEqual({ valid: true });
  });

  test('bad code → { valid:false }, no detail leak', async () => {
    const r = await request(publicApp()).get('/api/invite/NOPE/validate').expect(200);
    expect(r.body).toEqual({ valid: false });
  });

  test('DB error → { valid:false } (never 500)', async () => {
    db.query.mockImplementation(async () => { throw new Error('db down'); });
    const r = await request(publicApp()).get('/api/invite/INV-ABCDEF12/validate').expect(200);
    expect(r.body).toEqual({ valid: false });
  });
});
