'use strict';

// Bengali-digit mobile normalization (live error 2026-10-26 ~01:28:
// "যোগাযোগের তথ্য ঠিক করুন — মোবাইল নম্বর (১১ ডিজিট, 01 দিয়ে শুরু)".
// Cause: JS \d / [^\d] are ASCII-only, so collectStep6/collectAuto
// stripped Bengali digits entirely instead of converting them.
// The rule itself is unchanged: /^01\d{9}$/ after conversion.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { bnToArab } = require('../services/StepHandler');

const normalize = (raw) => bnToArab(raw).replace(/\D/g, '');
const valid = (raw) => /^01\d{9}$/.test(normalize(raw));

describe('phone normalization: Bengali digits', () => {
  it('converts a fully Bengali number to ASCII and passes', () => {
    assert.strictEqual(normalize('০১৭১২৩৪৫৬৭৮'), '01712345678');
    assert.strictEqual(valid('০১৭১২৩৪৫৬৭৮'), true);
  });

  it('converts mixed and spaced Bengali numbers', () => {
    assert.strictEqual(normalize('০১৭12345678'), '01712345678');
    assert.strictEqual(normalize('০১৭১ ২৩৪৫ ৬৭৮'), '01712345678');
    assert.strictEqual(valid('০১৭১ ২৩৪৫ ৬৭৮'), true);
  });

  it('leaves English numbers unchanged (regression)', () => {
    assert.strictEqual(normalize('01712345678'), '01712345678');
    assert.strictEqual(normalize('0171 234 5678'), '01712345678');
    assert.strictEqual(valid('01712345678'), true);
  });

  it('still rejects short, long, 02-start, +880 and empty numbers', () => {
    assert.strictEqual(valid('০১৭১২৩৪৫৬৭'), false);
    assert.strictEqual(valid('০১৭১২৩৪৫৬৭৮৯'), false);
    assert.strictEqual(valid('০২১২৩৪৫৬৭৮৯'), false);
    assert.strictEqual(valid('+8801712345678'), false);
    assert.strictEqual(valid('৮৮০১৭১২৩৪৫৬৭৮'), false);
    assert.strictEqual(valid(''), false);
  });

  it('bnToArab leaves non-digit text (e.g. emails) untouched', () => {
    assert.strictEqual(bnToArab('you@example.com'), 'you@example.com');
  });
});
