// Jest project for the FRONTEND unit tests (tests/frontend/).
// Runs with plain node env + hand-written stubs (fetch/localStorage/DOM) —
// no jsdom needed, keeps the suite fast.
// The backend suite (jest.config.js, `npm test`) is untouched; its
// roots:['tests'] also picks up tests/frontend, so `npm test` runs everything.
module.exports = {
  testEnvironment: 'node',
  roots: ['tests/frontend'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  testTimeout: 15000,
};
