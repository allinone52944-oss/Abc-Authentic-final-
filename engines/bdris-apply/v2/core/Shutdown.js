'use strict';
/**
 * Graceful-shutdown helper — problem-map #13 (service timeout loop).
 *
 * Proven cause (live journal 2026-10-29 20:19:25 + 20:40:59 UTC): both
 * timeouts were STOP timeouts, not watchdog (WatchdogUSec=0,
 * Type=simple) and not OOM (kernel journal clean). The unit had
 * TimeoutStopSec=5s; a stop was requested, SIGTERM went to the whole
 * cgroup, processes did not exit within 5s ("State 'final-sigterm'
 * timed out"), systemd SIGKILLed 10 node processes (engines +
 * Playwright chromium), and Restart=always brought the service back
 * 5s later — wiping engine process memory mid-filing.
 *
 * Why shutdown never finished in 5s (code-read, not guessed):
 * - v2/server.js shutdown did `server.close(() => exit)` WITHOUT ever
 *   closing socket.io: server.close() only calls back once every open
 *   connection ends, and live socket.io clients keep it open forever.
 * - session/browser closes awaited stuck pages with no bound at all.
 * - backend/server.js (the systemd main process) had NO signal
 *   handler: default SIGTERM killed it instantly while its adapter
 *   children were left to the cgroup signal, and the bdris-apply
 *   adapter's exit handler would scheduleRestart() a dying engine.
 *
 * This helper bounds every step and guarantees a hard exit, so a
 * shutdown can never hang past the budget again. The live unit now
 * has TimeoutStopSec=30s (user-applied 2026-10-30, takes effect on
 * the next stop); the hard cap here is 20s, well inside it, and the
 * typical path (io.close + bounded closes) completes in ~1-2s.
 *
 * No filing, name, cinno, single-name, charge, or QR logic lives
 * here — only process-lifecycle plumbing. Unit-testable with no
 * browser and no live contact.
 */

const DEFAULT_STEP_TIMEOUT_MS = 8000;
const DEFAULT_HARD_TIMEOUT_MS = 20000;

/**
 * Race a promise against a timeout. Never rejects: resolves
 * { ok: true, value } on success, { ok: false, timedOut: true } on
 * timeout, { ok: false, error } on rejection. A timed-out step's late
 * settlement is swallowed (its promise keeps running detached, but
 * the shutdown sequence moves on — exactly what a stop budget needs).
 */
function withTimeout(promise, ms, label, logFn) {
  return new Promise((resolve) => {
    let settled = false;
    // Deliberately NOT unref'd: if the step hangs and nothing else
    // keeps the loop alive, an unref'd timer would never fire and
    // the shutdown itself would hang — the exact failure being fixed.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (typeof logFn === 'function') logFn(`shutdown step '${label}' timed out after ${ms}ms, continuing`);
      resolve({ ok: false, timedOut: true });
    }, ms);
    Promise.resolve(promise).then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: true, value }); } },
      (error) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error }); } },
    );
  });
}

/**
 * Sequential shutdown controller. steps: [{ name, fn, timeoutMs }].
 * - Idempotent: a second run() returns the same promise; a second
 *   signal while shutting down is a no-op (the caller may force-exit
 *   separately if it must).
 * - A failed/timed-out step is logged and skipped — later steps
 *   (notably the browser close) still run.
 * - A hard timer guarantees exitFn(0) even if every step hangs.
 * - exitFn defaults to process.exit; tests inject a recorder.
 */
function createShutdown({ steps = [], hardTimeoutMs = DEFAULT_HARD_TIMEOUT_MS, exitFn, logFn } = {}) {
  const log = typeof logFn === 'function' ? logFn : () => {};
  const exit = typeof exitFn === 'function' ? exitFn : (code) => process.exit(code);
  let runPromise = null;
  let exited = false;
  const doExit = () => {
    if (exited) return;
    exited = true;
    try { exit(0); } catch (e) { log(`shutdown exit failed: ${e && e.message}`); }
  };
  return {
    run() {
      if (runPromise) return runPromise;
      runPromise = (async () => {
        const hard = setTimeout(() => {
          log(`shutdown hard timeout after ${hardTimeoutMs}ms, forcing exit`);
          doExit();
        }, hardTimeoutMs);
        // The hard timer must fire even if the event loop is otherwise
        // idle — do NOT unref it.
        try {
          for (const step of steps) {
            const ms = step.timeoutMs || DEFAULT_STEP_TIMEOUT_MS;
            try {
              const r = await withTimeout(Promise.resolve().then(() => step.fn()), ms, step.name, log);
              if (!r.ok && !r.timedOut && r.error) log(`shutdown step '${step.name}' failed: ${r.error && r.error.message}`);
              else log(`shutdown step '${step.name}' done${r.timedOut ? ' (timed out)' : ''}`);
            } catch (e) {
              log(`shutdown step '${step.name}' threw: ${e && e.message}`);
            }
          }
        } finally {
          clearTimeout(hard);
          doExit();
        }
        return { exited: true };
      })();
      return runPromise;
    },
  };
}

/**
 * Close an HTTP server that may have live keep-alive / socket.io
 * connections. Plain server.close() waits for every connection to
 * end — with a connected socket.io client that is forever. So:
 * io.close() first (disconnects socket.io clients), then
 * closeAllConnections() where available (Node >= 18.2), then
 * server.close(). Resolves true when closed, false on timeout.
 */
function closeServer(server, io, timeoutMs, logFn) {
  const log = typeof logFn === 'function' ? logFn : () => {};
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; log('http server close timed out, forcing connection destroy'); try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (e) {} resolve(false); }
    }, timeoutMs);
    const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    try {
      if (io && typeof io.close === 'function') {
        try { io.close(); } catch (e) { log(`socket.io close failed: ${e && e.message}`); }
      }
      try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (e) {}
      server.close(() => finish(true));
    } catch (e) {
      log(`http server close failed: ${e && e.message}`);
      finish(false);
    }
  });
}

/**
 * Terminate a spawned child process gracefully: SIGTERM, wait up to
 * termTimeoutMs for its 'exit' event, then SIGKILL and wait briefly
 * for exit. Resolves { signaled, killed, exited }. Never rejects;
 * a null/already-exited child resolves immediately. Used by the
 * engine adapters' stop() so a supervisor cannot resurrect an
 * engine while systemd is stopping the cgroup.
 */
function killChildWithGrace(proc, { termTimeoutMs = 4000, killTimeoutMs = 2000, logFn } = {}) {
  const log = typeof logFn === 'function' ? logFn : () => {};
  if (!proc) return Promise.resolve({ signaled: false, killed: false, exited: true });
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve({ signaled: false, killed: false, exited: true });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const onExit = () => finish({ signaled: true, killed: false, exited: true });
    try { proc.once('exit', onExit); } catch (e) { finish({ signaled: false, killed: false, exited: true }); return; }
    const killTimer = setTimeout(() => {
      try { proc.removeListener('exit', onExit); } catch (e) {}
      // Attach the exit listener BEFORE SIGKILL: a fast exit between
      // kill() and listener attach would otherwise be missed entirely
      // (the exit event fires once) — the bug this edit fixes.
      const hardTimer = setTimeout(() => finish({ signaled: true, killed: true, exited: false }), killTimeoutMs);
      try { proc.once('exit', () => { clearTimeout(hardTimer); finish({ signaled: true, killed: true, exited: true }); }); } catch (e) {}
      if (proc.exitCode !== null || proc.signalCode !== null) { clearTimeout(hardTimer); finish({ signaled: true, killed: true, exited: true }); return; }
      try {
        const killed = proc.kill('SIGKILL');
        log(`child did not exit on SIGTERM in ${termTimeoutMs}ms, SIGKILL sent (kill returned ${killed})`);
      } catch (e) {
        clearTimeout(hardTimer);
        finish({ signaled: true, killed: false, exited: false });
      }
    }, termTimeoutMs);
    // If the child exits promptly, the SIGKILL timer must not linger
    // past the process lifetime: clear it on exit.
    try {
      proc.once('exit', () => clearTimeout(killTimer));
    } catch (e) {}
    try {
      const ok = proc.kill('SIGTERM');
      if (!ok) log('child SIGTERM delivery returned false (may already be dead)');
    } catch (e) {
      clearTimeout(killTimer);
      finish({ signaled: false, killed: false, exited: false });
    }
  });
}

module.exports = {
  withTimeout,
  createShutdown,
  closeServer,
  killChildWithGrace,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_HARD_TIMEOUT_MS,
};
