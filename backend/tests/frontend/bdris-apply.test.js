/**
 * bdris-apply.html regression tests — permanent fixes (2026-10-15).
 *
 * The bdris-apply frontend is a single HTML file with inline scripts.
 * These are static regression tests: they load the real HTML and verify
 * the fix patterns are present, so the fixes can't be silently reverted.
 *
 * Covers:
 *  1. Draft auto-save before submit (submitAuto -> saveDraft before runChain)
 *  2. S.starting deadlock fix (timeout clears flag; reconnect re-emits)
 *  3. No [DEBUG] in user-visible note() calls
 *  4. Submit handler idempotency (single binding, no double-fire)
 */

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', '..', '..', 'frontend', 'bdris-apply.html');

let html;
beforeAll(() => {
  html = fs.readFileSync(HTML_PATH, 'utf8');
  expect(html.length).toBeGreaterThan(10000);
});

describe('draft persistence (fix #1)', () => {
  test('submitAuto saves draft before running the chain', () => {
    // submitAuto must call saveDraft(6, proceed) where proceed() runs the chain —
    // i.e. draft is saved (or 3s timeout elapses) BEFORE runChain fires.
    // Pattern: saveDraft(6, proceed) ... const proceed = () => { ... runChain( ... }
    expect(html).toMatch(/saveDraft\(6,\s*proceed\)/);
    expect(html).toMatch(/const proceed\s*=\s*\(\)\s*=>\s*\{[^}]*runChain\(/);
  });

  test('draft save has timeout fallback so submit never blocks', () => {
    expect(html).toMatch(/setTimeout\(proceed,\s*3000\)/);
  });
});

describe('S.starting deadlock (fix #2)', () => {
  test('startSession sets a timeout that clears S.starting', () => {
    expect(html).toMatch(/S\._startT\s*=\s*setTimeout\(\(\)\s*=>\s*\{[\s\S]*?S\.starting\s*=\s*false/);
  });

  test('READY handler clears the session timeout', () => {
    // The BOT_STATUS READY branch must clear S._startT
    const readyBranch = html.match(/if\s*\(st\s*===\s*'READY'\)\s*\{([\s\S]*?)\n\s*\}\n\s*if\s*\(st\s*===\s*'LOADING'\)/);
    expect(readyBranch).not.toBeNull();
    expect(readyBranch[1]).toMatch(/clearTimeout\(S\._startT\)/);
  });

  test('reconnect re-emits session start when callbacks are queued', () => {
    expect(html).toMatch(/socket\.on\('connect'[\s\S]*?S\._readyQ[\s\S]*?startSession\(\)/);
  });

  test('disconnect clears the session timeout', () => {
    expect(html).toMatch(/socket\.on\('disconnect'[\s\S]*?clearTimeout\(S\._startT\)/);
  });
});

describe('no [DEBUG] in user-visible UI (fix #3)', () => {
  test("no note() call contains [DEBUG]", () => {
    const debugNotes = html.match(/note\('[^\n]*\[DEBUG\][^\n]*'\)/g) || [];
    expect(debugNotes).toEqual([]);
  });

  test('debug logging uses console.log, not note()', () => {
    expect(html).toMatch(/console\.log\('\[bdris\] submitAuto/);
  });
});

describe('submit handler idempotency (fix #4)', () => {
  test('submit buttons use single fn binding (no addEventListener + onclick double)', () => {
    // Buttons are defined with { html, fn } descriptors — fn assigned once
    const submitBtns = html.match(/\{\s*html:\s*'[^']*আবেদন জমা দিন[^']*',\s*fn:/g) || [];
    expect(submitBtns.length).toBeGreaterThan(0);
    // No direct addEventListener('click') on submit buttons
    expect(html).not.toMatch(/addEventListener\('click',\s*submitAuto\)/);
  });
});

describe('address copy flags (fix #6, 2026-10-15, superseded off-screen by FINAL-PACK prescopy 2026-10-29)', () => {
  test('collectStep4 reads the live checkbox on-screen, preserves the recorded flag off-screen', () => {
    // 2026-10-15 rule kept on-screen: element present -> its checked value.
    // Off-screen the 2026-10-15 default-FALSE destroyed a ticked copy on
    // the live 2026-10-28 run (preview '—', Step 4 return empty), so the
    // FINAL-PACK prescopy rule preserves the recorded flag instead.
    // The old "defaults to FALSE when missing" assertion is therefore
    // intentionally replaced; final-pack.test.js executes both cases.
    expect(html).toMatch(/spEl \? spEl\.checked : !!prev\.permCopy/);
    expect(html).toMatch(/rpEl \? rpEl\.checked : !!prev\.presCopy/);
    expect(html).not.toMatch(/\$\('sp_same'\)\s*\?\s*\$\('sp_same'\)\.checked\s*:\s*true/);
  });

  test('auto collectAuto is null-safe on copy checkboxes', () => {
    // Was: $('sp_same').checked — throws if element missing, leaving s2b empty
    // which made the engine check all copy boxes. Null-safety is kept;
    // the missing-element value is now the preserved flag (FINAL-PACK
    // prescopy), not a hard FALSE — see final-pack.test.js execution tests.
    const autoSrc = html.slice(html.indexOf('function collectAuto'));
    expect(autoSrc).toMatch(/const permCopyA = spElA \? spElA\.checked : !!prevB\.permCopy;/);
    const m = autoSrc.match(/S\.d\.s2b\s*=\s*\{([\s\S]*?)\n\s*\};/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/permCopy: permCopyA/);
  });
});

describe('instant step transitions (fix #7, 2026-10-15)', () => {
  test('advanceAndSend does not block on guardOpBusy', () => {
    // Was: "এক মুহূর্ত পরে আবার চাপুন" block — now UI advances instantly,
    // engine sync queues in background
    const m = html.match(/function advanceAndSend\(n, op, payload\) \{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    // No actual guardOpBusy() CALL (comments may mention the name)
    expect(m[1]).not.toMatch(/guardOpBusy\(\)/);
    expect(m[1]).toMatch(/goStep\(n\)/);
  });

  test('emitStep queues instead of blocking', () => {
    const m = html.match(/function emitStep\(op, payload, onAckExtra\) \{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    expect(m[1]).not.toMatch(/guardOpBusy\(\)/);
    expect(m[1]).toMatch(/_opQ/);
    expect(m[1]).toMatch(/pumpOpQ\(\)/);
  });
});

describe('recent applications delete (2026-10-15)', () => {
  test('delAck removes entry from localStorage by id', () => {
    const m = html.match(/function delAck\(id\) \{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/getAcks\(\)\.filter/);
    expect(m[1]).toMatch(/localStorage\.setItem\('bdris_acks'/);
  });

  test('ack card has delete button wired to delAck', () => {
    expect(html).toMatch(/data-ackdel/);
    expect(html).toMatch(/delAck\(b\.dataset\.ackdel\)/);
    expect(html).toMatch(/🗑️ মুছুন/);
  });
});

describe('static address geo data (2026-10-15)', () => {
  const path = require('path');
  const GEO_PATH = path.join(__dirname, '..', '..', '..', 'frontend', 'bd-geo.json');

  test('bd-geo.json exists with full hierarchy', () => {
    const geo = JSON.parse(fs.readFileSync(GEO_PATH, 'utf8'));
    const divs = Object.keys(geo);
    expect(divs.length).toBe(8);
    let districts = 0, upazilas = 0, unions = 0;
    Object.values(geo).forEach(d1 => Object.values(d1).forEach(d2 => {
      districts++;
      Object.values(d2).forEach(u => { upazilas++; unions += (u.u || []).length + (u.p || []).length; });
    }));
    expect(districts).toBe(64);
    expect(upazilas).toBeGreaterThan(490);
    expect(unions).toBeGreaterThan(4500);
  });

  test('geoLoad tries static data before engine', () => {
    const m = html.match(/async function geoLoad\(k, Ls, data, wantOv\) \{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/staticGeoOpts\(k, data\)/);
    // static hit skips the engine retry loop
    expect(m[1]).toMatch(/if\s*\(!opts\.length\)\s*\{/);
  });

  test('engine fallback loop is shortened (not 45s)', () => {
    const m = html.match(/async function geoLoad\(k, Ls, data, wantOv\) \{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    expect(m[1]).not.toMatch(/Date\.now\(\) - t0 < 45000/);
    expect(m[1]).toMatch(/Date\.now\(\) - t0 < 15000/);
  });

  test('staticGeoOpts covers division/district/upazila/union levels', () => {
    expect(html).toMatch(/function staticGeoOpts\(k, data\)/);
    expect(html).toMatch(/k === 'division'/);
    expect(html).toMatch(/k === 'district'/);
    expect(html).toMatch(/k === 'cityCorpUpazila'/);
    expect(html).toMatch(/k === 'paurasavaUnion'/);
  });

  test('geo data preloads on page open', () => {
    expect(html).toMatch(/loadGeoData\(\);/);
    expect(html).toMatch(/fetch\('bd-geo\.json(\?[^']*)?'/);
  });
});

describe('address book dropdowns (2026-10-15)', () => {
  test('address book uses dropdown HTML not text inputs for geo levels', () => {
    expect(html).toMatch(/function addrBookGeoHtml\(d\)/);
    // dropdowns for division/district/upazila/union
    expect(html).toMatch(/sel\('ab_division'/);
    expect(html).toMatch(/sel\('ab_district'/);
    expect(html).toMatch(/sel\('ab_cityCorpUpazila'/);
    expect(html).toMatch(/sel\('ab_paurasavaUnion'/);
  });

  test('address book cascade is pure JS from static data (no engine)', () => {
    const m = html.match(/function addrBookWire\(d\) \{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/GEO_DATA/);
    expect(m[1]).not.toMatch(/fetchOpts|socket\.emit/);
  });

  test('renderAddrBook wires dropdowns after geo load', () => {
    expect(html).toMatch(/addrBookGeoHtml\(\)/);
    expect(html).toMatch(/loadGeoData\(\)\.then\(\(\) => addrBookWire\(\)\)/);
  });

  test('SAVE_ADDRESS has timeout feedback so silent hang is impossible', () => {
    const m = html.match(/\$\('abSave'\)\.onclick = \(\) => \{([\s\S]*?)\n  \};/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/setTimeout\(\(\) =>/);
    expect(m[1]).toMatch(/সেভ হচ্ছে না/);
  });
});

describe('double-charge fix (2026-10-25)', () => {
  test('charge() sends a client idempotency_key instead of an empty body', () => {
    expect(html).toMatch(/async function charge\(kind, idempotencyKey\)/);
    expect(html).toMatch(/idempotency_key: idempotencyKey/);
  });

  test('submit charge key is stable per flow: draftId, else a sessionStorage key', () => {
    expect(html).toMatch(/function submitChargeKey\(\)/);
    expect(html).toMatch(/if \(S\.draftId\) return 'draft-' \+ S\.draftId \+ '-submit'/);
    expect(html).toMatch(/sessionStorage\.getItem\('bdris_submit_key'\)/);
  });

  test('OTP submit reuses a fresh cached token instead of charging again', () => {
    expect(html).toMatch(/function cachedSubmitToken\(\)/);
    expect(html).toMatch(/25 \* 60 \* 1000/);
    expect(html).toMatch(/var tok = cachedSubmitToken\(\);/);
    expect(html).toMatch(/S\._submitTok = tok; S\._submitTokAt = Date\.now\(\)/);
  });

  test('PDF charge uses a stable key per ack and caches the token per ack', () => {
    expect(html).toMatch(/var pdfKey = ackNo \? 'pdf-' \+ ackNo : null/);
    expect(html).toMatch(/S\._pdfTok\[pdfKey\] = \{ tok: tok, at: Date\.now\(\) \}/);
  });

  test('FETCH_ORIGINAL with an existing token is NOT charged again by the shim', () => {
    expect(html).toMatch(/if \(args\[0\] && typeof args\[0\] === 'object' && args\[0\]\._chargeToken\)/);
    expect(html).toMatch(/charge\('pdf', ackNo \? 'pdf-' \+ ackNo : null\)/);
  });

  test('draft save remembers the submit key and draft open restores it', () => {
    expect(html).toMatch(/bdris_submit_key_for_' \+ r\.draftId/);
    expect(html).toMatch(/bdris_submit_key_for_' \+ S\.draftId/);
  });
});

describe('header back button must not use browser history (2026-10-25)', () => {
  test('header "← ফিরে যান" button does not call history.back()', () => {
    // Live-verified 2026-10-25 (deploy d069316): history.back() landed
    // on login.html, because after the login redirect the previous
    // history entry IS login.html — and login.html's doLogin() success
    // path leaves its submit button disabled with "⏳ যাচাই করা হচ্ছে..."
    // text, so the restored page looked stuck on verifying. The session
    // itself was never lost (direct return to bdris-apply.html worked).
    expect(html).not.toMatch(/history\.back\(\)/);
  });

  test('header back button returns to the entry page, not login, not history', () => {
    // Corrected 2026-10-25 to the user's logic ("back = where you came
    // from"): the button is wired to goBackToEntry(), which navigates
    // to the entry page recorded on load, falling back to the in-app
    // start screen only when no entry page is known. It never leaves
    // via history and never targets login.html.
    expect(html).toMatch(/<button id="topBackBtn"[^>]*>← ফিরে যান<\/button>/);
    expect(html).toMatch(/\$\('topBackBtn'\)\.onclick = \(\) => goBackToEntry\(\);/);
    expect(html).toMatch(/function goBackToEntry\(\)/);
    expect(html).toMatch(/sessionStorage\.getItem\('bdris_apply_entry'\)/);
    expect(html).toMatch(/rememberEntry\(\)/);
  });

  test('no inline history.back handler remains anywhere on the page', () => {
    expect(html).not.toMatch(/onclick="history\.back\(\)"/);
  });
});

describe('entry-page logic for the back button (2026-10-25, real run)', () => {
  // Extract the pure helper from the real page and run it — not just
  // a regex presence check.
  let entryUrlFromReferrer;
  beforeAll(() => {
    const m = html.match(/function entryUrlFromReferrer\(referrer, currentHref\) \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    entryUrlFromReferrer = eval('(' + m[0].replace(/^function entryUrlFromReferrer/, 'function') + ')');
  });

  test('dashboard entry is accepted', () => {
    expect(entryUrlFromReferrer('https://abc-authentic.store/dashboard.html', 'https://abc-authentic.store/bdris-apply.html'))
      .toBe('https://abc-authentic.store/dashboard.html');
  });

  test('service-detail entry (with query) is accepted', () => {
    expect(entryUrlFromReferrer('https://abc-authentic.store/service-detail.html?id=x', 'https://abc-authentic.store/bdris-apply.html'))
      .toBe('https://abc-authentic.store/service-detail.html?id=x');
  });

  test('login.html entry is rejected (login redirect must not become "back")', () => {
    expect(entryUrlFromReferrer('https://abc-authentic.store/login.html?next=%2Fbdris-apply.html', 'https://abc-authentic.store/bdris-apply.html'))
      .toBeNull();
  });

  test('cross-origin referrer is rejected', () => {
    expect(entryUrlFromReferrer('https://example.com/page.html', 'https://abc-authentic.store/bdris-apply.html'))
      .toBeNull();
  });

  test('same-page referrer (reload) is rejected, so a reload cannot overwrite the entry', () => {
    expect(entryUrlFromReferrer('https://abc-authentic.store/bdris-apply.html', 'https://abc-authentic.store/bdris-apply.html'))
      .toBeNull();
  });

  test('empty referrer is rejected', () => {
    expect(entryUrlFromReferrer('', 'https://abc-authentic.store/bdris-apply.html')).toBeNull();
  });
});

describe('session-start speed fix (2026-10-25)', () => {
  test('startSession timeout is 60s, not 30s (production START→READY measured 35–41s)', () => {
    const m = html.match(/S\._startT = setTimeout\(\(\) => \{[\s\S]*?\}, (\d+)\)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(60000);
  });

  test('startSession shows an honest load-time expectation, not a generic wait', () => {
    expect(html).toMatch(/BDRIS ফর্ম লোড হচ্ছে/);
    // Live-verified 2026-10-25: pool session ready at the first 5s
    // check (<=5s), so the start message must not claim 35-40s (or
    // the 30-50s wording seen live) any more — "a few seconds" only.
    expect(html).toMatch(/কয়েক সেকেন্ড লাগতে পারে/);
    expect(html).not.toMatch(/৩৫–৪০ সেকেন্ড লাগতে পারে/);
    expect(html).not.toMatch(/৩০–৫০ সেকেন্ড লাগতে পারে/);
  });
});

describe('header back button no-op on home with unknown entry (2026-10-25, proven cause)', () => {
  // Proven chain (code, not guesswork):
  //  bdris-apply.html head guard: no token -> /login.html?next=<pathname>
  //  login.html: explicit ?next= wins -> back to /bdris-apply.html, so
  //  the return load's document.referrer IS login.html
  //  entryUrlFromReferrer: pathname '/login.html' -> null, so
  //  rememberEntry() stores nothing -> goBackToEntry() fell back to
  //  renderHome() -> on the start screen (the init renderHome() view)
  //  that re-renders the identical screen: the press visibly goes
  //  nowhere. These tests execute the real goBackToEntry() with stubs.
  let goBackToEntry;
  beforeAll(() => {
    const m = html.match(/function goBackToEntry\(\) \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    goBackToEntry = m[0];
  });

  function runGoBack({ storedEntry, view }) {
    const store = { v: storedEntry === undefined ? null : storedEntry };
    const sessionStorage = { getItem: () => store.v, setItem: (k, v) => { store.v = v; } };
    const location = { href: 'https://abc-authentic.store/bdris-apply.html' };
    const S = { view };
    let homeCalls = 0;
    const renderHome = () => { homeCalls++; };
    // eslint-disable-next-line no-eval
    const fn = eval('(' + goBackToEntry.replace(/^function goBackToEntry/, 'function') + ')');
    fn();
    return { href: location.href, homeCalls };
  }

  test('stored entry wins: navigates to the entry page, home not re-rendered', () => {
    const r = runGoBack({ storedEntry: 'https://abc-authentic.store/dashboard.html', view: 'home' });
    expect(r.href).toBe('https://abc-authentic.store/dashboard.html');
    expect(r.homeCalls).toBe(0);
  });

  test('no entry + already on home: leaves to /dashboard.html, does NOT re-render home', () => {
    const r = runGoBack({ storedEntry: null, view: 'home' });
    expect(r.href).toBe('/dashboard.html');
    expect(r.homeCalls).toBe(0);
  });

  test('no entry + mid-flow view: existing renderHome() fallback is unchanged', () => {
    const r = runGoBack({ storedEntry: null, view: 'flow' });
    expect(r.href).toBe('https://abc-authentic.store/bdris-apply.html');
    expect(r.homeCalls).toBe(1);
  });

  test('no-entry fallback never targets login.html', () => {
    const r = runGoBack({ storedEntry: null, view: 'home' });
    expect(r.href).not.toMatch(/login\.html/);
  });
});

describe('login redirect must not destroy the back entry (2026-10-25)', () => {
  // The head guard runs BEFORE the redirect to login.html, while
  // document.referrer is still the true origin page, and login.html
  // never clears sessionStorage — so a preserved entry survives the
  // round-trip, and rememberEntry() must not overwrite it with the
  // login.html referrer of the return load.
  test('head guard preserves a same-origin non-login referrer before redirecting', () => {
    const head = html.slice(0, 4000);
    expect(head).toMatch(/location\.href = '\/login\.html\?next='/);
    expect(head).toMatch(/sessionStorage\.setItem\('bdris_apply_entry', r\)/);
    expect(head).toMatch(/ru\.origin === cu\.origin/);
    expect(head).toMatch(/ru\.pathname !== '\/login\.html'/);
    expect(head).toMatch(/ru\.pathname !== cu\.pathname/);
  });

  test('rememberEntry keeps a preserved entry when the return referrer is login.html', () => {
    const entryFn = html.match(/function entryUrlFromReferrer\(referrer, currentHref\) \{[\s\S]*?\n\}/);
    const remFn = html.match(/function rememberEntry\(\) \{[\s\S]*?\n\}/);
    expect(entryFn).not.toBeNull();
    expect(remFn).not.toBeNull();
    const store = { v: 'https://abc-authentic.store/service-detail.html?id=x' };
    const sessionStorage = { getItem: () => store.v, setItem: (k, v) => { store.v = v; } };
    const location = { search: '', href: 'https://abc-authentic.store/bdris-apply.html' };
    const document = { referrer: 'https://abc-authentic.store/login.html?next=%2Fbdris-apply.html' };
    // eslint-disable-next-line no-eval
    eval(entryFn[0] + '\n' + remFn[0] + '\nrememberEntry();');
    expect(store.v).toBe('https://abc-authentic.store/service-detail.html?id=x');
  });
});

describe('zone/ward failure visibility (2026-10-25 zone fix)', () => {
  test('fetchAddrOpts returns {options, error} instead of collapsing failures to []', () => {
    expect(html).toMatch(/function fetchAddrOpts\(level, parents, tmo, form\)/);
    expect(html).toMatch(/res\(\{ options: \[\], error: 'timeout' \}\)/);
    expect(html).toMatch(/r\.ok === false/);
  });

  test('fetchAddrOpts timeout is longer than the backend executor timeout (40000 > 30000)', () => {
    expect(html).toMatch(/fetchAddrOpts\(lvl, parents, 40000, form\)/);
    expect(html).not.toMatch(/fetchAddrOpts\(lvl, parents, 25000, form\)/);
  });

  test('geoLoad does NOT degrade paurasavaUnion/ward to a text input on empty, it shows an error banner and keeps the select', () => {
    const m = html.match(/async function geoLoad\(k, Ls, data, wantOv\) \{([\s\S]*?)\nasync function geoMirror/);
    expect(m).not.toBeNull();
    // FINAL-SOLUTION (2026-10-30, #8): the banner is now branched —
    // SESSION_EXPIRED names the session refresh, other errors keep
    // the original "list did not arrive" wording. Both are error
    // banners on the kept select, never a degrade to text.
    expect(m[1]).toMatch(/showBanner\('err', \/SESSION_EXPIRED\/\.test\(zoneErr\)/);
    expect(m[1]).toMatch(/অঞ্চলের তালিকা আসেনি \(/);
    expect(m[1]).toMatch(/setGeoState\(k, Ls, 'error'\)/);
    // The degradeToText call must not be on the zone/ward empty path:
    // geoLoad's only remaining degradeToText is for other levels, after the zone/ward early return.
    const zoneBranch = m[1].split("if (k === 'paurasavaUnion' || k === 'ward')")[1].split('} else {')[0];
    expect(zoneBranch).not.toMatch(/degradeToText/);
  });

  test('geoLoad hides the zone error banner on a successful zone/ward load', () => {
    expect(html).toMatch(/if \(k === 'paurasavaUnion' \|\| k === 'ward'\) hideBanner\(\)/);
  });
});

describe('Bengali-digit mobile numbers (live error 2026-10-26)', () => {
  test('collectStep6, collectAuto and status login normalize Bengali digits before the 01 rule', () => {
    // bnDigits() already existed in the same file but was never
    // applied to phone fields: [^\\d] stripped Bengali digits
    // entirely, so a Bengali-typed number failed as "".
    expect(html).toMatch(/S\.d\.phone = bnDigits\(\$\('c_phone'\)/);
    expect(html).toMatch(/S\.d\.phone = bnDigits\(\$\('a_phone'\)/);
    expect(html).toMatch(/const mobileEmail = bnDigits\(\$\('st_mobile'\)/);
  });

  test('the 11-digit / 01-start rule itself is unchanged', () => {
    expect(html).toMatch(/\/\^01\\d\{9\}\$\//);
  });
});

describe('Debug-2 (2026-10-26): original-PDF record type, chain uiStep, charge-failure recovery', () => {
  test('showDone treats COMPLETED.original as a URL only when it is a string (v2 sends a record object, v1 sent a URL)', () => {
    expect(html).toMatch(/const origUrl = \(typeof d\.original === 'string'/);
    expect(html).toMatch(/downloadOriginal\(origUrl, no\)/);
    expect(html).not.toMatch(/downloadOriginal\(d\.original, no\)/);
  });

  test('chainAck uses the OPS screen step for uiStep, not the engine site-step number', () => {
    // Engine S0 -> step 1 and S1 -> step 2, but uiStep is a screen
    // number (S0 done -> screen 2, S1 done -> screen 3); manualStepAck
    // already used the OPS step. The old engine-step preference made
    // auto-chain drafts resume one screen too early.
    expect(html).toMatch(/if \(o\.step\) S\.d\.uiStep = Math\.max\(S\.d\.uiStep \|\| 0, o\.step\)/);
    expect(html).not.toMatch(/S\.d\.uiStep = parseInt\(d\.step, 10\)/);
  });

  test('charge shim recovers itself on a failed submit charge (callers cannot see an async false)', () => {
    // wrapEmitStep is async: `emitStep(...) === false` at the call
    // sites is always false-negative (a Promise). On !tok the wrapper
    // must release the buttons and reset otpStage itself, or the UI
    // sat on "জমা হচ্ছে…" until the 90s busy watchdog.
    expect(html).toMatch(/if \(!tok\) \{ busy\(false\); if \(S\.otpStage === 'submitting'\) S\.otpStage = 'code'; return false; \}/);
  });
});
