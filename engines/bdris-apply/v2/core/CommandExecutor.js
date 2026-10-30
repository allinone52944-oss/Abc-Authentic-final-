/**
 * CommandExecutor — Executes commands with guarantees
 *
 * Principles:
 * - Every command gets a response (never hangs)
 * - Timeout with defined fallback
 * - Deduplication by command ID
 * - Progress events for long operations
 * - Structured errors
 */

// FINAL-SOLUTION (2026-10-30, problem-map #5): stable in-flight
// join key for one press. Volatile per-emit fields are excluded
// (_opId: the frontend mints a fresh one per emit, so including it
// would defeat the join; _commandId/_timeoutMs likewise), while
// the payload itself — including the charge token — stays in the
// key, so a genuinely new attempt (new code, new charge) still
// runs separately. Long strings (doc base64) are sampled, never
// fully hashed, and the key itself is never logged (it can carry
// phone/name material in hashed form only, and even that is
// never printed).
function stableOpKey(value, depth = 0) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    if (value.length <= 64) return JSON.stringify(value);
    return `str:${value.length}:${value.slice(0, 32)}|${value.slice(-32)}`;
  }
  if (typeof value !== 'object' || depth > 4) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableOpKey(v, depth + 1)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => !['_opId', '_commandId', '_timeoutMs', '_submitSource'].includes(k)).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableOpKey(value[k], depth + 1)}`).join(',')}}`;
}

class CommandExecutor {
  constructor(options = {}) {
    this.handlers = new Map(); // commandName -> handler
    this.defaultTimeoutMs = options.defaultTimeoutMs || 60000;
    this.completedCommands = new Map(); // commandId -> result (for dedup)
    this.maxCacheSize = 100;
    this.inflightCommands = new Map(); // join key -> promise (for in-flight dedup)
  }

  register(name, handler, options = {}) {
    this.handlers.set(name, {
      fn: handler,
      timeoutMs: options.timeoutMs || this.defaultTimeoutMs,
    });
  }

  async execute(commandName, params = {}, context = {}) {
    const handler = this.handlers.get(commandName);
    if (!handler) {
      return { ok: false, error: 'UNKNOWN_COMMAND', message: `Unknown command: ${commandName}` };
    }

    // Deduplication
    const cmdId = params._commandId;
    if (cmdId && this.completedCommands.has(cmdId)) {
      return this.completedCommands.get(cmdId);
    }

    const emit = context.emit || (() => {});
    const timeoutMs = params._timeoutMs || handler.timeoutMs;

    // FINAL-SOLUTION (2026-10-30, problem-map #5): socket-path
    // in-flight join. The HTTP chain got its guard at 3cc84c5, but
    // the socket path never had one: tonight's journal shows a bot
    // SUBMIT_S4_OTP enqueued TWICE from one user press, and the
    // completed-only _commandId dedup cannot catch it (the
    // frontend's _opId differs per emit and is never mapped to
    // _commandId). A concurrent identical SUBMIT_* op for the same
    // user now JOINS the in-flight run and receives its result —
    // never a second execution. Sequential replays (after the
    // first run settles) still run: only concurrent duplicates
    // join. Failures are never cached — a joined caller gets the
    // first run's outcome, and a later retry runs fresh.
    // Restricted to SUBMIT_* (the page-mutating ops): read-only
    // commands keep their existing behaviour.
    let joinKey = null;
    if (commandName.startsWith('SUBMIT_')) {
      try {
        const user = (context && (context.userId || (context.session && context.session.userId))) || 'anon';
        joinKey = `${user}|${commandName}|${stableOpKey(params)}`;
      } catch {
        joinKey = null; // unhashable payload → old behaviour (run), never a wrong join
      }
      if (joinKey) {
        const inflight = this.inflightCommands.get(joinKey);
        if (inflight) {
          console.log(`EXECUTOR-JOIN: ${commandName} joined in-flight run`);
          return inflight;
        }
      }
    }

    const runPromise = (async () => {
      try {
        const result = await this.withTimeout(
          handler.fn(params, { ...context, emit }),
          timeoutMs,
          commandName
        );

      const response = { ok: true, ...result };

      // Cache for dedup
      if (cmdId) {
        this.completedCommands.set(cmdId, response);
        if (this.completedCommands.size > this.maxCacheSize) {
          const firstKey = this.completedCommands.keys().next().value;
          this.completedCommands.delete(firstKey);
        }
      }

        return response;
      } catch (e) {
        if (e.code === 'COMMAND_TIMEOUT') {
          // S4PREP silent-timeout fix (2026-10-28): a timeout used to
          // leave zero journal trace — the op died silently while the
          // frontend showed 'sending' forever. Log every timeout
          // (command + window only, never params: a submit payload
          // can carry a phone number).
          console.log(`EXECUTOR-TIMEOUT: ${commandName} after ${timeoutMs}ms`);
          return {
            ok: false,
            error: 'TIMEOUT',
            message: `${commandName} timed out after ${timeoutMs}ms`,
          };
        }
        // Same silence rule for failures: command + code only.
        console.log(`EXECUTOR-FAILED: ${commandName} ${e.code || 'ERROR'}`);
        return {
          ok: false,
          error: 'EXECUTION_FAILED',
          message: e.message || 'Command execution failed',
        };
      }
    })();
    if (joinKey) {
      this.inflightCommands.set(joinKey, runPromise);
      try {
        return await runPromise;
      } finally {
        // Delete only if this run still owns the slot (a later
        // run for the same key must never be evicted by this one).
        if (this.inflightCommands.get(joinKey) === runPromise) this.inflightCommands.delete(joinKey);
      }
    }
    return runPromise;
  }

  withTimeout(promise, ms, name) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = new Error(`${name} timed out`);
        e.code = 'COMMAND_TIMEOUT';
        reject(e);
      }, ms);

      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  getRegisteredCommands() {
    return [...this.handlers.keys()];
  }
}

module.exports = { CommandExecutor };
