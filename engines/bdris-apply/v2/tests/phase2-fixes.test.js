/**
 * Phase 2 fixes (2026-10-27) — bdris-apply follow-up round, code part.
 * Fake DOM / mock data only — no live bdris.gov.bd contact, no
 * browser, no personal data. All names are fixtures.
 * Run: node --test engines/bdris-apply/v2/tests/phase2-fixes.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { StepHandler } = require('../services/StepHandler');

const READBACK_REASON = 'সাইটে নাম ঠিকমতো বসেনি — আবার চেষ্টা করুন';

// ---- Fake page for _dropStaleNameFailures (real evaluate fn runs) ----
function makeNamePage(values) {
  // values: { personFirstNameEn: site value, ... } keyed by input name
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

describe('Phase 2 Issue B: S1 stale name-fail re-validation', () => {
  const data = {
    firstNameBn: 'রহিম', lastNameBn: 'উদ্দিন',
    firstNameEn: 'Mary-Jane', lastNameEn: 'Smith',
  };
  // transitName('Mary-Jane') is 'MaryJane' (cleanName strips '-');
  // the site holding 'Mary Jane' is the same name up to the loose
  // key (spaces stripped) — a transient/mangled miss, not a wrong name.
  const siteValues = {
    personFirstNameBn: 'রহিম', personLastNameBn: 'উদ্দিন',
    personFirstNameEn: 'Mary Jane', personLastNameEn: 'Smith',
  };

  it('drops transient name failures that read back loose-equal, keeps other failures', async () => {
    const handler = new StepHandler({ page: makeNamePage(siteValues) });
    const failed = [
      { field: 'নামের প্রথম অংশ (বাংলা)', reason: READBACK_REASON },
      { field: 'First Name (English)', reason: READBACK_REASON },
      { field: 'Last Name (English)', reason: READBACK_REASON },
      { field: 'কাগজপত্র', reason: 'modal' },
    ];
    const dropped = await handler._dropStaleNameFailures(data, failed);
    assert.strictEqual(dropped, 3);
    assert.deepStrictEqual(failed.map((f) => f.field), ['কাগজপত্র']);
  });

  it('keeps a genuinely wrong name', async () => {
    const handler = new StepHandler({ page: makeNamePage({
      ...siteValues, personFirstNameEn: 'Karim',
    }) });
    const failed = [{ field: 'First Name (English)', reason: READBACK_REASON }];
    const dropped = await handler._dropStaleNameFailures(
      { ...data, firstNameEn: 'Rahim' }, failed);
    assert.strictEqual(dropped, 0);
    assert.strictEqual(failed.length, 1);
  });

  it('keeps a near-miss: includes-matching must NOT drop it', async () => {
    const handler = new StepHandler({ page: makeNamePage({
      ...siteValues, personFirstNameEn: 'Rahim Uddin',
    }) });
    const failed = [{ field: 'First Name (English)', reason: READBACK_REASON }];
    const dropped = await handler._dropStaleNameFailures(
      { ...data, firstNameEn: 'Rahim' }, failed);
    assert.strictEqual(dropped, 0);
    assert.strictEqual(failed.length, 1);
  });

  it('keeps a matching-value entry whose reason is NOT the read-back reason', async () => {
    const handler = new StepHandler({ page: makeNamePage(siteValues) });
    const failed = [{ field: 'First Name (English)', reason: 'field not found' }];
    const dropped = await handler._dropStaleNameFailures(data, failed);
    assert.strictEqual(dropped, 0);
    assert.strictEqual(failed.length, 1);
  });

  it('keeps an entry when the site field is empty (name really missing)', async () => {
    const handler = new StepHandler({ page: makeNamePage({
      ...siteValues, personFirstNameEn: '',
    }) });
    const failed = [{ field: 'First Name (English)', reason: READBACK_REASON }];
    const dropped = await handler._dropStaleNameFailures(data, failed);
    assert.strictEqual(dropped, 0);
    assert.strictEqual(failed.length, 1);
  });

  it('keeps an entry when there is no wanted value (single-name guard)', async () => {
    const handler = new StepHandler({ page: makeNamePage(siteValues) });
    const failed = [{ field: 'Last Name (English)', reason: READBACK_REASON }];
    const dropped = await handler._dropStaleNameFailures(
      { ...data, lastNameEn: '' }, failed);
    assert.strictEqual(dropped, 0);
    assert.strictEqual(failed.length, 1);
  });
});

describe('Phase 2 Issue A: warmFromData must not wipe the division list', () => {
  const htmlPath = path.join(__dirname, '..', '..', '..', '..', 'frontend', 'bdris-apply.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  // Slice warmFromData (up to the next top-level function) without
  // executing any of the page's DOM code.
  const start = html.indexOf('async function warmFromData()');
  assert.ok(start >= 0, 'warmFromData must exist in bdris-apply.html');
  const end = html.indexOf('function addrRec(', start);
  const warmSrc = html.slice(start, end >= 0 ? end : undefined);

  it('the deterministic rebuild loop breaks on no-want without resetting to idle', () => {
    assert.ok(warmSrc.includes('if (!want) { break; }'),
      'warmFromData loop must break (not wipe) on a level with no wanted value');
  });

  it('warmFromData contains no idle-wipe of a just-loaded level', () => {
    assert.ok(!warmSrc.includes("setGeoState(L.k, GEO_LEVELS, 'idle')"),
      'the idle wipe that emptied step-2 division on first paint must be gone');
  });
});
