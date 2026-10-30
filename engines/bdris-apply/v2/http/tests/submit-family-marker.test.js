/**
 * Family marker strictness (2026-10-30 principled fix) — unit level.
 * The old familyRejectionMarker scanned the ENTIRE response body
 * with the bare /180/ regex, so any "180" anywhere in a 118KB shell
 * (a size, a year fragment, a script) mistagged the shell as a
 * family rejection. The marker now mirrors the bot, which tests
 * the wording on a TARGETED validation message: the server's
 * explicit error wording — a JSON message/code, else error-class
 * text (text-danger / invalid-feedback / alert-danger). A shell
 * with no error-class text and no JSON message yields no marker,
 * by construction.
 * Run: node --test engines/bdris-apply/v2/http/tests/submit-family-marker.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { familyRejectionMarker, submitRejectionWording } = require('../client');

const FAMILY = 'Difference of age among children needs to be at least 180 days';

// A shell-like body: contains "180" (a year fragment and a size)
// but NO error-class markup and NO JSON message — the exact shape
// that used to mistag.
const SHELL_LIKE = `<html><head><script>var sizes = [180, 240]; var year = 1800;</script></head>`
  + `<body><div class="form">application form 180 fields</div></body></html>`;

describe('family marker strictness', () => {
  it('shell-like body containing 180 but no error-class text and no JSON → no marker', () => {
    assert.strictEqual(familyRejectionMarker({ text: SHELL_LIKE, json: null }), '');
    assert.ok(!/family: 180-days/.test(submitRejectionWording({ text: SHELL_LIKE, json: null })));
  });

  it('plain family wording without error-class markup → no marker (strictness documented)', () => {
    assert.strictEqual(familyRejectionMarker({ text: FAMILY, json: null }), '');
  });

  it('JSON family message → marker', () => {
    assert.strictEqual(
      familyRejectionMarker({ text: '', json: { message: FAMILY } }),
      '[family: 180-days]',
    );
  });

  it('JSON family code → marker', () => {
    assert.strictEqual(
      familyRejectionMarker({ text: '', json: { code: 'difference of age' } }),
      '[family: 180-days]',
    );
  });

  it('error-class family text → marker', () => {
    const html = `<div class="text-danger">${FAMILY}</div>`;
    assert.strictEqual(familyRejectionMarker({ text: html, json: null }), '[family: 180-days]');
    assert.match(submitRejectionWording({ text: html, json: null }), /\[family: 180-days\]/);
  });

  it('error-class non-family text → no marker', () => {
    assert.strictEqual(
      familyRejectionMarker({ text: '<div class="invalid-feedback">Father ubrn not verified</div>', json: null }),
      '',
    );
  });

  it('JSON non-family message → no marker', () => {
    assert.strictEqual(
      familyRejectionMarker({ text: '', json: { message: 'Father ubrn not verified' } }),
      '',
    );
  });

  it('empty response → no marker', () => {
    assert.strictEqual(familyRejectionMarker({ text: '', json: null }), '');
    assert.strictEqual(familyRejectionMarker({}), '');
  });
});
