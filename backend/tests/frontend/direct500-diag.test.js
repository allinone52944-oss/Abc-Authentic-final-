/**
 * Direct 500 diagnostic (2026-10-29) — failure-reporting only.
 *
 * After a DEFINITIVE direct send failure on a BRN-free filing, the
 * frontend must surface the direct reason instead of running the
 * bot S4_PREP/S3 replay into the parents-verify gate (which failed
 * twice live and buried the direct reason). This change touches
 * failure reporting only: no send payload, no true data value, no
 * QR logic, and no retry behaviour for non-definitive failures.
 *
 * Approach (same as the other frontend tests): read the real HTML,
 * extract `isDefinitiveBrnFreeSendFailure` by brace matching and
 * evaluate it, so the tests always run the CURRENT source text.
 * Static tests pin the branch placement inside directSendAck.
 */

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', '..', '..', 'frontend', 'bdris-apply.html');

let html;
beforeAll(() => {
  html = fs.readFileSync(HTML_PATH, 'utf8');
  expect(html.length).toBeGreaterThan(10000);
});

/** Extract the full `function name(...) { ... }` definition by brace matching. */
function extractFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\s*\\('));
  if (!m) throw new Error('function not found: ' + name);
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error('unbalanced braces for: ' + name);
}

let isDefinitiveBrnFreeSendFailure;
beforeAll(() => {
  const src = extractFn(html, 'isDefinitiveBrnFreeSendFailure');
  isDefinitiveBrnFreeSendFailure = new Function(`${src}; return isDefinitiveBrnFreeSendFailure;`)();
});

describe('isDefinitiveBrnFreeSendFailure decision matrix', () => {
  const definitive = {
    fallback: true, brnFree: true, httpStep: 'otp-send',
    httpReason: 'OTP send returned status 500: Invalid Operation, Please communicate with support team.',
  };

  test('definitive BRN-free 500 send failure is recognised', () => {
    expect(isDefinitiveBrnFreeSendFailure(definitive)).toBe(true);
  });

  test('any server-answered status counts as definitive (400 included)', () => {
    expect(isDefinitiveBrnFreeSendFailure({
      ...definitive, httpReason: 'OTP send returned status 400: DUPLICATE.',
    })).toBe(true);
  });

  test('non-BRN-free filing keeps the bot fallback', () => {
    expect(isDefinitiveBrnFreeSendFailure({ ...definitive, brnFree: false })).toBe(false);
    expect(isDefinitiveBrnFreeSendFailure({ ...definitive, brnFree: undefined })).toBe(false);
  });

  test('non-send steps keep the bot fallback', () => {
    expect(isDefinitiveBrnFreeSendFailure({ ...definitive, httpStep: 'bootstrap' })).toBe(false);
    expect(isDefinitiveBrnFreeSendFailure({ ...definitive, httpStep: 'verify' })).toBe(false);
    expect(isDefinitiveBrnFreeSendFailure({ ...definitive, httpStep: 'submit' })).toBe(false);
  });

  test('no-response / seed / session reasons are NOT definitive', () => {
    expect(isDefinitiveBrnFreeSendFailure({ ...definitive, httpReason: '' })).toBe(false);
    expect(isDefinitiveBrnFreeSendFailure({ ...definitive, httpReason: 'SEED_FAILED' })).toBe(false);
    expect(isDefinitiveBrnFreeSendFailure({ ...definitive, httpReason: 'Copy-source address is empty' })).toBe(false);
    expect(isDefinitiveBrnFreeSendFailure({ ...definitive, httpReason: 'OTP send timed out' })).toBe(false);
  });

  test('fallback:false or missing ack is NOT definitive', () => {
    expect(isDefinitiveBrnFreeSendFailure({ ...definitive, fallback: false })).toBe(false);
    expect(isDefinitiveBrnFreeSendFailure(null)).toBe(false);
    expect(isDefinitiveBrnFreeSendFailure(undefined)).toBe(false);
  });

  test('helper reads only routing + reason fields, never a value field', () => {
    const src = extractFn(html, 'isDefinitiveBrnFreeSendFailure');
    expect(src).toMatch(/r\.fallback/);
    expect(src).toMatch(/r\.brnFree/);
    expect(src).toMatch(/r\.httpStep/);
    expect(src).toMatch(/r\.httpReason/);
    expect(src).not.toMatch(/r\.phone|applicantName|personUbrn|otp\b(?!-send)/);
  });
});

describe('directSendAck diagnostic branch placement', () => {
  test('diagnostic branch runs before directFallbackToBotSend inside directSendAck', () => {
    const ack = extractFn(html, 'directSendAck');
    const branchAt = ack.indexOf('isDefinitiveBrnFreeSendFailure(r)');
    const fallbackAt = ack.indexOf('directFallbackToBotSend()');
    expect(branchAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(branchAt).toBeLessThan(fallbackAt);
  });

  test('diagnostic branch surfaces the direct reason and skips the replay', () => {
    const ack = extractFn(html, 'directSendAck');
    const branch = ack.slice(ack.indexOf('isDefinitiveBrnFreeSendFailure(r)'));
    expect(branch).toMatch(/showFail\(/);
    expect(branch).toMatch(/r\.httpReason\.trim\(\)/);
    expect(branch).toMatch(/বট replay চালানো হয়নি/);
    // No replay emit and no OTP-view render on the diagnostic path:
    // the branch returns before directFallbackToBotSend, and the
    // branch text up to that call contains neither.
    const beforeFallback = branch.slice(0, branch.indexOf('directFallbackToBotSend()'));
    expect(beforeFallback).not.toMatch(/SUBMIT_S4_PREP/);
    expect(beforeFallback).not.toMatch(/renderOtpCode\(/);
  });

  test('non-definitive failures still reach the bot fallback (unchanged line intact)', () => {
    const ack = extractFn(html, 'directSendAck');
    expect(ack).toMatch(/directFallbackToBotSend\(\);/);
    // The pre-existing warning note for fallback cases is intact.
    expect(ack).toMatch(/সরাসরি পাঠানো যায়নি — সাইটের জবাব: /);
  });

  test('send payload path untouched: directSend still posts phase send via directHttpPost', () => {
    const send = extractFn(html, 'directSend');
    expect(send).toMatch(/phase:\s*'send'/);
    expect(send).toMatch(/directHttpPost\(/);
    expect(send).not.toMatch(/isDefinitiveBrnFreeSendFailure/);
  });
});
