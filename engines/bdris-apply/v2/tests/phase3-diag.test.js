/**
 * S1 nameCheck diagnostics (2026-10-27) — bdris-apply diagnostics round.
 * Fake DOM / mock data only — no live bdris.gov.bd contact, no
 * browser, no personal data. All names are fixtures.
 * Run: node --test engines/bdris-apply/v2/tests/phase3-diag.test.js
 * (from engines/bdris-apply/)
 *
 * Why: the S1 ack's failed[] carries only {field, reason}, so a later
 * step-4 panel can never say WHAT the site held for the English names.
 * submitS1 now attaches nameCheck (want vs got from the first
 * read-back) to every S1 return. These tests prove the wiring: the
 * panel entries themselves are unchanged (field+reason only), while
 * nameCheck carries the values needed to tell a genuine mismatch
 * (got present-but-different, or empty) from a transient one.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { StepHandler } = require('../services/StepHandler');

const READBACK_REASON = 'সাইটে নাম ঠিকমতো বসেনি — আবার চেষ্টা করুন';

// ---- Fake page: evaluate() runs the fn against a stub document ----
function makeS1Page(values) {
  // values keyed by input name; unknown selects/inputs read as 'x'
  // so the bpFilled address check passes without a real cascade.
  return {
    async evaluate(fn) {
      const prev = global.document;
      global.document = {
        querySelector(sel) {
          let key = null;
          if (sel.startsWith('#')) key = sel.slice(1);
          else {
            const m = sel.match(/name\*="([^"]+)"/);
            if (m) key = m[1];
            else {
              const m2 = sel.match(/name="([^"]+)"/);
              if (m2) key = m2[1];
            }
          }
          if (key && key in values) return { value: values[key] };
          if (key) return { value: 'x' };
          return null;
        },
      };
      try {
        return await fn();
      } finally {
        global.document = prev;
      }
    },
    async waitForTimeout() {},
  };
}

function makeHandler(siteValues) {
  const handler = new StepHandler({ page: makeS1Page(siteValues) });
  handler.fillInput = async () => ({ ok: true });
  handler.selectDropdown = async () => ({ ok: true });
  handler._handleAttachmentModal = async () => ({ ok: true });
  handler._fillAddressSection = async () => {};
  handler._clickNextAndWait = async () => ({ ok: true });
  handler._waitVisible = async () => true;
  handler._dropStaleAddressFailures = async () => {};
  return handler;
}

const baseData = {
  firstNameBn: 'রহিম', lastNameBn: 'উদ্দিন',
  firstNameEn: 'Rahim', lastNameEn: 'Uddin',
  division: 'ঢাকা', district: 'ঢাকা', vilBn: 'x',
  docsAvailable: true,
};

const matchedSite = {
  personFirstNameBn: 'রহিম', personLastNameBn: 'উদ্দিন',
  personFirstNameEn: 'Rahim', personLastNameEn: 'Uddin',
};

function findCheck(out, field) {
  return (out.nameCheck || []).find((c) => c.field === field);
}

describe('S1 nameCheck diagnostics', () => {
  it('mismatched English first name: failed entry unchanged, nameCheck shows want vs got', async () => {
    const handler = makeHandler({ ...matchedSite, personFirstNameEn: 'RahimX' });
    const out = await handler.submitS1(baseData);
    assert.strictEqual(out.ok, false);
    const entry = (out.failed || []).find((f) => f.field === 'First Name (English)');
    assert.ok(entry, 'mismatch must still produce the panel entry');
    assert.strictEqual(entry.reason, READBACK_REASON);
    assert.deepStrictEqual(Object.keys(entry).sort(), ['field', 'reason'],
      'failed[] entries must stay field+reason only');
    const check = findCheck(out, 'First Name (English)');
    assert.deepStrictEqual(check, { field: 'First Name (English)', want: 'Rahim', got: 'RahimX' });
    assert.strictEqual(findCheck(out, 'নামের প্রথম অংশ (বাংলা)').got, 'রহিম');
    assert.strictEqual((out.nameCheck || []).length, 4, 'all four checked fields recorded');
  });

  it('empty site last name: entry kept, nameCheck got is empty', async () => {
    const handler = makeHandler({ ...matchedSite, personLastNameEn: '' });
    const out = await handler.submitS1(baseData);
    assert.strictEqual(out.ok, false);
    assert.ok((out.failed || []).some((f) => f.field === 'Last Name (English)'));
    assert.deepStrictEqual(findCheck(out, 'Last Name (English)'),
      { field: 'Last Name (English)', want: 'Uddin', got: '' });
  });

  it('all names matched: success return still carries nameCheck', async () => {
    const handler = makeHandler(matchedSite);
    const out = await handler.submitS1(baseData);
    assert.strictEqual(out.ok, true);
    assert.strictEqual((out.failed || []).length, 0);
    assert.strictEqual((out.nameCheck || []).length, 4);
    for (const c of out.nameCheck) assert.strictEqual(c.got, c.want);
  });

  it('single-name last name: unchecked field absent from nameCheck', async () => {
    const handler = makeHandler({ ...matchedSite, personLastNameEn: '' });
    const out = await handler.submitS1({ ...baseData, lastNameEn: '' });
    assert.strictEqual(findCheck(out, 'Last Name (English)'), undefined,
      'single-name guard skips the check, so no nameCheck row');
    assert.ok((out.nameCheck || []).some((c) => c.field === 'First Name (English)'));
  });

  it('early address-missing return also carries nameCheck', async () => {
    const handler = makeHandler({ ...matchedSite, personFirstNameEn: 'RahimX' });
    const { division, district, vilBn, ...noAddr } = baseData;
    const out = await handler.submitS1(noAddr);
    assert.strictEqual(out.ok, false);
    assert.ok((out.failed || []).some((f) => /জন্মস্থানের ঠিকানা/.test(f.field || '')));
    assert.deepStrictEqual(findCheck(out, 'First Name (English)'),
      { field: 'First Name (English)', want: 'Rahim', got: 'RahimX' });
  });
});
