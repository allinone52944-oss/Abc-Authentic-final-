/**
 * Cascade + relation-restore fix (2026-11-01, permanent fix) — extracted
 * function tests against frontend/bdris-apply.html. No browser, no DOM
 * execution of the page itself: the pure relation helpers are extracted
 * and run in isolation with a stubbed S (draft state).
 *
 * Live-proven defects (check-only verification 2026-11-01):
 *  1. A draft saved with relation Others resumed showing Father selected
 *     (renderStep5/auto render silently reset any unrecognised saved
 *     relation to relList[0], and submit payloads defaulted the same way).
 *  2. After draft resume + step forward/back re-render, the birthplace
 *     cascade selects went placeholder-only with no options (a warm run
 *     dropped by the _warmRunning guard + the stale run's finally-block
 *     placeholder conversion stranded the fresh selects).
 *
 * This file proves the relation half behaviorally: saved relations
 * present exactly as saved (label or site-code form), and a missing or
 * unrecognised saved relation is unset — never silently Father. The
 * cascade half (warm queue, working retry, retry banner) is covered by
 * backend pattern tests in backend/tests/frontend/bdris-apply.test.js,
 * since warmFromData needs the full page DOM to run.
 * Run: node --test engines/bdris-apply/v2/tests/cascade-relation.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', '..', '..', '..', 'frontend', 'bdris-apply.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in bdris-apply.html`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') { depth -= 1; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function extractConst(name) {
  const start = html.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `const ${name} must exist in bdris-apply.html`);
  const end = html.indexOf(';', start);
  assert.ok(end > start, `const ${name} must terminate`);
  return html.slice(start, end + 1);
}

function loadRelationHelpers() {
  const ctx = { S: { d: { s1: {} } } };
  vm.createContext(ctx);
  vm.runInContext([
    extractConst('RELATIONS'),
    extractConst('REL_ADULT'),
    extractConst('REL_MINOR'),
    extractConst('REL_CODE_TO_LABEL'),
    extractFn('relationsForAge'),
    extractFn('normalizeRelation'),
    extractFn('relationRenderState'),
  ].join('\n'), ctx);
  return ctx;
}

function assertState(st, value, dropped) {
  // Field-wise compare: objects built inside the vm realm fail
  // deepStrictEqual on prototype mismatch despite identical fields.
  assert.strictEqual(st.value, value, `value must be ${value}`);
  assert.strictEqual(st.dropped, dropped, `dropped must be ${dropped}`);
}

describe('cascade-relation fix: normalizeRelation', () => {
  it('passes Bengali labels through unchanged', () => {
    const ctx = loadRelationHelpers();
    assert.strictEqual(ctx.normalizeRelation('অন্যান্য'), 'অন্যান্য');
    assert.strictEqual(ctx.normalizeRelation('পিতা'), 'পিতা');
    assert.strictEqual(ctx.normalizeRelation('অভিভাবক'), 'অভিভাবক');
    assert.strictEqual(ctx.normalizeRelation('নিজ'), 'নিজ');
  });

  it('maps every site radio code to its Bengali label', () => {
    const ctx = loadRelationHelpers();
    const cases = {
      FATHER: 'পিতা', MOTHER: 'মাতা', SELF: 'নিজ',
      GRANDFATHER: 'পিতামহ', GRANDMOTHER: 'পিতামহী',
      MATERNALGRANDFATHER: 'মাতামহ', MATERNALGRANDMOTHER: 'মাতামহী',
      GUARDIAN: 'অভিভাবক', OTHERS: 'অন্যান্য',
    };
    for (const [code, label] of Object.entries(cases)) {
      assert.strictEqual(ctx.normalizeRelation(code), label, `${code} must map to ${label}`);
      assert.strictEqual(ctx.normalizeRelation(code.toLowerCase()), label, `${code.toLowerCase()} must map to ${label}`);
    }
  });

  it('returns empty for missing or unknown values, never a guess', () => {
    const ctx = loadRelationHelpers();
    assert.strictEqual(ctx.normalizeRelation(''), '');
    assert.strictEqual(ctx.normalizeRelation(null), '');
    assert.strictEqual(ctx.normalizeRelation(undefined), '');
    assert.strictEqual(ctx.normalizeRelation('GIBBERISH'), '');
    assert.strictEqual(ctx.normalizeRelation('  '), '');
  });
});

describe('cascade-relation fix: relationRenderState never silently Fathers', () => {
  it('a saved Others (label or code) restores as Others for a minor', () => {
    const ctx = loadRelationHelpers();
    ctx.S.d.s1.dob = '2017-05-15';
    assertState(ctx.relationRenderState('অন্যান্য'), 'অন্যান্য', '');
    assertState(ctx.relationRenderState('OTHERS'), 'অন্যান্য', '');
    assertState(ctx.relationRenderState('পিতা'), 'পিতা', '');
  });

  it('a saved Others restores as Others for an adult', () => {
    const ctx = loadRelationHelpers();
    ctx.S.d.s1.dob = '1980-02-02';
    assertState(ctx.relationRenderState('অন্যান্য'), 'অন্যান্য', '');
    assertState(ctx.relationRenderState('OTHERS'), 'অন্যান্য', '');
  });

  it('a missing saved relation is unset, not Father', () => {
    const ctx = loadRelationHelpers();
    ctx.S.d.s1.dob = '2017-05-15';
    assertState(ctx.relationRenderState(''), '', '');
    assertState(ctx.relationRenderState(null), '', '');
  });

  it('an unrecognised saved relation is unset with the raw value kept for the note', () => {
    const ctx = loadRelationHelpers();
    ctx.S.d.s1.dob = '2017-05-15';
    assertState(ctx.relationRenderState('GIBBERISH'), '', 'GIBBERISH');
  });

  it('a known relation outside the current age list is unset, never substituted', () => {
    const ctx = loadRelationHelpers();
    ctx.S.d.s1.dob = '1980-02-02'; // adult list is only নিজ/অন্যান্য
    assertState(ctx.relationRenderState('পিতা'), '', 'পিতা');
  });

  it('no missing/unknown input ever yields Father', () => {
    const ctx = loadRelationHelpers();
    for (const dob of ['2017-05-15', '1980-02-02', '']) {
      ctx.S.d.s1.dob = dob;
      for (const saved of ['', null, 'GIBBERISH', 'OTHERS', 'অন্যান্য', 'SELF']) {
        const st = ctx.relationRenderState(saved);
        assert.notStrictEqual(st.value, 'পিতা', `dob=${dob} saved=${saved} must not become Father`);
      }
    }
  });
});
