/**
 * Frontend S4Prep fix (2026-10-26, permanent fix) — static + extracted
 * function tests against frontend/bdris-apply.html. No browser, no
 * DOM execution of the page itself: the file is read as text for
 * structure, and the two pure doc-signature helpers are extracted
 * and run in isolation.
 * Run: node --test engines/bdris-apply/v2/tests/frontend-s4prep.test.js
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
  // Brace-counting extraction: docsMetaSig's body contains an object
  // literal, so a [^}]* regex would truncate it mid-function.
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

function loadSigHelpers() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${extractFn('docsPartialHash')}\n${extractFn('docsMetaSig')}`, ctx);
  return ctx;
}

describe('frontend S4Prep: code-sent only after otpSent:true ack', () => {
  it('renderOtpCode takes a sent flag with a sending default', () => {
    assert.match(html, /function renderOtpCode\(sent\)/);
    assert.match(html, /sent = sent === true/);
    assert.match(html, /কোড পাঠানো হচ্ছে/);
  });
  it('sendOtp does NOT pre-render the OTP view in sending state (ALL-BUGS (a): view only after send success)', () => {
    // SUPERSEDED 2026-10-30 (user bug report, bug (a)): the old
    // pre-render made a FAILED send (400 cap) still show "code
    // being sent" with an OTP view and no sent code — advancing
    // without a sent OTP is meaningless. The view now renders
    // only on otpSent:true proof (ack handlers below), so the
    // sending-state pre-render is gone for good.
    assert.doesNotMatch(html, /renderOtpCode\(false\)/);
    assert.match(html, /renderOtpCode\(true\)/);
  });
  it('both ack handlers gate the sent text on d.otpSent === true', () => {
    const hits = html.match(/d\.otpSent === true/g) || [];
    assert.ok(hits.length >= 2, `expected >=2 otpSent gates, got ${hits.length}`);
  });
});

describe('frontend S4Prep: branch on machine-readable code, not Bengali text', () => {
  it('S4Prep failure branches on CONTACT_ANCHORS_MISSING', () => {
    assert.match(html, /x\.code === 'CONTACT_ANCHORS_MISSING'/);
  });
  it('no S4Prep failure branch still uses the old Bengali regex', () => {
    assert.doesNotMatch(html, /পেজ পাওয়া যায়নি\/\.test/);
  });
});

describe('frontend S4Prep payload carries docs for replay', () => {
  it('payloadFor(SUBMIT_S4_PREP) includes the draft docs', () => {
    assert.match(html, /if \(op === 'SUBMIT_S4_PREP'\) return \{ email: S\.d\.email \|\| '', phone: S\.d\.phone \|\| '', docs: S\.d\.docs \|\| \[\], relation: S\.d\.relation \|\| defaultRelation\(\) \}/);
  });
  it('payloadFor(SUBMIT_S4_PREP) includes the relation for replay (item 22)', () => {
    assert.match(html, /if \(op === 'SUBMIT_S4_PREP'\) return \{[^}]*relation: S\.d\.relation \|\| defaultRelation\(\) \}/);
  });
  it('S4Prep emits use payloadFor (so docs travel), not a docs-less literal', () => {
    assert.match(html, /emitStep\('SUBMIT_S4_PREP', payloadFor\('SUBMIT_S4_PREP'\)\)/);
    assert.doesNotMatch(html, /emitStep\('SUBMIT_S4_PREP', \{ email: S\.d\.email \|\| '', phone: S\.d\.phone \|\| '' \}\)/);
  });
});

describe('frontend documents-return: effective without new files', () => {
  it('documentsReturnAction resends SUBMIT_S3_DOCS from saved docs', () => {
    assert.match(html, /function documentsReturnAction\(\)/);
    assert.match(html, /emitStep\('SUBMIT_S3_DOCS', payloadFor\('SUBMIT_S3_DOCS'\)\)/);
  });
  it('re-upload is asked only when base64 is missing for 40 or 41', () => {
    assert.match(html, /function docsReadyForResend\(\)/);
    assert.match(html, /\['40', '41'\]\.every/);
    assert.match(html, /d\.base64/);
  });
  it('a successful documents-return S3 ack chains into S4Prep', () => {
    assert.match(html, /_docsReturnPending/);
    assert.match(html, /emitStep\('SUBMIT_S4_PREP'/);
  });
});

describe('frontend docsMetaSig: same name/type, different content', () => {
  it('distinguishes different content of the same length, not just name/type/size', () => {
    const { docsMetaSig } = loadSigHelpers();
    const a = { relation: 'SELF', docs: [{ name: 'doc.jpg', docType: '40', base64: 'AAAA' }] };
    const b = { relation: 'SELF', docs: [{ name: 'doc.jpg', docType: '40', base64: 'BBBB' }] };
    const c = { relation: 'SELF', docs: [{ name: 'doc.jpg', docType: '40', base64: 'AAAA' }] };
    assert.notStrictEqual(docsMetaSig(a), docsMetaSig(b), 'same name/type/length, different bytes must differ');
    assert.strictEqual(docsMetaSig(a), docsMetaSig(c), 'identical docs must give an identical signature');
  });
  it('includes size and a partial hash, not the full base64', () => {
    const { docsMetaSig } = loadSigHelpers();
    const sig = docsMetaSig({ relation: '', docs: [{ name: 'x.jpg', docType: '41', base64: 'QUJD'.repeat(500) }] });
    assert.ok(!sig.includes('QUJD'.repeat(10)), 'signature must not embed the full base64');
    assert.ok(sig.includes('1500'), 'signature must include the decoded size');
  });
});
