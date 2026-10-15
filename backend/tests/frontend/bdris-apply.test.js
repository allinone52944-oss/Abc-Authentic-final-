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

describe('address copy flags (fix #6, 2026-10-15)', () => {
  test('collectStep4 defaults copy flags to FALSE when checkbox missing', () => {
    // Destructive default (true) caused all 3 addresses to merge into 1
    expect(html).toMatch(/\$\('sp_same'\)\s*\?\s*\$\('sp_same'\)\.checked\s*:\s*false/);
    expect(html).toMatch(/\$\('rp_same'\)\s*\?\s*\$\('rp_same'\)\.checked\s*:\s*false/);
    expect(html).not.toMatch(/\$\('sp_same'\)\s*\?\s*\$\('sp_same'\)\.checked\s*:\s*true/);
  });

  test('auto collectAuto is null-safe on copy checkboxes', () => {
    // Was: $('sp_same').checked — throws if element missing, leaving s2b empty
    // which made the engine check all copy boxes
    const m = html.match(/S\.d\.s2b\s*=\s*\{([\s\S]*?)\n\s*\};\n\s*S\.d\.phone/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/\$\('sp_same'\)\s*\?/);
  });
});
