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
const { StepHandler, verifyChargeToken } = require('./services/StepHandler');
const { OriginalFetcher } = require('./services/OriginalFetcher');

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

    // ── OriginalFetcher: আসল PDF (কার্যালয়ের কপি) ──
    // v1 original-fetcher.js থেকে migrate; নিজস্ব isolated browser context ব্যবহার করে,
    // চলমান আবেদন-সেশনে হাত দেয় না।
    this.originalFetcher = new OriginalFetcher({
      browserManager: this.browserManager,
      log: (...a) => this.log(...a),
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

    // ── FETCH_ORIGINAL: আসল PDF (কার্যালয়ের কপি) ──
    // v1-এর socket.on('FETCH_ORIGINAL') থেকে migrate।
    // Charge token যাচাই (backend /charge/pdf দেয়) — টোকেন ছাড়া ডাউনলোড নয়।
    // {ok:true, url} বা {ok:false, error} ফেরত দেয়।
    this.executor.register('FETCH_ORIGINAL',
      async (params, ctx) => {
        const data = params || {};
        const userId = ctx.socket?.abcUser?.id || null;

        if (process.env.ABC_JWT_SECRET) {
          if (!verifyChargeToken(data._chargeToken, userId, 'pdf')) {
            throw new Error('CHARGE_REQUIRED');
          }
        }

        const ack = String(data.ack || data.ackId || '').replace(/\D/g, '');
        // rec সরাসরি আসতে পারে, নইলে shared index (v1-এর সাথে continuity) থেকে
        let rec = data.rec || null;
        if (!rec) {
          if (!ack) throw new Error('MISSING_ACK');
          rec = this.originalFetcher.loadRec(ack);
        }
        if (!rec) throw new Error('NO_RECORD');

        const job = await this.originalFetcher.ensureOriginal(rec);
        const r = job.result || {};
        if (!r.ok) throw new Error(r.err || 'FETCH_FAILED');
        return { ok: true, url: r.url, bytes: r.bytes || 0, ackId: this.originalFetcher.keyOf(rec.appId) };
      },
      { timeoutMs: 6 * 60 * 1000 } // job timeout (5min) + buffer
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
      ['SUBMIT_S4_PREP', 'submitS4Prep', 120000],
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

      // Legacy: START_BDRIS_SESSION (frontend page-load-এ emit করে)
      // v1-এর মতো BOT_STATUS/READY পাঠাতে হবে, নইলে frontend "প্রস্তুত হচ্ছে"-তে আটকে থাকে
      socket.on('START_BDRIS_SESSION', async () => {
        try {
          socket.emit('BOT_STATUS', { status: 'LOADING', message: '⏳ সংযোগ প্রস্তুত হচ্ছে...' });
          // Session তৈরি বা reuse (INIT_SESSION-এর logic)
          let sid = sessionId;
          if (!sid) {
            if (userId) {
              const existing = this.sessionManager.findByUser(userId);
              if (existing) {
                sid = existing.id;
                this.sessionManager.touch(sid);
              }
            }
            if (!sid) {
              const sess = await this.sessionManager.create(userId, { socketId: socket.id });
              sid = sess.id;
              const nav = new BdrisNavigator(sess.page);
              await nav.gotoForm();
            }
            sessionId = sid;
          }
          socket.emit('BOT_STATUS', { status: 'READY', message: '✅ BDRIS সেশন প্রস্তুত।', fresh: true });
          socket.emit('SESSION_READY', { sessionId: sid });
        } catch (e) {
          socket.emit('BOT_STATUS', { status: 'ERROR', message: '❌ সংযোগ তৈরি হয়নি — আবার চেষ্টা করুন।' });
        }
      });

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
        try {
          // Ensure session exists (direct, not via self-emit)
          if (!sessionId) {
            let sid = null;
            if (userId) {
              const existing = this.sessionManager.findByUser(userId);
              if (existing) { sid = existing.id; this.sessionManager.touch(sid); }
            }
            if (!sid) {
              const sess = await this.sessionManager.create(userId, { socketId: socket.id });
              sid = sess.id;
              const nav0 = new BdrisNavigator(sess.page);
              await nav0.gotoForm();
            }
            sessionId = sid;
          }
          const session = this.sessionManager.get(sessionId);
          if (!session) {
            if (callback) callback({ ok: false, error: 'SESSION_EXPIRED' });
            return;
          }
          this.sessionManager.touch(sessionId);
          const result = await this.executor.execute('GET_ADDRESS_OPTIONS', data, {
            session,
            emit: (ev, payload) => socket.emit(ev, payload),
            socket,
          });
          if (callback) callback(result);
        } catch (e) {
          if (callback) callback({ ok: false, error: e.message });
        }
      });

      // Legacy compatibility: FETCH_ORIGINAL direct
      // Frontend socket.emit('FETCH_ORIGINAL', {ack, _chargeToken}) করে আর
      // BOT_STATUS/ORIGINAL_PDF event-এর অপেক্ষা করে — সেই shape বজায় রাখা হলো।
      // Session লাগে না (OriginalFetcher নিজস্ব isolated context ব্যবহার করে)।
      socket.on('FETCH_ORIGINAL', async (data = {}) => {
        const ack = String(data.ack || data.ackId || '').replace(/\D/g, '');
        const fail = (msg) => socket.emit('BOT_STATUS', {
          status: 'ORIGINAL_PDF', ackId: ack, original: null, ok: false, error: msg,
        });
        try {
          const result = await this.executor.execute('FETCH_ORIGINAL', data, {
            session: sessionId ? this.sessionManager.get(sessionId) : null,
            emit: (ev, payload) => socket.emit(ev, payload),
            socket,
          });
          if (!result.ok) return fail(result.error || result.message);
          socket.emit('BOT_STATUS', {
            status: 'ORIGINAL_PDF',
            ackId: result.ackId || ack,
            original: result.url || null,
            ok: true,
          });
        } catch (e) {
          fail(e.message || 'FETCH_FAILED');
        }
      });

      // Legacy compatibility: SUBMIT_* handlers emit STEP_CHANGE_ACK
      // Frontend v1-এর মতো socket.emit('SUBMIT_S1', data) করে আর
      // STEP_CHANGE_ACK-এর অপেক্ষা করে — সেই wire protocol বজায় রাখা হলো।
      const legacySubmits = [
        'SUBMIT_S0', 'SUBMIT_S1', 'SUBMIT_S2', 'SUBMIT_S2B',
        'SUBMIT_S3_DOCS', 'SUBMIT_S4_PREP', 'SUBMIT_S4_OTP',
      ];
      for (const evName of legacySubmits) {
        socket.on(evName, async (data = {}) => {
          // Auto-init session if needed
          if (!sessionId) {
            try {
              const sess = await this.sessionManager.create(userId, { socketId: socket.id });
              sessionId = sess.id;
              const nav0 = new BdrisNavigator(sess.page);
              await nav0.gotoForm();
            } catch (e) {
              socket.emit('STEP_CHANGE_ACK', { step: 0, failed: [{ reason: e.message }] });
              return;
            }
          }
          const session = this.sessionManager.get(sessionId);
          if (!session) {
            socket.emit('STEP_CHANGE_ACK', { step: 0, failed: [{ reason: 'SESSION_EXPIRED' }] });
            return;
          }
          this.sessionManager.touch(sessionId);
          try {
            const result = await this.executor.execute(evName, data, {
              session,
              emit: (ev, payload) => socket.emit(ev, payload),
              socket,
            });
            // v1 shape: {step, message, failed, blocked}
            socket.emit('STEP_CHANGE_ACK', {
              step: result.step || 0,
              message: result.message || '',
              failed: result.failed || [],
              blocked: result.blocked || undefined,
              ok: result.ok,
            });
            // S4 completion → BOT_STATUS/COMPLETED for frontend
            if (evName === 'SUBMIT_S4_OTP' && result.ok && result.completed) {
              socket.emit('BOT_STATUS', {
                status: 'COMPLETED',
                ackId: result.ackId,
                ackNum: result.ackNum,
                screenshot: result.screenshot,
                pdf: result.pdf,
                original: result.originalRec || null,
              });
            }
          } catch (e) {
            socket.emit('STEP_CHANGE_ACK', {
              step: 0,
              failed: [{ reason: e.message || 'EXECUTION_FAILED' }],
            });
          }
        });
      }

      // Legacy: Address book (SAVE_ADDRESS / DELETE_ADDRESS)
      // v1-এর file-based address storage — userId অনুযায়ী আলাদা file।
      const path = require('path');
      const fs = require('fs');
      const addrFileFor = (uid) => {
        const safe = String(uid || 'anon').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || 'anon';
        return path.join(__dirname, '..', 'addresses_u_' + safe + '.json');
      };
      const loadAddresses = (uid) => {
        try { return JSON.parse(fs.readFileSync(addrFileFor(uid), 'utf8')); }
        catch { return []; }
      };
      const saveAddresses = (uid, list) => {
        fs.writeFileSync(addrFileFor(uid), JSON.stringify(list, null, 1));
      };
      socket.on('SAVE_ADDRESS', (addr, callback) => {
        try {
          if (!addr || !addr.name) { if (callback) callback({ ok: false, error: 'নাম দিন' }); return; }
          const uid = socket.abcUser?.id || userId || 'anon';
          const list = loadAddresses(uid);
          const id = addr.id || ('addr-' + Date.now().toString(36));
          const rec = Object.assign({}, addr, { id });
          const i = list.findIndex(x => x.id === id);
          if (i >= 0) list[i] = rec; else list.push(rec);
          saveAddresses(uid, list);
          if (callback) callback({ ok: true, addresses: list });
        } catch (e) { if (callback) callback({ ok: false, error: 'সেভ করা যায়নি' }); }
      });
      socket.on('DELETE_ADDRESS', (id, callback) => {
        try {
          const uid = socket.abcUser?.id || userId || 'anon';
          const list = loadAddresses(uid).filter(a => a.id !== id);
          saveAddresses(uid, list);
          if (callback) callback({ ok: true, addresses: list });
        } catch (e) { if (callback) callback({ ok: false, error: 'মুছে ফেলা যায়নি' }); }
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

// ── Bootstrap: standalone subprocess entry point ──
// Adapter (index.js) এই file-কে subprocess হিসেবে spawn করে।
// v1-এর মতো Express + Socket.IO server চালু করতে হবে, নইলে
// health check "starting"-এ আটকে থাকবে।
if (require.main === module) {
  const express = require('express');
  const http = require('http');
  const { Server } = require('socket.io');

  const PORT = parseInt(process.env.BDRIS_APPLY_PORT || '3102', 10);
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, engine: 'bdris-apply-v2', time: new Date().toISOString() });
  });

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: true, credentials: true },
  });

  const engine = new BdrisEngineV2(io, {});
  // setupSocketHandlers() constructor-এই call হয়

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[bdris-apply-v2] listening on 127.0.0.1:${PORT}`);
  });

  process.on('unhandledRejection', (e) => {
    console.error('UNHANDLED-REJECTION:', (e && e.stack) ? String(e.stack).slice(0, 500) : String(e).slice(0, 500));
  });
  process.on('uncaughtException', (e) => {
    console.error('UNCAUGHT-EXCEPTION:', (e && e.stack) ? String(e.stack).slice(0, 500) : String(e).slice(0, 500));
  });

  const shutdown = async () => {
    await engine.shutdown();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
