// FIX-9 regression: migrate.js wraps the base schema in a transaction.
// pg is mocked; the REAL migrate.js main() runs at require-time against the
// mock client. Happy path → BEGIN ... COMMIT; schema failure → ROLLBACK +
// process.exit(1). Also includes the schema-text guards for FIX-10 (users
// status CHECK includes 'pending') and FIX-16 (composite index).
jest.mock('pg', () => {
  const state = { statements: [], failSchema: false };
  const client = {
    query: jest.fn(async (text) => {
      const t = String(text);
      state.statements.push(t);
      // simulate a broken base schema (big CREATE TABLE users statement)
      if (state.failSchema && /CREATE TABLE/i.test(t) && /users/.test(t)) {
        throw new Error('schema boom');
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn(async () => client),
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    on: jest.fn(),
    end: jest.fn(async () => {}),
  };
  return { Pool: jest.fn(() => pool), __mock: { state, client, pool } };
});

const fs = require('fs');
const path = require('path');

async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('FIX-9 migrate.js base-schema transaction (real migrate.js, mocked pg)', () => {
  let exitSpy;
  let mock;

  beforeEach(() => {
    jest.resetModules();
    mock = require('pg').__mock;
    mock.state.statements = [];
    mock.state.failSchema = false;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  });
  afterEach(() => {
    exitSpy.mockRestore();
    jest.resetModules();
  });

  test('base schema applied inside BEGIN/COMMIT, no ROLLBACK', async () => {
    require('../../migrate'); // main() runs at require-time
    await waitFor(() => mock.state.statements.filter((s) => s === 'COMMIT').length >= 1);
    const stmts = mock.state.statements;
    const schemaIdx = stmts.findIndex((s) => /idx_tx_user_type_status/.test(s));
    expect(schemaIdx).toBeGreaterThan(-1); // the real schema.sql was sent
    expect(stmts.slice(0, schemaIdx)).toContain('BEGIN');
    expect(stmts.slice(schemaIdx)).toContain('COMMIT');
    expect(stmts).not.toContain('ROLLBACK');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('schema failure → ROLLBACK, no COMMIT, process.exit(1)', async () => {
    mock.state.failSchema = true;
    require('../../migrate');
    await waitFor(() => mock.state.statements.includes('ROLLBACK'));
    const stmts = mock.state.statements;
    expect(stmts).toContain('BEGIN');
    expect(stmts).toContain('ROLLBACK');
    expect(stmts).not.toContain('COMMIT');
    await waitFor(() => exitSpy.mock.calls.length > 0);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('schema text guards', () => {
  const schema = fs.readFileSync(
    path.join(__dirname, '../../../database/schema.sql'), 'utf8'
  );

  test("FIX-10: users.status CHECK includes 'pending'", () => {
    const usersBlock = schema.match(/CREATE TABLE[^(]*users[\s\S]*?;/i);
    expect(usersBlock).toBeTruthy();
    expect(usersBlock[0]).toMatch(/CHECK\s*\(\s*status\s+IN\s*\([^)]*'pending'[^)]*\)/);
  });

  test('FIX-16: composite index idx_tx_user_type_status exists', () => {
    expect(schema).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_tx_user_type_status ON transactions\(user_id,\s*type,\s*status\)/
    );
  });

  test('2026-10-15: orders.idempotency_key backfill precedes its unique index', () => {
    // Production DBs created before M-2/M-15 lack the column; CREATE TABLE IF
    // NOT EXISTS is a no-op there, so the index build failed with
    // 'column "idempotency_key" does not exist' and wedged deploys.
    const alterIdx = schema.search(
      /ALTER TABLE orders\s+ADD COLUMN IF NOT EXISTS idempotency_key/i
    );
    const indexIdx = schema.search(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_idem/i
    );
    expect(alterIdx).toBeGreaterThan(-1);
    expect(indexIdx).toBeGreaterThan(-1);
    expect(alterIdx).toBeLessThan(indexIdx);
  });
});
