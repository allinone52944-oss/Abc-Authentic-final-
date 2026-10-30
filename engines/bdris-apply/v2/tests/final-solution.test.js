/**
 * FINAL-SOLUTION FIX PACK (2026-10-30) — problem-map items, one test
 * per fix where testable (node:test, no live contact, no browser,
 * no personal data; fixture values only).
 *
 * Covered:
 *  #1  submit-response summary: re-rendered form vs real rejection
 *      shapes, and SUBMIT_NOT_SUCCESS carrying the summary.
 *  #3  OTP evidence freshness: a stale ticking countdown is NOT
 *      fresh proof; a reset countdown / new toast IS.
 *  #5  Executor in-flight join: concurrent identical SUBMIT_* ops
 *      for one user run once; different payload/user/sequential
 *      runs still run separately.
 *  #6  Chain decision flags: SESSION_DEAD / OTP_SEND_UNEXPIRED
 *      propagate to the result for the UI to branch on.
 *  #7  S2B phase budget (source-pattern guard, same approach as
 *      the frontend static suite): phase logs + budget skips
 *      present, 120s executor cap unchanged.
 *  #8  otpSend session-dead classification (redirect/auth/non-JSON).
 *  #9  saveDraftRecord round-trip + id sanitisation (HTTP
 *      /draft-save shares this store with socket SAVE_DRAFT).
 *  #14 otpSend 400-unexpired classification (previous code valid).
 *
 * Run: node --test engines/bdris-apply/v2/tests/final-solution.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, after } = require('node:test');

const { BdrisHttpClient, submitResponseSummary } = require('../http/client');
const { CommandExecutor } = require('../core/CommandExecutor');
const { runHttpChain } = require('../services/HttpPathRunner');
const { StepHandler } = require('../services/StepHandler');
const { saveDraftRecord, draftsDirFor } = require('../server');

const SUCCESS_PHRASE = 'আবেদনপত্রটি সফল ভাবে সাবমিট করা হয়েছে';

// ---------- #1: submit-response summary ----------

describe('final-solution #1: submit-response summary', () => {
  it('re-rendered form page: formFields true, successPhrase false', () => {
    const s = submitResponseSummary({
      status: 200, json: null,
      text: '<html><form><input name="personInfoForBirth.father.ubrn"></form></html>',
    });
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.isJson, false);
    assert.strictEqual(s.hasSuccessPhrase, false);
    assert.strictEqual(s.hasFormFields, true);
    // The old [field: ubrn] heuristic would have called this a
    // ubrn rejection; the summary proves it is just a form page.
    assert.ok(!JSON.stringify(s).includes('ubrn'), 'summary carries no field values');
  });

  it('success page: phrase true, print link detected', () => {
    const s = submitResponseSummary({
      status: 200, json: null,
      text: `<html>${SUCCESS_PHRASE} <a href="/admin/br/application/print">print</a></html>`,
    });
    assert.strictEqual(s.hasSuccessPhrase, true);
    assert.strictEqual(s.hasPrintLink, true);
    assert.strictEqual(s.hasFormFields, false);
  });

  it('JSON success: jsonSuccess true', () => {
    const s = submitResponseSummary({ status: 200, json: { success: true }, text: '' });
    assert.strictEqual(s.jsonSuccess, true);
    assert.strictEqual(s.isJson, true);
  });

  it('submitApplication attaches the summary to SUBMIT_NOT_SUCCESS', async () => {
    const c = new BdrisHttpClient({ base: 'https://example.invalid' });
    c.bootstrapped = true;
    c.csrfToken = 'test-csrf';
    c.request = async () => ({
      ok: true, status: 200, json: null,
      text: '<html><form><input name="personInfoForBirth.father.ubrn"></form></html>',
    });
    const addr = {
      division: 'Dhaka', district: 'Dhaka', cityCorpUpazila: 'DSCC',
      postBn: 'Post', postEn: 'Post', vilBn: 'Vil', vilEn: 'Vil',
    };
    await assert.rejects(
      () => c.submitApplication({
        person: { firstNameBn: 'A', firstNameEn: 'A', dob: '1980-02-02', thChild: '1', gender: 'MALE' },
        father: { nameBn: 'F', nameEn: 'F' },
        mother: { nameBn: 'M', nameEn: 'M' },
        birthPlace: addr, permAddr: addr, prsntAddr: addr,
        relation: 'SELF', phone: '01000000000', otp: '123456',
        documents: [{ attachmentType: 40, id: 40 }, { attachmentType: 41, id: 41 }],
      }),
      (e) => {
        assert.strictEqual(e.code, 'SUBMIT_NOT_SUCCESS');
        assert.ok(e.responseSummary, 'summary attached');
        assert.strictEqual(e.responseSummary.hasFormFields, true);
        assert.strictEqual(e.responseSummary.hasSuccessPhrase, false);
        assert.ok(!e.message.includes('personInfoForBirth'), 'message carries no form text');
        return true;
      }
    );
  });
});

// ---------- #8 + #14: otpSend classification ----------

function sendClient(requestFn) {
  const c = new BdrisHttpClient({ base: 'https://example.invalid' });
  c.bootstrapped = true;
  c.csrfToken = 'test-csrf';
  c.request = requestFn;
  return c;
}
const sendData = {
  phone: '01000000000', email: '', officeId: '0', personUbrn: '',
  relation: 'SELF', applicantName: 'Test', applicantBrn: '',
  applicantDob: '1980-02-02', officeAddressType: 'PERMANENT',
};

describe('final-solution #8/#14: otpSend classification', () => {
  it('200 non-JSON (HTML/stub) send -> SESSION_DEAD, never sent-proof', async () => {
    const c = sendClient(async () => ({ ok: true, status: 200, json: null, text: '<html>login</html>' }));
    await assert.rejects(() => c.otpSend(sendData), (e) => e.code === 'SESSION_DEAD');
  });

  it('302 send -> SESSION_DEAD', async () => {
    const c = sendClient(async () => ({ ok: false, status: 302, json: null, text: '' }));
    await assert.rejects(() => c.otpSend(sendData), (e) => e.code === 'SESSION_DEAD');
  });

  it('400 with unexpired wording -> OTP_SEND_UNEXPIRED (previous code valid)', async () => {
    const c = sendClient(async () => ({
      ok: false, status: 400, json: { message: 'ওটিপি-এর মেয়াদ শেষ হয়নি', success: false }, text: '',
    }));
    await assert.rejects(() => c.otpSend(sendData), (e) => e.code === 'OTP_SEND_UNEXPIRED');
  });

  it('400 with other wording stays OTP_SEND_FAILED', async () => {
    const c = sendClient(async () => ({
      ok: false, status: 400, json: { message: 'Invalid Operation', success: false }, text: '',
    }));
    await assert.rejects(() => c.otpSend(sendData), (e) => e.code === 'OTP_SEND_FAILED');
  });

  it('400 with a non-JSON body is NOT session-dead (server answer, bot fallback stays open)', async () => {
    const c = sendClient(async () => ({ ok: false, status: 400, json: null, text: '<html>Bad Request</html>' }));
    await assert.rejects(() => c.otpSend(sendData), (e) => e.code === 'OTP_SEND_FAILED');
  });

  it('200 MESSAGE_SENT JSON still succeeds', async () => {
    const c = sendClient(async () => ({
      ok: true, status: 200, json: { code: 'MESSAGE_SENT', success: true, payload: null }, text: '',
    }));
    const r = await c.otpSend(sendData);
    assert.strictEqual(r.code, 'MESSAGE_SENT');
  });
});

// ---------- #3: OTP evidence freshness ----------

function evalPage(states) {
  let i = 0;
  return {
    evaluate: async () => {
      const s = states[Math.min(i++, states.length - 1)];
      return {
        toasts: (s.toasts || []).map((t) => ({ txt: t.txt, err: !!t.err, ok: !!t.ok })),
        interval: !!s.interval,
        intervalText: s.intervalText || '',
        sendHidden: false,
      };
    },
    waitForTimeout: async () => {},
  };
}

describe('final-solution #3: OTP evidence freshness', () => {
  it('stale ticking countdown is NOT fresh proof', async () => {
    const h = new StepHandler({ page: evalPage([
      { interval: true, intervalText: '04:58' },
      { interval: true, intervalText: '04:57' },
      { interval: true, intervalText: '04:56' },
    ]) });
    const before = { toasts: [], interval: true, intervalText: '04:59' };
    const ev = await h._waitOtpEvidence(30, before);
    assert.strictEqual(ev.ok, false, 'a countdown that only ticks down proves nothing new');
  });

  it('reset countdown (jumped up) IS fresh proof', async () => {
    const h = new StepHandler({ page: evalPage([{ interval: true, intervalText: '04:59' }]) });
    const before = { toasts: [], interval: true, intervalText: '02:10' };
    const ev = await h._waitOtpEvidence(1000, before);
    assert.strictEqual(ev.ok, true);
  });

  it('first send (no snapshot): visible interval counts', async () => {
    const h = new StepHandler({ page: evalPage([{ interval: true, intervalText: '04:59' }]) });
    const ev = await h._waitOtpEvidence(1000, null);
    assert.strictEqual(ev.ok, true);
  });

  it('new success toast IS fresh proof; stale toast alone is not', async () => {
    const fresh = new StepHandler({ page: evalPage([{ toasts: [{ txt: 'OTP sent', ok: true }] }]) });
    const ev1 = await fresh._waitOtpEvidence(1000, { toasts: ['earlier note'], interval: false, intervalText: '' });
    assert.strictEqual(ev1.ok, true);
    const stale = new StepHandler({ page: evalPage([{ toasts: [{ txt: 'OTP sent', ok: true }] }]) });
    const ev2 = await stale._waitOtpEvidence(30, { toasts: ['OTP sent'], interval: false, intervalText: '' });
    assert.strictEqual(ev2.ok, false, 'the same toast text from before the click proves nothing new');
  });
});

// ---------- #5: executor in-flight join ----------

describe('final-solution #5: executor in-flight join', () => {
  it('concurrent identical SUBMIT_S4_OTP (different _opId) runs once', async () => {
    const ex = new CommandExecutor();
    let runs = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    ex.register('SUBMIT_S4_OTP', async () => { runs++; await gate; return { step: 6 }; }, { timeoutMs: 5000 });
    const ctx = { userId: 'u1' };
    const p1 = ex.execute('SUBMIT_S4_OTP', { otp: '123456', _chargeToken: 'tok', _opId: 'a' }, ctx);
    const p2 = ex.execute('SUBMIT_S4_OTP', { otp: '123456', _chargeToken: 'tok', _opId: 'b' }, ctx);
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.strictEqual(runs, 1);
    assert.deepStrictEqual(a, b);
  });

  it('different otp, different user, sequential, non-SUBMIT: all run separately', async () => {
    const ex = new CommandExecutor();
    let runs = 0;
    ex.register('SUBMIT_S4_OTP', async () => { runs++; return { step: 6 }; }, { timeoutMs: 5000 });
    ex.register('GET_ADDRESS_OPTIONS', async () => { runs++; return { options: [] }; }, { timeoutMs: 5000 });
    await ex.execute('SUBMIT_S4_OTP', { otp: '111111' }, { userId: 'u1' });
    await ex.execute('SUBMIT_S4_OTP', { otp: '222222' }, { userId: 'u1' });
    await ex.execute('SUBMIT_S4_OTP', { otp: '111111' }, { userId: 'u2' });
    await ex.execute('SUBMIT_S4_OTP', { otp: '111111' }, { userId: 'u1' });
    await Promise.all([
      ex.execute('GET_ADDRESS_OPTIONS', { k: 'ward' }, { userId: 'u1' }),
      ex.execute('GET_ADDRESS_OPTIONS', { k: 'ward' }, { userId: 'u1' }),
    ]);
    assert.strictEqual(runs, 6);
  });
});

// ---------- #6: chain decision flags ----------

describe('final-solution #6: chain decision flags', () => {
  it('SESSION_DEAD send failure carries sessionDead + fallback, no bot confusion', async () => {
    const saved = process.env.BDRIS_HTTP_PATH;
    process.env.BDRIS_HTTP_PATH = 'on';
    try {
      const err = new Error('OTP send got a non-JSON response (status 200) — session refresh needed.');
      err.code = 'SESSION_DEAD';
      const out = await runHttpChain({
        data: {
          person: { dob: '1980-02-02' }, relation: 'SELF', applicantName: 'Test',
          phone: '01000000000', officeAddressType: 'PERMANENT',
        },
        phase: 'send',
        userId: 'u1',
        client: { bootstrapped: true, otpSend: async () => { throw err; } },
        log: () => {},
      });
      assert.strictEqual(out.fallback, true);
      assert.strictEqual(out.sessionDead, true);
      assert.strictEqual(out.otpUnexpired, false);
    } finally {
      if (saved === undefined) delete process.env.BDRIS_HTTP_PATH;
      else process.env.BDRIS_HTTP_PATH = saved;
    }
  });

  it('OTP_SEND_UNEXPIRED send failure carries otpUnexpired', async () => {
    const saved = process.env.BDRIS_HTTP_PATH;
    process.env.BDRIS_HTTP_PATH = 'on';
    try {
      const err = new Error('OTP send returned status 400: ওটিপি-এর মেয়াদ শেষ হয়নি. Previous code still valid.');
      err.code = 'OTP_SEND_UNEXPIRED';
      const out = await runHttpChain({
        data: {
          person: { dob: '1980-02-02' }, relation: 'SELF', applicantName: 'Test',
          phone: '01000000000', officeAddressType: 'PERMANENT',
        },
        phase: 'send',
        userId: 'u1',
        client: { bootstrapped: true, otpSend: async () => { throw err; } },
        log: () => {},
      });
      assert.strictEqual(out.fallback, true);
      assert.strictEqual(out.otpUnexpired, true);
      assert.strictEqual(out.sessionDead, false);
    } finally {
      if (saved === undefined) delete process.env.BDRIS_HTTP_PATH;
      else process.env.BDRIS_HTTP_PATH = saved;
    }
  });
});

// ---------- #7: S2B phase budget (source-pattern guard) ----------

describe('final-solution #7: S2B phase budget (pattern guard)', () => {
  it('phase logs + budget skips present, 120s cap unchanged', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'StepHandler.js'), 'utf8');
    assert.ok(src.includes('S2B-PHASE:'), 'per-phase timing logs');
    assert.ok(src.includes('refill-skipped-budget'), 're-fill loop budget skip');
    assert.ok(src.includes('retry-skipped-budget'), 'retry-next budget skip');
    // The cap lives in server.js registration, not StepHandler:
    // ['SUBMIT_S2B', 'submitS2B', 120000] — still 120000, the
    // number was NOT raised (banned band-aid).
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(serverSrc.includes("['SUBMIT_S2B', 'submitS2B', 120000]"), 'S2B executor window still 120s');
  });
});

// ---------- #4/#5/#6: decision + diagnosis log lines (pattern guard) ----------

describe('final-solution #4/#5/#6: journal log lines present', () => {
  it('S4PREP page-state, executor join, chain decision, bot-submit decision, draft autosave', () => {
    const handlerSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'StepHandler.js'), 'utf8');
    assert.ok(handlerSrc.includes('S4PREP-PAGESTATE:'), 'S4PREP failure captures page state');
    const execSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'CommandExecutor.js'), 'utf8');
    assert.ok(execSrc.includes('EXECUTOR-JOIN:'), 'socket in-flight join logs');
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(serverSrc.includes('HTTP-CHAIN-DECISION'), 'http-chain decision log');
    assert.ok(serverSrc.includes('BOT-SUBMIT-DECISION'), 'bot submit decision log');
    assert.ok(serverSrc.includes('DRAFT-AUTOSAVE:'), 'http draft-save log');
    assert.ok(serverSrc.includes("'/draft-save'"), 'HTTP /draft-save route registered');
  });
});

// ---------- #9: saveDraftRecord ----------

describe('final-solution #9: saveDraftRecord (shared socket + HTTP store)', () => {
  const uid = 'finalsol-test-user';
  after(() => {
    try { fs.rmSync(draftsDirFor(uid), { recursive: true, force: true }); } catch {}
  });

  it('round-trips a draft and sanitises a hostile id', () => {
    const r = saveDraftRecord(uid, { draftId: '../../evil id!', s1: { firstNameBn: 'A' } });
    assert.ok(!r.draftId.includes('/') && !r.draftId.includes(' '), 'id sanitised');
    assert.ok(r.savedAt);
    const back = JSON.parse(fs.readFileSync(path.join(draftsDirFor(uid), r.draftId + '.json'), 'utf8'));
    assert.strictEqual(back.s1.firstNameBn, 'A');
    assert.strictEqual(back.draftId, r.draftId);
  });

  it('same draftId overwrites (auto-save never piles copies)', () => {
    const a = saveDraftRecord(uid, { draftId: 'auto-1', uiStep: 6 });
    const b = saveDraftRecord(uid, { draftId: 'auto-1', uiStep: 6, phone: '01000000000' });
    assert.strictEqual(a.draftId, b.draftId);
    const files = fs.readdirSync(draftsDirFor(uid)).filter((f) => f.startsWith('auto-1'));
    assert.strictEqual(files.length, 1);
  });
});
