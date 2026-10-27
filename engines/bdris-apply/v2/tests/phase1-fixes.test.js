/**
 * Phase 1 fixes (2026-10-27) — bdris-apply final-fix plan, code part.
 * Fake DOM / mock client only — no live bdris.gov.bd contact, no
 * browser, no personal data. All names are fixtures from reported cases.
 * Run: node --test engines/bdris-apply/v2/tests/phase1-fixes.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BdrisNavigator } = require('../services/BdrisNavigator');
const { StepHandler } = require('../services/StepHandler');
const { HttpGeoService } = require('../services/HttpGeoService');

// ---- Fake page for navigator tests (same shape as navigator-geo) ----
function makeSelectPage(optionsBySelector) {
  const nodes = {};
  for (const [sel, opts] of Object.entries(optionsBySelector)) {
    const state = { options: opts, value: '' };
    const node = {
      get options() { return state.options; },
      get value() { return state.value; },
      set value(v) { state.value = v; },
      dispatchEvent() {},
      _state: state,
    };
    // The evaluate splits on ',' — register under every part, like a
    // real document with both the id and the name selector present.
    nodes[sel] = node;
    for (const part of sel.split(',')) nodes[part.trim()] = node;
  }
  return {
    nodes,
    async evaluate(fn, arg) {
      const prev = global.document;
      global.document = { querySelector: (sel) => nodes[sel] || null };
      try {
        return await fn(arg);
      } finally {
        global.document = prev;
      }
    },
    async waitForTimeout() {},
  };
}

const SEL = '#birthPlacePaurasavaOrUnion, select[name="birthPlacePaurasavaOrUnion"]';

describe('Phase 1 Item 1: value-first selection', () => {
  it('selects by value even when the site text differs by a letter (jha vs ja)', async () => {
    const page = makeSelectPage({
      [SEL]: [
        { value: '', text: '--- নির্বাচন করুন ---' },
        { value: '5689', text: 'ঝিলংজা' },
        { value: '5690', text: 'চৌফলদন্ডী' },
      ],
    });
    const nav = new BdrisNavigator(page);
    // Frontend wants ঝিলংঝা (jha); the site lists ঝিলংজা (ja).
    // Text/loose matching cannot bridge a letter variant — the geo id must.
    assert.strictEqual(await nav.selectOptionByValue(SEL, '5689'), true);
    assert.strictEqual(page.nodes[SEL]._state.value, '5689');
  });

  it('selectOption with a value wins over a differing label', async () => {
    const page = makeSelectPage({
      [SEL]: [
        { value: '', text: '--- নির্বাচন করুন ---' },
        { value: '5689', text: 'ঝিলংজা' },
      ],
    });
    const nav = new BdrisNavigator(page);
    assert.strictEqual(await nav.selectOption(SEL, 'ঝিলংঝা', { value: '5689' }), true);
    assert.strictEqual(page.nodes[SEL]._state.value, '5689');
  });

  it('a missing value does NOT fall back to a label (no first-option accident)', async () => {
    const page = makeSelectPage({
      [SEL]: [
        { value: '', text: '--- নির্বাচন করুন ---' },
        { value: '5689', text: 'ঝিলংজা' },
      ],
    });
    const nav = new BdrisNavigator(page);
    assert.strictEqual(await nav.selectOptionByValue(SEL, '9999'), false);
    assert.strictEqual(page.nodes[SEL]._state.value, '');
  });

  it('text/loose fallback still works when no value is given (PM Khali dots + commas)', async () => {
    const pageDots = makeSelectPage({
      [SEL]: [
        { value: '', text: '--- নির্বাচন করুন ---' },
        { value: '1', text: 'পি.এম. খালী' },
      ],
    });
    const navDots = new BdrisNavigator(pageDots);
    assert.strictEqual(await navDots.selectOption(SEL, 'পিএমখালী'), true);
    assert.strictEqual(pageDots.nodes[SEL]._state.value, '1');

    const pageCommas = makeSelectPage({
      [SEL]: [
        { value: '', text: '--- নির্বাচন করুন ---' },
        { value: '2', text: 'পি, এম, খালী' },
      ],
    });
    const navCommas = new BdrisNavigator(pageCommas);
    assert.strictEqual(await navCommas.selectOption(SEL, 'পিএমখালী'), true);
    assert.strictEqual(pageCommas.nodes[SEL]._state.value, '2');
  });

  it('_selectFirstMatch tries the value first, then text candidates', async () => {
    const page = makeSelectPage({
      [SEL]: [
        { value: '', text: '--- নির্বাচন করুন ---' },
        { value: '5689', text: 'ঝিলংজা' },
        { value: '5690', text: 'চৌফলদন্ডী' },
      ],
    });
    const nav = new BdrisNavigator(page);
    const handler = new StepHandler(nav);
    handler._waitVisible = async () => ({});
    // Value matches despite the letter variant.
    let r = await handler._selectFirstMatch([SEL], ['ঝিলংঝা'], 'পৌরসভা/ইউনিয়ন', '5689');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(page.nodes[SEL]._state.value, '5689');
    // Wrong value + valid text falls back to text.
    page.nodes[SEL]._state.value = '';
    r = await handler._selectFirstMatch([SEL], ['চৌফলদন্ডী'], 'পৌরসভা/ইউনিয়ন', '9999');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(page.nodes[SEL]._state.value, '5690');
  });
});

// ---- Fake page for _dropStaleAddressFailures (real evaluate fn runs) ----
function makeBirthPlacePage(readBack) {
  // readBack: { selects: {Div: text, ...}, inputs: {PostOfc: value, ...} }
  const selNode = (text) => ({
    options: [{ text: '--- নির্বাচন করুন ---' }, { text }],
    selectedIndex: text ? 1 : 0,
  });
  const inpNode = (value) => ({ value: value || '' });
  return {
    async evaluate(fn, prefix) {
      const prev = global.document;
      global.document = {
        querySelector(sel) {
          const m = sel.match(/name="([^"]+)"/);
          if (!m) return null;
          const name = m[1].replace(prefix, '');
          if (sel.startsWith('select')) return selNode(readBack.selects[name] || '');
          return inpNode(readBack.inputs[name] || '');
        },
      };
      try {
        return await fn(prefix);
      } finally {
        global.document = prev;
      }
    },
    async waitForTimeout() {},
  };
}

describe('Phase 1 Item 2: S1 stale-fail re-validation', () => {
  const data = {
    country: 'বাংলাদেশ', division: 'ঢাকা', district: 'ঢাকা',
    cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', paurasavaUnion: 'অঞ্চল - ৭',
    ward: 'ওয়ার্ড - ৭১', postBn: 'ঢাকা', postEn: 'Dhaka',
    vilBn: 'গ্রাম', vilEn: 'Village',
  };
  const readBack = {
    selects: {
      Country: 'বাংলাদেশ', Div: 'ঢাকা', Dist: 'ঢাকা',
      CityCorpCantOrUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন',
      WardInCityCorp: 'অঞ্চল - ৭', PaurasavaOrUnion: '',
      WardInPaurasavaOrUnion: 'ওয়ার্ড - ৭১',
    },
    inputs: {
      PostOfc: 'ঢাকা', PostOfcEn: 'Dhaka', PostCode: '',
      VilAreaTownBn: 'গ্রাম', VilAreaTownEn: 'Village',
      HouseRoadBn: '', HouseRoadEn: '',
    },
  };

  it('drops transient address failures that read back correct, keeps genuine ones', async () => {
    const handler = new StepHandler({ page: makeBirthPlacePage(readBack) });
    const failed = [
      { field: 'বিভাগ', reason: 'first fill miss' },
      { field: 'জেলা', reason: 'first fill miss' },
      { field: 'ওয়ার্ড', reason: 'first fill miss' },
      { field: 'কাগজপত্র', reason: 'modal' },
    ];
    const dropped = await handler._dropStaleAddressFailures('birthPlace', data, failed);
    assert.strictEqual(dropped, 3);
    assert.deepStrictEqual(failed.map((f) => f.field), ['কাগজপত্র']);
  });

  it('keeps a genuinely wrong ward, including the near-miss (7 vs 71)', async () => {
    const handler = new StepHandler({ page: makeBirthPlacePage(readBack) });
    const failed = [{ field: 'ওয়ার্ড', reason: 'wrong' }];
    // Page shows ওয়ার্ড - ৭১ but data wants ওয়ার্ড - ৭: strict loose
    // equality must NOT treat this as a match (includes would).
    const dropped = await handler._dropStaleAddressFailures('birthPlace', { ...data, ward: 'ওয়ার্ড - ৭' }, failed);
    assert.strictEqual(dropped, 0);
    assert.strictEqual(failed.length, 1);
  });
});

// ---- Mock HTTP client for zone diagnostics (same shape as http-geo) ----
function coxClient(zoneEntries4, zoneEntries5, wardEntries) {
  const geo = (parent, order, type, ward, entries, target) => ({ parent: String(parent), order, type, ward: !!ward, entries, target });
  const table = [
    geo('1', 1, 1, false, [{ id: 10, nameBn: 'চট্টগ্রাম', nameEn: 'CTG' }], 2),
    geo(10, 2, 2, false, [{ id: 20, nameBn: 'কক্সবাজার', nameEn: 'CXB' }], 3),
    geo(20, 3, 8, false, [], 4),
    geo(20, 3, 3, false, [{ id: 30, nameBn: 'কক্সবাজার সদর', nameEn: 'CXB SADAR' }], 4),
    geo(30, 4, 4, false, zoneEntries4, 7),
    geo(30, 4, 5, false, zoneEntries5, 7),
  ];
  if (wardEntries) table.push(geo(40, 7, 13, false, wardEntries, 7));
  return {
    bootstrapped: true,
    async bootstrap() { this.bootstrapped = true; },
    async getGeo(parentGeoId, geoOrder, geoType, opts = {}) {
      const row = table.find((r) => r.parent === String(parentGeoId) && r.order === geoOrder && r.type === geoType && r.ward === !!opts.ward);
      if (!row) return { entries: [], targetGeoOrder: geoOrder + 1, geoOrder, geoType, geoGroup: opts.geoGroup };
      return { entries: row.entries, targetGeoOrder: row.target, geoOrder, geoType, geoGroup: opts.geoGroup };
    },
  };
}

const coxParents = { division: 'চট্টগ্রাম', district: 'কক্সবাজার', upazila: 'কক্সবাজার সদর', zone: '' };

describe('Phase 1 Items 4+5: zone diagnostics + PM Khali chain', () => {
  it('GEO_EMPTY names the upazila id, order and per-type counts', async () => {
    const svc = new HttpGeoService({ client: coxClient([], []) });
    await assert.rejects(() => svc.getZoneOptions(coxParents, 'birth'), (e) => {
      assert.strictEqual(e.code, 'GEO_EMPTY');
      assert.match(e.message, /upazilaId=30/);
      assert.match(e.message, /order=4/);
      assert.match(e.message, /type4=0/);
      assert.match(e.message, /type5=0/);
      return true;
    });
  });

  it('PM Khali full chain: dotted site name matches the undotted frontend name', async () => {
    const svc = new HttpGeoService({
      client: coxClient(
        [{ id: 40, nameBn: 'পি.এম. খালী' }],
        [{ id: 41, nameBn: 'চৌফলদন্ডী' }],
        [{ id: 50, nameBn: 'ওয়ার্ড - ১' }, { id: 51, nameBn: 'ওয়ার্ড - ২' }],
      ),
    });
    const res = await svc.getWardOptions({ ...coxParents, zone: 'পিএমখালী' }, 'birth');
    assert.deepStrictEqual(res.options.map((o) => o.name), ['ওয়ার্ড - ১', 'ওয়ার্ড - ২']);
  });

  it('PM Khali comma variant also matches via the loose layer', async () => {
    const svc = new HttpGeoService({
      client: coxClient(
        [{ id: 40, nameBn: 'পি, এম, খালী' }],
        [],
        [{ id: 50, nameBn: 'ওয়ার্ড - ১' }],
      ),
    });
    const res = await svc.getWardOptions({ ...coxParents, zone: 'পিএমখালী' }, 'birth');
    assert.deepStrictEqual(res.options.map((o) => o.name), ['ওয়ার্ড - ১']);
  });
});
