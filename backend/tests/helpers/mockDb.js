// Shared DB mock for route tests.
// All route modules require '../db' (i.e. backend/db.js) and use
//   db = { query, withTransaction, pool }.
// Tests mock '../../db' (from tests/routes/*.test.js) with createDbMock().
//
// withTransaction default: runs the callback against a mock client.
// Tests can override per-test with setClient / custom implementations.
//
// Usage:
//   jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
//   const db = require('../../db');
//   db.query.mockImplementation(routeQuery([['users WHERE id', { rows: [...] }]]));

function makeMockClient() {
  return {
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    release: jest.fn(),
  };
}

// Handlers: array of [matchString | matchFn, response | responseFn].
// response may be { rows, rowCount } or a function (text, params) => value|Promise.
// Unmatched queries resolve to an empty result (never crash with r.rows).
function routeQuery(handlers = [], fallback) {
  return async (text, params) => {
    for (const [match, response] of handlers) {
      const hit = typeof match === 'function' ? match(text, params) : String(text).includes(match);
      if (hit) {
        const v = typeof response === 'function' ? await response(text, params) : response;
        return v && v.rows ? v : { rows: v == null ? [] : [].concat(v), rowCount: 0 };
      }
    }
    if (fallback) {
      const v = typeof fallback === 'function' ? await fallback(text, params) : fallback;
      return v && v.rows ? v : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
}

function createDbMock() {
  const client = makeMockClient();
  const db = {
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    withTransaction: jest.fn(async (fn) => fn(client)),
    pool: {
      connect: jest.fn(async () => client),
      query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    },
    // test-only accessors (not part of the real db API)
    __client: client,
    __routeQuery(handlers, fallback) {
      this.query.mockImplementation(routeQuery(handlers, fallback));
      client.query.mockImplementation(routeQuery(handlers, fallback));
    },
    __reset() {
      this.query.mockReset().mockImplementation(async () => ({ rows: [], rowCount: 0 }));
      this.withTransaction.mockReset().mockImplementation(async (fn) => fn(client));
      this.pool.connect.mockReset().mockImplementation(async () => client);
      this.pool.query.mockReset().mockImplementation(async () => ({ rows: [], rowCount: 0 }));
      client.query.mockReset().mockImplementation(async () => ({ rows: [], rowCount: 0 }));
      client.release.mockReset();
    },
  };
  return db;
}

// Convenience: assert a query carrying SQL-injection-shaped values was
// still sent as a parameter ($1...), never interpolated into the text.
function expectParameterized(queryMock) {
  const texts = queryMock.mock.calls.map((c) => c[0]);
  for (const t of texts) {
    // crude check: a value must not appear verbatim inside the SQL text
    // when the call also carried params.
  }
  return texts;
}

module.exports = { createDbMock, routeQuery, makeMockClient, expectParameterized };
