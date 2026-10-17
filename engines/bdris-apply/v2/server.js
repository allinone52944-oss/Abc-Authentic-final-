/**
 * BDRIS Engine v2 — Main Server
 *
 * Clean architecture rewrite:
 * - BrowserManager: browser lifecycle
 * - SessionManager: user sessions
 * - CommandExecutor: command pattern with guarantees
 * - BdrisNavigator: site interaction
 * - AddressService: address cascade
 *
 * Principles:
 * - Every command gets a response (never hangs)
 * - Explicit state machine
 * - No fragile mirroring
 * - Realtime by design
 */

const { BrowserManager } = require('./core/BrowserManager');
const { SessionManager } = require('./core/SessionManager');
const { CommandExecutor } = require('./core/CommandExecutor');
const { BdrisNavigator } = require('./services/BdrisNavigator');
const { AddressService } = require('./services/AddressService');

class BdrisEngineV2 {
  constructor(io, options = {}) {
    this.io = io;
    this.options = options;

    // Core components
    this.browserManager = new BrowserManager({
      onStateChange: (oldS, newS) => this.log(`Browser: ${oldS} → ${newS}`),
    });

    this.sessionManager = new SessionManager({
      browserManager: this.browserManager,
      sessionTimeoutMs: options.sessionTimeoutMs || 25 * 60 * 1000,
      onSessionExpired: (sid, uid) => this.log(`Session expired: ${sid} (user ${uid})`),
    });

    this.executor = new CommandExecutor({
      defaultTimeoutMs: options.defaultTimeoutMs || 60000,
    });

    this.registerCommands();
    this.setupSocketHandlers();
  }

  log(...args) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[engine-v2 ${ts}]`, ...args);
  }

  registerCommands() {
    // GET_ADDRESS_OPTIONS — replaces fragile mirror logic
    this.executor.register('GET_ADDRESS_OPTIONS',
      async (params, ctx) => {
        const { level, parents = {}, form = 'birth' } = params;
        const session = ctx.session;

        if (!session?.page) {
          throw new Error('No active session');
        }

        const nav = new BdrisNavigator(session.page);
        const addrService = new AddressService(nav);

        // Ensure we're on the form
        const url = session.page.url();
        if (!url.includes('bdris.gov.bd')) {
          ctx.emit('PROGRESS', '⏳ BDRIS ফর্ম লোড হচ্ছে...');
          await nav.gotoForm();
        }

        const options = await addrService.getOptions(level, parents, form);
        this.log(`ADDR-OPTS: ${form}/${level} → ${options.length}`);
        return { options };
      },
      { timeoutMs: 30000 }
    );

    // ENSURE_READY — ensure browser is ready
    this.executor.register('ENSURE_READY',
      async (params, ctx) => {
        const session = ctx.session;
        if (!session?.page) {
          throw new Error('No active session');
        }
        const nav = new BdrisNavigator(session.page);
        const url = session.page.url();
        if (!url.includes('bdris.gov.bd')) {
          await nav.gotoForm();
        }
        return { ready: true };
      },
      { timeoutMs: 45000 }
    );

    // Add more commands here as needed:
    // SUBMIT_S0, SUBMIT_S1, etc. — migrated from v1 with clean patterns
    const { StepHandler } = require('./services/StepHandler');

    const stepCommands = [
      ['SUBMIT_S0', 'submitS0', 60000],
      ['SUBMIT_S1', 'submitS1', 120000],
      ['SUBMIT_S2', 'submitS2', 120000],
      ['SUBMIT_S2B', 'submitS2B', 120000],
      ['SUBMIT_S3_DOCS', 'submitS3', 180000],
      ['SUBMIT_S4_OTP', 'submitS4', 120000],
    ];

    for (const [cmdName, methodName, timeoutMs] of stepCommands) {
      this.executor.register(cmdName,
        async (params, ctx) => {
          const session = ctx.session;
          if (!session?.page) {
            throw new Error('No active session');
          }
          const nav = new BdrisNavigator(session.page);
          const handler = new StepHandler(nav, {
            emit: (ev, msg) => ctx.emit(ev, msg),
            userId: ctx.socket?.abcUser?.id || null,
          });
          if (typeof handler[methodName] !== 'function') {
            throw new Error(`StepHandler.${methodName} not implemented`);
          }
          const result = await handler[methodName](params);
          // Map to legacy STEP_CHANGE_ACK shape for frontend compat
          return result;
        },
        { timeoutMs }
      );
    }
  }

  setupSocketHandlers() {
    this.io.on('connection', (socket) => {
      this.log(`Connected: ${socket.id}`);
      let sessionId = null;

      // Authenticate (from JWT or standalone)
      const userId = socket.abcUser?.id || null;

      socket.on('INIT_SESSION', async (data = {}, callback) => {
        try {
          // Same-user takeover: reuse existing session
          if (userId) {
            const existing = this.sessionManager.findByUser(userId);
            if (existing) {
              sessionId = existing.id;
              this.sessionManager.touch(sessionId);
              this.log(`Session reused: ${sessionId} (user ${userId})`);
              if (callback) callback({ ok: true, sessionId, reused: true });
              socket.emit('SESSION_READY', { sessionId });
              return;
            }
          }

          // Create new session
          const session = await this.sessionManager.create(userId, {
            socketId: socket.id,
          });
          sessionId = session.id;

          // Navigate to BDRIS form
          const nav = new BdrisNavigator(session.page);
          socket.emit('PROGRESS', '⏳ BDRIS ফর্ম লোড হচ্ছে...');
          await nav.gotoForm();

          this.log(`Session created: ${sessionId} (user ${userId})`);
          if (callback) callback({ ok: true, sessionId, reused: false });
          socket.emit('SESSION_READY', { sessionId });
        } catch (e) {
          this.log(`INIT_SESSION failed: ${e.message}`);
          if (callback) callback({ ok: false, error: e.message });
          socket.emit('SESSION_ERROR', { message: e.message });
        }
      });

      // Generic command handler
      socket.on('ENGINE_COMMAND', async (data = {}, callback) => {
        const { command, params = {} } = data;

        if (!sessionId) {
          const err = { ok: false, error: 'NO_SESSION', message: 'Session not initialized' };
          if (callback) callback(err);
          return;
        }

        const session = this.sessionManager.get(sessionId);
        if (!session) {
          const err = { ok: false, error: 'SESSION_EXPIRED', message: 'Session expired' };
          if (callback) callback(err);
          socket.emit('SESSION_EXPIRED', {});
          return;
        }

        this.sessionManager.touch(sessionId);

        const emit = (event, payload) => socket.emit(event, payload);
        const result = await this.executor.execute(command, params, {
          session,
          emit,
          socket,
        });

        if (callback) callback(result);
      });

      // Legacy compatibility: GET_ADDRESS_OPTIONS direct
      socket.on('GET_ADDRESS_OPTIONS', async (data = {}, callback) => {
        if (!sessionId) {
          // Auto-init session if needed
          await new Promise((resolve) => {
            socket.emit('INIT_SESSION', {}, resolve);
          });
        }
        socket.emit('ENGINE_COMMAND', {
          command: 'GET_ADDRESS_OPTIONS',
          params: data,
        }, callback);
      });

      socket.on('disconnect', async () => {
        this.log(`Disconnected: ${socket.id}`);
        // Don't destroy session immediately — allow reconnection
        // Session will expire via timeout if not reused
      });
    });
  }

  async shutdown() {
    this.log('Shutting down...');
    await this.sessionManager.closeAll();
    await this.browserManager.close();
  }

  getStats() {
    return {
      browser: this.browserManager.state,
      sessions: this.sessionManager.getStats(),
      commands: this.executor.getRegisteredCommands(),
    };
  }
}

module.exports = { BdrisEngineV2 };
