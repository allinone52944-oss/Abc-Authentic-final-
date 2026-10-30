/**
 * GRACEFUL SHUTDOWN (#13 service timeout loop, 2026-10-30) — unit tests.
 *
 * Proven live cause: systemd STOP timeouts (TimeoutStopSec was 5s)
 * SIGKILLed the cgroup because shutdown never finished — v2's
 * server.close() waited on live socket.io connections forever, and
 * session/browser closes had no bound; backend had no signal
 * handler at all. These tests prove the bounded machinery with no
 * browser and no live contact (spawned children are local `node -e`
 * sleepers only; fixture values only).
 *
 * Run: node --test engines/bdris-apply/v2/tests/shutdown.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { describe, it } = require('node:test');

const {
  withTimeout,
  createShutdown,
  closeServer,
  killChildWithGrace,
} = require('../core/Shutdown');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Shutdown.withTimeout', () => {
  it('resolves ok for a fast value', async () => {
    const r = await withTimeout(Promise.resolve(42), 1000, 'fast', () => {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value, 42);
  });

  it('resolves timedOut for a hanging promise', async () => {
    const r = await withTimeout(new Promise(() => {}), 100, 'hang', () => {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.timedOut, true);
  });

  it('resolves ok:false with the error on rejection, never rejects', async () => {
    const r = await withTimeout(Promise.reject(new Error('boom')), 1000, 'rej', () => {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.message, 'boom');
  });
});

describe('Shutdown.createShutdown', () => {
  it('runs steps in order and exits exactly once', async () => {
    const order = [];
    let exits = 0;
    const s = createShutdown({
      hardTimeoutMs: 5000,
      exitFn: () => { exits += 1; },
      logFn: () => {},
      steps: [
        { name: 'a', timeoutMs: 1000, fn: async () => { order.push('a'); } },
        { name: 'b', timeoutMs: 1000, fn: async () => { order.push('b'); } },
      ],
    });
    await s.run();
    assert.deepStrictEqual(order, ['a', 'b']);
    assert.strictEqual(exits, 1);
  });

  it('a timed-out step does not block later steps', async () => {
    const order = [];
    let exits = 0;
    const s = createShutdown({
      hardTimeoutMs: 5000,
      exitFn: () => { exits += 1; },
      logFn: () => {},
      steps: [
        { name: 'hang', timeoutMs: 100, fn: () => new Promise(() => {}) },
        { name: 'after', timeoutMs: 1000, fn: async () => { order.push('after'); } },
      ],
    });
    await s.run();
    assert.deepStrictEqual(order, ['after']);
    assert.strictEqual(exits, 1);
  });

  it('a second run() is a no-op (single exit)', async () => {
    let exits = 0;
    const s = createShutdown({
      hardTimeoutMs: 5000,
      exitFn: () => { exits += 1; },
      logFn: () => {},
      steps: [{ name: 'a', timeoutMs: 1000, fn: async () => {} }],
    });
    await Promise.all([s.run(), s.run()]);
    assert.strictEqual(exits, 1);
  });

  it('hard timer forces exit even when a step never settles', async () => {
    const start = Date.now();
    let exitAt = 0;
    const s = createShutdown({
      hardTimeoutMs: 200,
      exitFn: () => { exitAt = Date.now(); },
      logFn: () => {},
      steps: [{ name: 'forever', timeoutMs: 2000, fn: () => new Promise(() => {}) }],
    });
    const runP = s.run();
    // Exit must come from the hard timer (~200ms), long before the
    // 2s step timeout. Poll briefly instead of awaiting run().
    for (let i = 0; i < 50 && exitAt === 0; i++) await sleep(20);
    assert.ok(exitAt > 0, 'hard timer should have fired');
    assert.ok(exitAt - start < 1500, 'exit must precede the step timeout');
    // Let the step timeout finish so the test process can drain.
    await runP;
  });
});

describe('Shutdown.killChildWithGrace', () => {
  // NOTE: a freshly spawned child has NOT installed its signal
  // handlers yet (node startup takes ~tens of ms) — a SIGTERM sent
  // immediately kills it by default action. Tests therefore wait for
  // a 'ready' line on stdout before signalling, so the SIGKILL path
  // is genuinely exercised instead of the startup race.
  const spawnReadySleeper = (trap) => {
    const script = trap
      ? "process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => {}, 60000)"
      : "console.log('ready'); setTimeout(() => {}, 60000)";
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    const ready = new Promise((resolve) => {
      child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
    });
    return { child, ready };
  };

  it('a child that dies on SIGTERM needs no SIGKILL', async () => {
    const { child, ready } = spawnReadySleeper(false);
    await ready;
    const r = await killChildWithGrace(child, { termTimeoutMs: 4000, killTimeoutMs: 1000 });
    assert.strictEqual(r.exited, true);
    assert.strictEqual(r.killed, false);
  });

  it('a child that ignores SIGTERM gets SIGKILLed', async () => {
    const { child, ready } = spawnReadySleeper(true);
    await ready;
    const r = await killChildWithGrace(child, { termTimeoutMs: 300, killTimeoutMs: 2000 });
    assert.strictEqual(r.killed, true);
    assert.strictEqual(r.exited, true);
  });

  it('null and already-exited children resolve immediately', async () => {
    const r0 = await killChildWithGrace(null, {});
    assert.strictEqual(r0.exited, true);
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((r) => child.once('exit', r));
    const r1 = await killChildWithGrace(child, {});
    assert.strictEqual(r1.exited, true);
    assert.strictEqual(r1.killed, false);
  });
});

describe('Shutdown.closeServer', () => {
  it('closes a server with a held-open keep-alive connection promptly', async () => {
    const server = http.createServer((req, res) => { res.end('ok'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    if (typeof server.closeAllConnections !== 'function') {
      server.close();
      console.log('SKIP: closeAllConnections unavailable on this Node');
      return;
    }
    // Hold one keep-alive connection open, as a socket.io client would.
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
    await sleep(200);
    const t0 = Date.now();
    const ok = await closeServer(server, null, 3000, () => {});
    assert.strictEqual(ok, true);
    assert.ok(Date.now() - t0 < 3000, 'close must not wait for the held socket');
    try { sock.destroy(); } catch (e) {}
  });
});

describe('Shutdown wiring (source-pattern guards)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  it('v2/server.js shutdown is bounded and closes socket.io', () => {
    const src = read('../server.js');
    assert.ok(src.includes('createShutdown'), 'v2 server must use the bounded shutdown controller');
    assert.ok(src.includes('closeServer(server, io'), 'v2 shutdown must close socket.io + http together');
    assert.ok(!src.includes('server.close(() => process.exit(0))'), 'unbounded server.close exit must be gone');
  });

  it('backend/server.js handles SIGTERM and stops engine adapters', () => {
    const src = read('../../../../backend/server.js');
    assert.ok(src.includes("process.on('SIGTERM', onBackendSignal)"), 'backend must handle SIGTERM');
    assert.ok(src.includes('bdrisApplyAdapter.stop'), 'backend shutdown must stop the bdris-apply child');
    assert.ok(src.includes('deathEngine.stop'), 'backend shutdown must stop the death child');
  });

  it('both engine adapters export stop()', () => {
    const bdrisAdapter = require('../../index.js');
    assert.strictEqual(typeof bdrisAdapter.stop, 'function');
    const deathAdapter = require('../../../death-final/index.js');
    assert.strictEqual(typeof deathAdapter.stop, 'function');
  });
});
