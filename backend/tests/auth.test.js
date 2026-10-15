// Unit tests for backend/auth.js (pure functions + middleware).
// Uses REAL bcrypt/JWT with the test JWT_SECRET from tests/setup.js.
const jwt = require('jsonwebtoken');
const auth = require('../auth');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('hashPassword / verifyPassword', () => {
  test('hashes a password and verifies it', async () => {
    const hash = await auth.hashPassword('secret123');
    expect(hash).not.toBe('secret123');
    expect(await auth.verifyPassword('secret123', hash)).toBe(true);
  });

  test('rejects wrong password', async () => {
    const hash = await auth.hashPassword('secret123');
    expect(await auth.verifyPassword('wrongpass', hash)).toBe(false);
  });

  test('rejects weak passwords (WEAK_PASSWORD)', async () => {
    await expect(auth.hashPassword('12345')).rejects.toThrow('WEAK_PASSWORD');
    await expect(auth.hashPassword('')).rejects.toThrow('WEAK_PASSWORD');
    await expect(auth.hashPassword(null)).rejects.toThrow('WEAK_PASSWORD');
  });

  test('verifyPassword returns false on missing args (no throw)', async () => {
    expect(await auth.verifyPassword(null, 'hash')).toBe(false);
    expect(await auth.verifyPassword('pw', null)).toBe(false);
    expect(await auth.verifyPassword()).toBe(false);
  });

  test('two hashes of the same password differ (salted)', async () => {
    const a = await auth.hashPassword('same-password1');
    const b = await auth.hashPassword('same-password1');
    expect(a).not.toBe(b);
  });
});

describe('signAccess / mintRefreshToken / hashRefreshToken', () => {
  test('signAccess returns a JWT verifiable with JWT_SECRET', () => {
    const token = auth.signAccess({ id: 'u1', role: 'user' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    expect(decoded.id).toBe('u1');
    expect(decoded.role).toBe('user');
    expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('mintRefreshToken returns token + sha256 hash + future expiry', () => {
    const { token, hash, expiresAt } = auth.mintRefreshToken();
    expect(token).toMatch(/^[a-f0-9]{96}$/);
    expect(hash).toBe(auth.hashRefreshToken(token));
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
  });

  test('mintRefreshToken is unique every call', () => {
    expect(auth.mintRefreshToken().token).not.toBe(auth.mintRefreshToken().token);
  });

  test('legacy alias sign === signAccess', () => {
    expect(auth.sign).toBe(auth.signAccess);
  });
});

describe('requireAuth middleware', () => {
  test('401 NO_TOKEN when Authorization header missing', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();
    auth.requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'NO_TOKEN' });
    expect(next).not.toHaveBeenCalled();
  });

  test('401 NO_TOKEN when scheme is not Bearer', () => {
    const req = { headers: { authorization: 'Token abc' } };
    const res = mockRes();
    const next = jest.fn();
    auth.requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('401 INVALID_TOKEN for garbage token', () => {
    const req = { headers: { authorization: 'Bearer not.a.real.token' } };
    const res = mockRes();
    const next = jest.fn();
    auth.requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'INVALID_TOKEN' });
    expect(next).not.toHaveBeenCalled();
  });

  test('401 INVALID_TOKEN for token signed with a different secret', () => {
    const forged = jwt.sign({ id: 'u1', role: 'admin' }, 'attacker-secret');
    const req = { headers: { authorization: 'Bearer ' + forged } };
    const res = mockRes();
    const next = jest.fn();
    auth.requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('sets req.user and calls next() for a valid token', () => {
    const token = auth.signAccess({ id: 'u9', role: 'user' });
    const req = { headers: { authorization: 'Bearer ' + token } };
    const res = mockRes();
    const next = jest.fn();
    auth.requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.id).toBe('u9');
    expect(req.user.role).toBe('user');
  });

  test('expired token is rejected', () => {
    const expired = jwt.sign({ id: 'u1' }, process.env.JWT_SECRET, { expiresIn: '-1s' });
    const req = { headers: { authorization: 'Bearer ' + expired } };
    const res = mockRes();
    const next = jest.fn();
    auth.requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireAdmin middleware', () => {
  test('403 ADMIN_ONLY when no user on request', () => {
    const res = mockRes();
    const next = jest.fn();
    auth.requireAdmin({ user: undefined }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'ADMIN_ONLY' });
    expect(next).not.toHaveBeenCalled();
  });

  test('403 ADMIN_ONLY for non-admin role', () => {
    const res = mockRes();
    const next = jest.fn();
    auth.requireAdmin({ user: { id: 'u1', role: 'user' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() for admin role', () => {
    const res = mockRes();
    const next = jest.fn();
    auth.requireAdmin({ user: { id: 'a1', role: 'admin' } }, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('require-time JWT_SECRET guard', () => {
  test('throws when JWT_SECRET is missing (must run isolated)', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    jest.resetModules();
    expect(() => require('../auth')).toThrow('JWT_SECRET');
    process.env.JWT_SECRET = saved;
    jest.resetModules();
  });
});
