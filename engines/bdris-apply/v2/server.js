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
const path = require('path');
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
// FINAL-SOLUTION (2026-10-30, problem-map #9): server-side draft
// store shared by the socket SAVE_DRAFT handler and the HTTP
// /draft-save route. Same file layout and id sanitisation as the
// socket handler always had (drafts/u_<uid>/<id>.json) — the HTTP
// route exists because the direct path succeeds over plain HTTP
// precisely when the socket is dead, and a socket-only auto-save
// would then fail exactly when it is needed most (a restart
// wiped an in-session filing on 2026-10-30 because no save had
// ever reached the server). The frontend auto-saves the FULL
// draft (docs base64 included) — the http-chain send body is
// deliberately docs-stripped and is never used as draft data.
const fs = require('fs');
function draftsDirFor(uid) {
  const safe = String(uid || 'anon').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || 'anon';
  const d = path.join(__dirname, '..', 'drafts', 'u_' + safe);
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
function saveDraftRecord(uid, data) {
  const raw = (data && data.draftId) || ('draft-' + Date.now().toString(36));
  const id = String(raw).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80) || ('draft-' + Date.now().toString(36));
  const rec = Object.assign({}, data, { draftId: id, savedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(draftsDirFor(uid), id + '.json'), JSON.stringify(rec));
  return { draftId: id, savedAt: rec.savedAt };
}
const { SessionManager } = require('./core/SessionManager');
const { CommandExecutor } = require('./core/CommandExecutor');
const { toStepAck, shouldDropSession } = require('./core/stepAck');
const { BdrisNavigator } = require('./services/BdrisNavigator');
const { AddressService } = require('./services/AddressService');
const { StepHandler, verifyChargeToken } = require('./services/StepHandler');
const { OriginalFetcher, STEP_LABELS } = require('./services/OriginalFetcher');
const { runSubmitHttpChain, runStageAProbe, getHttpPathStatus, isHttpPathEnabled, HTTP_CANDIDATE_LABEL } = require('./services/HttpPathRunner');
const { HttpGeoService } = require('./services/HttpGeoService');
const { probePageScripts } = require('./services/RegisterScriptProbe');

// ── HTTP-CHAIN IDEMPOTENCY GUARD (2026-10-30, double-emit root fix) ──
// Journal proof (2026-10-30, UTC): ONE user send press produced TWO
// identical HTTP-chain runs in the same second (send twice → two
// different OTP SMS), the submit phase also ran twice (charge hit
// DUPLICATE_TRANSACTION), and a bot SUBMIT_S4_OTP op was enqueued
// twice. The chain itself logs once per run (this.log is a single
// console.log per call), so the duplication is at REQUEST level —
// two POSTs / two chain runs in one process — not a double log
// line. The exact trigger (double-click vs trigger+resend vs proxy
// double-forward) is NOT proven, so this guard is server-side and
// trigger-agnostic: it keys on what the request IS, not how it
// arrived.
//  * In-flight: a second identical phase while the first still runs
//    WAITS for the first run and returns its result — the chain
//    (send / verify / submit / charge-gate) executes exactly once.
//  * Completed: a clearly successful result (ok === true) is cached
//    briefly (TTL below) and replayed for an identical repeat —
//    no second SMS, no second submit, no second charge attempt.
//  * Failed / blocked / fallback / OUTCOME_UNKNOWN results are
//    NEVER cached: a deliberate user retry after a failure always
//    runs fresh, and OUTCOME_UNKNOWN handling is untouched (an
//    unknown result has ok === false, so it can never be replayed
//    as a success).
// Key: [userId, phase, phone, applicantName, applicantDob, otp,
// docs fingerprint] — otp only for non-send phases (a submit retry
// with a NEW otp is a different attempt and must run); docs enter
// only as (type, base64 length) pairs, never content. The key is
// NEVER logged: it carries phone/name/DOB. Payload data, names,
// backtick/cinno, single-name, charge-token and QR logic are
// untouched — this guard only decides whether an identical chain
// runs again. The charge token is deliberately NOT in the key: a
// token refresh between two duplicate POSTs must not break dedup,
// and the charge gate still runs exactly once (inside the single
// chain execution).
// Deliberate-resend note: the TTL below (30s) covers duplicates
// from ONE user action (same-second in the journal); a deliberate
// resend minutes later passes through and sends fresh. Within the
// TTL, an identical filing identity replays the first success —
// that is the intended anti-double-file behaviour, not a bug.
const HTTP_CHAIN_DEDUP_TTL_MS = 30000;
const HTTP_CHAIN_DEDUP_MAX_KEYS = 500;
function httpChainGuardKey(userId, params = {}) {
  const s1 = params.s1 && typeof params.s1 === 'object' ? params.s1 : {};
  const s3 = params.s3 && typeof params.s3 === 'object' ? params.s3 : {};
  const s4prep = params.s4prep && typeof params.s4prep === 'object' ? params.s4prep : {};
  const phase = params.phase || 'full';
  const phone = params.phone || s4prep.phone || '';
  const applicantName = params.applicantName || s3.applicantName
    || [s1.firstNameEn, s1.lastNameEn].filter(Boolean).join(' ') || '';
  const applicantDob = s1.dob || params.applicantDob || '';
  const otp = phase === 'send' ? '' : (params.otp || '');
  const docsFp = Array.isArray(params.docs)
    ? params.docs.map((d) => [(d && d.docType) || '', String((d && d.base64) || '').length]).join('|')
    : '';
  return JSON.stringify([String(userId || ''), String(phase), String(phone),
    String(applicantName), String(applicantDob), String(otp), docsFp]);
}

// S4Prep-area fix (2026-10-28, items 4/22): the per-step dispatch
// merge, extracted verbatim (plus the relation fill) so tests can
// prove it without driving a socket. Explicit step fields win;
// ctx (this emit, or the session's stored ctx) fills the gaps;
// the session contact fills s4prep email/phone gaps; a S4Prep
// without docs inherits the session's S3 docs. Relation fill:
// the frontend sends relation on S3 and (now) on S4Prep + ctx,
// but the merge never carried it, so catch-up submitS3 got
// relation: undefined and skipped the relation radio entirely
// (StepHandler.js if (data.relation) gate). Order: explicit
// params.relation, then ctx, then the session copy stored at
// S3/S4Prep — the same precedence shape as contact/docs.
function mergeStepParams(params = {}, session = {}, cmdName = '') {
  const ctxData = params.ctx || session.formCtx || null;
  if (params.ctx) session.formCtx = params.ctx;
  const merged = { ...params };
  if (ctxData) {
    if (!merged.s0 && ctxData.s0) merged.s0 = ctxData.s0;
    if (!merged.s1 && ctxData.s1) merged.s1 = ctxData.s1;
    if (!merged.s2 && ctxData.s2) merged.s2 = ctxData.s2;
    if (!merged.s2b && ctxData.s2b) merged.s2b = ctxData.s2b;
    if (!merged.applicantDob && ctxData.s1 && ctxData.s1.dob) merged.applicantDob = ctxData.s1.dob;
    if (!merged.relation && ctxData.relation) merged.relation = ctxData.relation;
  }
  if (!merged.relation && session.relation) merged.relation = session.relation;
  if (session.contact) {
    const sp = (merged.s4prep && typeof merged.s4prep === 'object') ? merged.s4prep : {};
    merged.s4prep = {
      email: sp.email || session.contact.email || '',
      phone: sp.phone || session.contact.phone || '',
    };
  }
  if (cmdName === 'SUBMIT_S4_PREP' && (!merged.docs || !merged.docs.length) && session.docs && session.docs.length) {
    merged.docs = session.docs;
  }
  return merged;
}

// S4Prep-area fix (2026-10-28, items 4/24): the HTTP-chain
// Playwright fallback's step plan, extracted so tests can prove
// it carries the same context the per-step dispatch merge
// carries. Before this, the fallback handler was built with only
// {emit, userId} (no singleName/applicantDob) and its submitS4Prep
// got only {s4prep, s1} — so a catch-up replay inside the fallback
// was impossible (no s0/s2/s2b, no docs, no relation, no contact).
// The plan below mirrors the merge: explicit draft fields win;
// the session copy (contact/docs/relation/singleName/applicantDob)
// fills only the gaps. Behaviour for a complete draft is
// unchanged — every added field is a fallback, never an override.
function buildPlaywrightFallbackPlan(d = {}, session = {}) {
  const s4c = { ...(d.s4prep || {}) };
  s4c.email = s4c.email || (session.contact && session.contact.email) || '';
  s4c.phone = s4c.phone || (session.contact && session.contact.phone) || '';
  const relation = d.relation || (d.s3 && d.s3.relation) || session.relation;
  const docs = d.docs || (d.s3 && d.s3.docs) || session.docs || [];
  const applicantDob = (d.s1 && d.s1.dob) || d.applicantDob || session.applicantDob;
  return {
    handlerOptions: {
      singleName: session.singleName || null,
      applicantDob: session.applicantDob || null,
      familyNamesOnly: session.familyNamesOnly || false,
    },
    steps: [
      ['submitS0', { ...(d.s0 || {}), addressType: (d.s0 && d.s0.addressType) || d.addressType || 'BIRTHPLACE' }],
      ['submitS1', d.s1 || d.person || {}],
      ['submitS2', { ...(d.s2 || {}), applicantDob }],
      ['submitS2B', d.s2b || {}],
      ['submitS3', { ...(d.s3 || {}), docs: d.docs || (d.s3 || {}).docs || [], s1: d.s1, applicantDob, relation }],
      ['submitS4Prep', { ...s4c, s0: d.s0, s1: d.s1, s2: d.s2, s2b: d.s2b, docs, relation }],
      ['submitS4', {
        otp: d.otp, _chargeToken: d._chargeToken,
        s1: d.s1, s2: d.s2, s2b: d.s2b, s3: d.s3, s4prep: s4c,
        applicantDob,
      }],
    ],
  };
}

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
      // আসল PDF-এর ফাইল সার্ভ করা frontend ডিরেক্টরিতে লিখতে হবে (backend
      // এখান থেকেই static serve করে)। ডিফল্ট engines/frontend পথটি dead —
      // সেখানে লিখলে URL 404 হয়, ডাউনলোড করা ফাইল খোলা যায় না (2026-10-28)।
      frontendDir: path.join(__dirname, '..', '..', '..', 'frontend'),
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
  // শুধু প্রথম সেশনই বাঁচত, পরের সবাই পুরো খরচ দিত। 2026-10-26:
  // gotoForm() এখন ফর্ম-কনটেন্ট যাচাই করে — কনটেন্ট ছাড়া পেজ
  // (challenge/stub) throw করে, তাই এই catch-এ বাদ পড়ে, পুলে ঢোকে
  // না; আগে যাচাই ছাড়া পুল হতো, আর সেই খারাপ পেজই পরে প্রতিটা
  // geo কলে একই "no token / no select" ব্যর্থতা দিত। পুলের নিয়ম:
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
    // GET_ADDRESS_OPTIONS — session-seeded HTTP geo first,
    // Playwright second. 2026-10-26: the HTTP geo client is seeded
    // from the session page's cookies + page CSRF (a bare fetch
    // bootstrap is proven blocked with 403), so the session page
    // is now needed for BOTH paths: seeding HTTP, and the
    // Playwright cascade fallback. AddressService THROWS on empty
    // instead of returning [], so a failure is visible upstream
    // instead of collapsing to a text input that can never unlock
    // Ward.
    this.executor.register('GET_ADDRESS_OPTIONS',
      async (params, ctx) => {
        const { level, parents = {}, form = 'birth' } = params;
        const session = ctx.session;

        // Fresh-page factory for the stub case (live banner after
        // bba3e7e: session page at /br/application with no form
        // content at all). ensureFormPage() uses it ONCE instead
        // of reloading the same stale page: the old page is
        // closed, a brand-new page becomes the session page, and
        // the navigator swaps to it. If the fresh page is also a
        // stub, ensureFormPage classifies it as false and the
        // cascade surfaces that state — no second fresh attempt,
        // no loop. Callers without a browser (tests) pass no
        // factory and keep the old reload behaviour.
        const nav = session?.page ? new BdrisNavigator(session.page, {
          createFreshPage: async () => {
            const oldPage = session.page;
            const fresh = await this.browserManager.newPage();
            session.page = fresh;
            if (oldPage) {
              await this.browserManager.closePage(oldPage).catch(() => {});
            }
            return fresh;
          },
        }) : null;
        const addrService = new AddressService(nav);

        // Ensure we're on the form page BEFORE the HTTP seed, so
        // the seed reads CSRF from the form page itself instead of
        // whatever page the session happens to sit on. The old
        // check skipped navigation for ANY bdris.gov.bd URL, so a
        // session page on a non-form BDRIS page seeded from a page
        // with no meta _csrf (live banner 2026-10-26) and then ran
        // the cascade against missing selects. ensureFormPage()
        // navigates only when the page is actually not the form;
        // a failure here is swallowed on purpose so AddressService
        // still runs and surfaces its own named diagnostic (HTTP
        // page-state error + Playwright form-not-loaded error)
        // instead of this handler throwing a bare navigation error.
        if (nav) {
          try {
            const check = await nav.ensureFormPage(form);
            if (check.navigated) ctx.emit('PROGRESS', '⏳ BDRIS ফর্ম লোড হচ্ছে...');
          } catch (e) { /* AddressService surfaces the diagnostic */ }
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
        } else {
          // A stub page at the form URL used to pass this check
          // (URL-contains only). Verify content; a stub is not ready.
          const state = await nav.getPageState().catch(() => null);
          if (state && !state.formContent) {
            await nav.gotoForm();
          }
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

        // Fail-CLOSED (2026-10-26, A-to-Z audit): same proof as
        // submitS4 — backend cannot start without JWT_SECRET and the
        // adapter spawns this engine with the backend's full env, so a
        // missing secret here is a misconfiguration, not a free pass.
        // verifyChargeToken already returns false on empty secret.
        // PDF tokens are NOT single-use consumed (re-downloading one's
        // own paid PDF is legitimate; see StepHandler).
        const secret = process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '';
        if (!verifyChargeToken(data._chargeToken, userId, 'pdf', secret)) {
          throw new Error('CHARGE_REQUIRED');
        }

        const ack = String(data.ack || data.ackId || '').replace(/\D/g, '');
        // rec সরাসরি আসতে পারে, নইলে shared index (v1-এর সাথে continuity) থেকে
        let rec = data.rec || null;
        if (!rec) {
          if (!ack) throw new Error('MISSING_ACK');
          rec = this.originalFetcher.loadRec(ack);
        }
        if (!rec) throw new Error('NO_RECORD');

        // PREMIUM-PROGRESS (2026-10-28): ফেচের লাইভ ধাপ ফ্রন্টএন্ডে —
        // শুধু ধাপের নাম + লেখা, কোনো ব্যক্তিগত তথ্য নয়। ctx.emit
        // না থাকলে চুপচাপ এগোয় (ফেচ থামবে না)।
        const job = await this.originalFetcher.ensureOriginal(rec, (step) => {
          try {
            if (ctx.emit) ctx.emit('BOT_STATUS', { status: 'ORIGINAL_PDF_PROGRESS', ackId: ack, step, label: STEP_LABELS[step] || step });
          } catch { /* progress-এর ভুল ফেচ থামাবে না */ }
        });
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
      ['SUBMIT_S2B', 'submitS2B', 300000],
      ['SUBMIT_S3_DOCS', 'submitS3', 180000],
      // S4Prep replay (2026-10-26, permanent fix): one docs-Next or a
      // full S0-S3 catch-up plus OTP evidence can exceed the old 120s
      // cap on a slow site, so raise it to 300s. The frontend guard
      // refreshes on every PROGRESS event, so a long replay does not
      // trip the 75s frontend op guard while the engine is working.
      ['SUBMIT_S4_PREP', 'submitS4Prep', 300000],
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
            // D6: handlers were stateless across steps (new instance
            // per command, never passed singleName/applicantDob), so
            // S3/S4Prep/S4 lost them. Carry them on the session.
            singleName: session.singleName || null,
            applicantDob: session.applicantDob || null,
            familyNamesOnly: session.familyNamesOnly || false,
          });
          if (typeof handler[methodName] !== 'function') {
            throw new Error(`StepHandler.${methodName} not implemented`);
          }
          // D5: the frontend attaches ctx {s0,s1,s2,s2b} to every
          // emit, but no handler ever read it — S3's applicant
          // name fell back to the literal 'Applicant', S3's
          // pre-2013 SELF rule was dead, and S4Prep/S4 cinno +
          // original-record were dead. Merge ctx (and the session's
          // stored ctx from earlier steps) without overwriting
          // explicit step fields. (The merge lives in
          // mergeStepParams above, S4Prep-area fix 2026-10-28, so
          // tests can prove it; the relation fill there is item 22,
          // and the S4Prep docs/contact fills are the 2026-10-26
          // Debug-2 / replay-docs rules, moved verbatim.)
          const merged = mergeStepParams(params, session, cmdName);
          const result = await handler[methodName](merged);
          if (cmdName === 'SUBMIT_S3_DOCS' && merged.docs && merged.docs.length) session.docs = merged.docs;
          // S4Prep-area fix (2026-10-28, item 22): remember the
          // relation the same way docs are remembered, so a later
          // S4Prep in this session replays with the radio even
          // when its own payload lacks one.
          if ((cmdName === 'SUBMIT_S3_DOCS' || cmdName === 'SUBMIT_S4_PREP') && merged.relation) session.relation = merged.relation;
          if (handler.singleName) session.singleName = handler.singleName;
          if (handler.applicantDob) session.applicantDob = handler.applicantDob;
          // Family advance persistence (2026-10-29 follow-up): a
          // later step command in this session must not re-fill
          // the BRN that already triggered the family error.
          if (handler.familyNamesOnly) session.familyNamesOnly = true;
          if (handler.contact && (handler.contact.email || handler.contact.phone)) session.contact = handler.contact;
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
    // Frontend wiring (DIRECT-PATH WIRING 2026-10-28): the UI
    // probes this on every READY, with no _commandId
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

    // ── HTTP_PROBE_STAGE_A: read-only Stage A probe (2026-10-27) ──
    // Seed → bootstrap-skip → geo chain → office lookups, then STOP.
    // Never uploads, never sends/verifies OTP, never submits, never
    // checks a charge token (no chargeable action happens). Not
    // gated on BDRIS_HTTP_PATH (read-only, like GET_ADDRESS_OPTIONS).
    // Seeding uses the same seedFromPage path as the gate fix; when
    // seeding fails it returns the seed error and attempts NO bare
    // bootstrap (proven 403).
    this.executor.register('HTTP_PROBE_STAGE_A',
      async (params, ctx) => {
        const session = ctx.session;
        const probeBase = { path: 'http-probe', stage: 'A', candidate: true, candidateLabel: HTTP_CANDIDATE_LABEL };
        if (!session?.page) {
          return { ...probeBase, ok: false, error: 'NO_SESSION_PAGE', message: 'Stage A probe needs a warm browser session page to seed from.' };
        }
        let httpClient = null;
        try {
          const geo = new HttpGeoService();
          if (await geo.seedFromPage(session.page)) httpClient = geo.client;
          else return { ...probeBase, ok: false, error: 'SEED_FAILED', message: geo.lastSeedError ? geo.lastSeedError.message : 'unknown' };
        } catch (e) {
          return { ...probeBase, ok: false, error: 'SEED_FAILED', message: e.message };
        }
        return runStageAProbe({
          client: httpClient,
          geoChain: params?.geoChain || null,
          officeParams: params?.officeParams || null,
          officeProjectionParams: params?.officeProjectionParams || null,
          // 2026-10-27 flag-forward fix: the frontend script-probe
          // button emits {scriptProbe:true}, but this call previously
          // dropped the flag, so runStageAProbe never ran its script
          // step and the button returned a plain-probe result.
          scriptProbe: params?.scriptProbe || false,
          log: (...a) => this.log(...a),
        });
      },
      { timeoutMs: 120000 }
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
    // disable it. DIRECT-PATH WIRING (2026-10-28): the live UI
    // calls this command via ENGINE_COMMAND in two phases —
    // phase 'send' (OTP send only, no charge gate, no in-runner
    // Playwright fallback; the frontend falls back to queued bot
    // S4_PREP) and phase 'submit' (charge gate, verify, submit,
    // in-runner Playwright fallback). The frontend learns the flag
    // from HTTP_PATH_STATUS on READY, never from a client guess.
    this.executor.register('SUBMIT_HTTP_CHAIN',
      async (params, ctx) => {
        const session = ctx.session;
        // DIRECT HTTP BYPASS (2026-10-29): the HTTP route injects
        // ctx.userId from its own verified JWT (no socket); the
        // socket path keeps working unchanged (ctx.userId unset).
        const userId = ctx.userId || ctx.socket?.abcUser?.id || null;
        const secret = process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '';

        // Playwright adapter: the existing step path, split from the
        // combined draft exactly as the per-step commands receive it.
        // NOTE: constructing this closure executes nothing — the
        // adapter body runs only if runSubmitHttpChain invokes it,
        // which the disabled branch never does (proven by test:
        // a counting fake adapter stays at 0 calls when disabled).
        // DIRECT-PATH WIRING (2026-10-28): the UI send phase must
        // never run Playwright itself — its fallback is the queued
        // bot S4_PREP owned by the frontend (ordered, page-safe).
        // The submit/full phases keep the in-runner Playwright
        // fallback (pre-submit failure → bot; unknown submit
        // outcome → suppressed, see HttpPathRunner).
        const phase = params.phase || null;
        const playwrightRunner = (phase === 'send') ? null : (session?.page ? async (data) => {
          const nav = new BdrisNavigator(session.page);
          // S4Prep-area fix (2026-10-28, items 4/24): the step plan
          // lives in buildPlaywrightFallbackPlan above, so the
          // fallback carries the same context the per-step dispatch
          // merge carries (s0/s1/s2/s2b, docs, contact, relation,
          // singleName, applicantDob) and a catch-up replay inside
          // submitS4Prep is possible here too.
          const plan = buildPlaywrightFallbackPlan(data || {}, session);
          const handler = new StepHandler(nav, {
            emit: (ev, msg) => ctx.emit(ev, msg),
            userId,
            ...plan.handlerOptions,
          });
          const steps = plan.steps;
          for (const [method, stepParams] of steps) {
            const r = await handler[method](stepParams);
            if (!r || r.ok === false) {
              return { ...r, ok: false, path: 'playwright', failedStep: method };
            }
          }
          return { ok: true, path: 'playwright', completed: true };
        } : null);

        // Session-seeded HTTP client (gate fix 2026-10-27): seed from
        // the warm session page's cookies + CSRF, exactly like
        // GET_ADDRESS_OPTIONS does for geo. When seeding fails (no
        // warm page, or the page is not the form page), pass no
        // client and keep the old behaviour — bare bootstrap will
        // 403 and the chain falls back to Playwright, as before.
        // seedFromPage never navigates, so it cannot hijack a
        // mid-flow page from inside this command.
        let httpClient = null;
        if (session?.page) {
          try {
            const geo = new HttpGeoService();
            if (await geo.seedFromPage(session.page)) httpClient = geo.client;
            else this.log('HTTP seed skipped:', geo.lastSeedError ? geo.lastSeedError.message : 'unknown');
          } catch (e) {
            this.log('HTTP seed failed:', e.message);
          }
        }

        return runSubmitHttpChain({
          data: params,
          userId,
          secret,
          client: httpClient,
          playwrightRunner,
          phase,
          // RESEED (2026-10-30): the live warm page, for the
          // runner's pre-submit refresh (never navigated by the
          // reseed; absent = reseed logs its skip, submit still
          // proceeds on the jarred state).
          reseedPage: session?.page || null,
          // DIRECT-PATH WIRING: a UI direct call must run SEEDED —
          // a failed seed fails fast (SEED_FAILED → bot fallback)
          // instead of attempting a bare bootstrap (proven 403).
          noBareBootstrap: !!params.uiDirect,
          log: (...a) => this.log(...a),
          emit: (ev, msg) => ctx.emit(ev, msg),
        }).then(async (chainResult) => {
          // DIRECT-PATH WIRING: mirror the legacy SUBMIT handler's
          // originalRec save — a Playwright-fallback submit's
          // originalRec would otherwise never be persisted, and the
          // later FETCH_ORIGINAL {ack} would die with NO_RECORD
          // (the v2 bug the legacy handler fixed). A pure-HTTP
          // success has no ackNum/originalRec, so nothing saves.
          if (chainResult && chainResult.httpFallback && chainResult.originalRec && chainResult.ackNum) {
            try { if (this.originalFetcher) this.originalFetcher.saveRec(chainResult.ackNum, chainResult.originalRec); } catch { /* ঐচ্ছিক */ }
          }
          return chainResult;
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

      // G7: a reused session must be verified, not trusted. A page
      // that degraded to a stub after creation used to be returned
      // as READY with no check at all (INIT reuse, START reuse,
      // ENSURE_READY URL-contains check). One cheap getPageState
      // evaluate: form content present -> reuse; absent -> destroy
      // and fall through to fresh creation. Test doubles without
      // evaluate() keep the old behaviour (cannot verify).
      const verifyReusedSession = async (sid) => {
        const sess = sid ? this.sessionManager.get(sid) : null;
        if (!sess?.page || typeof sess.page.evaluate !== 'function') return true;
        try {
          const nav = new BdrisNavigator(sess.page);
          const state = await nav.getPageState();
          if (state && state.formContent) return true;
        } catch (e) { /* treat as unverifiable -> destroy below */ }
        await this.sessionManager.destroy(sid).catch(() => {});
        return false;
      };

      // Authenticate (from JWT or standalone)
      const userId = socket.abcUser?.id || null;

      // Legacy: START_BDRIS_SESSION (frontend page-load-এ emit করে)
      // v1-এর মতো BOT_STATUS/READY পাঠাতে হবে, নইলে frontend "প্রস্তুত হচ্ছে"-তে আটকে থাকে
      socket.on('START_BDRIS_SESSION', async () => {
        try {
          socket.emit('BOT_STATUS', { status: 'LOADING', message: '⏳ সংযোগ প্রস্তুত হচ্ছে...' });
          // Session তৈরি বা reuse (INIT_SESSION-এর logic)
          if (sessionId && !(await verifyReusedSession(sessionId))) sessionId = null;
          let sid = sessionId;
          if (!sid) {
            if (userId) {
              const existing = this.sessionManager.findByUser(userId);
              if (existing) {
                if (await verifyReusedSession(existing.id)) {
                  sid = existing.id;
                  this.sessionManager.touch(sid);
                } else {
                  sid = null;
                }
              }
            }
            if (!sid) {
              const sess = await this.sessionManager.create(userId, { socketId: socket.id });
              sid = sess.id;
              const nav = new BdrisNavigator(sess.page);
              // Proven trap (live stub page reused forever): a
              // gotoForm failure must NOT leave this session in
              // the map — the next START/INIT would find it via
              // findByUser and reuse it as READY without ever
              // re-navigating, so every later geo call inherits
              // the same stub page. Destroy it; the next attempt
              // creates a fresh page instead.
              try {
                await nav.gotoForm();
              } catch (e) {
                await this.sessionManager.destroy(sid).catch(() => {});
                throw e;
              }
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
          // Same-user takeover: reuse existing session, but only
          // if it still has form content (G7) — a stub reuse is
          // destroyed and falls through to fresh creation below.
          if (userId) {
            const existing = this.sessionManager.findByUser(userId);
            if (existing) {
              if (await verifyReusedSession(existing.id)) {
                sessionId = existing.id;
                this.sessionManager.touch(sessionId);
                this.log(`Session reused: ${sessionId} (user ${userId})`);
                if (callback) callback({ ok: true, sessionId, reused: true });
                socket.emit('SESSION_READY', { sessionId });
                return;
              }
              sessionId = null;
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
          // Proven trap (see START_BDRIS_SESSION above): on a
          // gotoForm failure, destroy this session and clear the
          // closure id — otherwise the failed session stays in
          // the map, the next INIT reuses it via findByUser
          // without re-navigating, and every later geo call
          // inherits the same stub page.
          try {
            await nav.gotoForm();
          } catch (e) {
            await this.sessionManager.destroy(sessionId).catch(() => {});
            sessionId = null;
            throw e;
          }

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
              // Proven trap (see START_BDRIS_SESSION above):
              // destroy on gotoForm failure so the next call
              // creates a fresh page instead of reusing this stub
              // via findByUser.
              try {
                await nav0.gotoForm();
              } catch (e) {
                await this.sessionManager.destroy(sid).catch(() => {});
                throw e;
              }
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

      // Stage A probe direct (2026-10-27): the frontend button emits
      // HTTP_PROBE_STAGE_A directly (ack callback, like
      // GET_ADDRESS_OPTIONS). Without this handler the emit reached
      // NO listener — the ack never fired and the button timed out
      // with zero server log lines (live demo 2026-10-27). The
      // executor registration alone does not route socket events.
      socket.on('HTTP_PROBE_STAGE_A', async (data = {}, callback) => {
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
              // Same proven trap as GET_ADDRESS_OPTIONS: destroy on
              // gotoForm failure so the next call creates a fresh
              // page instead of reusing a stub via findByUser.
              try {
                await nav0.gotoForm();
              } catch (e) {
                await this.sessionManager.destroy(sid).catch(() => {});
                throw e;
              }
            }
            sessionId = sid;
          }
          const session = this.sessionManager.get(sessionId);
          if (!session) {
            if (callback) callback({ ok: false, error: 'SESSION_EXPIRED' });
            return;
          }
          this.sessionManager.touch(sessionId);
          const result = await this.executor.execute('HTTP_PROBE_STAGE_A', data, {
            session,
            emit: (ev, payload) => socket.emit(ev, payload),
            socket,
          });
          // The probe result shape is already the ack shape.
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
              // S4Prep-area fix (2026-10-28, item 6): mirror the
              // destroy-on-failure in INIT/START/GET_ADDRESS/PROBE.
              // Without this, a failed/stub page stayed ACTIVE and
              // the next step ran on that broken page. The session
              // was just created above, so destroy it and clear the
              // closure id; the next op auto-inits fresh instead.
              if (sessionId) {
                const failedId = sessionId;
                sessionId = null;
                await this.sessionManager.destroy(failedId).catch(() => {});
              }
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
          // FINAL-SOLUTION (2026-10-30, problem-map #6): log
          // which path chose this bot submit — a user press, or
          // the direct-submit fallback — so the next live filing's
          // path is provable from the journal. _submitSource is a
          // safe enum the frontend sets (never a phone, code, or
          // name); unknown/absent sources log as 'unknown', never
          // guessed. (This loop is the real S4_OTP dispatch — the
          // frontend emits under the op name, not ENGINE_COMMAND.)
          if (evName === 'SUBMIT_S4_OTP') {
            const src = (data && typeof data._submitSource === 'string' && data._submitSource) || 'unknown';
            console.log(`BOT-SUBMIT-DECISION source=${src.slice(0, 32)}`);
          }
          try {
            const result = await this.executor.execute(evName, data, {
              session,
              emit: (ev, payload) => socket.emit(ev, payload),
              socket,
            });
            // S4PREP silent-timeout fix (2026-10-28): never forward
            // a failure (above all a TIMEOUT) with an empty failed
            // list — manualStepAck's failure branch requires
            // d.blocked || failed.length, so an empty list made the
            // timeout masquerade as the OTP 'sending' view. And a
            // timed-out op's page is untrusted (withTimeout never
            // cancels the underlying work, and sessions are reused
            // across reloads), so drop the session: the next op
            // bootstraps a fresh page instead of fighting a zombie.
            const ack = toStepAck(result);
            if (shouldDropSession(result) && sessionId) {
              const dropped = sessionId;
              sessionId = null;
              await this.sessionManager.destroy(dropped).catch(() => {});
              console.log(`SESSION-DROPPED-TIMEOUT: ${evName}`);
            }
            // v1 shape: {step, message, failed, blocked}
            socket.emit('STEP_CHANGE_ACK', ack);
            // S4 completion → BOT_STATUS/COMPLETED for frontend
            if (evName === 'SUBMIT_S4_OTP' && result.ok && result.completed) {
              // Debug-2 (2026-10-26): v1 saved the original-PDF
              // record into the shared index at submit success
              // (origIndexPut) so the later FETCH_ORIGINAL {ack}
              // could find it; v2 built originalRec but NEVER
              // saved it (saveRec had zero production callers),
              // so every post-submit FETCH_ORIGINAL died with
              // NO_RECORD. Persist it here, mirroring v1.
              if (result.originalRec && result.ackNum) {
                try { if (this.originalFetcher) this.originalFetcher.saveRec(result.ackNum, result.originalRec); } catch { /* ঐচ্ছিক */ }
              }
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

      // Legacy: Draft handlers (v1 compat) — writes via the
      // module-level saveDraftRecord (shared with HTTP /draft-save);
      // reads keep the local dir helper below, unchanged.
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
          const r = saveDraftRecord(uid, data);
          socket.emit('BOT_STATUS', { status: 'PROGRESS', message: `💾 খসড়া সংরক্ষিত (${r.draftId})` });
          if (callback) callback({ ok: true, draftId: r.draftId, savedAt: r.savedAt });
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

      // QTRACE DIAGNOSTIC (2026-10-28): ব্রাউজারের সারি-ঘটনা জার্নালে —
      // আচরণ নয়, শুধু লগ। ক্লায়েন্ট শুধু অপের নাম/সংখ্যা/বুলিয়ান পাঠায়;
      // এখানেও শুধু সেই সাদা ক্ষেত্রগুলোই ছাপা হয়, আর কিছু নয়।
      socket.on('CLIENT_TRACE', (d = {}) => {
        try {
          if (!d || typeof d !== 'object') return;
          const ev = typeof d.ev === 'string' ? d.ev.slice(0, 24) : '';
          if (!ev) return;
          const op = typeof d.op === 'string' ? d.op.slice(0, 24) : '';
          const parts = ['CLIENT-TRACE:', ev];
          if (op) parts.push(op);
          if (typeof d.q === 'number') parts.push('q=' + d.q);
          if (typeof d.failed === 'number') parts.push('failed=' + d.failed);
          if (typeof d.ready === 'boolean') parts.push('ready=' + d.ready);
          if (typeof d.conn === 'boolean') parts.push('conn=' + d.conn);
          if (typeof d.busy === 'boolean') parts.push('busy=' + d.busy);
          if (typeof d.saved === 'boolean') parts.push('saved=' + d.saved);
          if (typeof d.repump === 'boolean') parts.push('repump=' + d.repump);
          if (typeof d.blocked === 'boolean') parts.push('blocked=' + d.blocked);
          if (typeof d.dropped === 'string' && d.dropped) parts.push('dropped=' + d.dropped.slice(0, 120));
          console.log(parts.join(' '));
        } catch (e) {}
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

      // Phase 1 (2026-10-27): value-first DOM mirror — frontend
      // geoMirror already sends {selector, label, value, childSelector}
      // but v2 had no handler, so mirrors died in a 14s timeout and
      // geoChanged swallowed it. Ported from the old server's
      // SELECT_DOM_OPTION (value first, then label fallback).
      socket.on('SELECT_DOM_OPTION', async (data = {}, callback) => {
        try {
          if (!sessionId) { if (callback) callback({ error: 'Bot not ready' }); return; }
          const session = this.sessionManager.get(sessionId);
          if (!session || !session.page) { if (callback) callback({ error: 'Bot not ready' }); return; }
          this.sessionManager.touch(sessionId);
          const nav = new BdrisNavigator(session.page);
          const { selector, label, childSelector, value } = data || {};
          let done = false;
          if (value) done = await nav.selectOption(selector, '', { value });
          if (!done && label) done = await nav.selectOption(selector, label);
          if (!done) { if (callback) callback({ error: `Option not found: ${label}` }); return; }
          if (childSelector) await nav.waitForOptions(childSelector, 10000).catch(() => {});
          if (callback) callback({ success: true });
        } catch (e) {
          if (callback) callback({ error: 'অপশন বাছা যায়নি — আবার চেষ্টা করুন' });
        }
      });

      socket.on('disconnect', async (reason) => {
        // DISCONNECT-REASON DIAGNOSTIC (2026-10-28): socket.io passes the
        // disconnect reason — log it so the next drop names its own cause
        // (parser rejection vs ping timeout vs transport error).
        this.log(`Disconnected: ${socket.id} reason=${reason}`);
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

  // DIRECT HTTP BYPASS (2026-10-29): plain-HTTP trigger for the
  // direct chain — the SAME executor call the socket
  // ENGINE_COMMAND handler makes, so response shapes cannot drift.
  // The browser socket dies every few minutes (transport close);
  // a short POST survives it, and the chain itself already runs
  // server-side. Auth is two-layer: the backend mount already
  // enforced its JWT + rate limit before proxying, and this route
  // re-verifies the same JWT (body _authToken, same id precedence
  // as io.use) to derive userId — the charge gate binds tokens to
  // that id, so a client-supplied userId is never trusted, and the
  // token itself is never logged. Returns {status, body} so tests
  // can call it without HTTP.
  async handleHttpChainRequest(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, body: { ok: false, error: 'BAD_REQUEST', message: 'Request body must be a JSON object.' } };
    }
    const secret = process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '';
    const tokenPayload = verifyJwtHS256(body._authToken, secret);
    const userId = tokenPayload ? (tokenPayload.id || tokenPayload.sub || tokenPayload.userId) : null;
    if (!userId) {
      return { status: 401, body: { ok: false, error: 'UNAUTHORIZED', message: 'Valid access token required.' } };
    }
    // Fresh execution only: a replayed _commandId would return a
    // cached result (e.g. a stale sent-proof without sending), and
    // a client _timeoutMs must not stretch the executor window.
    const params = { ...body };
    delete params._authToken;
    delete params._commandId;
    delete params._timeoutMs;
    // Server-side flag, never a client guess (the executor handler
    // enforces it again as a second layer). Shape is verbatim the
    // runSubmitHttpChain disabled return, so the frontend's
    // existing disabled → bot-fallback branch handles it.
    if (!isHttpPathEnabled()) {
      return { status: 200, body: {
        ok: false, httpPath: 'disabled', disabled: true, error: 'HTTP_PATH_DISABLED',
        candidate: true, candidateLabel: HTTP_CANDIDATE_LABEL,
        message: 'HTTP path is disabled (opt-in BDRIS_HTTP_PATH=on not set) — this command executed nothing; the caller runs the existing Playwright flow itself.',
      } };
    }
    const session = this.sessionManager.findByUser(userId);
    if (!session) {
      return { status: 200, body: { ok: false, error: 'NO_SESSION', message: 'Session not initialized' } };
    }
    this.sessionManager.touch(session.id);
    // Progress/DONE events (e.g. the Playwright fallback's
    // COMPLETED) go to the session's socket when one is alive —
    // best-effort only: a dead socket drops them silently, exactly
    // as a dead socket drops the socket path's own events.
    const engine = this;
    const emit = (ev, msg) => {
      try {
        const sid = session.metadata && session.metadata.socketId;
        if (sid && engine.io) engine.io.to(sid).emit(ev, msg);
      } catch {}
    };
    // IDEMPOTENCY GUARD (2026-10-30, double-emit root fix): an
    // identical phase for the same filing joins the in-flight run
    // or replays a fresh success — never a second chain execution.
    // Maps live on the engine instance (lazily created so
    // prototype-built test engines work); per-process by design,
    // because the duplication is two POSTs in one process. Failed /
    // blocked / fallback / unknown results are never cached, so a
    // deliberate retry after failure always runs fresh. The guard
    // key is never logged (it carries phone/name/DOB).
    if (!this._httpChainGuard) this._httpChainGuard = { inflight: new Map(), done: new Map() };
    const guard = this._httpChainGuard;
    const guardKey = httpChainGuardKey(userId, params);
    const guardNow = Date.now();
    for (const [k, v] of guard.done) { if (guardNow - v.at >= HTTP_CHAIN_DEDUP_TTL_MS) guard.done.delete(k); }
    // FINAL-SOLUTION (2026-10-30, problem-map #6): every chain
    // outcome logs its decision (phase + result kind + machine
    // flags only — never identifiers) so the next live filing's
    // path is provable from the journal.
    const logChainDecision = (outcomeLabel, body) => {
      const b = (body && typeof body === 'object') ? body : {};
      console.log(`HTTP-CHAIN-DECISION phase=${params.phase || 'unknown'} outcome=${outcomeLabel} ok=${b.ok === true} fallback=${b.fallback === true || b.httpFallback === true} httpStep=${b.httpStep || ''} error=${b.error || ''} sessionDead=${b.sessionDead === true} otpUnexpired=${b.otpUnexpired === true}`);
    };
    const inFlight = guard.inflight.get(guardKey);
    if (inFlight) {
      const shared = await inFlight;
      logChainDecision('joined-inflight', shared.body);
      return { status: shared.status, body: shared.body };
    }
    const cached = guard.done.get(guardKey);
    if (cached && guardNow - cached.at < HTTP_CHAIN_DEDUP_TTL_MS) {
      logChainDecision('replayed-cached', cached.body);
      return { status: cached.status, body: cached.body };
    }
    const runPromise = (async () => {
      try {
        const result = await this.executor.execute('SUBMIT_HTTP_CHAIN', params, {
          session, emit, userId, socket: null,
        });
        return { status: 200, body: result };
      } catch (e) {
        return { status: 500, body: { ok: false, error: 'EXECUTION_FAILED', message: (e && e.message) || 'Command execution failed' } };
      }
    })();
    guard.inflight.set(guardKey, runPromise);
    const outcome = await runPromise;
    // Cache-then-release with no await between them, so no waiter
    // can slip between the two map updates.
    if (outcome.body && outcome.body.ok === true) {
      guard.done.set(guardKey, { status: outcome.status, body: outcome.body, at: Date.now() });
      while (guard.done.size > HTTP_CHAIN_DEDUP_MAX_KEYS) {
        const firstKey = guard.done.keys().next().value;
        guard.done.delete(firstKey);
      }
    }
    guard.inflight.delete(guardKey);
    logChainDecision(outcome.body && outcome.body.ok === true ? 'direct-success' : 'direct-failure', outcome.body);
    return outcome;
  }

  // REGISTER-PROBE TRIGGER (2026-10-30): plain-HTTP trigger for the
  // probeRegisterEndpoint() diagnostic — same shape discipline as
  // handleHttpChainRequest (returns {status, body} so tests can call
  // it without HTTP). Auth is the SAME two-layer gate as /http-chain
  // and /draft-save: the backend mount already enforced its JWT +
  // rate limit before proxying, and this handler re-verifies the
  // same JWT (body _authToken, same id precedence as io.use) to
  // derive userId — a client-supplied userId is never trusted, and
  // the token itself is never logged or forwarded. The probe client
  // is seeded EXACTLY like the submit chain's (SUBMIT_HTTP_CHAIN
  // executor): the requesting user's session page goes through
  // HttpGeoService.seedFromPage, which seeds a client from the
  // page's cookies + CSRF. No session page, or a failed seed,
  // returns an error and attempts NO bare bootstrap (proven 403)
  // and NO probe call. The probe is the ONLY BDRIS call this
  // handler ever makes: it sends an empty body that cannot create
  // a record, and returns only {status, isJson, wording}. No
  // frontend button exists for it — the live run is an explicit
  // server-side call.
  async handleProbeRegisterRequest(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, body: { ok: false, error: 'BAD_REQUEST', message: 'Request body must be a JSON object.' } };
    }
    const secret = process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '';
    const tokenPayload = verifyJwtHS256(body._authToken, secret);
    const userId = tokenPayload ? (tokenPayload.id || tokenPayload.sub || tokenPayload.userId) : null;
    if (!userId) {
      return { status: 401, body: { ok: false, error: 'UNAUTHORIZED', message: 'Valid access token required.' } };
    }
    const session = this.sessionManager.findByUser(userId);
    if (!session) {
      return { status: 200, body: { ok: false, error: 'NO_SESSION', message: 'Session not initialized' } };
    }
    if (!session.page) {
      return { status: 200, body: { ok: false, error: 'NO_SESSION_PAGE', message: 'Probe needs a warm browser session page to seed from.' } };
    }
    let client = null;
    try {
      const geo = new HttpGeoService();
      if (await geo.seedFromPage(session.page)) client = geo.client;
    } catch {
      client = null;
    }
    if (!client) {
      return { status: 200, body: { ok: false, error: 'SEED_FAILED', message: 'Session page seeding failed; no bare bootstrap attempted.' } };
    }
    const result = await client.probeRegisterEndpoint();
    return { status: 200, body: { status: result.status, isJson: result.isJson, wording: result.wording } };
  }

  // REGISTER-SCRIPT PROBE (2026-10-30): POST /probe-register-script —
  // the read-only diagnostic that settles WHERE the warm form page
  // itself calls /api/br/application/register. Same two-layer gate
  // as /probe-register (body _authToken verified via verifyJwtHS256,
  // same id precedence, token never logged or forwarded) and the
  // same session seeding (sessionManager.findByUser + HttpGeoService
  // .seedFromPage, no bare bootstrap on failure). It then reads the
  // warm page's script refs via page.evaluate, fetches each
  // same-origin script's text with the seeded client, and returns
  // ONLY RegisterScriptProbe's reduced result: script pathnames,
  // inline presence, found booleans, match counts, and — for
  // matching scripts only — HTTP method if visible plus payload
  // key NAMES only. No script text, page content, cookie, token,
  // or value ever leaves the server in this response. It calls NO
  // submit/OTP/charge/draft function and NO register endpoint POST
  // itself — searching script text is not submitting. No frontend
  // button exists for it — the live run is an explicit call.
  async handleProbeRegisterScriptRequest(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, body: { ok: false, error: 'BAD_REQUEST', message: 'Request body must be a JSON object.' } };
    }
    const secret = process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '';
    const tokenPayload = verifyJwtHS256(body._authToken, secret);
    const userId = tokenPayload ? (tokenPayload.id || tokenPayload.sub || tokenPayload.userId) : null;
    if (!userId) {
      return { status: 401, body: { ok: false, error: 'UNAUTHORIZED', message: 'Valid access token required.' } };
    }
    const session = this.sessionManager.findByUser(userId);
    if (!session) {
      return { status: 200, body: { ok: false, error: 'NO_SESSION', message: 'Session not initialized' } };
    }
    if (!session.page) {
      return { status: 200, body: { ok: false, error: 'NO_SESSION_PAGE', message: 'Script probe needs a warm browser session page to read script refs from.' } };
    }
    let client = null;
    try {
      const geo = new HttpGeoService();
      if (await geo.seedFromPage(session.page)) client = geo.client;
    } catch {
      client = null;
    }
    if (!client) {
      return { status: 200, body: { ok: false, error: 'SEED_FAILED', message: 'Session page seeding failed; no bare bootstrap attempted.' } };
    }
    // Static assets need no CSRF, but carry the seeded headers when
    // available; a client that cannot produce them still fetches.
    let headers = {};
    try { headers = client.apiHeaders(); } catch { headers = {}; }
    try {
      const result = await probePageScripts({
        page: session.page,
        fetchText: async (p) => {
          const r = await client.request(p, { headers });
          if (!r || r.status !== 200 || typeof r.text !== 'string') throw new Error('script fetch failed');
          return r.text;
        },
      });
      return { status: 200, body: result };
    } catch {
      return { status: 200, body: { ok: false, error: 'SCRIPT_PROBE_FAILED', message: 'Warm page script collection failed.' } };
    }
  }

  // DIRECT HTTP BYPASS (2026-10-29): POST /http-chain, reached
  // externally as /api/bdris-apply/http-chain through the backend
  // mount (requireAuth + rate limit) and the adapter proxy.
  setupHttpRoutes(app) {
    app.post('/http-chain', async (req, res) => {
      try {
        const r = await this.handleHttpChainRequest(req.body);
        res.status(r.status).json(r.body);
      } catch {
        res.status(500).json({ ok: false, error: 'EXECUTION_FAILED' });
      }
    });
    // FINAL-SOLUTION (2026-10-30, problem-map #9): POST /draft-save
    // — the auto-save endpoint for the frontend's silent draft
    // save (preview + send success). Same JWT verification as
    // /http-chain (the adapter strips Authorization before
    // proxying, so the token travels in the body, as there).
    // Reached externally as /api/bdris-apply/draft-save through
    // the backend mount (requireAuth + rate limit). Body:
    // {_authToken, draft: <full draftPayload incl. docs base64>}.
    // Returns {ok, draftId, savedAt} — the restore proof is the
    // draft list (LIST_DRAFTS) showing this id afterwards.
    app.post('/draft-save', async (req, res) => {
      try {
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const secret = process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '';
        const tokenPayload = verifyJwtHS256(body._authToken, secret);
        const userId = tokenPayload ? (tokenPayload.id || tokenPayload.sub || tokenPayload.userId) : null;
        if (!userId) {
          res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Valid access token required.' });
          return;
        }
        if (!body.draft || typeof body.draft !== 'object') {
          res.status(400).json({ ok: false, error: 'BAD_REQUEST', message: 'draft object required.' });
          return;
        }
        const r = saveDraftRecord(userId, body.draft);
        console.log(`DRAFT-AUTOSAVE: user draft ${r.draftId} saved via HTTP`);
        res.status(200).json({ ok: true, draftId: r.draftId, savedAt: r.savedAt });
      } catch {
        res.status(500).json({ ok: false, error: 'DRAFT_SAVE_FAILED' });
      }
    });
    // REGISTER-PROBE TRIGGER (2026-10-30): POST /probe-register —
    // the minimal trigger for handleProbeRegisterRequest above.
    // Reached externally as /api/bdris-apply/probe-register through
    // the backend mount (requireAuth + rate limit) and the adapter
    // proxy. POST only, so it cannot fire from a link or prefetch;
    // no frontend button exists for it.
    app.post('/probe-register', async (req, res) => {
      try {
        const r = await this.handleProbeRegisterRequest(req.body);
        res.status(r.status).json(r.body);
      } catch {
        res.status(500).json({ ok: false, error: 'PROBE_FAILED' });
      }
    });
    // REGISTER-SCRIPT PROBE (2026-10-30): POST /probe-register-script
    // — the minimal trigger for handleProbeRegisterScriptRequest
    // above. Reached externally as /api/bdris-apply/probe-register-script
    // through the backend mount (requireAuth + rate limit) and the
    // adapter proxy. POST only, so it cannot fire from a link or
    // prefetch; no frontend button exists for it.
    app.post('/probe-register-script', async (req, res) => {
      try {
        const r = await this.handleProbeRegisterScriptRequest(req.body);
        res.status(r.status).json(r.body);
      } catch {
        res.status(500).json({ ok: false, error: 'PROBE_FAILED' });
      }
    });
  }
}

module.exports = { BdrisEngineV2, mergeStepParams, buildPlaywrightFallbackPlan, httpChainGuardKey, HTTP_CHAIN_DEDUP_TTL_MS, saveDraftRecord, draftsDirFor };

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
  // PING-TIMEOUT FIX (2026-10-28): socket.io defaults allow only 20s for a
  // pong after each 25s ping. Background tabs (timer throttling) and slow
  // networks stall longer than that, so the server declared 'ping timeout'
  // and dropped live sessions mid-application. 60s keeps dead-connection
  // detection finite (~85s worst case) while surviving stalls/throttling
  // bursts; the 25s ping interval is unchanged so middleboxes still see
  // regular traffic.
  const io = new Server(server, {
    cors: { origin: true, credentials: true },
    pingInterval: 25000,
    pingTimeout: 60000,
  });

  const engine = new BdrisEngineV2(io, {});
  // setupSocketHandlers() constructor-এই call হয়
  // DIRECT HTTP BYPASS (2026-10-29): plain-HTTP trigger route.
  engine.setupHttpRoutes(app);

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

  // GRACEFUL SHUTDOWN (#13 service timeout loop, 2026-10-30): the old
  // shutdown did `server.close(() => exit)` WITHOUT closing socket.io,
  // so server.close() never called back while any client stayed
  // connected — and session/browser closes had no bound at all. That
  // is why systemd's 5s stop budget expired and the whole cgroup got
  // SIGKILLed twice. Every step below is bounded and a 20s hard timer
  // forces exit (live unit is now TimeoutStopSec=30s); the typical
  // path completes in ~1-2s. A second signal forces immediate exit.
  const { createShutdown, closeServer } = require('./core/Shutdown');
  const shutdown = createShutdown({
    hardTimeoutMs: 20000,
    logFn: (m) => console.log(`[bdris-apply-v2:shutdown] ${m}`),
    steps: [
      { name: 'http-stop-accepting', timeoutMs: 5000, fn: () => closeServer(server, io, 5000, (m) => console.log(`[bdris-apply-v2:shutdown] ${m}`)) },
      { name: 'engine-sessions', timeoutMs: 8000, fn: () => engine.sessionManager.closeAll() },
      { name: 'engine-browser', timeoutMs: 8000, fn: () => engine.browserManager.close() },
    ],
  });
  let _shutdownSignaled = false;
  const onSignal = () => {
    if (_shutdownSignaled) { process.exit(0); return; }
    _shutdownSignaled = true;
    shutdown.run();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
