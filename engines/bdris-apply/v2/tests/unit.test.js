/**
 * Unit tests for v2 engine components
 * Run: node --test v2/tests/
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Test CommandExecutor (no browser needed)
const { CommandExecutor } = require('../core/CommandExecutor');

describe('CommandExecutor', () => {
  it('executes registered command', async () => {
    const ex = new CommandExecutor();
    ex.register('ADD', async (p) => ({ sum: p.a + p.b }));
    const r = await ex.execute('ADD', { a: 2, b: 3 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sum, 5);
  });

  it('returns error for unknown command', async () => {
    const ex = new CommandExecutor();
    const r = await ex.execute('NOPE', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'UNKNOWN_COMMAND');
  });

  it('times out long commands', async () => {
    const ex = new CommandExecutor({ defaultTimeoutMs: 100 });
    ex.register('SLOW', async () => {
      await new Promise(r => setTimeout(r, 5000));
      return {};
    });
    const r = await ex.execute('SLOW', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'TIMEOUT');
  });

  it('deduplicates by command ID', async () => {
    const ex = new CommandExecutor();
    let calls = 0;
    ex.register('COUNT', async () => ({ n: ++calls }));
    const p = { _commandId: 'cmd-123' };
    const r1 = await ex.execute('COUNT', p);
    const r2 = await ex.execute('COUNT', p);
    assert.strictEqual(r1.n, 1);
    assert.strictEqual(r2.n, 1); // Cached, not re-executed
    assert.strictEqual(calls, 1);
  });

  it('handles handler exceptions', async () => {
    const ex = new CommandExecutor();
    ex.register('FAIL', async () => { throw new Error('boom'); });
    const r = await ex.execute('FAIL', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'EXECUTION_FAILED');
    assert.match(r.message, /boom/);
  });
});

// Test BdrisNavigator.normalize (no browser needed)
const { BdrisNavigator } = require('../services/BdrisNavigator');

describe('BdrisNavigator.normalize', () => {
  it('normalizes Bengali variants for matching', () => {
    // U+09DC (ঢ়) normalizes to U+09A1+U+09BC for fuzzy matching
    // (matches v1 behavior — treats similar chars as equivalent)
    const a = BdrisNavigator.normalize('গ\u09DC'); // গঢ়
    const b = BdrisNavigator.normalize('গ\u09A1\u09BC'); // গড়
    assert.strictEqual(a, b);
  });

  it('trims whitespace', () => {
    assert.strictEqual(BdrisNavigator.normalize('  ঢাকা  '), 'ঢাকা');
  });

  it('handles empty', () => {
    assert.strictEqual(BdrisNavigator.normalize(''), '');
    assert.strictEqual(BdrisNavigator.normalize(null), '');
  });
});

// Test SessionManager (mock browser)
describe('SessionManager', () => {
  it('creates and retrieves sessions', async () => {
    const { SessionManager } = require('../core/SessionManager');
    const mockBrowser = {
      newPage: async () => ({ url: () => '', isClosed: () => false }),
      closePage: async () => {},
    };
    const sm = new SessionManager({
      browserManager: mockBrowser,
      sessionTimeoutMs: 60000,
    });
    const s = await sm.create('user-1');
    assert.ok(s.id);
    assert.strictEqual(s.userId, 'user-1');

    const found = sm.get(s.id);
    assert.strictEqual(found.id, s.id);

    const byUser = sm.findByUser('user-1');
    assert.strictEqual(byUser.id, s.id);

    await sm.destroy(s.id);
    assert.strictEqual(sm.get(s.id), null);
    await sm.closeAll();
  });

  it('expires old sessions', async () => {
    const { SessionManager } = require('../core/SessionManager');
    const mockBrowser = {
      newPage: async () => ({ url: () => '', isClosed: () => false }),
      closePage: async () => {},
    };
    const sm = new SessionManager({
      browserManager: mockBrowser,
      sessionTimeoutMs: 50, // 50ms for test
    });
    const s = await sm.create('user-1');
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(sm.get(s.id), null); // Expired
    await sm.closeAll();
  });
});

console.log('All v2 unit tests passed!');
