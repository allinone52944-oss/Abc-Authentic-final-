// FIX-2 regression: backend/auth.js must REFUSE to start without JWT_SECRET.
// The old 'dev-secret-change-me' fallback was removed; require-time throw
// is the guard. This file intentionally does NOT mock ../../db (auth.js
// needs none) and resets the module registry so each test gets a fresh
// require of auth.js.
describe('FIX-2 auth.js requires JWT_SECRET at require-time', () => {
  const SAVED = process.env.JWT_SECRET;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.JWT_SECRET;
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = SAVED;
    jest.resetModules();
  });

  test('missing JWT_SECRET → throws FATAL at require-time', () => {
    expect(() => require('../../auth')).toThrow(/JWT_SECRET/);
  });

  test('empty-string JWT_SECRET → also throws', () => {
    process.env.JWT_SECRET = '';
    expect(() => require('../../auth')).toThrow(/JWT_SECRET/);
  });

  test('JWT_SECRET set → require succeeds and tokens sign with it', () => {
    process.env.JWT_SECRET = 'only-for-this-test';
    let auth;
    expect(() => { auth = require('../../auth'); }).not.toThrow();
    const t = auth.signAccess({ id: 'u1', role: 'user' });
    expect(typeof t).toBe('string');
    expect(t.split('.')).toHaveLength(3);
  });
});
