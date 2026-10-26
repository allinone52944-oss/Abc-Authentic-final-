/**
 * submitS2B copy fallback (live report 2026-10-26): the user clicked
 * "স্থায়ী ঠিকানা ও বর্তমান ঠিকানা একই" but the present address
 * never auto-filled, so the address step never advanced and the
 * later "কোড পাঠান" replay failed at the document step with
 * "ডকুমেন্ট পেজ পাওয়া যায়নি". Root cause in submitS2B: the
 * copy branch checked the site checkbox and waited, but never
 * verified the copy, never fell back to a direct fill, and the
 * re-check loop only ran for data cases (rec && !cp) — a copy
 * case (pres = null, presCopy = true) was silently skipped.
 *
 * Fake page only — no live bdris.gov.bd contact, no browser,
 * no personal data. The direct-fill section is stubbed so this
 * test proves the new branch logic (verify -> fallback -> verify
 * or honest failure), not _fillAddressSection itself.
 *
 * Run: node --test engines/bdris-apply/v2/tests/s2b-copy-fallback.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { StepHandler } = require('../services/StepHandler');

function makeState() {
  const mkSelect = (opts, selected) => ({
    options: opts.map((t, i) => ({ text: t, value: String(i + 1) })),
    selectedIndex: selected,
    offsetParent: {},
    get value() { return this.selectedIndex >= 0 ? String(this.selectedIndex + 1) : ''; },
    set value(v) { const i = Number(v) - 1; if (i >= 0) this.selectedIndex = i; },
  });
  const mkInput = (value) => ({ value, offsetParent: {} });
  const els = {};
  const put = (name, el) => { els[`select[name="${name}"]`] = el; els[`input[name="${name}"]`] = el; };
  // Permanent address: fully filled on the site page.
  put('permAddrCountry', mkSelect(['বাংলাদেশ'], 0));
  put('permAddrDiv', mkSelect(['ঢাকা'], 0));
  put('permAddrDist', mkSelect(['ঢাকা'], 0));
  put('permAddrCityCorpCantOrUpazila', mkSelect(['ঢাকা দক্ষিণ সিটি কর্পোরেশন'], 0));
  put('permAddrPaurasavaOrUnion', mkSelect(['--- নির্বাচন করুন ---', 'পারুলিয়া ইউনিয়ন'], 1));
  put('permAddrWardInPaurasavaOrUnion', mkSelect(['--- নির্বাচন করুন ---', 'ওয়ার্ড - ১'], 1));
  put('permAddrWardInCityCorp', mkSelect(['--- নির্বাচন করুন ---'], 0));
  put('permAddrPostOfc', mkInput('পারুলিয়া'));
  put('permAddrPostOfcEn', mkInput('PARULIA'));
  put('permAddrVilAreaTownBn', mkInput('পারুলিয়া'));
  put('permAddrVilAreaTownEn', mkInput('PARULIA'));
  // Present address: empty on the site page.
  put('prsntAddrCountry', mkSelect(['বাংলাদেশ'], -1));
  put('prsntAddrDiv', mkSelect(['ঢাকা'], -1));
  put('prsntAddrDist', mkSelect(['ঢাকা'], -1));
  put('prsntAddrCityCorpCantOrUpazila', mkSelect(['ঢাকা দক্ষিণ সিটি কর্পোরেশন'], -1));
  put('prsntAddrPaurasavaOrUnion', mkSelect(['--- নির্বাচন করুন ---', 'পারুলিয়া ইউনিয়ন'], 0));
  put('prsntAddrWardInPaurasavaOrUnion', mkSelect(['--- নির্বাচন করুন ---', 'ওয়ার্ড - ১'], 0));
  put('prsntAddrWardInCityCorp', mkSelect(['--- নির্বাচন করুন ---'], 0));
  put('prsntAddrPostOfc', mkInput(''));
  put('prsntAddrPostOfcEn', mkInput(''));
  put('prsntAddrVilAreaTownBn', mkInput(''));
  put('prsntAddrVilAreaTownEn', mkInput(''));
  return els;
}

function makePage(els, { copyBoxFound = true } = {}) {
  let checked = false;
  const checkbox = {
    isChecked: async () => checked,
    // Site copy that does NOT work: checking changes nothing.
    check: async () => { checked = true; },
    click: async () => { checked = !checked; },
  };
  const documentStub = {
    querySelector: (sel) => els[sel] || null,
    querySelectorAll: () => [],
  };
  return {
    evaluate: async (fn, arg) => {
      const prev = global.document;
      global.document = documentStub;
      try { return await fn(arg); } finally { global.document = prev; }
    },
    locator: (sel) => ({
      first: () => ({
        count: async () => (copyBoxFound && /স্থায়ী ঠিকানা ও বর্তমান ঠিকানা একই/.test(sel) ? 1 : 0),
        isVisible: async () => true,
        isChecked: checkbox.isChecked,
        check: checkbox.check,
        click: checkbox.click,
      }),
      count: async () => 0,
      nth: () => ({ isVisible: async () => false }),
    }),
    $: async () => null,
    waitForTimeout: async () => {},
  };
}

function makeHandler(page, els) {
  const nav = { page, selectOption: async () => true, waitForOptions: async () => true };
  const h = new StepHandler(nav, {});
  h._dismissNotices = async () => {};
  h._clickNextAndWait = async () => ({ ok: true });
  h._waitVisible = async () => null;
  h._detectValidationBlock = async () => ({ blocked: false });
  // Direct fill, as _fillAddressSection would: copy a record into a section.
  h._fillAddressSection = async (prefix, d) => {
    const setSel = (name, text) => {
      const el = els[`select[name="${prefix}${name}"]`];
      if (!el || !text) return;
      const i = el.options.findIndex((o) => o.text === text);
      if (i >= 0) el.selectedIndex = i;
    };
    const setInp = (name, v) => { const el = els[`input[name="${prefix}${name}"]`]; if (el && v) el.value = v; };
    setSel('Country', d.country);
    setSel('Div', d.division);
    setSel('Dist', d.district);
    setSel('CityCorpCantOrUpazila', d.cityCorpUpazila);
    setSel('PaurasavaOrUnion', d.paurasavaUnion);
    setSel('WardInPaurasavaOrUnion', d.ward);
    setInp('PostOfc', d.postOfficeBn || d.postBn);
    setInp('PostOfcEn', d.postOfficeEn || d.postEn);
    setInp('VilAreaTownBn', d.villageBn || d.vilBn);
    setInp('VilAreaTownEn', d.villageEn || d.vilEn);
  };
  return h;
}

const perm = {
  country: 'বাংলাদেশ', division: 'ঢাকা', district: 'ঢাকা',
  cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন',
  paurasavaUnion: 'পারুলিয়া ইউনিয়ন', ward: 'ওয়ার্ড - ১',
  postOfficeBn: 'পারুলিয়া', postOfficeEn: 'PARULIA',
  villageBn: 'পারুলিয়া', villageEn: 'PARULIA',
};

describe('submitS2B present-address copy', () => {
  it('a copy checkbox that copies nothing falls back to a direct fill from the permanent address', async () => {
    const els = makeState();
    const h = makeHandler(makePage(els), els);
    const r = await h.submitS2B({ perm, permCopy: false, pres: null, presCopy: true });
    assert.strictEqual(r.ok, true, JSON.stringify(r.failed));
    assert.deepStrictEqual(r.failed, []);
    // Present section is now actually filled on the page.
    assert.strictEqual(els['input[name="prsntAddrVilAreaTownBn"]'].value, 'পারুলিয়া');
    assert.strictEqual(els['select[name="prsntAddrDiv"]'].selectedIndex, 0);
  });

  it('a missing copy checkbox fails honestly instead of silently leaving the present address empty', async () => {
    const els = makeState();
    const h = makeHandler(makePage(els, { copyBoxFound: false }), els);
    const r = await h.submitS2B({ perm, permCopy: false, pres: null, presCopy: true });
    assert.strictEqual(r.ok, false);
    assert.ok(r.failed.some((f) => f.field === 'বর্তমান ঠিকানা'), JSON.stringify(r.failed));
    assert.strictEqual(els['input[name="prsntAddrVilAreaTownBn"]'].value, '');
  });
});
