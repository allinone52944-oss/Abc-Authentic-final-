/**
 * SUBMIT-CONFIRM (2026-10-31) — bot final-submit confirmation
 * warning (node:test, no live contact, no browser, no personal
 * data; fixture values only).
 *
 * Live evidence (2026-10-31 ~16:37, post basis-fix deploy):
 * after the OTP code was supplied, the bot's final submit failed
 * TWICE identically. BDRIS shows a PRE-SUBMIT CONFIRMATION
 * WARNING — "আবেদনপত্রটি সাবমিট করার পূর্বে সকল তথ্য ঠিক
 * আছে কিনা দেখে নিন ও আবেদনকারীকে দেখান।" — and the bot
 * misclassified that warning as a validation error: no success
 * banner, no BDRIS 400, filing stuck at the OTP step with the
 * code boxes filled and buttons re-enabled. A third retry was
 * deliberately withheld (duplicate-submission risk).
 *
 * Covered:
 *  #1  The exact warning text (live phrase AND the mock
 *      variant) is a confirmation checkpoint: submitS4 confirms
 *      it through the site's own confirm control and proceeds to
 *      normal success detection — never a validation failure.
 *  #2  A genuine field validation error still fails the submit
 *      with its real reason (no blanket "ignore warnings" rule).
 *  #3  No double-submit on the confirmation path: the submit
 *      button is clicked exactly once; the confirm click only
 *      completes that same submit (cancel controls never clicked).
 *  #4  Warning present but no confirm control → an honest NAMED
 *      confirmation failure, never the warning text as a
 *      validation error and never a guessed OTP error.
 *  #5  The matcher itself: live phrase + mock variant match;
 *      genuine field errors, OTP errors, and empty text do not.
 *
 * Run: node --test engines/bdris-apply/v2/tests/submit-confirm.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const nodeCrypto = require('node:crypto');

const { StepHandler, isSubmitConfirmWarning } = require('../services/StepHandler');

const WARN_LIVE = 'আবেদনপত্রটি সাবমিট করার পূর্বে সকল তথ্য ঠিক আছে কিনা দেখে নিন ও আবেদনকারীকে দেখান।';
const WARN_MOCK = 'আবেদনপত্রটি সাবমিট করার পূর্বে সকল তথ্য ঠিক আছে কিনা দেখে নিন। একবার সাবমিট হয়ে গেলে এডিট করা যাবে না।';
const ACK_LINE = 'আবেদন নম্বর: 12345678901234567';

function validChargeToken(userId, secret, ref) {
  const head = `v1.${userId}.submit.${ref}.${Date.now()}`;
  const mac = nodeCrypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

// Stateful fake page. Element visibility is driven by state so a
// confirm click (warning hidden, success shown) is observable by
// the handler's later probes — the property a static stub lacks.
function makeConfirmPage(opts = {}) {
  const state = {
    warningVisible: opts.warningVisible !== false,
    successVisible: !!opts.successVisible,
    errorTexts: opts.errorTexts || [],
    dialogButtons: opts.dialogButtons || ['confirm'],
    globalButtons: opts.globalButtons || [],
    otpPresent: opts.otpPresent !== false,
    waitRejects: !!opts.waitRejects,
    submitClicks: 0, confirmClicks: 0, cancelClicks: 0,
  };

  const visGet = (cond) => ({
    get offsetParent() { return cond() ? {} : null; },
    getClientRects: () => (cond() ? [{}] : []),
  });
  const warnCond = () => state.warningVisible;
  const succCond = () => state.successVisible;

  function makeButton(kind) {
    const label = kind === 'confirm' ? 'নিশ্চিত করুন' : 'বাতিল';
    const el = {
      innerText: label, value: '', children: [],
      className: '', parentElement: null,
      getAttribute: () => null,
      querySelectorAll: () => [], querySelector: () => null,
      ...visGet(warnCond),
      click: () => {
        if (kind === 'confirm') {
          state.confirmClicks++;
          state.warningVisible = false;
          state.successVisible = true;
        } else {
          state.cancelClicks++;
        }
      },
    };
    return el;
  }

  const dialogButtons = state.dialogButtons.map(makeButton);
  const globalButtons = state.globalButtons.map(makeButton);

  const bodyEl = {
    get innerText() {
      if (state.warningVisible) return WARN_LIVE;
      if (state.successVisible) return ACK_LINE;
      return '';
    },
    children: [], className: '', parentElement: null,
    getAttribute: () => null,
    querySelectorAll: (sel) => (String(sel).includes('button') ? globalButtons : []),
    querySelector: () => null,
  };
  const dialogEl = {
    get innerText() {
      return (state.warningVisible ? WARN_LIVE : '')
        + '\n' + dialogButtons.map((b) => b.innerText).join('\n');
    },
    children: [], className: 'modal-content', parentElement: bodyEl,
    getAttribute: (n) => (n === 'role' ? 'dialog' : null),
    querySelectorAll: (sel) => (String(sel).includes('button') ? dialogButtons : []),
    querySelector: () => null,
    ...visGet(warnCond),
  };
  const warningEl = {
    innerText: WARN_LIVE, children: [], className: 'alert-info',
    parentElement: opts.noDialog ? bodyEl : dialogEl,
    getAttribute: () => null,
    querySelectorAll: () => [], querySelector: () => null,
    ...visGet(warnCond),
  };
  const successEl = {
    innerText: ACK_LINE, children: [], className: 'alert-success',
    parentElement: bodyEl,
    getAttribute: () => null,
    querySelectorAll: () => [], querySelector: () => null,
    ...visGet(succCond),
  };
  const errorEls = state.errorTexts.map((t) => ({
    innerText: t, children: [], className: 'text-danger',
    parentElement: bodyEl,
    getAttribute: () => null,
    querySelectorAll: () => [], querySelector: () => null,
    offsetParent: {}, getClientRects: () => [{}],
  }));
  const otpEl = { innerText: '', children: [], parentElement: bodyEl };

  const allEls = [warningEl, dialogEl, ...dialogButtons, ...globalButtons, successEl, ...errorEls];
  const doc = {
    body: bodyEl,
    querySelectorAll: (sel) => {
      const s = String(sel);
      if (s === 'body *') return allEls;
      if (s.includes('alert-success')) return state.successVisible ? [successEl] : [];
      if (s.includes('text-danger')) return errorEls;
      if (s.includes('jq-toast-single')) return [];
      return [];
    },
    querySelector: (sel) => {
      const s = String(sel);
      if (s.includes('alert-success')) return state.successVisible ? successEl : null;
      if (s.includes('otp')) return state.otpPresent ? otpEl : null;
      return null;
    },
  };

  const page = {
    evaluate: async (fn) => {
      const prev = global.document;
      global.document = doc;
      try { return await fn(); } finally { global.document = prev; }
    },
    waitForTimeout: async () => {},
    // Faithful success wait: resolves only when the success
    // banner is actually visible (a blind resolve would fake a
    // success the site never showed).
    waitForSelector: async () => {
      if (state.waitRejects || !state.successVisible) throw new Error('timeout');
      return {};
    },
    waitForEvent: async () => null,
    screenshot: async () => Buffer.from('fakepng'),
    url: () => 'https://bdris.gov.bd/br/application',
    _state: state,
  };
  return page;
}

function makeHandler(page, progress) {
  const h = new StepHandler({ page }, {
    emit: (ev, payload) => {
      if (ev === 'PROGRESS') progress.push(String(payload));
    },
    userId: 'u1',
  });
  h._ensureOtpStep = async () => ({ ok: true });
  h._typeInto = async () => ({ ok: true });
  h._waitVisible = async () => ({ click: async () => {} });
  h._robustClick = async () => { page._state.submitClicks++; };
  return h;
}

function withSecret(fn) {
  const prev = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret-confirm';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prev;
    });
}

test('matcher: live phrase and mock variant match; genuine errors do not', () => {
  assert.equal(isSubmitConfirmWarning(WARN_LIVE), true);
  assert.equal(isSubmitConfirmWarning(WARN_MOCK), true);
  assert.equal(isSubmitConfirmWarning('  ' + WARN_LIVE + '  '), true);
  assert.equal(isSubmitConfirmWarning('এই ঘরটি আবশ্যক'), false);
  assert.equal(isSubmitConfirmWarning('পিতার BRN সঠিক নয়'), false);
  assert.equal(isSubmitConfirmWarning('কোডটি মিলছে না বা মেয়াদ শেষ'), false);
  assert.equal(isSubmitConfirmWarning(''), false);
  assert.equal(isSubmitConfirmWarning(null), false);
});

test('detect: warning visible → text; absent → null', async () => {
  const h = makeHandler(makeConfirmPage({ warningVisible: true }), []);
  const found = await h._detectSubmitConfirm();
  assert.ok(found && found.includes('সাবমিট করার পূর্বে'), 'warning text returned');
  const h2 = makeHandler(makeConfirmPage({ warningVisible: false, successVisible: true }), []);
  assert.equal(await h2._detectSubmitConfirm(), null);
});

test('confirm dialog: confirm clicked, cancel never clicked', async () => {
  const page = makeConfirmPage({ dialogButtons: ['confirm', 'cancel'] });
  const h = makeHandler(page, []);
  assert.equal(await h._confirmSubmitDialog(), true);
  assert.equal(page._state.confirmClicks, 1);
  assert.equal(page._state.cancelClicks, 0);
});

test('confirm dialog: cancel-only → false, nothing clicked', async () => {
  const page = makeConfirmPage({ dialogButtons: ['cancel'], globalButtons: [] });
  const h = makeHandler(page, []);
  assert.equal(await h._confirmSubmitDialog(), false);
  assert.equal(page._state.confirmClicks, 0);
  assert.equal(page._state.cancelClicks, 0);
});

test('confirm dialog: global fallback confirm found when no dialog', async () => {
  const page = makeConfirmPage({ dialogButtons: [], globalButtons: ['confirm'], noDialog: true });
  const h = makeHandler(page, []);
  assert.equal(await h._confirmSubmitDialog(), true);
  assert.equal(page._state.confirmClicks, 1);
});

test('submitS4 confirmation path: warning → confirm → success, submit clicked once', async () => {
  await withSecret(async () => {
    const page = makeConfirmPage({ warningVisible: true, dialogButtons: ['confirm', 'cancel'] });
    const progress = [];
    const h = makeHandler(page, progress);
    const tok = validChargeToken('u1', 'test-secret-confirm', 'confirm-ok-1');
    const r = await h.submitS4({
      otp: '123456', _chargeToken: tok, s1: {}, s2: {}, s2b: {}, s3: {}, s4prep: {},
    });
    assert.equal(r.ok, true, 'submit succeeds after confirmation');
    assert.equal(r.completed, true);
    assert.match(String(r.ackNum || ''), /12345678901234567/);
    assert.equal(page._state.submitClicks, 1, 'no double-submit: submit button clicked once');
    assert.equal(page._state.confirmClicks, 1, 'confirm clicked once');
    assert.equal(page._state.cancelClicks, 0, 'cancel never clicked');
    assert.ok(progress.some((m) => m.includes('নিশ্চিতকরণ')), 'confirmation surfaced in progress');
  });
});

test('submitS4 genuine field error still fails with its real reason', async () => {
  await withSecret(async () => {
    const page = makeConfirmPage({
      warningVisible: false, errorTexts: ['এই ঘরটি আবশ্যক'],
      waitRejects: true,
    });
    const progress = [];
    const h = makeHandler(page, progress);
    const tok = validChargeToken('u1', 'test-secret-confirm', 'confirm-err-1');
    const r = await h.submitS4({
      otp: '123456', _chargeToken: tok, s1: {}, s2: {}, s2b: {}, s3: {}, s4prep: {},
    });
    assert.equal(r.ok, false, 'genuine error still fails');
    assert.ok(String(r.failed[0].reason).includes('এই ঘরটি আবশ্যক'), 'real reason kept');
    assert.equal(page._state.submitClicks, 1);
    assert.equal(page._state.confirmClicks, 0, 'no confirm attempted without a warning');
    assert.ok(!progress.some((m) => m.includes('নিশ্চিতকরণ')), 'no confirmation noise on a real error');
  });
});

test('submitS4 warning without confirm control → named confirmation failure, never the warning as error', async () => {
  await withSecret(async () => {
    const page = makeConfirmPage({
      warningVisible: true, dialogButtons: ['cancel'], globalButtons: [],
      waitRejects: true,
    });
    const h = makeHandler(page, []);
    const tok = validChargeToken('u1', 'test-secret-confirm', 'confirm-miss-1');
    const r = await h.submitS4({
      otp: '123456', _chargeToken: tok, s1: {}, s2: {}, s2b: {}, s3: {}, s4prep: {},
    });
    assert.equal(r.ok, false, 'unconfirmed submit fails honestly');
    const reason = String(r.failed[0].reason);
    assert.ok(reason.includes('নিশ্চিতকরণ'), 'named confirmation reason');
    assert.ok(!reason.includes('সাবমিট করার পূর্বে'), 'warning text never becomes the error');
    assert.ok(!reason.includes('কোডটি মিলছে না'), 'no guessed OTP error while confirmation is pending');
    assert.equal(page._state.submitClicks, 1, 'no double-submit on the failed confirmation path');
    assert.equal(page._state.confirmClicks, 0);
  });
});
