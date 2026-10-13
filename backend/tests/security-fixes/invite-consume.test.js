// FIX-6 regression: consumeInvite returns success ONLY when the conditional
// UPDATE actually touched a row (active, unexpired, under max_uses).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const db = require('../../db');
const { consumeInvite } = require('../../routes/invites');

beforeEach(() => { db.__reset(); });

describe('FIX-6 consumeInvite rowCount gate', () => {
  test('UPDATE touched 1 row → true', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(consumeInvite('INV-ABCDEF12')).resolves.toBe(true);
  });

  test('UPDATE touched 0 rows (inactive/expired/maxed) → false', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(consumeInvite('INV-ABCDEF12')).resolves.toBe(false);
  });

  test('UPDATE is conditional: active, unexpired, under max_uses', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    await consumeInvite('inv-abcdef12');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE invite_links SET used_count = used_count \+ 1/);
    expect(sql).toMatch(/is_active = TRUE/);
    expect(sql).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/);
    expect(sql).toMatch(/max_uses IS NULL OR used_count < max_uses/);
    expect(params[0]).toBe('INV-ABCDEF12'); // code normalized to upper case
  });
});
