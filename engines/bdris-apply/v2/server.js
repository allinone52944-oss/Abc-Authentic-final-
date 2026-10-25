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

const crypto = require('crypto');
const { BrowserManager } = require('./core/BrowserManager');

function verifyJwtHS256(token, secret) {
  try {
    if (!token || !secret) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const sig = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest('base64url');
    if (sig.length !== parts[2].length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(parts[2]))) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp + 60) return null;
    return payload;
  } catch { return null; }
}
const { SessionManager } = require('./core/SessionManager');
const { CommandExecutor } = require('./core/CommandExecutor');
const { BdrisNavigator } = require('./services/BdrisNavigator');
const { AddressService } = require('./services/AddressService');
const { StepHandler, verifyChargeToken } = require('./services/StepHandler');
const { OriginalFetcher } = require('./services/OriginalFetcher');
const { runSubmitHttpChain, getHttpPathStatus } = require('./services/HttpPathRunner');

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

  // 2026-10-25 warm-up pool: engine চালু হলেই Chromium + BDRIS ফর্ম
  // আগে থেকে লোড করা পেজের একটি পুল (BDRIS_WARM_POOL_SIZE, ডিফল্ট ৩,
  // সীমা ১..৫) তৈরি হয়, যাতে প্রথম কয়েকজন গ্রাহককেই ৩৫–৪১ সেকেন্ডের
  // launch + form-load খরচ দিতে না হয় — আগের একটিমাত্র warm পেজে
  // শুধু প্রথম সেশনই বাঁচত, পরের সবাই পুরো খরচ দিত। পুলের নিয়ম:
  // প্রতিটি পেজ fresh browser context-এ anonymous public ফর্ম মাত্র,
  // কোনো ইউজার ডেটা থাকে না; সেশনে নেওয়া পেজ পুলে আর ফেরে না
  // (SessionManager.destroy তা বন্ধ করে দেয়), আর নেওয়ার সঙ্গে
  // সঙ্গে একটি করে নতুন পেজ দিয়ে পুল ভরা হয়। ব্যর্থ হলে চুপচাপ
  // বাদ — সেশন আগের মতোই নিজে পেজ বানিয়ে কাজ করবে, কখনো ভাঙবে না।
  async warmUp() {
    const raw = parseInt(process.env.BDRIS_WARM_POOL_SIZE || '3', 10);
    const target = Number.isNaN(raw) ? 3 : Math.min(5, Math.max(1, raw));
    this.warmPoolTarget = target;
    this._replenishingWarmPool = false;
    // Replenish on take: one fresh page per handed-out page, guarded
    // against concurrent replenishes inside replenishWarmPool().
    this.browserManager.onWarmPageTaken = () => { void this.replenishWarmPool(); };
    for (let i = 0; i < target; i++) {
      if (this.browserManager.warmPoolSize() >= target) break;
      try {
        const page = await this.browserManager.newPage();
        const nav = new BdrisNavigator(page);
        await nav.gotoForm();
        this.browserManager.setWarmPage(page);
      } catch (e) {
        this.log('Warm-up page skipped (sessions will launch normally):', e.message);
      }
    }
    this.log(`Warm-up pool ready: ${this.browserManager.warmPoolSize()}/${target} pages pre-loaded`);
  }

  // Refill exactly one page after a take. Concurrent calls are skipped
  // (flag guard) — a take that arrives mid-replenish simply waits for
  // the next take to trigger its own refill. Failures are silent-ish:
  // logged at the existing level, never thrown to session creation.
  async replenishWarmPool() {
    if (this._replenishingWarmPool) return;
    if (this.browserManager.warmPoolSize() >= (this.warmPoolTarget || 3)) return;
    this._replenishingWarmPool = true;
    try {
      const page = await this.browserManager.newPage();
      const nav = new BdrisNavigator(page);
      await nav.gotoForm();
      this.browserManager.setWarmPage(page);
      this.log(`Warm-up pool replenished: ${this.browserManager.warmPoolSize()} pages`);
    } catch (e) {
      this.log('Warm-up replenish skipped:', e.message);
    } finally {
      this._replenishingWarmPool = false;
    }
  }

  registerCommands() {
    // GET_ADDRESS_OPTIONS — HTTP geo first, Playwright second.
    // 2026-10-25 zone fix: AddressService tries the HTTP geo API
    // first (no Playwright page needed, fits the frontend timeout)
    // and only then the Playwright cascade. It THROWS on empty
    // instead of returning [], so a failure is visible upstream
    // instead of collapsing to a text input that can never unlock
    // Ward. The session page is therefore only required for the
    // Playwright fallback, not for the HTTP path.
    this.executor.register('GET_ADDRESS_OPTIONS',
      async (params, ctx) => {
        const { level, parents = {}, form = 'birth' } = params;
        const session = ctx.session;

        const nav = session?.page ? new BdrisNavigator(session.page) : null;
        const addrService = new AddressService(nav);

        // Ensure we're on the form — only for the Playwright fallback;
        // the HTTP path does not need the page at all.
        if (nav) {
          const url = session.page.url();
          if (!url.includes('bdris.gov.bd')) {
            ctx.emit('PROGRESS', '⏳ BDRIS ফর্ম লোড হচ্ছে...');
            await nav.gotoForm();
          }
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

        const secret = process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '';
        if (secret) {
          if (!verifyChargeToken(data._chargeToken, userId, 'pdf', secret)) {
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

    // ── HTTP_PATH_STATUS: non-destructive probe (no session needed) ──
    // Returns ONLY {httpPath, enabled, ready, candidate, candidateLabel}.
    // It never starts a session, sends OTP, uploads, submits, runs
    // Playwright, or changes any state, and it never logs or emits.
    // Frontend wiring rule: call this FIRST, with no _commandId
    // (the executor caches by _commandId, so a reused id would
    // return a stale status). If it says disabled, the frontend
    // runs its existing Playwright flow itself — it must NOT call
    // SUBMIT_HTTP_CHAIN expecting it to run Playwright.
    // `ready: true` means only that the engine process answered
    // the probe, not that bdris.gov.bd or a session is ready.
    this.executor.register('HTTP_PATH_STATUS',
      async () => getHttpPathStatus(),
      { timeoutMs: 5000 }
    );

    // ── SUBMIT_HTTP_CHAIN: HTTP-first full chain (opt-in only) ──
    // CONTRACT (2026-10-25 probe fix — read before wiring):
    //  * Disabled (default): returns {ok:false, httpPath:'disabled',
    //    error:'HTTP_PATH_DISABLED'} WITHOUT executing anything —
    //    no Playwright, no charge-gate check, no HTTP. The CALLER
    //    (existing frontend Playwright flow) runs Playwright itself.
    //    Before this fix the disabled branch AWAITED the full
    //    Playwright chain, so a frontend probe-then-old-flow would
    //    have double-executed; that behaviour is gone, on purpose.
    //  * Enabled: bootstrap → geo (if a geoChain spec is supplied)
    //    → upload 40/41 → OTP send → verify → submit via
    //    BdrisHttpClient, behind the SAME charge-token gate
    //    Playwright submitS4 enforces. On HTTP failure the runner
    //    falls back to the Playwright steps below for this session
    //    and logs step + reason; a submit whose outcome is unknown
    //    never auto-retries (see HttpPathRunner).
    // Submit/verify payloads are CANDIDATE until a live capture
    // confirms them — the label is on every log line and response.
    // Env: BDRIS_HTTP_PATH=on (or 1/true/yes/enabled) OPTS IN to the
    // HTTP path; default OFF (safe-by-default, candidate payloads
    // unproven). Unset/empty/off/0/false/no/disabled/unknown all
    // disable it. Frontend wiring for this command is still pending
    // (frontend files are out of scope here), so the live UI does
    // not call this command yet; the command is reachable today
    // only via ENGINE_COMMAND like every other command.
    this.executor.register('SUBMIT_HTTP_CHAIN',
      async (params, ctx) => {
        const session = ctx.session;
        const userId = ctx.socket?.abcUser?.id || null;
        const secret = process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '';

        // Playwright adapter: the existing step path, split from the
        // combined draft exactly as the per-step commands receive it.
        // NOTE: constructing this closure executes nothing — the
        // adapter body runs only if runSubmitHttpChain invokes it,
        // which the disabled branch never does (proven by test:
        // a counting fake adapter stays at 0 calls when disabled).
        const playwrightRunner = session?.page ? async (data) => {
          const nav = new BdrisNavigator(session.page);
          const handler = new StepHandler(nav, {
            emit: (ev, msg) => ctx.emit(ev, msg),
            userId,
          });
          const d = data || {};
          const steps = [
            ['submitS0', { addressType: d.addressType || 'BIRTH' }],
            ['submitS1', d.s1 || d.person || {}],
            ['submitS2', { ...(d.s2 || {}), applicantDob: (d.s1 || {}).dob || d.applicantDob }],
            ['submitS2B', d.s2b || {}],
            ['submitS3', { ...(d.s3 || {}), docs: d.docs || (d.s3 || {}).docs || [], s1: d.s1, applicantDob: (d.s1 || {}).dob || d.applicantDob }],
            ['submitS4Prep', { ...(d.s4prep || {}), s1: d.s1 }],
            ['submitS4', {
              otp: d.otp, _chargeToken: d._chargeToken,
              s1: d.s1, s2: d.s2, s2b: d.s2b, s3: d.s3, s4prep: d.s4prep,
              applicantDob: (d.s1 || {}).dob || d.applicantDob,
            }],
          ];
          for (const [method, stepParams] of steps) {
            const r = await handler[method](stepParams);
            if (!r || r.ok === false) {
              return { ...r, ok: false, path: 'playwright', failedStep: method };
            }
          }
          return { ok: true, path: 'playwright', completed: true };
        } : null;

        return runSubmitHttpChain({
          data: params,
          userId,
          secret,
          playwrightRunner,
          log: (...a) => this.log(...a),
          emit: (ev, msg) => ctx.emit(ev, msg),
        });
      },
      { timeoutMs: 180000 }
    );
  }

  setupSocketHandlers() {
    const getSecret = () => process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '';

    this.io.use((socket, next) => {
      const secret = getSecret();
      if (!secret) {
        socket.abcUser = null;
        return next();
      }
      const token = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
      const payload = verifyJwtHS256(token, secret);
      if (!payload) return next(new Error('UNAUTHORIZED'));
      const uid = payload.id || payload.sub || payload.userId;
      if (!uid) return next(new Error('UNAUTHORIZED'));
      socket.abcUser = { id: String(uid), role: payload.role || 'user' };
      next();
    });

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
          // 2026-10-25 zone fix: NEVER collapse a failure to [].
          // The old code returned [] for every ok:false result
          // (timeout, parent-not-found, session), and the frontend
          // then degraded paurasavaUnion to a text input — hiding
          // the real error and making Ward unreachable. Now an
          // executor failure is passed through as {ok:false, error}
          // so the frontend can show it and offer a retry; only a
          // genuine ok:true result returns the raw options array
          // (v1 compat with the frontend's array check).
          if (callback) {
            if (result && result.ok === false) {
              // 2026-10-25: the executor returns a generic error CODE
              // ('EXECUTION_FAILED'/'TIMEOUT') plus the detailed
              // message (e.g. the ZONE_WARD_FETCH_FAILED text naming
              // the HTTP reason AND the Playwright reason). The old
              // line sent ONLY the code, so the frontend — and the
              // user — could never tell a timeout from a bootstrap
              // failure from a parent-not-found, and every live
              // symptom looked identical. Keep the code, but also
              // forward the message; the frontend patch prefers it
              // for the banner. Nothing else in this shape changes.
              callback({ ok: false, error: result.error || result.message || 'GET_ADDRESS_OPTIONS_FAILED', message: result.message || result.error || 'GET_ADDRESS_OPTIONS_FAILED' });
            } else if (Array.isArray(result?.options)) {
              callback(result.options);
            } else if (Array.isArray(result)) {
              callback(result);
            } else {
              callback({ ok: false, error: 'GET_ADDRESS_OPTIONS_BAD_RESPONSE' });
            }
          }
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
      socket.on('LIST_ADDRESSES', (callback) => {
        try {
          const uid = socket.abcUser?.id || userId || 'anon';
          if (callback) callback({ ok: true, addresses: loadAddresses(uid) });
        } catch (e) { if (callback) callback({ ok: false, addresses: [] }); }
      });

      // Legacy: Draft handlers (v1 compat)
      const DRAFTS_BASE = path.join(__dirname, '..', 'drafts');
      const draftsDirFor = (uid) => {
        const safe = String(uid || 'anon').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || 'anon';
        const d = path.join(DRAFTS_BASE, 'u_' + safe);
        try { fs.mkdirSync(d, { recursive: true }); } catch {}
        return d;
      };
      socket.on('SAVE_DRAFT', (data, callback) => {
        try {
          const uid = socket.abcUser?.id || userId || 'anon';
          const raw = (data && data.draftId) || ('draft-' + Date.now().toString(36));
          const id = String(raw).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80) || ('draft-' + Date.now().toString(36));
          const rec = Object.assign({}, data, { draftId: id, savedAt: new Date().toISOString() });
          fs.writeFileSync(path.join(draftsDirFor(uid), id + '.json'), JSON.stringify(rec));
          socket.emit('BOT_STATUS', { status: 'PROGRESS', message: `💾 খসড়া সংরক্ষিত (${id})` });
          if (callback) callback({ ok: true, draftId: id, savedAt: rec.savedAt });
        } catch (e) { if (callback) callback({ ok: false, error: 'খসড়া সংরক্ষণ করা যায়নি' }); }
      });
      socket.on('LIST_DRAFTS', (callback) => {
        try {
          const uid = socket.abcUser?.id || userId || 'anon';
          const list = fs.readdirSync(draftsDirFor(uid)).filter(f => f.endsWith('.json')).map(f => {
            try {
              const r = JSON.parse(fs.readFileSync(path.join(draftsDirFor(uid), f), 'utf8'));
              return {
                draftId: r.draftId, savedAt: r.savedAt, uiStep: parseInt(r.uiStep, 10) || 0,
                name: [r.s1 && r.s1.firstNameBn, r.s1 && r.s1.lastNameBn].filter(Boolean).join(' ') || '(নাম নেই)',
                dob: (r.s1 && r.s1.dob) || '',
              };
            } catch { return null; }
          }).filter(Boolean).sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
          if (callback) callback(list);
        } catch { if (callback) callback([]); }
      });
      socket.on('LOAD_DRAFT', (draftId, callback) => {
        try {
          const uid = socket.abcUser?.id || userId || 'anon';
          const f = path.join(draftsDirFor(uid), String(draftId).replace(/[^a-zA-Z0-9-]/g, '') + '.json');
          const draft = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (callback) callback({ ok: true, draft });
        } catch (e) { if (callback) callback({ ok: false, error: 'খসড়া পাওয়া যায়নি' }); }
      });
      socket.on('DELETE_DRAFT', (draftId, callback) => {
        try {
          const uid = socket.abcUser?.id || userId || 'anon';
          const f = path.join(draftsDirFor(uid), String(draftId).replace(/[^a-zA-Z0-9-]/g, '') + '.json');
          fs.unlinkSync(f);
          if (callback) callback({ ok: true });
        } catch (e) { if (callback) callback({ ok: false }); }
      });

      socket.on('KEEPALIVE', () => {
        if (sessionId) this.sessionManager.touch(sessionId);
      });

      socket.on('GET_DOM_OPTIONS', async (selector, callback) => {
        try {
          if (!sessionId) { if (callback) callback([]); return; }
          const session = this.sessionManager.get(sessionId);
          if (!session || !session.page) { if (callback) callback([]); return; }
          this.sessionManager.touch(sessionId);
          const page = session.page;
          await page.waitForSelector(selector, { state: 'attached', timeout: 3000 }).catch(() => {});
          const options = await page.evaluate((sel) => {
            const selectors = sel.includes(',') ? sel.split(',').map(s => s.trim()) : [sel];
            let el = null;
            for (const s of selectors) { el = document.querySelector(s); if (el) break; }
            if (!el || !el.options) return [];
            return Array.from(el.options)
              .filter(o => o.value && o.value !== '-1' && o.value !== '' && o.text.trim() !== '' && !/নির্বাচন করুন/.test(o.text))
              .map(o => ({ id: o.value, name: o.text.trim() }));
          }, selector).catch(() => []);
          if (callback) callback(options);
        } catch {
          if (callback) callback({ error: 'Failed to read DOM' });
        }
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
    // Non-blocking: warm-up must never delay listen / health.
    engine.warmUp();
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
