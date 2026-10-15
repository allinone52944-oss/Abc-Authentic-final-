// Loaded before every test file (setupFiles).
// auth.js throws at require-time when JWT_SECRET is missing,
// so it must be set here — no source file is modified for tests.
process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests-only';
// L-6: db.js fails fast without DATABASE_URL; tests use a dummy (pg Pool is
// mocked in tests that touch the real db module, others mock ../../db itself).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';


// Silence noisy logging during tests (safeLog, pool errors, engines).
// Individual tests may re-spy console.log when they need to assert on it.
if (!process.env.KEEP_TEST_LOGS) {
  const noop = () => {};
  console.log = noop;
  console.error = noop;
  console.warn = noop;
}
