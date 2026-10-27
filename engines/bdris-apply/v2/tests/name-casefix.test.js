/**
 * Name case-fix + S1-NAMECHECK removal (2026-10-27).
 * Fake DOM / mock data only — no live bdris.gov.bd contact, no
 * browser, no personal data. All names are fixtures.
 * Run: node --test engines/bdris-apply/v2/tests/name-casefix.test.js
 * (from engines/bdris-apply/)
 *
 * Why: live journal capture 2026-10-27 proved the site itself
 * uppercases English names (want Demo/Test, site holds DEMO/TEST),
 * so the Phase 2 name-drop must compare case-insensitively —
 * otherwise the step-4 panel persists for names that ARE on the
 * site. And the TEMPORARY S1-NAMECHECK journal line is removed in
 * the same round, as promised: a failed S1 must log no such line,
 * so real names never land in the service journal.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { StepHandler } = require('../services/StepHandler');

const READBACK_REASON = 'সাইটে নাম ঠিকমতো বসেনি — আবার চেষ্টা করুন';

// ---- Fake page for _dropStaleNameFailures (real evaluate fn runs) ----
function makeNamePage(values) {
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
          }
          if (!key || !(key in values)) return null;
          return { value: values[key] };
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

// ---- Fake page + handler for the submitS1 removal guard ----
function makeS1Page(values) {
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

function makeS1Handler(siteValues) {
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

async function captureLogs(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    const out = await fn();
    return { out, lines };
  } finally {
    console.log = orig;
  }
}

describe('Name case-fix: site uppercasing must not keep the panel', () => {
  const data = {
    firstNameBn: 'ডেমো', lastNameBn: 'টেস্ট',
    firstNameEn: 'Demo', lastNameEn: 'Test',
  };

  it('drops entries when the site holds the same names uppercased (live case)', async () => {
    const handler = new StepHandler({ page: makeNamePage({
      personFirstNameBn: 'ডেমো', personLastNameBn: 'টেস্ট',
      personFirstNameEn: 'DEMO', personLastNameEn: 'TEST',
    }) });
    const failed = [
      { field: 'নামের প্রথম অংশ (বাংলা)', reason: READBACK_REASON },
      { field: 'নামের শেষ অংশ (বাংলা)', reason: READBACK_REASON },
      { field: 'First Name (English)', reason: READBACK_REASON },
      { field: 'Last Name (English)', reason: READBACK_REASON },
    ];
    const dropped = await handler._dropStaleNameFailures(data, failed);
    assert.strictEqual(dropped, 4);
    assert.deepStrictEqual(failed, []);
  });

  it('drops entries for mixed-case site values too, not just full upper', async () => {
    const handler = new StepHandler({ page: makeNamePage({
      personFirstNameBn: 'ডেমো', personLastNameBn: 'টেস্ট',
      personFirstNameEn: 'dEmO', personLastNameEn: 'tEsT',
    }) });
    const failed = [
      { field: 'First Name (English)', reason: READBACK_REASON },
      { field: 'Last Name (English)', reason: READBACK_REASON },
    ];
    const dropped = await handler._dropStaleNameFailures(data, failed);
    assert.strictEqual(dropped, 2);
    assert.deepStrictEqual(failed, []);
  });

  it('keeps a genuinely wrong name even with case-insensitive compare', async () => {
    const handler = new StepHandler({ page: makeNamePage({
      personFirstNameBn: 'ডেমো', personLastNameBn: 'টেস্ট',
      personFirstNameEn: 'KARIM', personLastNameEn: 'TEST',
    }) });
    const failed = [{ field: 'First Name (English)', reason: READBACK_REASON }];
    const dropped = await handler._dropStaleNameFailures(
      { ...data, firstNameEn: 'Rahim' }, failed);
    assert.strictEqual(dropped, 0);
    assert.strictEqual(failed.length, 1);
  });

  it('keeps a near-miss: case-insensitivity must NOT become includes-matching', async () => {
    const handler = new StepHandler({ page: makeNamePage({
      personFirstNameBn: 'ডেমো', personLastNameBn: 'টেস্ট',
      personFirstNameEn: 'RAHIM UDDIN', personLastNameEn: 'TEST',
    }) });
    const failed = [{ field: 'First Name (English)', reason: READBACK_REASON }];
    const dropped = await handler._dropStaleNameFailures(
      { ...data, firstNameEn: 'Rahim' }, failed);
    assert.strictEqual(dropped, 0);
    assert.strictEqual(failed.length, 1);
  });

  it('failed S1 logs NO S1-NAMECHECK line (temporary capture removed)', async () => {
    const handler = makeS1Handler({
      personFirstNameBn: 'ডেমো', personLastNameBn: 'টেস্ট',
      personFirstNameEn: 'RahimX', personLastNameEn: 'Test',
    });
    const { out, lines } = await captureLogs(() => handler.submitS1({
      firstNameBn: 'ডেমো', lastNameBn: 'টেস্ট',
      firstNameEn: 'Rahim', lastNameEn: 'Test',
      division: 'ঢাকা', district: 'ঢাকা', vilBn: 'x',
      docsAvailable: true,
    }));
    assert.strictEqual(out.ok, false);
    assert.strictEqual(
      lines.filter((l) => l.startsWith('S1-NAMECHECK')).length, 0,
      'no journal capture line may survive for real applications');
  });
});
