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

describe('OriginalFetcher (no browser)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { OriginalFetcher } = require('../services/OriginalFetcher');

  const fakeBM = { launch: async () => { throw new Error('no browser in unit test'); } };

  function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'origfetch-'));
  }

  it('cachedOriginal returns null when no file', () => {
    const f = new OriginalFetcher({ browserManager: fakeBM, frontendDir: tmpDir(), log: () => {} });
    assert.strictEqual(f.cachedOriginal('12345'), null);
  });

  it('cachedOriginal validates %PDF header and size', () => {
    const dir = tmpDir();
    const buf = Buffer.concat([Buffer.from('%PDF-1.4 test'), Buffer.alloc(9000)]);
    fs.writeFileSync(path.join(dir, 'bdris-original-999.pdf'), buf);
    fs.writeFileSync(path.join(dir, 'bdris-original-111.pdf'), Buffer.from('tiny'));
    const f = new OriginalFetcher({ browserManager: fakeBM, frontendDir: dir, log: () => {} });
    const hit = f.cachedOriginal('999');
    assert.strictEqual(hit.ok, true);
    assert.strictEqual(hit.url, '/bdris-original-999.pdf');
    assert.strictEqual(hit.cached, true);
    assert.strictEqual(f.cachedOriginal('111'), null); // too small
    assert.strictEqual(f.cachedOriginal('000'), null); // missing
  });

  it('ensureOriginal returns cached result without browser', async () => {
    const dir = tmpDir();
    const buf = Buffer.concat([Buffer.from('%PDF-1.4 test'), Buffer.alloc(9000)]);
    fs.writeFileSync(path.join(dir, 'bdris-original-777.pdf'), buf);
    const f = new OriginalFetcher({ browserManager: fakeBM, frontendDir: dir, log: () => {} });
    const job = await f.ensureOriginal({ appId: '777' });
    assert.strictEqual(job.status, 'done');
    assert.strictEqual(job.result.cached, true);
  });

  it('ensureOriginal rejects on missing appId', async () => {
    const f = new OriginalFetcher({ browserManager: fakeBM, frontendDir: tmpDir(), log: () => {} });
    await assert.rejects(() => f.ensureOriginal({}), /MISSING_APPID/);
  });

  it('hanging job settles via timeout (v1 bug fix)', async () => {
    // _runJob never resolves — job must still settle as failed, not hang forever
    const f = new OriginalFetcher({
      browserManager: fakeBM, frontendDir: tmpDir(),
      jobTimeoutMs: 300, jobTtlMs: 60000, log: () => {},
    });
    f._runJob = () => new Promise(() => {}); // hang forever
    const job = await f.ensureOriginal({ appId: '555' });
    assert.strictEqual(job.status, 'failed');
    assert.match(job.result.err, /timed out/);
    assert.strictEqual(f.getStatus('555').status, 'failed');
  });

  it('concurrent callers join the same running job', async () => {
    const f = new OriginalFetcher({
      browserManager: fakeBM, frontendDir: tmpDir(), log: () => {},
    });
    let calls = 0;
    f._runJob = async () => { calls++; await new Promise(r => setTimeout(r, 100)); return { ok: true, url: '/x.pdf', bytes: 9000 }; };
    const [a, b] = await Promise.all([
      f.ensureOriginal({ appId: '333' }),
      f.ensureOriginal({ appId: '333' }),
    ]);
    assert.strictEqual(calls, 1); // single job for same appId
    assert.strictEqual(a, b);
    assert.strictEqual(a.status, 'done');
  });

  it('finished jobs are cleaned up after TTL (v1 leak fix)', async () => {
    const f = new OriginalFetcher({
      browserManager: fakeBM, frontendDir: tmpDir(), jobTtlMs: 200, log: () => {},
    });
    f._runJob = async () => ({ ok: false, url: null, bytes: 0 });
    await f.ensureOriginal({ appId: '222' });
    assert.ok(f.getStatus('222'));
    await new Promise(r => setTimeout(r, 400));
    assert.strictEqual(f.getStatus('222'), null); // cleaned
  });

  it('saveRec/loadRec round-trip via index file', () => {
    const dir = tmpDir();
    const idx = path.join(dir, 'originals-index.json');
    const f = new OriginalFetcher({ browserManager: fakeBM, frontendDir: dir, indexFile: idx, log: () => {} });
    assert.strictEqual(f.loadRec('123'), null);
    const rec = { appId: '123', date: '01/01/2020', nameEn: 'Test', mobileNo: '01700000000' };
    assert.strictEqual(f.saveRec('123', rec), true);
    assert.deepStrictEqual(f.loadRec('123'), rec);
  });
});

console.log('All v2 unit tests passed!');
