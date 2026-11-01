/**
 * OTHERS-FILL (2026-11-01) — Others/Guardian relation dead-end fix
 * (node:test, no live contact, no browser, no personal data;
 * fixture values only).
 *
 * Live evidence (2026-11-01 ~12:38, Fakhiha filing blocked): the
 * filer relation was Others (অন্যান্য), and the filing could not
 * pass the site's gate. The site's own form shows, under
 * "পিতা,মাতা ব্যতিরেকে অন্য কেহ হইলে", REQUIRED fields — জন্ম
 * নিবন্ধন নম্বর*, জন্ম তারিখ*, আবেদনকারীর নাম — but the engine
 * collected no such fields in the frontend and the bot, after
 * clicking the relation radio, filled only #applicantName (the
 * child's English-name fallback) and the declaration checkbox.
 * The required Others-person fields stayed empty, so the site
 * blocked the filing. The 2026-10-28 feature note (others/
 * guardian person fields per the main site's rule) was never
 * built — this is that bug, now live-proven.
 *
 * Covered:
 *  #1  locateOthersFields finds the block's fields by label text
 *      (id form), by name attribute when no id exists, by the
 *      name placeholder, and from the global pool when the block
 *      heading is absent; a missing field yields null, never a
 *      guessed selector.
 *  #2  _fillOthersPerson fails honestly with a NAMED reason when
 *      the person data is missing/incomplete, when a site field
 *      cannot be found, and when a landed value fails read-back
 *      — never a silent skip, never invented values.
 *  #3  _fillOthersPerson fills BRN (normalized), DOB (masked
 *      DD/MM/YYYY) and English name (transit-clean, backtick
 *      stripped) and verifies all three landed values.
 *  #4  submitS3 calls _fillOthersPerson exactly when the SITE
 *      picked GUARDIAN/OTHERS (state.value — never the UI's
 *      requested relation, since the site may force SELF).
 *  #5  Server plumbing: mergeStepParams falls back ctx -> session
 *      for other; the fallback plan's submitS3 step carries other
 *      from the draft, then s3, then the session.
 *
 * Run: node --test engines/bdris-apply/v2/tests/others-fill.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');

const { StepHandler, locateOthersFields, normalizeBrn } = require('../services/StepHandler');
const { mergeStepParams, buildPlaywrightFallbackPlan } = require('../server');

const BLOCK_HEAD = 'পিতা,মাতা ব্যতিরেকে অন্য কেহ হইলে';

// Fake-document input: parentElement chain ends at a node whose
// text carries (or lacks) the block heading; labelOf resolves via
// document.querySelector('label[for="..."]') for id'd inputs, or
// via a LABEL parent for id-less ones.
function makeDoc(inputs, labelsById) {
  return {
    querySelectorAll: () => inputs,
    querySelector: (sel) => {
      const m = String(sel).match(/^label\[for="([^"]+)"\]$/);
      if (m && labelsById[m[1]]) return { innerText: labelsById[m[1]], textContent: labelsById[m[1]] };
      return null;
    },
  };
}
function sectionNode(withHead) {
  return {
    tagName: 'DIV',
    innerText: withHead ? BLOCK_HEAD + ' জন্ম নিবন্ধন নম্বর জন্ম তারিখ আবেদনকারীর নাম' : 'আবেদনকারীর তথ্য',
    textContent: withHead ? BLOCK_HEAD : 'আবেদনকারীর তথ্য',
    parentElement: null,
    querySelector: () => null,
  };
}
function labelNode(text, parent) {
  return { tagName: 'LABEL', innerText: text, textContent: text, parentElement: parent, querySelector: () => null };
}
function inputNode(opts) {
  return {
    id: opts.id || '',
    type: opts.type || 'text',
    placeholder: opts.placeholder || '',
    getAttribute: (n) => (n === 'name' ? (opts.name || null) : null),
    parentElement: opts.parent || null,
  };
}

describe('locateOthersFields (label/section-driven, never guessed ids)', () => {
  test('finds all three fields by label text in the Others block', () => {
    const sec = sectionNode(true);
    const doc = makeDoc([
      inputNode({ id: 'siteBrn', parent: sec }),
      inputNode({ id: 'siteDob', parent: sec }),
      inputNode({ id: 'siteName', parent: sec }),
    ], {
      siteBrn: 'জন্ম নিবন্ধন নম্বর *',
      siteDob: 'জন্ম তারিখ *',
      siteName: 'আবেদনকারীর নাম',
    });
    const prev = global.document;
    global.document = doc;
    try {
      assert.deepStrictEqual(locateOthersFields(), { brn: '#siteBrn', dob: '#siteDob', en: '#siteName' });
    } finally { global.document = prev; }
  });

  test('falls back to input[name="..."] when an input has no id', () => {
    const sec = sectionNode(true);
    const doc = makeDoc([
      inputNode({ name: 'otherBrnField', parent: labelNode('জন্ম নিবন্ধন নম্বর', sec) }),
      inputNode({ name: 'otherDobField', parent: labelNode('জন্ম তারিখ', sec) }),
      inputNode({ name: 'otherNameField', parent: labelNode('আবেদনকারীর নাম', sec) }),
    ], {});
    const prev = global.document;
    global.document = doc;
    try {
      assert.deepStrictEqual(locateOthersFields(), {
        brn: 'input[name="otherBrnField"]',
        dob: 'input[name="otherDobField"]',
        en: 'input[name="otherNameField"]',
      });
    } finally { global.document = prev; }
  });

  test('finds the name field by its "নাম ইংরেজিতে" placeholder when no label matches', () => {
    const sec = sectionNode(true);
    const doc = makeDoc([
      inputNode({ id: 'b1', parent: sec }),
      inputNode({ id: 'd1', parent: sec }),
      inputNode({ id: 'n1', placeholder: 'নাম ইংরেজিতে', parent: sec }),
    ], { b1: 'জন্ম নিবন্ধন নম্বর', d1: 'জন্ম তারিখ' });
    const prev = global.document;
    global.document = doc;
    try {
      assert.strictEqual(locateOthersFields().en, '#n1');
    } finally { global.document = prev; }
  });

  test('falls back to the global pool when the block heading is absent', () => {
    const sec = sectionNode(false);
    const doc = makeDoc([
      inputNode({ id: 'gBrn', parent: sec }),
      inputNode({ id: 'gDob', parent: sec }),
      inputNode({ id: 'gName', parent: sec }),
    ], { gBrn: 'জন্ম নিবন্ধন নম্বর', gDob: 'জন্ম তারিখ', gName: 'আবেদনকারীর নাম' });
    const prev = global.document;
    global.document = doc;
    try {
      assert.deepStrictEqual(locateOthersFields(), { brn: '#gBrn', dob: '#gDob', en: '#gName' });
    } finally { global.document = prev; }
  });

  test('a missing field yields null, never a guessed selector', () => {
    const sec = sectionNode(true);
    const doc = makeDoc([
      inputNode({ id: 'onlyBrn', parent: sec }),
      inputNode({ id: 'onlyDob', parent: sec }),
    ], { onlyBrn: 'জন্ম নিবন্ধন নম্বর', onlyDob: 'জন্ম তারিখ' });
    const prev = global.document;
    global.document = doc;
    try {
      assert.deepStrictEqual(locateOthersFields(), { brn: '#onlyBrn', dob: '#onlyDob', en: null });
    } finally { global.document = prev; }
  });
});

// Fake page for _fillOthersPerson: evaluate() answers the two
// calls the method makes (locateOthersFields, then the read-back)
// from canned values; _typeInto/_typeMaskedDate are stubbed on the
// instance so only the method's own logic is under test.
function makeOthersHandler(found, landed) {
  const calls = { typeInto: [], typeMasked: [] };
  const page = {
    evaluate: async (fn, arg) => {
      if (arg) return landed; // read-back call passes the selectors
      return found; // locate call passes no arg
    },
  };
  const h = new StepHandler({ page }, {});
  h._typeInto = async (sels, val, label) => { calls.typeInto.push({ sels, val, label }); return { ok: true }; };
  h._typeMaskedDate = async (sels, val, label) => { calls.typeMasked.push({ sels, val, label }); return { ok: true }; };
  return { h, calls };
}
const OTHER = { brn: '12345678901234567', dob: '1990-05-06', en: 'Karim`' };
const FOUND = { brn: '#oBrn', dob: '#oDob', en: '#oName' };

describe('_fillOthersPerson (honest failure, verified fill)', () => {
  test('missing person data fails naming the person and the field', async () => {
    const { h } = makeOthersHandler(FOUND, {});
    const r1 = await h._fillOthersPerson(null, 'OTHERS');
    assert.strictEqual(r1.ok, false);
    assert.match(r1.reason, /অন্য ব্যক্তি/);
    const r2 = await h._fillOthersPerson({ brn: OTHER.brn, en: OTHER.en }, 'GUARDIAN');
    assert.strictEqual(r2.ok, false);
    assert.match(r2.reason, /অভিভাবক/);
    assert.match(r2.reason, /জন্ম তারিখ/);
  });

  test('unfindable site fields fail naming every missing field', async () => {
    const { h, calls } = makeOthersHandler({ brn: '#oBrn', dob: null, en: null }, {});
    const r = await h._fillOthersPerson(OTHER, 'OTHERS');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /জন্ম তারিখ/);
    assert.match(r.reason, /নাম \(English\)/);
    assert.strictEqual(calls.typeInto.length, 0); // nothing filled before the honest stop
  });

  test('fills BRN normalized, DOB as DD/MM/YYYY, name transit-clean, and verifies read-back', async () => {
    const landed = { brn: '12345678901234567', dob: '06/05/1990', en: 'Karim' };
    const { h, calls } = makeOthersHandler(FOUND, landed);
    const r = await h._fillOthersPerson(OTHER, 'OTHERS');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(calls.typeInto[0].sels, ['#oBrn']);
    assert.strictEqual(calls.typeInto[0].val, normalizeBrn(OTHER.brn));
    assert.deepStrictEqual(calls.typeMasked[0].sels, ['#oDob']);
    assert.strictEqual(calls.typeMasked[0].val, '06/05/1990');
    assert.deepStrictEqual(calls.typeInto[1].sels, ['#oName']);
    assert.strictEqual(calls.typeInto[1].val, 'Karim'); // backtick stripped at send
  });

  test('read-back mismatch fails naming the mismatched field', async () => {
    const landed = { brn: '12345678901234567', dob: '06/05/1990', en: 'KarimX' };
    const { h } = makeOthersHandler(FOUND, landed);
    const r = await h._fillOthersPerson(OTHER, 'GUARDIAN');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /নাম \(English\)/);
    assert.match(r.reason, /ঠিকভাবে বসেনি/);
  });

  test('a helper failure (e.g. missing element) propagates, never swallowed', async () => {
    const { h } = makeOthersHandler(FOUND, { brn: '12345678901234567', dob: '06/05/1990', en: 'Karim' });
    h._typeInto = async () => ({ ok: false, field: 'X', reason: 'ঘর পাওয়া যায়নি' });
    const r = await h._fillOthersPerson(OTHER, 'OTHERS');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /ঘর পাওয়া যায়নি/);
  });
});

describe('submitS3 wiring (site-picked relation decides)', () => {
  test('submitS3 calls _fillOthersPerson only for site-picked GUARDIAN/OTHERS', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'StepHandler.js'), 'utf8');
    const gate = src.indexOf("state.value === 'GUARDIAN' || state.value === 'OTHERS'");
    const call = src.indexOf('_fillOthersPerson(data.other, state.value)');
    assert.ok(gate > 0, 'gate on the site-picked relation value must exist');
    assert.ok(call > gate, 'the fill call must sit inside that gate');
    // The call must come after the #applicantName fallback (so the
    // other-person name overwrites the child-name fallback when the
    // block's name input IS #applicantName) and before the
    // declaration checkbox.
    const fallback = src.indexOf('আবেদনকারীর নাম:');
    const decl = src.indexOf('// ঘোষণা checkbox');
    assert.ok(fallback > 0 && fallback < call, 'fill must follow the #applicantName fallback');
    assert.ok(decl > call, 'fill must precede the declaration checkbox');
  });
});

describe('server plumbing (other travels like relation)', () => {
  test('mergeStepParams: explicit other wins, then ctx, then session', () => {
    // NOTE: mergeStepParams caches params.ctx on session.formCtx
    // (the existing relation behavior) — so each assertion needs
    // its own session object, or a cached ctx would leak across.
    const mkSess = () => ({ other: { brn: 'S', dob: '1990-01-01', en: 'Sess' } });
    assert.deepStrictEqual(
      mergeStepParams({ other: { brn: 'E' }, ctx: { other: { brn: 'C' } } }, mkSess(), 'SUBMIT_S4_PREP').other,
      { brn: 'E' });
    assert.deepStrictEqual(
      mergeStepParams({ ctx: { other: { brn: 'C' } } }, mkSess(), 'SUBMIT_S4_PREP').other,
      { brn: 'C' });
    assert.deepStrictEqual(
      mergeStepParams({}, mkSess(), 'SUBMIT_S4_PREP').other,
      mkSess().other);
    assert.strictEqual(mergeStepParams({}, {}, 'SUBMIT_S4_PREP').other, undefined);
  });

  test('fallback plan submitS3 carries other: draft, then s3, then session', () => {
    const draftOther = { brn: '11111111111111111', dob: '1990-01-01', en: 'Draft' };
    const s3Other = { brn: '22222222222222222', dob: '1991-01-01', en: 'S3' };
    const sessOther = { brn: '33333333333333333', dob: '1992-01-01', en: 'Sess' };
    const s3a = buildPlaywrightFallbackPlan({ other: draftOther, s1: { dob: '2003-05-06' } }, { page: {}, other: sessOther }).steps.find(([m]) => m === 'submitS3')[1];
    assert.deepStrictEqual(s3a.other, draftOther);
    const s3b = buildPlaywrightFallbackPlan({ s3: { other: s3Other }, s1: { dob: '2003-05-06' } }, { page: {}, other: sessOther }).steps.find(([m]) => m === 'submitS3')[1];
    assert.deepStrictEqual(s3b.other, s3Other);
    const s3c = buildPlaywrightFallbackPlan({ s1: { dob: '2003-05-06' } }, { page: {}, other: sessOther }).steps.find(([m]) => m === 'submitS3')[1];
    assert.deepStrictEqual(s3c.other, sessOther);
  });
});
