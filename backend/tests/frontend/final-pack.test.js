/**
 * Final pack (2026-10-29) — whole-application reliability fixes.
 *
 * Folded-in pending branches (adapted to current main, not merged
 * wholesale): fix-bdris-prescopy (off-screen collect must preserve
 * a recorded copy/fields) and fix-bdris-stale-banner (a passed
 * step's late failure ack is stale display, not a current block).
 * Left out deliberately: fix-bdris-parentverify-channel and
 * fix-bdris-parentverify-singlename-pattern — both are research
 * classifications of the bot parents-verify gate, not fixes, and
 * the BRN-free chase they belong to is parked by the user.
 *
 * New in this pack: step-6 email live-save, previous-button
 * collect+save (fill survives next/previous), address-book pick
 * clears the copy flag + saves the draft, draft-save watchdog
 * (warns when the socket ack never arrives), home merges the
 * server's submitted-applications list (another browser no longer
 * shows empty history), and DONE-page original-PDF terminal
 * states (charge-fail retry + 120s re-label watchdog that cancels
 * nothing). Nothing here touches the send payload, BRN-free
 * routing, the direct-500 question, charge idempotency, or QR
 * logic. Tests use no personal values.
 *
 * Approach (same as the other frontend tests): read the real
 * HTML, extract functions by brace matching and evaluate them
 * with mocked DOM/state, so tests run the CURRENT source text.
 * Static tests pin placement of code that only runs in a browser.
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

describe('prescopy preserve (folded from fix-bdris-prescopy)', () => {
  test('off-screen collect preserves a recorded copy and fields', () => {
    const S = { d: { s2b: {
      permCopy: true, presCopy: false,
      perm: null, pres: { division: 'D', ward: 'W' },
    } } };
    const readAddrFields = () => { throw new Error('must not read DOM off-screen'); };
    const $ = () => null; // Step 4 form not on screen
    const run = new Function('S', '$', 'readAddrFields', `${extractFn(html, 'collectStep4')}; return collectStep4();`);
    const out = run(S, $, readAddrFields);
    expect(out.permCopy).toBe(true);
    expect(out.pres).toEqual({ division: 'D', ward: 'W' });
  });

  test('on-screen collect still reads the live checkboxes', () => {
    const S = { d: { s2b: { permCopy: true, presCopy: true, perm: { division: 'OLD' }, pres: { division: 'OLD' } } } };
    const els = { sp_same: { checked: false }, rp_same: { checked: true } };
    const $ = (id) => els[id] || null;
    const readAddrFields = () => ({ division: 'NEW' });
    const run = new Function('S', '$', 'readAddrFields', `${extractFn(html, 'collectStep4')}; return collectStep4();`);
    const out = run(S, $, readAddrFields);
    expect(out.permCopy).toBe(false);
    expect(out.perm).toEqual({ division: 'NEW' });
    expect(out.presCopy).toBe(true);
    expect(out.pres).toBe(null);
  });
});

describe('collectAuto preserve (folded from fix-bdris-prescopy)', () => {
  test('off-screen collectAuto keeps recorded address fields', () => {
    const S = { d: { s2b: { permCopy: false, presCopy: false, perm: { division: 'P' }, pres: { division: 'R' } } } };
    const $ = (id) => {
      if (id === 'sp_same' || id === 'rp_same') return null;
      return { value: '', checked: false };
    };
    const readDobIso = () => '';
    const readPersonAuto = () => ({});
    const readAddrFields = () => { throw new Error('must not read DOM off-screen'); };
    const bnDigits = (s) => String(s || '');
    const run = new Function('S', '$', 'readDobIso', 'readPersonAuto', 'readAddrFields', 'bnDigits',
      `${extractFn(html, 'collectAuto')}; return collectAuto();`);
    run(S, $, readDobIso, readPersonAuto, readAddrFields, bnDigits);
    expect(S.d.s2b.perm).toEqual({ division: 'P' });
    expect(S.d.s2b.pres).toEqual({ division: 'R' });
  });
});

describe('stale-banner (folded from fix-bdris-stale-banner)', () => {
  test('manualStepAck suppresses a passed op late failure before any display', () => {
    const src = extractFn(html, 'manualStepAck');
    const suppressAt = src.indexOf("S._passedOps[op]");
    const staleAt = src.indexOf("if (staleAck) { if (op) dropSent(op); return; }");
    expect(suppressAt).toBeGreaterThan(-1);
    expect(staleAt).toBeGreaterThan(-1);
    expect(suppressAt).toBeLessThan(staleAt);
    expect(src).toContain('opAbort(); busy(false); return;');
  });

  test('manualStepAck records a pass in the success branch, stale acks excluded', () => {
    const src = extractFn(html, 'manualStepAck');
    expect(src).toContain("(S._passedOps = S._passedOps || {})[op] = true");
    expect(src).toContain('if (op && !staleAck)');
  });

  test('passed-op state is cleared on home, new draft, and fresh session', () => {
    expect(html).toContain('S._passedOps = {}; // FINAL-PACK stale-banner: home');
    expect(html).toContain('S._passedOps = {}; // FINAL-PACK stale-banner: new draft');
    expect(html).toContain('S._passedOps = {}; // FINAL-PACK stale-banner: site session truly new');
  });
});

describe('fill survival: live-save and previous-button save', () => {
  test('step-6 email gets the same live-save as phone', () => {
    expect(html).toContain("const ce = $('c_email');");
    expect(html).toContain("ce.oninput = () => { S.d.email = (ce.value || '').trim(); };");
  });

  test('every manual previous button collects and saves before navigating back', () => {
    expect(html).toContain("collectStep2(); if (S.draftId) saveDraft(1, () => {}); goStep(1);");
    expect(html).toContain("collectStep3(); if (S.draftId) saveDraft(2, () => {}); goStep(2);");
    expect(html).toContain("collectStep4(); if (S.draftId) saveDraft(3, () => {}); goStep(3);");
    expect(html).toContain("if (S.draftId) saveDraft(4, () => {}); goStep(4);");
    expect(html).toContain("collectStep6(); if (S.draftId) saveDraft(5, () => {}); goStep(5);");
  });

  test('draft-save watchdog warns once and never double-calls the callback', () => {
    const src = extractFn(html, 'saveDraft');
    expect(src).toContain('setTimeout(() => {');
    expect(src).toContain('10000');
    expect(src).toContain('S._draftSaveWarned');
    const timerBody = src.slice(src.indexOf('setTimeout'), src.indexOf('socket.emit'));
    expect(timerBody).not.toContain('cb(');
  });
});

describe('address-book pick no longer loses the picked address', () => {
  test('manual permanent/present picks clear the copy flag and save the draft', () => {
    expect(html).toContain('S.d.s2b.permCopy = false; renderStep4(); if (S.draftId) saveDraft(4, () => {});');
    expect(html).toContain('S.d.s2b.presCopy = false; renderStep4(); if (S.draftId) saveDraft(4, () => {});');
  });

  test('birthplace and auto picks save the draft', () => {
    expect(html).toContain('if (S.draftId) saveDraft(2, () => {});');
    expect(html).toContain('S.d.s2b.permCopy = false; renderAuto(); if (S.draftId) saveDraft(S.d.uiStep || 0, () => {});');
    expect(html).toContain('S.d.s2b.presCopy = false; renderAuto(); if (S.draftId) saveDraft(S.d.uiStep || 0, () => {});');
  });

  test('address-book list has a retry when the socket answer never arrives', () => {
    const src = extractFn(html, 'loadAddrList');
    expect(src).toContain('15000');
    expect(src).toContain("id=\"addrRetry\"");
  });
});

describe('post-submit location: server records merge into home', () => {
  test('home fetches the existing server applications endpoint and dedups by number', () => {
    expect(html).toContain("fetch('/api/bdris-apply/applications'");
    expect(html).toContain('const localNos = new Set(getAcks().map(a => String(a.no)));');
    expect(html).toContain("data-srvdel=");
  });
});

describe('original-PDF terminal states', () => {
  test('charge failure resets the DONE pending button to retry', () => {
    const idx = html.indexOf("charge('pdf', pdfKey).then(function (tok) {");
    expect(idx).toBeGreaterThan(-1);
    const seg = html.slice(idx, idx + 1200);
    expect(seg).toContain("const pend = $('akOrigPend');");
    expect(seg).toContain("pend.textContent = '⬇️ আসল PDF আবার আনুন';");
  });

  test('DONE pending watchdog re-labels only, cancels nothing, and honours a real result', () => {
    expect(html).toContain('}, 120000);');
    expect(html).toContain("(S._origDone = S._origDone || {})[ono] = true;");
    expect(html).toContain('const done = S._origDone && S._origDone[key];');
  });
});

describe('preserved behaviours (must not regress)', () => {
  test('diagnostic skip helper and branch placement are intact', () => {
    expect(html).toContain('function isDefinitiveBrnFreeSendFailure(r)');
    const ack = extractFn(html, 'directSendAck');
    expect(ack.indexOf('isDefinitiveBrnFreeSendFailure(r)')).toBeLessThan(ack.indexOf('directFallbackToBotSend();'));
  });

  test('phone live-save is intact', () => {
    // OTP-TRAP (A5, 2026-10-31): the live-save assignment is
    // unchanged; the handler now additionally clears the OTP
    // return flag when the phone diverges from the sent number.
    expect(html).toContain("S.d.phone = bnDigits(cp.value || '').replace(/\\D/g, '');");
    expect(html).toContain("if (S._otpSessionLive && S._sentPhone && S.d.phone !== S._sentPhone) { S._otpSessionLive = false; S._sentPhone = null; }");
  });

  test('no QR logic is introduced by this pack', () => {
    const added = html.match(/FINAL-PACK[^\n]*/g) || [];
    added.forEach(line => expect(line.toLowerCase()).not.toContain('qr'));
  });
});
