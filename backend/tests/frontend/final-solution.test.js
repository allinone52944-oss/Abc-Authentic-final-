/**
 * FINAL-SOLUTION FIX PACK (2026-10-30) — frontend regression tests.
 *
 * Same static approach as bdris-apply.test.js: load the real HTML
 * and verify the fix patterns are present, so the fixes can't be
 * silently reverted. No browser, no live data, no identifiers.
 *
 * Covers (problem-map #):
 *  #2  OTP-view return button without re-send (preview, gated on
 *      the live OTP session flag set only on sent proof).
 *  #3  Sent-proof gate: ok+sent WITHOUT the server MESSAGE_SENT
 *      code is never claimed as sent.
 *  #4  Held submit: a queued S4_OTP orphaned by an earlier op's
 *      failure is held and re-fired after the next good prep,
 *      never silently dropped; step navigation voids it.
 *  #6  Submit-source flags on bot submits (user-press vs
 *      direct-fallback) for the journal decision log.
 *  #8  Session-dead branch in directSendAck (no bot replay on a
 *      dead session) + SESSION_EXPIRED zone banner wording.
 *  #9  Silent server-side auto-save (HTTP /draft-save first,
 *      socket fallback; signature guard; preview + send hooks).
 *  #10 Charge DUPLICATE shown as token-ok (alreadyCharged note).
 *  #11 Stale panels cleared on view change (setView) and step
 *      navigation (goStep hides the banner too).
 *  #12 Address-book pick-back: zone/ward digit match + no-break
 *      warm loop + named missed-level note.
 *  #14 400-unexpired branches (direct + bot prep): previous code
 *      still valid, no new code, no bot replay.
 */

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', '..', '..', 'frontend', 'bdris-apply.html');

let html;
beforeAll(() => {
  html = fs.readFileSync(HTML_PATH, 'utf8');
  expect(html.length).toBeGreaterThan(10000);
});

describe('final-solution #2: OTP-view return without re-send', () => {
  test('preview offers a return-to-OTP button gated on the live session flag', () => {
    expect(html).toMatch(/কোড জমা দেওয়ার পর্দায় ফিরুন/);
    expect(html).toMatch(/if \(S\._otpSessionLive\)/);
  });
  test('the flag is set only on a sent render, cleared on home/session-loss/DONE', () => {
    expect(html).toMatch(/if \(sent\) S\._otpSessionLive = true/);
    expect(html).toMatch(/S\._otpSessionLive = false/);
  });
  test('the return button re-renders the OTP view and sends nothing', () => {
    const btn = html.match(/কোড জমা দেওয়ার পর্দায় ফিরুন[\s\S]{0,200}?renderOtpCode\(true\)/);
    expect(btn).not.toBeNull();
    expect(html).not.toMatch(/কোড জমা দেওয়ার পর্দায় ফিরুন[\s\S]{0,200}?directSend\(\)/);
  });
});

describe('final-solution #3: sent-proof gate', () => {
  test('direct sent requires the server code, not just ok+sent', () => {
    expect(html).toMatch(/r\.ok === true && r\.sent === true && r\.sendCode != null/);
  });
  test('ok+sent without a code shows a no-proof failure, never sent', () => {
    expect(html).toMatch(/সার্ভারের নিশ্চিত জবাব \(MESSAGE_SENT\) আসেনি/);
  });
});

describe('final-solution #4: held submit repair', () => {
  test('queued S4_OTP is rescued before the queue is cleared', () => {
    expect(html).toMatch(/function takeQueuedOtp\(\)/);
    expect(html).toMatch(/const _failSavedOtp = takeQueuedOtp\(\)/);
  });
  test('held submit re-fires once after the next good prep on the OTP view', () => {
    expect(html).toMatch(/S\._pendingSubmit/);
    expect(html).toMatch(/ধরে রাখা কোড-জমা স্বয়ংক্রিয়ভাবে পাঠানো হচ্ছে/);
  });
  test('step navigation and a fresh press void the held submit', () => {
    expect(html).toMatch(/S\._pendingSubmit = null/);
  });
});

describe('final-solution #6: submit-source flags', () => {
  test('direct-fallback and user-press sources are attached to S4_OTP emits', () => {
    expect(html).toMatch(/_submitSource: 'direct-fallback'/);
    expect(html).toMatch(/_submitSource: 'user-press'/);
  });
});

describe('final-solution #8: session-dead detection', () => {
  test('directSendAck has a session-dead branch with no bot replay', () => {
    expect(html).toMatch(/r\.sessionDead === true/);
    expect(html).toMatch(/সেশন শেষ হয়ে গেছে — আবার লগইন করে সেশন refresh করুন/);
    expect(html).toMatch(/bot replay চালানো হয়নি/);
  });
  test('zone/ward SESSION_EXPIRED banner names the session refresh', () => {
    expect(html).toMatch(/SESSION_EXPIRED\)/);
    expect(html).toMatch(/সেশন শেষ হয়ে গেছে — আবার লগইন করে সেশন refresh করুন, তারপর উপরের ঘরটা আবার বাছুন/);
  });
});

describe('final-solution #9: silent server-side auto-save', () => {
  test('autoSaveDraft posts to HTTP /draft-save with socket fallback', () => {
    expect(html).toMatch(/function autoSaveDraft\(/);
    expect(html).toMatch(/\/api\/bdris-apply\/draft-save/);
    expect(html).toMatch(/saveDraft\(uiStep, done\)/);
  });
  test('auto-save is signature-guarded and hooked to preview + send success', () => {
    expect(html).toMatch(/S\._autoDraftSig/);
    expect(html).toMatch(/autoSaveDraft\(6\)/);
  });
});

describe('final-solution #10: charge DUPLICATE as token-ok', () => {
  test('alreadyCharged shows the no-double-charge note', () => {
    expect(html).toMatch(/d\.alreadyCharged/);
    expect(html).toMatch(/আগে চার্জ হয়ে গেছে — আবার কাটা হয়নি/);
  });
});

describe('final-solution #11: stale panels tied to view', () => {
  test('setView clears fail + banner on an actual view change', () => {
    expect(html).toMatch(/if \(S\.view !== v\) \{ hideFail\(\); hideBanner\(\); \}/);
  });
  test('goStep hides the banner too', () => {
    const go = html.match(/function goStep\(n\) \{[\s\S]{0,300}?hideBanner\(\)/);
    expect(go).not.toBeNull();
  });
});

describe('final-solution #12: address-book zone/ward pick-back', () => {
  test('digit match bridges Zone-8/অঞ্চল-৮ style label gaps', () => {
    expect(html).toMatch(/zoneWard/);
    expect(html).toMatch(/digitsOf/);
  });
  test('addrWarm no longer breaks on a miss; missed levels are named', () => {
    expect(html).toMatch(/missed\.push\(L\); parentMissed = true; continue/);
    expect(html).toMatch(/স্বয়ংক্রিয়ভাবে বসেনি — হাতে বেছে নিন/);
  });
});

describe('final-solution #14: 400-unexpired handling', () => {
  test('direct unexpired branch: previous code valid, OTP view, no replay', () => {
    expect(html).toMatch(/r\.otpUnexpired === true/);
    expect(html).toMatch(/আগের কোডের মেয়াদ এখনো আছে — নতুন কোড আসবে না, আগের কোডটাই বসান/);
  });
  test('bot prep unexpired branch matches the site wording', () => {
    expect(html).toMatch(/মেয়াদ শেষ হয়নি\|not expired/);
  });
});
