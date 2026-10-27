/**
 * S1-NAMECHECK journal capture (2026-10-27) — TEMPORARY diagnostics.
 * Fake DOM / mock data only — no live bdris.gov.bd contact, no
 * browser, no personal data. All names are fixtures.
 * Run: node --test engines/bdris-apply/v2/tests/s1-namecheck-log.test.js
 * (from engines/bdris-apply/)
 *
 * Why: the browser agent cannot inspect websocket acks, so the S1
 * nameCheck values are unreachable from the page. submitS1 therefore
 * logs them server-side (journal) on the failed return ONLY, for one
 * demo capture round. This line MUST be removed after capture — it
 * must not stay for real applications. These tests pin that contract:
 * failed S1 logs exactly one S1-NAMECHECK line carrying nameCheck;
 * successful S1 logs nothing.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { StepHandler } = require('../services/StepHandler');

// ---- Fake page: evaluate() runs the fn against a stub document ----
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

describe('S1-NAMECHECK journal capture (temporary)', () => {
  it('failed S1 logs exactly one S1-NAMECHECK line carrying nameCheck', async () => {
    const handler = makeHandler({ ...matchedSite, personFirstNameEn: 'RahimX' });
    const { out, lines } = await captureLogs(() => handler.submitS1(baseData));
    assert.strictEqual(out.ok, false);
    const hits = lines.filter((l) => l.startsWith('S1-NAMECHECK'));
    assert.strictEqual(hits.length, 1, 'exactly one capture line on failure');
    const logged = JSON.parse(hits[0].slice('S1-NAMECHECK'.length).trim());
    assert.deepStrictEqual(
      logged.find((c) => c.field === 'First Name (English)'),
      { field: 'First Name (English)', want: 'Rahim', got: 'RahimX' });
    assert.strictEqual(logged.length, 4, 'all four checked fields logged');
  });

  it('successful S1 logs no S1-NAMECHECK line', async () => {
    const handler = makeHandler(matchedSite);
    const { out, lines } = await captureLogs(() => handler.submitS1(baseData));
    assert.strictEqual(out.ok, true);
    assert.strictEqual(lines.filter((l) => l.startsWith('S1-NAMECHECK')).length, 0);
  });
});
