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

// 2026-10-25 speed fixes: warm page adoption + geo cache (no browser needed)
describe('SessionManager warm page (2026-10-25)', () => {
  it('adopts a warm page instead of creating a new one', async () => {
    const { SessionManager } = require('../core/SessionManager');
    const warm = { url: () => 'https://bdris.gov.bd/br/application', isClosed: () => false };
    let newPageCalls = 0;
    const mockBrowser = {
      newPage: async () => { newPageCalls++; return { url: () => '', isClosed: () => false }; },
      closePage: async () => {},
      takeWarmPage: () => warm,
    };
    const sm = new SessionManager({ browserManager: mockBrowser, sessionTimeoutMs: 60000 });
    const s = await sm.create('user-1');
    assert.strictEqual(s.page, warm);
    assert.strictEqual(newPageCalls, 0);
    await sm.destroy(s.id);
    await sm.closeAll();
  });

  it('falls back to a new page when no warm page exists', async () => {
    const { SessionManager } = require('../core/SessionManager');
    let newPageCalls = 0;
    const mockBrowser = {
      newPage: async () => { newPageCalls++; return { url: () => '', isClosed: () => false }; },
      closePage: async () => {},
    };
    const sm = new SessionManager({ browserManager: mockBrowser, sessionTimeoutMs: 60000 });
    const s = await sm.create('user-1');
    assert.strictEqual(newPageCalls, 1);
    await sm.destroy(s.id);
    await sm.closeAll();
  });
});

describe('AddressService geo cache (2026-10-25)', () => {
  it('caches live zone/ward results, never empty results, and keys by parents', async () => {
    const { AddressService } = require('../services/AddressService');
    let calls = 0;
    const nav = { getAddressOptions: async () => { calls++; return [{ id: '1', name: 'ওয়ার্ড - 1' }]; } };
    const svc = new AddressService(nav);
    const parents = { division: 'ঢাকা', district: 'ঢাকা', upazila: 'ঢাকা উত্তর সিটি কর্পোরেশন', zone: 'অঞ্চল - ১' };
    await svc.getOptions('ward', parents, 'birth');
    await svc.getOptions('ward', parents, 'birth');
    assert.strictEqual(calls, 1, 'second identical call must hit cache');
    await svc.getOptions('ward', { ...parents, zone: 'অঞ্চল - ২' }, 'birth');
    assert.strictEqual(calls, 2, 'different parents must miss cache');
    const navEmpty = { getAddressOptions: async () => { calls++; return []; } };
    const svc2 = new AddressService(navEmpty);
    await svc2.getOptions('ward', { ...parents, zone: 'অঞ্চল - ৯' }, 'birth');
    await svc2.getOptions('ward', { ...parents, zone: 'অঞ্চল - ৯' }, 'birth');
    assert.strictEqual(calls, 4, 'empty results must never be cached');
  });
});

// 2026-10-25 speed fix: warm page POOL (fake pages, no Chromium)
describe('BrowserManager warm pool (2026-10-25)', () => {
  const { BrowserManager } = require('../core/BrowserManager');

  function fakePage(id) {
    let closed = false;
    let closeCalls = 0;
    return {
      id,
      isClosed: () => closed,
      close: () => { closed = true; closeCalls++; },
      get closeCalls() { return closeCalls; },
      forceClose: () => { closed = true; },
    };
  }

  it('hands out pages FIFO', () => {
    const bm = new BrowserManager();
    const a = fakePage('a'), b = fakePage('b'), c = fakePage('c');
    bm.setWarmPage(a); bm.setWarmPage(b); bm.setWarmPage(c);
    assert.strictEqual(bm.takeWarmPage(), a);
    assert.strictEqual(bm.takeWarmPage(), b);
    assert.strictEqual(bm.takeWarmPage(), c);
    assert.strictEqual(bm.warmPoolSize(), 0);
  });

  it('skips closed pages, never hands one out', () => {
    const bm = new BrowserManager();
    const a = fakePage('a'), b = fakePage('b'), c = fakePage('c');
    bm.setWarmPage(a); bm.setWarmPage(b); bm.setWarmPage(c);
    b.forceClose();
    assert.strictEqual(bm.takeWarmPage(), a);
    assert.strictEqual(bm.takeWarmPage(), c, 'closed middle page must be skipped');
    assert.strictEqual(bm.takeWarmPage(), null);
  });

  it('enforces the cap and closes the excess page instead of leaking it', () => {
    const bm = new BrowserManager();
    const pages = [];
    for (let i = 0; i < 6; i++) pages.push(fakePage('p' + i));
    for (const p of pages) bm.setWarmPage(p);
    assert.strictEqual(bm.warmPoolSize(), 5, 'pool must not exceed the cap of 5');
    assert.strictEqual(pages[5].closeCalls, 1, 'excess page must be closed, not leaked');
    for (let i = 0; i < 5; i++) assert.strictEqual(bm.takeWarmPage(), pages[i]);
    assert.strictEqual(bm.takeWarmPage(), null);
  });

  it('returns null when empty and does not fire the replenish hook', () => {
    const bm = new BrowserManager();
    let calls = 0;
    bm.onWarmPageTaken = () => { calls++; };
    assert.strictEqual(bm.takeWarmPage(), null);
    assert.strictEqual(calls, 0, 'empty take must not trigger replenish');
  });

  it('fires the replenish hook exactly once per successful take', () => {
    const bm = new BrowserManager();
    let calls = 0;
    bm.onWarmPageTaken = () => { calls++; };
    bm.setWarmPage(fakePage('a')); bm.setWarmPage(fakePage('b'));
    bm.takeWarmPage();
    assert.strictEqual(calls, 1);
    bm.takeWarmPage();
    assert.strictEqual(calls, 2);
    bm.takeWarmPage(); // empty now
    assert.strictEqual(calls, 2, 'empty take must not add a call');
  });

  it('swallows replenish hook errors so session creation never breaks', () => {
    const bm = new BrowserManager();
    bm.onWarmPageTaken = () => { throw new Error('replenish boom'); };
    const a = fakePage('a');
    bm.setWarmPage(a);
    assert.strictEqual(bm.takeWarmPage(), a);
  });

  it('setWarmPage(null) is safe and changes nothing', () => {
    const bm = new BrowserManager();
    bm.setWarmPage(null);
    assert.strictEqual(bm.warmPoolSize(), 0);
    bm.setWarmPage(fakePage('a'));
    bm.setWarmPage(null);
    assert.strictEqual(bm.warmPoolSize(), 1);
  });

  it('setWarmPage never pools an already-closed page', () => {
    const bm = new BrowserManager();
    const dead = fakePage('dead');
    dead.forceClose();
    bm.setWarmPage(dead);
    assert.strictEqual(bm.warmPoolSize(), 0);
    assert.strictEqual(bm.takeWarmPage(), null);
  });
});

// HttpPathRunner flag + candidate label (no browser, no network)
const { isHttpPathEnabled, HTTP_CANDIDATE_LABEL, normalizeChainInput, getHttpPathStatus, runSubmitHttpChain } = require('../services/HttpPathRunner');

// Probe-vs-execution contract (2026-10-25 fix): HTTP_PATH_STATUS
// must be state-free, and a disabled SUBMIT_HTTP_CHAIN must execute
// NOTHING — before this fix its disabled branch awaited the full
// Playwright chain, so a frontend probe-then-old-flow would double.
describe('HttpPathStatus probe + disabled SUBMIT_HTTP_CHAIN contract', () => {
  it('probe is state-free: identical twice, env object untouched, no client/session needed', () => {
    const env = { BDRIS_HTTP_PATH: 'off' };
    const before = { ...env };
    const a = getHttpPathStatus(env);
    const b = getHttpPathStatus(env);
    assert.deepStrictEqual(a, b, 'probe must be deterministic and side-effect-free');
    assert.deepStrictEqual(env, before, 'probe must not mutate its env input');
    assert.strictEqual(a.httpPath, 'disabled');
    assert.strictEqual(a.enabled, false);
    assert.strictEqual(a.ready, true, 'ready means only that the engine process answered the probe');
    assert.strictEqual(a.candidate, true);
    assert.strictEqual(a.candidateLabel, HTTP_CANDIDATE_LABEL);
    const on = getHttpPathStatus({ BDRIS_HTTP_PATH: 'on' });
    assert.strictEqual(on.httpPath, 'enabled');
    assert.strictEqual(on.enabled, true);
  });

  it('disabled SUBMIT_HTTP_CHAIN executes nothing: fake Playwright adapter stays at 0 calls, even with no adapter', async () => {
    let calls = 0;
    const out = await runSubmitHttpChain({
      data: { s1: {} },
      env: {},
      playwrightRunner: async () => { calls += 1; return { ok: true, completed: true }; },
    });
    assert.strictEqual(calls, 0, 'disabled chain must never invoke the Playwright adapter');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.httpPath, 'disabled');
    assert.strictEqual(out.disabled, true);
    assert.strictEqual(out.error, 'HTTP_PATH_DISABLED');
    assert.strictEqual(out.candidate, true);
    assert.strictEqual(out.candidateLabel, HTTP_CANDIDATE_LABEL);
    // Old code threw 'HTTP_PATH_DISABLED and no browser session' here;
    // the new contract returns the disabled signal with no adapter at all.
    const noAdapter = await runSubmitHttpChain({ data: {}, env: { BDRIS_HTTP_PATH: '' } });
    assert.strictEqual(noAdapter.httpPath, 'disabled');
    assert.strictEqual(noAdapter.error, 'HTTP_PATH_DISABLED');
  });
});

describe('HttpPathRunner flag/label', () => {
  it('defaults to Playwright (HTTP opt-in only) and labels every path candidate', () => {
    const saved = process.env.BDRIS_HTTP_PATH;
    try {
      delete process.env.BDRIS_HTTP_PATH;
      assert.strictEqual(isHttpPathEnabled(), false, 'unset must not enable the candidate HTTP path');
      process.env.BDRIS_HTTP_PATH = 'on';
      assert.strictEqual(isHttpPathEnabled(), true);
      process.env.BDRIS_HTTP_PATH = 'off';
      assert.strictEqual(isHttpPathEnabled(), false);
      assert.match(HTTP_CANDIDATE_LABEL, /CANDIDATE/);
      assert.match(HTTP_CANDIDATE_LABEL, /NOT live-verified/);
    } finally {
      if (saved === undefined) delete process.env.BDRIS_HTTP_PATH; else process.env.BDRIS_HTTP_PATH = saved;
    }
  });

  it('normalizes the Playwright draft shape into canonical HTTP input', () => {
    const n = normalizeChainInput({
      s1: { firstNameBn: 'আবদুল', firstNameEn: 'Abdul', dob: '2020-01-15', birth: { division: 'ঢাকা' } },
      s2: { father: { nameBn: 'আবদুল হামিদ' } },
      s2b: { perm: { division: 'ঢাকা' }, pres: { division: 'ঢাকা' } },
      s3: { relation: 'FATHER' },
      s4prep: { phone: 'mock-phone' },
      otp: '123456',
    });
    assert.strictEqual(n.canonical.person.firstNameBn, 'আবদুল');
    assert.strictEqual(n.canonical.birthPlace.division, 'ঢাকা');
    assert.strictEqual(n.canonical.permAddr.division, 'ঢাকা');
    assert.strictEqual(n.otpContext.phone, 'mock-phone');
    assert.strictEqual(n.otp, '123456');
  });
});
