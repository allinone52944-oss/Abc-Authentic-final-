// Jest configuration for the backend unit test suite.
// DB is mocked everywhere (see tests/helpers/mockDb.js) —
// the real database is NEVER touched by these tests.
module.exports = {
  testEnvironment: 'node',
  roots: ['tests'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  testTimeout: 15000,
};
