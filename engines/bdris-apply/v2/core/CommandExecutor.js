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

class CommandExecutor {
  constructor(options = {}) {
    this.handlers = new Map(); // commandName -> handler
    this.defaultTimeoutMs = options.defaultTimeoutMs || 60000;
    this.completedCommands = new Map(); // commandId -> result (for dedup)
    this.maxCacheSize = 100;
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
        return {
          ok: false,
          error: 'TIMEOUT',
          message: `${commandName} timed out after ${timeoutMs}ms`,
        };
      }
      return {
        ok: false,
        error: 'EXECUTION_FAILED',
        message: e.message || 'Command execution failed',
      };
    }
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
