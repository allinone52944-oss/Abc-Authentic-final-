// FIX-3 regression: findValidToken(table) in routes/auth.js must only ever
// query an allowlisted table name — never interpolate caller input into SQL.
// The function is module-private (only the router is exported), so this
// test loads the REAL function body from source and binds it to a mocked db.
// hashLinkToken is re-implemented from the source formula
// (sha256 hex of String(token)) — verified against routes/auth.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUTH_PATH = path.join(__dirname, '../../routes/auth.js');

function loadRealFindValidToken(mockDb) {
  const src = fs.readFileSync(AUTH_PATH, 'utf8');
  const marker = 'async function findValidToken(table, token) {';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('findValidToken not found in routes/auth.js — fix regressed?');
  // brace-scan to the matching close (template-literal ${...} pairs are balanced)
  let i = src.indexOf('{', start);
  let depth = 0;
  let end = i;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error('could not extract findValidToken body');
  const fnSrc = src.slice(start, end + 1);
  const hashLinkToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  const factory = new Function('db', 'hashLinkToken', 'crypto', `return (${fnSrc});`);
  return { findValidToken: factory(mockDb, hashLinkToken, crypto), hashLinkToken };
}

describe('FIX-3 findValidToken table allowlist (real function from source)', () => {
  let mockDb;
  let findValidToken;
  let hashLinkToken;

  beforeEach(() => {
    mockDb = { query: jest.fn(async () => ({ rows: [] })) };
    ({ findValidToken, hashLinkToken } = loadRealFindValidToken(mockDb));
  });

  test.each(['users', 'email_verification_tokens; DROP TABLE users--', '', ' ', 'EMAIL_VERIFICATION_TOKENS', 'password_reset_tokens ', 'invite_links'])(
    'non-allowlisted table %p → throws Invalid token table',
    async (table) => {
      await expect(findValidToken(table, 'sometoken')).rejects.toThrow('Invalid token table');
      expect(mockDb.query).not.toHaveBeenCalled();
    }
  );

  test.each(['email_verification_tokens', 'password_reset_tokens'])(
    'allowlisted table %p → queries with literal table name, hash as $1 param',
    async (table) => {
      const token = 'abc123token';
      const expectedHash = hashLinkToken(token);
      mockDb.query.mockResolvedValue({ rows: [] });
      await expect(findValidToken(table, token)).resolves.toBeNull();
      const [sql, params] = mockDb.query.mock.calls[0];
      expect(sql).toContain(`FROM ${table}`); // literal, from the allowlist
      expect(sql).not.toContain(token); // presented token never interpolated
      expect(params[0]).toBe(expectedHash); // only the hash travels as a param
    }
  );

  test('returns the row when the stored hash matches (timing-safe)', async () => {
    const token = 'valid-token';
    const row = { id: 7, token_hash: hashLinkToken(token) };
    mockDb.query.mockResolvedValue({ rows: [row] });
    await expect(findValidToken('email_verification_tokens', token)).resolves.toBe(row);
  });

  test('row with non-matching hash → null (no bypass)', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ id: 7, token_hash: '0'.repeat(64) }] });
    await expect(findValidToken('email_verification_tokens', 'valid-token')).resolves.toBeNull();
  });
});
