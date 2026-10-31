/**
 * PARENT-VERIFY (2026-10-31) — mock only, no live contact.
 *
 * Regression tests for the real parent-BRN verification path in
 * services/StepHandler.js (submitS2 / _clickVerify), under
 * SITE-MIRRORING semantics (2026-10-29 point 2, restored by the
 * 2026-10-31 adjustment — see the history note below):
 *   1. Verify success → verifyStatus true, no verify failure, S2 ok.
 *   2. Verify control missing → verifyStatus false + verbatim
 *      named reason, NO failed entry from verify alone; S2 proceeds
 *      to the site's own Next gate, and the site advancing means
 *      S2 ok — never a silent pending badge, never our own block.
 *   3. Registry mismatch → the site's reason verbatim in
 *      verifyReason, NO failed entry from verify alone; the site
 *      advancing means S2 ok, per-parent and exact.
 *   4. Inconclusive wait (no definitive signal) → verifyStatus
 *      false + verbatim reason, NO failed entry; the site gate
 *      decides, never a guess.
 *   5. Mismatch after an empty landing → one refill + one re-attempt;
 *      a second success clears the failure and S2 proceeds.
 *   6. Near-field Bengali button (যাচাই করুন next to the BRN field)
 *      is found and clicked — the English-only global search is not
 *      the only path.
 *   7. Preserved deliberately: pre-2013 exempt (BRN cleared, verify
 *      skipped) and family names-only advance (verify skipped).
 *   8. Verify failed AND the site never advances → honest
 *      not-advanced failure whose reason is NOT verify-derived
 *      (fresh site error, or honest "no fresh error") and whose
 *      failed[] holds no verify entry: the site decided, not us.
 *
 * HISTORY — read before "fixing" these assertions back:
 *   Pre-branch code silently skipped verify (quietMissing) and S2
 *   proceeded with a pending badge — tests 2/3/4 fail on it (no
 *   reason, status null).
 *   Branch fix-bdris-parentverify @ 65b468f made a mismatch /
 *   missing control / inconclusive wait a failed entry, so the
 *   cycle-1 A1 gate failed the step — OUR engine adding a block
 *   the site did not impose, contradicting standing rule point 2
 *   ("Verify never blocks alone", 2026-10-29).
 *   This adjustment RESTORES point 2: tests 2/3/4/8 fail on the
 *   branch code (verify entry in failed[] fails the step) and pass
 *   on the adjusted code (badge reason present, site gate decides).
 */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { StepHandler } = require('../services/StepHandler');
const { BdrisNavigator } = require('../services/BdrisNavigator');

// ---------------------------------------------------------------------------
// Stateful fake page. Element objects are shared between
// page.locator() and fakeDoc.querySelector() so fills persist and
// verify reads observe them — the property the old harness lacked.
// ---------------------------------------------------------------------------

function makeVerifyPage(opts = {}) {
  const state = {
    step: opts.step || 'parents',
    advanceTo: opts.advanceTo || 'address',
    // 'id' | 'near' | 'global' | 'none' — which verify controls exist
    verifyButtons: opts.verifyButtons || 'id',
    // per-parent outcome queues consumed on each verify click
    verifySeq: opts.verifySeq || {},
    mismatchText: opts.mismatchText || 'No birth record found',
    dropValueFills: Object.assign({}, opts.dropValueFills || {}),
    realWaits: !!opts.realWaits,
    verifyClicks: { father: 0, mother: 0 },
  };

  // Per-parent verify region: innerText is a getter implementing the
  // click → "verifying…" → outcome state machine.
  function makeRegion(parent) {
    const region = { _phase: null };
    Object.defineProperty(region, 'innerText', {
      get() {
        const ph = region._phase;
        if (!ph) return '';
        if (ph.outcome === 'timeout') return 'যাচাই হচ্ছে…';
        if (ph.step === 0) { ph.step = 1; return 'যাচাই হচ্ছে…'; }
        if (ph.outcome === 'success') return 'যাচাই সফল';
        if (ph.outcome === 'mismatch') return state.mismatchText;
        return '';
      },
    });
    region.querySelectorAll = (sel) => {
      if (state.verifyButtons !== 'near') return [];
      if (String(sel).includes('button') || String(sel).includes('input')) {
        return [region._btn].filter(Boolean);
      }
      return [];
    };
    return region;
  }

  function makeParent(parent) {
    const region = makeRegion(parent);
    const chain = (leaf) => {
      const a1 = { parentElement: null, querySelectorAll: () => [] };
      const a2 = { parentElement: a1, querySelectorAll: () => [] };
      const a3 = { parentElement: a2, querySelectorAll: () => [] };
      a1.parentElement = a2; a2.parentElement = a3; a3.parentElement = region;
      leaf.parentElement = a1;
      return leaf;
    };
    const field = (key) => {
      const el = {
        value: '',
        required: false,
        offsetParent: {},
        removeAttribute: () => {},
        dispatchEvent: () => {},
        getClientRects: () => [{}],
        isVisible: async () => state.step === 'parents',
        isEnabled: async () => true,
        fill: async (v) => {
          if (v !== '' && state.dropValueFills[parent] > 0) {
            state.dropValueFills[parent]--;
            return;
          }
          el.value = v;
        },
        click: async () => {},
        check: async () => {},
        selectOption: async () => {},
        type: async (v) => { el.value = v; },
        waitFor: async () => {},
        boundingBox: async () => ({ y: 100 }),
        evaluate: async (fn) => fn(el),
        inputValue: async () => el.value,
      };
      return el;
    };
    const brn = chain(field('brn'));
    const dob = chain(field('dob'));
    const nameBn = chain(field('nameBn'));
    const nameEn = chain(field('nameEn'));
    const nat = {
      value: '',
      options: [{ value: '', text: '---' }, { value: '1', text: 'বাংলাদেশী' }],
      offsetParent: {},
      removeAttribute: () => {},
      dispatchEvent: () => {},
      getClientRects: () => [{}],
    };
    const clickVerify = () => {
      state.verifyClicks[parent]++;
      const q = state.verifySeq[parent] || ['success'];
      const outcome = q.length ? q.shift() : 'success';
      region._phase = { step: 0, outcome };
    };
    const mkBtn = (text) => ({
      innerText: text,
      value: text,
      parentElement: null,
      offsetParent: {},
      getClientRects: () => [{}],
      click: clickVerify,
      isVisible: async () => true,
      isEnabled: async () => true,
    });
    const idBtn = mkBtn('Verify');
    const b1 = { parentElement: null, querySelectorAll: () => [] };
    const b2 = { parentElement: null, querySelectorAll: () => [] };
    b1.parentElement = b2; b2.parentElement = region;
    idBtn.parentElement = b1;
    const nearBtn = mkBtn('যাচাই করুন');
    nearBtn.parentElement = b1; // climb 3 from near button also lands on region
    region._btn = nearBtn;
    const globalBtn = mkBtn('Verify');
    const g1 = { parentElement: null, querySelectorAll: () => [] };
    const g2 = { parentElement: null, querySelectorAll: () => [] };
    g1.parentElement = g2; g2.parentElement = region;
    globalBtn.parentElement = g1;
    return { region, brn, dob, nameBn, nameEn, nat, idBtn, nearBtn, globalBtn };
  }

  const F = makeParent('father');
  const M = makeParent('mother');

  const selParent = (sel) => {
    const s = String(sel);
    if (s.includes('father')) return 'father';
    if (s.includes('mother')) return 'mother';
    return null;
  };
  const fieldFor = (sel) => {
    const p = selParent(sel);
    if (!p) return null;
    const s = String(sel);
    const P = p === 'father' ? F : M;
    if (s.includes('Brn') || s.includes('.ubrn')) return P.brn;
    if (s.includes('BirthDate') || s.includes('.personBirthDate')) return P.dob;
    if (s.includes('NameBn') || s.includes('.personNameBn')) return P.nameBn;
    if (s.includes('NameEn') || s.includes('.personNameEn')) return P.nameEn;
    if (s.includes('Nationality') || s.includes('.personNationality')) return P.nat;
    return null;
  };
  const isParentsSel = (sel) => {
    const s = String(sel);
    return s.includes('father') || s.includes('mother');
  };
  const isAddressSel = (sel) => {
    const s = String(sel);
    return s.includes('permAddr') || s.includes('prsntAddr');
  };

  const fakeDoc = {
    body: { innerText: 'form page' },
    querySelector: (sel) => {
      const s = String(sel);
      if (s === 'form') return {};
      if (s === '#father-check') return state.verifyButtons === 'id' ? F.idBtn : null;
      if (s === '#mother-check') return state.verifyButtons === 'id' ? M.idBtn : null;
      if (s === '#applicantName') return { value: 'XY', offsetParent: {}, removeAttribute: () => {}, dispatchEvent: () => {} };
      const f = fieldFor(s);
      if (f) return state.step === 'parents' ? f : null;
      if (isAddressSel(s)) return state.step === 'address' ? { value: '', offsetParent: {}, getClientRects: () => [{}], removeAttribute: () => {} } : null;
      return null;
    },
    querySelectorAll: (sel) => {
      const s = String(sel);
      if (s.includes('text-danger') || s.includes('invalid-feedback')) return [];
      if (s.includes('button') || s.includes(' a') || s === 'a') {
        // Global Verify/যাচাই buttons: id buttons and global buttons
        // are both plain buttons; near buttons live inside regions.
        const list = [];
        if (state.verifyButtons === 'id') list.push(F.idBtn, M.idBtn);
        if (state.verifyButtons === 'global') list.push(F.globalBtn, M.globalBtn);
        return list;
      }
      return [];
    },
  };

  const nextBtn = {
    innerText: 'পরবর্তী',
    parentElement: null,
    offsetParent: {},
    getClientRects: () => [{}],
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ y: 100 }),
    waitFor: async () => {},
    evaluate: async (fn) => fn({
      parentElement: {
        id: 'parentsSection',
        querySelector: () => ({}),
      },
    }),
    click: async () => { if (state.advanceTo) state.step = state.advanceTo; },
  };
  // evaluate() on the Next button walks to the id-bearing ancestor;
  // emulate: parentElement chain with id on the section node.
  nextBtn.parentElement = { id: 'parentsSection', querySelector: () => ({}) };

  // Playwright's first()/nth() return Locators (which carry count()),
  // so wrap raw elements in a locator facade with the same surface.
  const wrap = (el, visible = true) => ({
    count: async () => (visible ? 1 : 0),
    isVisible: async () => visible && (el.isVisible ? await el.isVisible() : true),
    isEnabled: async () => visible && (el.isEnabled ? await el.isEnabled() : true),
    click: async (...a) => (visible && el.click ? el.click(...a) : undefined),
    fill: async (...a) => (visible && el.fill ? el.fill(...a) : undefined),
    type: async (...a) => (visible && el.type ? el.type(...a) : undefined),
    check: async (...a) => (visible && el.check ? el.check(...a) : undefined),
    waitFor: async (...a) => (el.waitFor ? el.waitFor(...a) : undefined),
    boundingBox: async (...a) => (el.boundingBox ? el.boundingBox(...a) : null),
    evaluate: async (...a) => (el.evaluate ? el.evaluate(...a) : undefined),
    inputValue: async (...a) => (el.inputValue ? el.inputValue(...a) : ''),
  });
  const hidden = wrap({ isVisible: async () => false }, false);

  const page = {
    state,
    url: () => 'https://bdris.gov.bd/br/application',
    waitForTimeout: async (ms) => {
      if (state.realWaits) await new Promise((r) => setTimeout(r, ms));
    },
    waitForFunction: async () => true,
    keyboard: { press: async () => {} },
    evaluate: async (fn, arg) => {
      const prev = global.document;
      global.document = fakeDoc;
      try { return await fn(arg); } finally { global.document = prev; }
    },
    locator: (sel) => {
      const s = String(sel);
      if (s.includes('পরবর্তী') || s.includes('Next')) {
        return {
          count: async () => 1,
          nth: () => wrap(nextBtn),
          first: () => wrap(nextBtn),
        };
      }
      if (s === '#father-check') {
        const on = state.verifyButtons === 'id';
        return {
          count: async () => (on ? 1 : 0),
          first: () => (on ? wrap(F.idBtn) : hidden),
          nth: () => (on ? wrap(F.idBtn) : hidden),
        };
      }
      if (s === '#mother-check') {
        const on = state.verifyButtons === 'id';
        return {
          count: async () => (on ? 1 : 0),
          first: () => (on ? wrap(M.idBtn) : hidden),
          nth: () => (on ? wrap(M.idBtn) : hidden),
        };
      }
      if (s.includes('has-text("Verify")') || s.includes('has-text("যাচাই")')) {
        const list = state.verifyButtons === 'global'
          ? [F.globalBtn, M.globalBtn]
          : (state.verifyButtons === 'id' ? [F.idBtn, M.idBtn] : []);
        return {
          count: async () => list.length,
          nth: (i) => (list[i] ? wrap(list[i]) : hidden),
          first: () => (list[0] ? wrap(list[0]) : hidden),
        };
      }
      if (s.includes('label:has-text')) return { count: async () => 0, nth: () => hidden };
      const f = fieldFor(s);
      if (f) {
        const visible = state.step === 'parents';
        return {
          count: async () => (visible ? 1 : 0),
          nth: () => (visible ? wrap(f) : hidden),
          first: () => (visible ? wrap(f) : hidden),
        };
      }
      if (isAddressSel(s)) {
        const visible = state.step === 'address';
        const anchorEl = { isVisible: async () => true };
        return {
          count: async () => (visible ? 1 : 0),
          nth: () => (visible ? wrap(anchorEl) : hidden),
          first: () => (visible ? wrap(anchorEl) : hidden),
        };
      }
      return { count: async () => 0, nth: () => hidden, first: () => hidden };
    },
    $: async () => null,
    waitForSelector: async () => null,
  };
  return page;
}

function makeHandler(page, options = {}) {
  return new StepHandler(new BdrisNavigator(page), { emit: () => {}, ...options });
}

const PARENTS = {
  father: { brn: '19861591905000146', dob: '1986-01-07', nameBn: 'পিতা', nameEn: 'Father', nationality: 'বাংলাদেশী' },
  mother: { brn: '19971511285119679', dob: '1997-01-10', nameBn: 'মাতা', nameEn: 'Mother', nationality: 'বাংলাদেশী' },
};

// ---------------------------------------------------------------------------
// 1. Verify success.
// ---------------------------------------------------------------------------

describe('parent verify: success path', () => {
  it('verified parents yield verifyStatus true and S2 ok', async () => {
    const page = makeVerifyPage({ verifyButtons: 'id' });
    const h = makeHandler(page, { applicantDob: '2015-06-01' });
    const out = await h.submitS2(PARENTS);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.verifyStatus.father, true);
    assert.strictEqual(out.verifyStatus.mother, true);
    assert.strictEqual(out.verifyReason.father, null);
    assert.strictEqual(out.verifyReason.mother, null);
    assert.deepStrictEqual(out.failed, []);
  });
});

// ---------------------------------------------------------------------------
// 2. Missing control → recorded honestly, never our own block.
//    The site's Next gate decides: the fake site advances, so S2 ok.
// ---------------------------------------------------------------------------

describe('parent verify: missing control', () => {
  it('no verify control anywhere records a named reason per parent and S2 still follows the site gate', async () => {
    const page = makeVerifyPage({ verifyButtons: 'none' });
    const h = makeHandler(page, { applicantDob: '2015-06-01' });
    const out = await h.submitS2(PARENTS);
    assert.strictEqual(out.ok, true, 'site advanced, so verify alone must not fail the step');
    assert.strictEqual(out.verifyStatus.father, false);
    assert.strictEqual(out.verifyStatus.mother, false);
    assert.match(out.verifyReason.father, /পিতা-এর Verify নিয়ন্ত্রণ.*পাওয়া যায়নি/);
    assert.match(out.verifyReason.mother, /মাতা-এর Verify নিয়ন্ত্রণ.*পাওয়া যায়নি/);
    assert.ok(!out.failed.some((f) => /BRN যাচাই/.test(f.field || '')),
      'verify must not land in failed[] on its own');
    // Pre-fix code returned { verified: null } silently and S2
    // proceeded with a pending badge — that outcome is gone: an
    // attempt was made, so the status is false, never null.
    assert.notStrictEqual(out.verifyStatus.father, null);
  });
});

// ---------------------------------------------------------------------------
// 3. Registry mismatch → verbatim reason on the badge, site gate decides.
// ---------------------------------------------------------------------------

describe('parent verify: registry mismatch', () => {
  it('a fresh mismatch records the site reason verbatim and S2 follows the site gate', async () => {
    const page = makeVerifyPage({
      verifyButtons: 'id',
      verifySeq: { father: ['mismatch'], mother: ['success'] },
      mismatchText: 'No birth record found for the given BRN',
    });
    const h = makeHandler(page, { applicantDob: '2015-06-01' });
    const out = await h.submitS2(PARENTS);
    assert.strictEqual(out.ok, true, 'site advanced, so a mismatch alone must not fail the step');
    assert.strictEqual(out.verifyStatus.father, false);
    assert.strictEqual(out.verifyReason.father, 'No birth record found for the given BRN');
    assert.ok(!out.failed.some((f) => /BRN যাচাই/.test(f.field || '')),
      'verify must not land in failed[] on its own');
    // The mother still verifies — the failure is per-parent, exact.
    assert.strictEqual(out.verifyStatus.mother, true);
  });
});

// ---------------------------------------------------------------------------
// 4. Inconclusive wait → recorded honestly, site gate decides, never a guess.
// ---------------------------------------------------------------------------

describe('parent verify: inconclusive wait', () => {
  it('a verify that never resolves records a reason and S2 follows the site gate', async () => {
    const page = makeVerifyPage({
      verifyButtons: 'id',
      verifySeq: { father: ['timeout'], mother: ['success'] },
      realWaits: true,
    });
    const h = makeHandler(page, { applicantDob: '2015-06-01' });
    const out = await h.submitS2(PARENTS);
    assert.strictEqual(out.ok, true, 'site advanced, so an inconclusive wait alone must not fail the step');
    assert.strictEqual(out.verifyStatus.father, false);
    assert.match(out.verifyReason.father, /ফলাফল সময়মতো পাওয়া যায়নি/);
    assert.ok(!out.failed.some((f) => /BRN যাচাই/.test(f.field || '')),
      'verify must not land in failed[] on its own');
  });
});

// ---------------------------------------------------------------------------
// 5. Mismatch after an empty landing → one refill + one re-attempt.
// ---------------------------------------------------------------------------

describe('parent verify: refill then re-attempt', () => {
  it('an empty-landed BRN is refilled once and a second success clears the failure', async () => {
    const page = makeVerifyPage({
      verifyButtons: 'id',
      verifySeq: { father: ['mismatch', 'success'], mother: ['success'] },
      dropValueFills: { father: 1 },
    });
    const h = makeHandler(page, { applicantDob: '2015-06-01' });
    const out = await h.submitS2(PARENTS);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.verifyStatus.father, true);
    assert.strictEqual(out.verifyReason.father, null);
    assert.ok(!out.failed.some((f) => f.field === 'পিতা-এর BRN যাচাই'));
    assert.strictEqual(page.state.verifyClicks.father, 2);
  });
});

// ---------------------------------------------------------------------------
// 6. Near-field Bengali button.
// ---------------------------------------------------------------------------

describe('parent verify: near-field Bengali button', () => {
  it('a যাচাই করুন button next to the BRN field is found without any id', async () => {
    const page = makeVerifyPage({ verifyButtons: 'near' });
    const h = makeHandler(page, { applicantDob: '2015-06-01' });
    const out = await h.submitS2(PARENTS);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.verifyStatus.father, true);
    assert.strictEqual(out.verifyStatus.mother, true);
    assert.strictEqual(page.state.verifyClicks.father, 1);
    assert.strictEqual(page.state.verifyClicks.mother, 1);
  });
});

// ---------------------------------------------------------------------------
// 8. Verify failed AND the site never advances → the failure is the
//    site's (not-advanced), never verify-derived, and failed[] holds
//    no verify entry. The site gate is the only authority.
// ---------------------------------------------------------------------------

describe('parent verify: failed verify plus site never advances', () => {
  it('a mismatch plus a non-advancing site fails honestly without a verify entry', async () => {
    const page = makeVerifyPage({
      verifyButtons: 'id',
      verifySeq: { father: ['mismatch'], mother: ['success'] },
      mismatchText: 'No birth record found for the given BRN',
    });
    page.state.advanceTo = null; // Next clicks but the site stays on parents
    const h = makeHandler(page, { applicantDob: '2015-06-01' });
    const out = await h.submitS2(PARENTS);
    assert.strictEqual(out.ok, false, 'site never advanced, so still an honest failure');
    assert.strictEqual(out.blocked, true);
    assert.strictEqual(out.verifyUncertain, true);
    assert.strictEqual(out.verifyStatus.father, false);
    assert.strictEqual(out.verifyReason.father, 'No birth record found for the given BRN');
    assert.ok(!out.failed.some((f) => /BRN যাচাই/.test(f.field || '')),
      'verify must not land in failed[] even when the step fails for another reason');
    assert.ok(!/verify হয়নি/.test(out.reason), `reason must not be verify-derived: ${out.reason}`);
    assert.match(out.reason, /নতুন কোনো ভুল-বার্তা পাওয়া যায়নি/);
  });
});

// ---------------------------------------------------------------------------
// 7. Preserved deliberately: exempt + family paths skip verify.
// ---------------------------------------------------------------------------

describe('parent verify: preserved exempt and family paths', () => {
  it('pre-2013 clears BRN and skips verify with the exempt marker', async () => {
    const page = makeVerifyPage({ verifyButtons: 'none' });
    const h = makeHandler(page, { applicantDob: '1980-01-01' });
    const out = await h.submitS2(PARENTS);
    assert.strictEqual(out.verifyStatus.father, 'skipped-pre2013');
    assert.strictEqual(out.verifyStatus.mother, 'skipped-pre2013');
    assert.ok(!out.failed.some((f) => /BRN যাচাই/.test(f.field)));
    assert.strictEqual(page.state.verifyClicks.father, 0);
    assert.strictEqual(page.state.verifyClicks.mother, 0);
  });

  it('family names-only advance skips verify with the family marker', async () => {
    const page = makeVerifyPage({ verifyButtons: 'none' });
    const h = makeHandler(page, { applicantDob: '2015-06-01' });
    const out = await h.submitS2({ ...PARENTS, familyNamesOnly: true });
    assert.strictEqual(out.verifyStatus.father, 'skipped-family');
    assert.strictEqual(out.verifyStatus.mother, 'skipped-family');
    assert.ok(!out.failed.some((f) => /BRN যাচাই/.test(f.field)));
    assert.strictEqual(page.state.verifyClicks.father, 0);
    assert.strictEqual(page.state.verifyClicks.mother, 0);
  });
});
