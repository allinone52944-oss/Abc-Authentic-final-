// Route tests for backend/routes/auth.js.
// DB is fully mocked (tests/helpers/mockDb.js). Tokens are REAL (auth.js).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../utils/whatsapp', () => ({
  notifyWelcome: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../utils/push', () => ({
  notifyNewUser: jest.fn().mockResolvedValue({ ok: true }),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const authRouter = require('../../routes/auth');
const wa = require('../../utils/whatsapp');
const push = require('../../utils/push');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', authRouter);
  return a;
}
const userToken = (id = 'u1', role = 'user') => auth.signAccess({ id, role });

const VALID = {
  name: 'Rahim Uddin',
  phone: '01712345678',
  whatsapp: '01812345678',
  email: 'rahim@example.com',
  password: 'secret123',
  religion: 'islam',
};

function settingsHandlers(regEnabled = { enabled: true }) {
  return [
    ['SELECT value FROM settings WHERE key', (text, params) => {
      if (params && params[0] === 'registration_enabled') return { rows: [{ value: regEnabled }] };
      return { rows: [] };
    }],
  ];
}

beforeEach(() => {
  db.__reset();
  wa.notifyWelcome.mockClear();
  push.notifyNewUser.mockClear();
});

describe('POST /api/auth/register — happy path', () => {
  test('201 with verify_email, no password hash leaked', async () => {
    db.__routeQuery([
      ...settingsHandlers(),
      ['FROM users WHERE phone = $1 OR email', { rows: [] }],
      ['INSERT INTO users', { rows: [{ id: 'u1', name: VALID.name, phone: VALID.phone, email: VALID.email, status: 'pending' }] }],
    ]);
    const r = await request(app()).post('/api/auth/register').send(VALID).expect(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.verify_email).toBe(true);
    expect(r.body.email).toBe(VALID.email);
    expect(JSON.stringify(r.body)).not.toContain('password_hash');
    // email not configured in tests → no verification token created
    expect(r.body.email_sent).toBe(false);
    // the new customer is welcomed on WhatsApp; admins are pushed
    expect(wa.notifyWelcome).toHaveBeenCalledTimes(1);
    expect(wa.notifyWelcome.mock.calls[0][1]).toBe('u1');
    expect(push.notifyNewUser).toHaveBeenCalledTimes(1);
  });

  test('registration is logged with the client IP (admin লগ tab)', async () => {
    db.__routeQuery([
      ...settingsHandlers(),
      ['FROM users WHERE phone = $1 OR email', { rows: [] }],
      ['INSERT INTO users', { rows: [{ id: 'u1', name: VALID.name, phone: VALID.phone, email: VALID.email, status: 'pending' }] }],
    ]);
    await request(app()).post('/api/auth/register')
      .set('x-forwarded-for', '203.0.113.9')
      .send(VALID).expect(201);
    const ins = db.query.mock.calls.find((c) => /INSERT INTO activity_log/.test(c[0]) && c[1][1] === 'auth.register');
    expect(ins).toBeDefined();
    expect(JSON.parse(ins[1][2])).toEqual({ ip: '203.0.113.9' });
  });

  test('registration OFF + valid invite → proceeds and consumes invite', async () => {
    db.__routeQuery([
      ...settingsHandlers({ enabled: false }),
      ['FROM invite_links WHERE code', { rows: [{ code: 'INV-ABCDEF1234567890ABCDEF1234567890', is_active: true, expires_at: null, max_uses: 5, used_count: 1 }] }],
      ['FROM users WHERE phone = $1 OR email', { rows: [] }],
      ['INSERT INTO users', { rows: [{ id: 'u2', name: VALID.name }] }],
      ['UPDATE invite_links SET used_count', { rows: [], rowCount: 1 }],
    ]);
    const r = await request(app())
      .post('/api/auth/register')
      .send({ ...VALID, phone: '01799998888', email: 'x@y.co', invite_code: 'inv-abcdef1234567890abcdef1234567890' })
      .expect(201);
    expect(r.body.ok).toBe(true);
    // H-3: consume now runs inside withTransaction → goes through the mock client
    const allCalls = [...db.query.mock.calls, ...db.__client.query.mock.calls];
    const upd = allCalls.find((c) => /UPDATE invite_links/.test(c[0]));
    expect(upd).toBeDefined();
    expect(upd[1][0]).toBe('INV-ABCDEF1234567890ABCDEF1234567890'); // normalized to uppercase
  });

  test('H-3: exhausted invite → 403 INVITE_EXHAUSTED (no orphan account)', async () => {
    db.__routeQuery([
      ...settingsHandlers({ enabled: false }),
      ['FROM invite_links WHERE code', { rows: [{ code: 'INV-ABCDEF1234567890ABCDEF1234567890', is_active: true, expires_at: null, max_uses: 1, used_count: 0 }] }],
      ['FROM users WHERE phone = $1 OR email', { rows: [] }],
      ['INSERT INTO users', { rows: [{ id: 'u3', name: VALID.name }] }],
      ['UPDATE invite_links SET used_count', { rows: [], rowCount: 0 }], // someone else took the last use
    ]);
    const r = await request(app())
      .post('/api/auth/register')
      .send({ ...VALID, phone: '01799998889', email: 'z@y.co', invite_code: 'INV-ABCDEF1234567890ABCDEF1234567890' })
      .expect(403);
    expect(r.body.error).toBe('INVITE_EXHAUSTED');
  });

  test('registration OFF without invite → 403 REGISTRATION_DISABLED', async () => {
    db.__routeQuery(settingsHandlers({ enabled: false }));
    const r = await request(app()).post('/api/auth/register').send(VALID).expect(403);
    expect(r.body.error).toBe('REGISTRATION_DISABLED');
  });
});

describe('POST /api/auth/register — invalid inputs', () => {
  beforeEach(() => { db.__routeQuery(settingsHandlers()); });
  const post = (body) => request(app()).post('/api/auth/register').send(body);

  test.each([
    ['missing name', { ...VALID, name: '' }, 'INVALID_NAME'],
    ['name too short', { ...VALID, name: 'A' }, 'INVALID_NAME'],
    ['name too long', { ...VALID, name: 'x'.repeat(121) }, 'INVALID_NAME'],
    ['bad phone', { ...VALID, phone: '12345' }, 'INVALID_PHONE'],
    ['non-BD phone', { ...VALID, phone: '02123456789' }, 'INVALID_PHONE'],
    ['bad whatsapp', { ...VALID, whatsapp: 'abc' }, 'INVALID_WHATSAPP'],
    ['bad email', { ...VALID, email: 'not-an-email' }, 'INVALID_EMAIL'],
    ['weak password', { ...VALID, password: '123' }, 'WEAK_PASSWORD'],
    ['bad religion', { ...VALID, religion: 'jedi' }, 'INVALID_RELIGION'],
  ])('%s → %s', async (_label, body, code) => {
    const r = await post(body).expect(400);
    expect(r.body.error).toBe(code);
  });

  test('duplicate phone/email → 409 ALREADY_REGISTERED', async () => {
    db.__routeQuery([
      ...settingsHandlers(),
      ['FROM users WHERE phone = $1 OR email', { rows: [{ id: 'u9' }] }],
    ]);
    const r = await post(VALID).expect(409);
    expect(r.body.error).toBe('ALREADY_REGISTERED');
  });

  test('SQL-injection-shaped values stay parameterized', async () => {
    db.__routeQuery([
      ...settingsHandlers(),
      ['FROM users WHERE phone = $1 OR email', { rows: [] }],
      ['INSERT INTO users', { rows: [{ id: 'u3', name: 'x' }] }],
    ]);
    await post({ ...VALID, name: "x'); DROP TABLE users; --" }).expect(201);
    const dupCall = db.query.mock.calls.find((c) => /FROM users WHERE phone/.test(c[0]));
    expect(dupCall[0]).toContain('$1');
    expect(dupCall[0]).not.toContain('DROP TABLE');
  });

  test('DB failure → 500 REGISTER_FAILED without leaking internals', async () => {
    db.query.mockImplementation(async () => { throw new Error('super secret db detail'); });
    const r = await post(VALID).expect(500);
    expect(r.body.error).toBe('REGISTER_FAILED');
    expect(JSON.stringify(r.body)).not.toContain('super secret');
  });
});

describe('POST /api/auth/login', () => {
  let pwHash;
  const userRow = () => ({
    id: 'u1', role: 'user', status: 'active', email_verified: true,
    login_enabled: true, locked_until: null, failed_attempts: 0,
    password_hash: pwHash, name: 'Rahim', phone: '01712345678', email: 'rahim@example.com',
  });
  beforeAll(async () => { pwHash = await auth.hashPassword('correct-password1'); });
  beforeEach(() => {
    db.__routeQuery([
      ['SELECT value FROM settings WHERE key', { rows: [] }],
      ['SELECT * FROM users WHERE LOWER(phone)', { rows: [userRow()] }],
      ['SELECT * FROM users WHERE id', { rows: [userRow()] }],
    ]);
  });

  test('happy path → 200 with tokens, no password_hash in user', async () => {
    const r = await request(app())
      .post('/api/auth/login')
      .send({ login: '01712345678', password: 'correct-password1' })
      .expect(200);
    expect(r.body.access_token).toBeTruthy();
    expect(r.body.refresh_token).toMatch(/^[a-f0-9]{96}$/);
    expect(r.body.user.id).toBe('u1');
    expect(r.body.user.password_hash).toBeUndefined();
    expect(r.body.user.failed_attempts).toBeUndefined();
  });

  test('missing credentials → 400 MISSING_CREDENTIALS', async () => {
    const r = await request(app()).post('/api/auth/login').send({}).expect(400);
    expect(r.body.error).toBe('MISSING_CREDENTIALS');
  });

  test('login is logged with the client IP (admin লগ tab)', async () => {
    await request(app())
      .post('/api/auth/login')
      .set('x-forwarded-for', '203.0.113.9')
      .send({ login: '01712345678', password: 'correct-password1' })
      .expect(200);
    const ins = db.query.mock.calls.find((c) => /INSERT INTO activity_log/.test(c[0]) && c[1][1] === 'auth.login');
    expect(ins).toBeDefined();
    expect(JSON.parse(ins[1][2])).toEqual({ ip: '203.0.113.9' });
  });

  test('unknown user → 401 INVALID_CREDENTIALS', async () => {
    db.__routeQuery([['SELECT * FROM users WHERE LOWER(phone)', { rows: [] }]]);
    const r = await request(app())
      .post('/api/auth/login').send({ login: '01700000000', password: 'x' }).expect(401);
    expect(r.body.error).toBe('INVALID_CREDENTIALS');
  });

  test('wrong password → 401 + failed_attempts incremented', async () => {
    const r = await request(app())
      .post('/api/auth/login').send({ login: '01712345678', password: 'wrong' }).expect(401);
    expect(r.body.error).toBe('INVALID_CREDENTIALS');
    const upd = db.query.mock.calls.find((c) => /UPDATE users SET failed_attempts/.test(c[0]));
    expect(upd).toBeDefined();
  });

  test('10th failed attempt locks the account → 423 ACCOUNT_LOCKED', async () => {
    const locked = { ...userRow(), failed_attempts: 9 };
    db.__routeQuery([
      ['SELECT value FROM settings WHERE key', { rows: [] }],
      ['SELECT * FROM users WHERE LOWER(phone)', { rows: [locked] }],
    ]);
    const r = await request(app())
      .post('/api/auth/login').send({ login: '01712345678', password: 'wrong' }).expect(423);
    expect(r.body.error).toBe('ACCOUNT_LOCKED');
    expect(r.body.retry_minutes).toBe(30);
  });

  test('already locked_until in future → 423 without password check', async () => {
    const locked = { ...userRow(), locked_until: new Date(Date.now() + 600000).toISOString() };
    db.__routeQuery([['SELECT * FROM users WHERE LOWER(phone)', { rows: [locked] }]]);
    const r = await request(app())
      .post('/api/auth/login').send({ login: '01712345678', password: 'correct-password1' }).expect(423);
    expect(r.body.error).toBe('ACCOUNT_LOCKED');
  });

  test('blocked user → 403 ACCOUNT_DISABLED', async () => {
    db.__routeQuery([['SELECT * FROM users WHERE LOWER(phone)', { rows: [{ ...userRow(), status: 'blocked' }] }]]);
    const r = await request(app())
      .post('/api/auth/login').send({ login: '01712345678', password: 'correct-password1' }).expect(403);
    expect(r.body.error).toBe('ACCOUNT_DISABLED');
  });

  test('email not verified → 403 EMAIL_NOT_VERIFIED', async () => {
    db.__routeQuery([['SELECT * FROM users WHERE LOWER(phone)', { rows: [{ ...userRow(), email_verified: false }] }]]);
    const r = await request(app())
      .post('/api/auth/login').send({ login: '01712345678', password: 'correct-password1' }).expect(403);
    expect(r.body.error).toBe('EMAIL_NOT_VERIFIED');
  });
});

describe('POST /api/auth/refresh + /logout', () => {
  test('missing refresh_token → 400 MISSING_TOKEN', async () => {
    const r = await request(app()).post('/api/auth/refresh').send({}).expect(400);
    expect(r.body.error).toBe('MISSING_TOKEN');
  });

  test('unknown refresh token → 401 INVALID_REFRESH', async () => {
    db.__routeQuery([['FROM refresh_tokens rt', { rows: [] }]]);
    const r = await request(app())
      .post('/api/auth/refresh').send({ refresh_token: 'nope' }).expect(401);
    expect(r.body.error).toBe('INVALID_REFRESH');
  });

  test('valid token rotates → 200 with new tokens, old revoked', async () => {
    db.__routeQuery([
      ['FROM refresh_tokens rt', { rows: [{ id: 'rt1', user_id: 'u1', role: 'user', status: 'active' }] }],
    ]);
    const r = await request(app())
      .post('/api/auth/refresh').send({ refresh_token: 'a'.repeat(96) }).expect(200);
    expect(r.body.access_token).toBeTruthy();
    expect(r.body.refresh_token).toMatch(/^[a-f0-9]{96}$/);
    const revoke = db.__client.query.mock.calls.find((c) => /UPDATE refresh_tokens SET revoked/.test(c[0]));
    expect(revoke).toBeDefined();
  });

  test('just-rotated token re-presented inside the leeway → same new pair, no theft response (concurrent-tabs fix)', async () => {
    if (authRouter.__resetRotationGrace) authRouter.__resetRotationGrace();
    db.__routeQuery([
      ['FROM refresh_tokens rt', { rows: [{ id: 'rt1', user_id: 'u1', role: 'user', status: 'active' }] }],
    ]);
    const first = await request(app())
      .post('/api/auth/refresh').send({ refresh_token: 'c'.repeat(96) }).expect(200);
    // Second tab presents the SAME pre-rotation token a moment later:
    // it must get the same rotated pair — NOT a chain-wide revoke.
    db.__client.query.mockClear();
    const second = await request(app())
      .post('/api/auth/refresh').send({ refresh_token: 'c'.repeat(96) }).expect(200);
    expect(second.body.refresh_token).toBe(first.body.refresh_token);
    expect(second.body.access_token).toBe(first.body.access_token);
    const chainRevoke = db.__client.query.mock.calls.find(
      (c) => /UPDATE refresh_tokens SET revoked = TRUE WHERE user_id/.test(c[0])
    );
    expect(chainRevoke).toBeUndefined();
  });

  test('revoked token OUTSIDE any rotation leeway → theft response still revokes the whole chain', async () => {
    if (authRouter.__resetRotationGrace) authRouter.__resetRotationGrace();
    db.__routeQuery([
      ['FROM refresh_tokens rt', { rows: [{ id: 'rt9', user_id: 'u1', role: 'user', status: 'active', revoked: true }] }],
    ]);
    const r = await request(app())
      .post('/api/auth/refresh').send({ refresh_token: 'd'.repeat(96) }).expect(401);
    expect(r.body.error).toBe('TOKEN_REUSED');
    const chainRevoke = db.__client.query.mock.calls.find(
      (c) => /UPDATE refresh_tokens SET revoked = TRUE WHERE user_id/.test(c[0])
    );
    expect(chainRevoke).toBeDefined();
  });

  test('revoked token WITH a recent DB rotation lineage (post-restart second tab) → rotates the lineage head, no chain revoke', async () => {
    // Simulates a service restart: the in-memory grace is gone, so
    // only the persistent lineage can save the second tab. Before
    // the fix this presented token looked like theft (TOKEN_REUSED
    // + whole-chain revoke) because the leeway lived only in memory.
    if (authRouter.__resetRotationGrace) authRouter.__resetRotationGrace();
    const crypto = require('crypto');
    const presentedHash = crypto.createHash('sha256').update('e'.repeat(96)).digest('hex');
    const now = new Date();
    db.__routeQuery([
      [(text, params) => text.includes('FROM refresh_tokens rt') && params && params[0] === presentedHash,
        { rows: [{ id: 'rt-old', user_id: 'u1', role: 'user', status: 'active', revoked: true, replaced_by_hash: 'newhash123', replaced_at: now }] }],
      [(text, params) => text.includes('FROM refresh_tokens rt') && params && params[0] === 'newhash123',
        { rows: [{ id: 'rt-new', user_id: 'u1', role: 'user', status: 'active', revoked: false, last_activity: now, created_at: now }] }],
    ]);
    const r = await request(app())
      .post('/api/auth/refresh').send({ refresh_token: 'e'.repeat(96) }).expect(200);
    expect(r.body.access_token).toBeTruthy();
    expect(r.body.refresh_token).toMatch(/^[a-f0-9]{96}$/);
    const chainRevoke = db.__client.query.mock.calls.find(
      (c) => /UPDATE refresh_tokens SET revoked = TRUE WHERE user_id/.test(c[0])
    );
    expect(chainRevoke).toBeUndefined();
    // The lineage head was rotated (lineage recorded on the old row):
    const lineageUpdate = db.__client.query.mock.calls.find(
      (c) => /replaced_by_hash/.test(c[0])
    );
    expect(lineageUpdate).toBeDefined();
  });

  test('revoked token with a STALE lineage (rotated >30s ago) → theft response still revokes the chain', async () => {
    if (authRouter.__resetRotationGrace) authRouter.__resetRotationGrace();
    const crypto = require('crypto');
    const presentedHash = crypto.createHash('sha256').update('f'.repeat(96)).digest('hex');
    const stale = new Date(Date.now() - 60000);
    db.__routeQuery([
      [(text, params) => text.includes('FROM refresh_tokens rt') && params && params[0] === presentedHash,
        { rows: [{ id: 'rt-old2', user_id: 'u1', role: 'user', status: 'active', revoked: true, replaced_by_hash: 'newhash456', replaced_at: stale }] }],
    ]);
    const r = await request(app())
      .post('/api/auth/refresh').send({ refresh_token: 'f'.repeat(96) }).expect(401);
    expect(r.body.error).toBe('TOKEN_REUSED');
    const chainRevoke = db.__client.query.mock.calls.find(
      (c) => /UPDATE refresh_tokens SET revoked = TRUE WHERE user_id/.test(c[0])
    );
    expect(chainRevoke).toBeDefined();
  });

  test('logout revokes and always returns ok', async () => {
    const r = await request(app())
      .post('/api/auth/logout').send({ refresh_token: 'b'.repeat(96) }).expect(200);
    expect(r.body.ok).toBe(true);
    const r2 = await request(app()).post('/api/auth/logout').send({}).expect(200);
    expect(r2.body.ok).toBe(true);
  });
});

describe('GET /api/auth/me (requireAuth)', () => {
  test('no token → 401 NO_TOKEN', async () => {
    const r = await request(app()).get('/api/auth/me').expect(401);
    expect(r.body.error).toBe('NO_TOKEN');
  });
  test('bad token → 401 INVALID_TOKEN', async () => {
    const r = await request(app()).get('/api/auth/me')
      .set('Authorization', 'Bearer garbage').expect(401);
    expect(r.body.error).toBe('INVALID_TOKEN');
  });
  test('valid token → 200, password_hash stripped', async () => {
    db.__routeQuery([['SELECT * FROM users WHERE id', {
      rows: [{ id: 'u1', name: 'R', password_hash: 'secret', failed_attempts: 0, locked_until: null }],
    }]]);
    const r = await request(app()).get('/api/auth/me')
      .set('Authorization', 'Bearer ' + userToken()).expect(200);
    expect(r.body.user.id).toBe('u1');
    expect(r.body.user.password_hash).toBeUndefined();
  });
  test('user gone → 404 NOT_FOUND', async () => {
    db.__routeQuery([['SELECT * FROM users WHERE id', { rows: [] }]]);
    const r = await request(app()).get('/api/auth/me')
      .set('Authorization', 'Bearer ' + userToken()).expect(404);
    expect(r.body.error).toBe('NOT_FOUND');
  });
});

describe('PUT /api/auth/me', () => {
  const T = () => userToken();
  test('update name → 200', async () => {
    db.__routeQuery([['UPDATE users SET', { rows: [{ id: 'u1', name: 'New Name' }] }]]);
    const r = await request(app()).put('/api/auth/me')
      .set('Authorization', 'Bearer ' + T()).send({ name: 'New Name' }).expect(200);
    expect(r.body.user.name).toBe('New Name');
  });
  test.each([
    ['bad email', { email: 'nope' }, 'INVALID_EMAIL'],
    ['bad religion', { religion: 'jedi' }, 'INVALID_RELIGION'],
    ['bad gender', { gender: 'x' }, 'INVALID_GENDER'],
    ['bad whatsapp', { whatsapp: '123' }, 'INVALID_WHATSAPP'],
    ['short name', { name: 'A' }, 'INVALID_NAME'],
  ])('%s → 400 %s', async (_l, body, code) => {
    const r = await request(app()).put('/api/auth/me')
      .set('Authorization', 'Bearer ' + T()).send(body).expect(400);
    expect(r.body.error).toBe(code);
  });
  test('nothing to update → 400 NOTHING_TO_UPDATE', async () => {
    const r = await request(app()).put('/api/auth/me')
      .set('Authorization', 'Bearer ' + T()).send({}).expect(400);
    expect(r.body.error).toBe('NOTHING_TO_UPDATE');
  });
  test('email already taken → 409 EMAIL_TAKEN', async () => {
    db.__routeQuery([['FROM users WHERE LOWER(email)', { rows: [{ id: 'u2' }] }]]);
    const r = await request(app()).put('/api/auth/me')
      .set('Authorization', 'Bearer ' + T()).send({ email: 'taken@x.co' }).expect(409);
    expect(r.body.error).toBe('EMAIL_TAKEN');
  });
  // Regression (2026-10-21): profile.html always submits the email
  // field — saving with the UNCHANGED email must not reset
  // verification (it silently un-verified users on every save).
  test('email unchanged → verification NOT reset', async () => {
    let updText = null; let updParams = null;
    db.__routeQuery([
      ['SELECT email FROM users WHERE id', { rows: [{ email: 'old@x.co' }] }],
      ['FROM users WHERE LOWER(email)', { rows: [] }],
      ['UPDATE users SET', (text, params) => { updText = text; updParams = params; return { rows: [{ id: 'u1', email: 'old@x.co' }] }; }],
    ]);
    const r = await request(app()).put('/api/auth/me')
      .set('Authorization', 'Bearer ' + T()).send({ name: 'Same Mail', email: 'old@x.co' }).expect(200);
    expect(updText).not.toMatch(/email_verified/);
    expect(updParams).not.toContain(false);
    expect(r.body.user.verify_email_sent).toBeUndefined();
  });
  test('email changed → verification reset', async () => {
    let updText = null; let updParams = null;
    db.__routeQuery([
      ['SELECT email FROM users WHERE id', { rows: [{ email: 'old@x.co' }] }],
      ['FROM users WHERE LOWER(email)', { rows: [] }],
      ['UPDATE users SET', (text, params) => { updText = text; updParams = params; return { rows: [{ id: 'u1', email: 'new@x.co' }] }; }],
    ]);
    await request(app()).put('/api/auth/me')
      .set('Authorization', 'Bearer ' + T()).send({ email: 'new@x.co' }).expect(200);
    expect(updText).toMatch(/email_verified/);
    expect(updParams).toContain(false);
  });
});

describe('POST /api/auth/change-password', () => {
  let pwHash;
  beforeAll(async () => { pwHash = await auth.hashPassword('old-password1'); });
  beforeEach(() => {
    db.__routeQuery([['SELECT * FROM users WHERE id', { rows: [{ id: 'u1', password_hash: pwHash }] }]]);
  });
  const T = () => userToken();

  test('happy path → 200 and revokes refresh tokens', async () => {
    const r = await request(app()).post('/api/auth/change-password')
      .set('Authorization', 'Bearer ' + T())
      .send({ current_password: 'old-password1', new_password: 'brand-new-password1' })
      .expect(200);
    expect(r.body.ok).toBe(true);
    const upd = db.query.mock.calls.find((c) => /UPDATE users SET password_hash/.test(c[0]));
    expect(upd).toBeDefined();
    const revoke = db.query.mock.calls.find((c) => /UPDATE refresh_tokens SET revoked/.test(c[0]));
    expect(revoke).toBeDefined();
  });
  test('weak new password → 400 WEAK_PASSWORD', async () => {
    const r = await request(app()).post('/api/auth/change-password')
      .set('Authorization', 'Bearer ' + T())
      .send({ current_password: 'old-password1', new_password: '123' }).expect(400);
    expect(r.body.error).toBe('WEAK_PASSWORD');
  });
  test('wrong current password → 401 WRONG_CURRENT_PASSWORD', async () => {
    const r = await request(app()).post('/api/auth/change-password')
      .set('Authorization', 'Bearer ' + T())
      .send({ current_password: 'nope-nope', new_password: 'brand-new-password1' }).expect(401);
    expect(r.body.error).toBe('WRONG_CURRENT_PASSWORD');
  });
});

describe('email verification + password reset link tokens', () => {
  const crypto = require('crypto');
  const tok = 'a'.repeat(64);
  // findValidToken compares sha256(token) against the stored token_hash
  const tokenHash = crypto.createHash('sha256').update(tok).digest('hex');
  test('GET /verify-email: malformed token → 400 INVALID_TOKEN', async () => {
    const r = await request(app()).get('/api/auth/verify-email?token=xyz').expect(400);
    expect(r.body.error).toBe('INVALID_TOKEN');
  });
  test('GET /verify-email: unknown/expired → 400 INVALID_OR_EXPIRED', async () => {
    db.__routeQuery([['FROM email_verification_tokens', { rows: [] }]]);
    const r = await request(app()).get(`/api/auth/verify-email?token=${tok}`).expect(400);
    expect(r.body.error).toBe('INVALID_OR_EXPIRED');
  });
  test('GET /verify-email: valid → 200 {valid:true}, does NOT consume (L-4)', async () => {
    db.__routeQuery([['FROM email_verification_tokens', { rows: [{ id: 't1', user_id: 'u1', token_hash: tokenHash }] }]]);
    const r = await request(app()).get(`/api/auth/verify-email?token=${tok}`).expect(200);
    expect(r.body.valid).toBe(true);
    const q = db.query.mock.calls.find((c) => /FROM email_verification_tokens/.test(c[0]));
    expect(q[0]).toContain('email_verification_tokens'); // literal, not interpolated
    // no UPDATE consumed the token
    expect(db.query.mock.calls.some((c) => /UPDATE email_verification_tokens/.test(c[0]))).toBe(false);
  });
  test('POST /verify-email: valid → 200 consumes the token (L-4)', async () => {
    db.__routeQuery([['FROM email_verification_tokens', { rows: [{ id: 't1', user_id: 'u1', token_hash: tokenHash }] }]]);
    const r = await request(app()).post('/api/auth/verify-email').send({ token: tok }).expect(200);
    expect(r.body.ok).toBe(true);
    const allQ = [...db.query.mock.calls, ...db.__client.query.mock.calls];
    expect(allQ.some((c) => /UPDATE email_verification_tokens SET used/.test(c[0]))).toBe(true);
  });
  test('POST /reset-password: malformed token → 400 INVALID_TOKEN', async () => {
    const r = await request(app()).post('/api/auth/reset-password')
      .send({ token: 'bad', new_password: 'newpass123' }).expect(400);
    expect(r.body.error).toBe('INVALID_TOKEN');
  });
  test('POST /reset-password: weak password → 400 WEAK_PASSWORD', async () => {
    const r = await request(app()).post('/api/auth/reset-password')
      .send({ token: tok, new_password: '123' }).expect(400);
    expect(r.body.error).toBe('WEAK_PASSWORD');
  });
  test('POST /reset-password: valid → 200, revokes refresh tokens', async () => {
    db.__routeQuery([['FROM password_reset_tokens', { rows: [{ id: 't2', user_id: 'u1', token_hash: tokenHash }] }]]);
    const r = await request(app()).post('/api/auth/reset-password')
      .send({ token: tok, new_password: 'newpass123' }).expect(200);
    expect(r.body.ok).toBe(true);
    const revoke = db.__client.query.mock.calls.find((c) => /UPDATE refresh_tokens SET revoked/.test(c[0]));
    expect(revoke).toBeDefined();
  });
  test('POST /forgot-password: bad email → 400; ok → 200 (no enumeration)', async () => {
    const bad = await request(app()).post('/api/auth/forgot-password').send({ email: 'x' }).expect(400);
    expect(bad.body.error).toBe('INVALID_EMAIL');
    db.__routeQuery([
      ['FROM password_reset_tokens prt', { rows: [{ c: '0' }] }],
      ['FROM users WHERE LOWER(email)', { rows: [] }],
    ]);
    const r = await request(app()).post('/api/auth/forgot-password').send({ email: 'nobody@x.co' }).expect(200);
    expect(r.body.ok).toBe(true);
  });
  test('POST /forgot-password: rate limited at 3/hour → 429', async () => {
    db.__routeQuery([['FROM password_reset_tokens prt', { rows: [{ c: '3' }] }]]);
    const r = await request(app()).post('/api/auth/forgot-password').send({ email: 'a@b.co' }).expect(429);
    expect(r.body.error).toBe('TOO_MANY_REQUESTS');
  });
  test('POST /resend-verification: rate limited → 429', async () => {
    db.__routeQuery([['FROM email_verification_tokens evt', { rows: [{ c: '5' }] }]]);
    const r = await request(app()).post('/api/auth/resend-verification').send({ email: 'a@b.co' }).expect(429);
    expect(r.body.error).toBe('TOO_MANY_REQUESTS');
  });
});

describe('OTP endpoints', () => {
  test('POST /send-otp: bad email → 400 INVALID_EMAIL', async () => {
    const r = await request(app()).post('/api/auth/send-otp').send({ email: 'x' }).expect(400);
    expect(r.body.error).toBe('INVALID_EMAIL');
  });
  test('POST /send-otp: SMTP unconfigured → 503 OTP_UNAVAILABLE', async () => {
    const r = await request(app()).post('/api/auth/send-otp').send({ email: 'a@b.co' }).expect(503);
    expect(r.body.error).toBe('OTP_UNAVAILABLE');
  });
  test('POST /verify-otp: bad shape → 400 INVALID_INPUT', async () => {
    const r = await request(app()).post('/api/auth/verify-otp')
      .send({ email: 'a@b.co', code: '12' }).expect(400);
    expect(r.body.error).toBe('INVALID_INPUT');
  });
  test('POST /verify-otp: wrong code → 400 INVALID_OR_EXPIRED', async () => {
    db.__routeQuery([['FROM otp_codes', { rows: [] }]]);
    const r = await request(app()).post('/api/auth/verify-otp')
      .send({ email: 'a@b.co', code: '123456' }).expect(400);
    expect(r.body.error).toBe('INVALID_OR_EXPIRED');
  });
  test('POST /verify-otp: correct code → 200', async () => {
    db.__routeQuery([['FROM otp_codes', { rows: [{ id: 'otp1', attempts: 0 }] }]]);
    const r = await request(app()).post('/api/auth/verify-otp')
      .send({ email: 'a@b.co', code: '123456' }).expect(200);
    expect(r.body.ok).toBe(true);
  });
  test('POST /verify-otp: too many attempts → 400 TOO_MANY_ATTEMPTS', async () => {
    db.__routeQuery([['FROM otp_codes', { rows: [{ id: 'otp1', attempts: 5 }] }]]);
    const r = await request(app()).post('/api/auth/verify-otp')
      .send({ email: 'a@b.co', code: '123456' }).expect(400);
    expect(r.body.error).toBe('TOO_MANY_ATTEMPTS');
  });
});

describe('GET /api/auth/voice-greeting', () => {
  test('returns enabled: false when setting is missing or disabled', async () => {
    db.__routeQuery([
      ['SELECT value FROM settings WHERE key', { rows: [] }],
    ]);
    const r = await request(app()).get('/api/auth/voice-greeting').expect(200);
    expect(r.body).toEqual({ enabled: false });

    db.__routeQuery([
      ['SELECT value FROM settings WHERE key', { rows: [{ value: { enabled: false } }] }],
    ]);
    const r2 = await request(app()).get('/api/auth/voice-greeting').expect(200);
    expect(r2.body).toEqual({ enabled: false });
  });

  test('returns configured voice greeting with rotation, voices and religions', async () => {
    db.__routeQuery([
      ['SELECT value FROM settings WHERE key', {
        rows: [{
          value: {
            enabled: true,
            rotation: true,
            greetings: { islam: 'আসসালামু আলাইকুম', hindu: 'নমস্কার' }
          }
        }]
      }],
    ]);
    const r = await request(app()).get('/api/auth/voice-greeting').expect(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.rotation).toBe(true);
    expect(r.body.greetings.islam).toBe('আসসালামু আলাইকুম');
    expect(r.body.voices).toEqual(['male', 'female', 'child']);
    expect(r.body.religions).toEqual(['islam', 'hindu', 'buddhist', 'christian', 'other']);
  });
});
