/**
 * BdrisNavigator — BDRIS site navigation and form interaction
 *
 * Principles:
 * - All selectors centralized here
 * - Methods are idempotent where possible
 * - Clear errors with context
 * - No business logic, just site interaction
 */

const BDRIS_BASE = 'https://bdris.gov.bd';

// Centralized selectors for all forms
const SELECTORS = {
  birth: {
    country: '#birthPlaceCountry, select[name="birthPlaceCountry"]',
    division: '#birthPlaceDiv, select[name="birthPlaceDiv"]',
    district: '#birthPlaceDist, select[name="birthPlaceDist"]',
    upazila: '#birthPlaceCityCorpCantOrUpazila, select[name="birthPlaceCityCorpCantOrUpazila"]',
    zone: '#birthPlacePaurasavaOrUnion, select[name="birthPlacePaurasavaOrUnion"], #birthPlaceWardInCityCorp, select[name="birthPlaceWardInCityCorp"]',
    ward: '#birthPlaceWardInPaurasavaOrUnion, select[name="birthPlaceWardInPaurasavaOrUnion"]',
  },
  perm: {
    country: '#permAddrCountry, select[name="permAddrCountry"]',
    division: '#permAddrDiv, select[name="permAddrDiv"]',
    district: '#permAddrDist, select[name="permAddrDist"]',
    upazila: '#permAddrCityCorpCantOrUpazila, select[name="permAddrCityCorpCantOrUpazila"]',
    zone: '#permAddrPaurasavaOrUnion, select[name="permAddrPaurasavaOrUnion"], #permAddrWardInCityCorp, select[name="permAddrWardInCityCorp"]',
    ward: '#permAddrWardInPaurasavaOrUnion, select[name="permAddrWardInPaurasavaOrUnion"]',
  },
  prsnt: {
    country: '#prsntAddrCountry, select[name="prsntAddrCountry"]',
    division: '#prsntAddrDiv, select[name="prsntAddrDiv"]',
    district: '#prsntAddrDist, select[name="prsntAddrDist"]',
    upazila: '#prsntAddrCityCorpCantOrUpazila, select[name="prsntAddrCityCorpCantOrUpazila"]',
    zone: '#prsntAddrPaurasavaOrUnion, select[name="prsntAddrPaurasavaOrUnion"], #prsntAddrWardInCityCorp, select[name="prsntAddrWardInCityCorp"]',
    ward: '#prsntAddrWardInPaurasavaOrUnion, select[name="prsntAddrWardInPaurasavaOrUnion"]',
  },
};

class BdrisNavigator {
  constructor(page) {
    this.page = page;
  }

  // Normalize Bengali text for matching
  static normalize(text) {
    return String(text || '')
      .replace(/[\u09DC]/g, '\u09A1\u09BC')
      .replace(/[\u09DD]/g, '\u09A2\u09BC')
      .replace(/[\u09DF]/g, '\u09AF\u09BC')
      .replace(/[\u0981\u200C\u200D]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async gotoForm() {
    await this.page.goto(`${BDRIS_BASE}/br/application`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // Wait for form to be interactive
    await this.page.waitForSelector(
      SELECTORS.birth.division,
      { timeout: 15000 }
    ).catch(() => {});
  }

  getSelectors(form) {
    const sel = SELECTORS[form];
    if (!sel) throw new Error(`Unknown form: ${form}`);
    return sel;
  }

  // State of the first existing select in a selector list: whether
  // the element exists at all, how many raw options it has, and how
  // many survive the same placeholder filter getOptions() applies.
  // Distinguishes "select missing" from "select present but
  // placeholder-only" — the two states the old code collapsed into
  // one empty list, which is why the live banner could only say
  // "options present: 0" without saying why.
  async getSelectState(selector) {
    return await this.page.evaluate((sel) => {
      const selectors = sel.split(',').map(s => s.trim());
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (!el) continue;
        const raw = el.options ? el.options.length : 0;
        const filtered = Array.from(el.options || []).filter(o => {
          const v = (o.value || '').trim();
          const t = (o.text || '').trim();
          return v && v !== '-1' && v !== '' && t && !/নির্বাচন করুন/i.test(t);
        }).length;
        return { exists: true, rawCount: raw, filteredCount: filtered };
      }
      return { exists: false, rawCount: 0, filteredCount: 0 };
    }, selector).catch(() => ({ exists: false, rawCount: 0, filteredCount: 0 }));
  }

  // Guarantee the page is the form page before a cascade runs.
  // Proven defect (live banner 2026-10-26, division options 0):
  // server.js skipped gotoForm whenever the session URL merely
  // contained "bdris.gov.bd" — a warm page on ANY BDRIS page
  // (not /br/application) therefore ran the cascade against
  // selects that do not exist there, and every parent failed with
  // options present: 0. This check is cheap on the common path
  // (one URL read + one selector evaluate when already on the
  // form) and only navigates when the page is actually not the
  // form. Test doubles without url()/goto() are left alone:
  // formPresent is null and the caller proceeds to its own
  // diagnostic instead of throwing here.
  async ensureFormPage(form = 'birth') {
    const sel = this.getSelectors(form);
    if (typeof this.page.url !== 'function') {
      return { navigated: false, pageUrl: null, formPresent: null };
    }
    let url = null;
    try { url = this.page.url(); } catch (e) { /* unknown */ }
    if (url && url.includes('/br/application')) {
      const state = await this.getSelectState(sel.division);
      if (state.exists) return { navigated: false, pageUrl: url, formPresent: true };
    }
    if (typeof this.page.goto !== 'function') {
      return { navigated: false, pageUrl: url, formPresent: false };
    }
    try {
      await this.page.goto(`${BDRIS_BASE}/br/application`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
    } catch (e) { /* selector check below decides */ }
    if (typeof this.page.waitForSelector === 'function') {
      await this.page.waitForSelector(sel.division, { timeout: 3000 }).catch(() => {});
    }
    let newUrl = url;
    try { newUrl = this.page.url(); } catch (e) { /* unknown */ }
    const after = await this.getSelectState(sel.division);
    return { navigated: true, pageUrl: newUrl, formPresent: after.exists };
  }

  async getOptions(selector) {
    return await this.page.evaluate((sel) => {
      const selectors = sel.split(',').map(s => s.trim());
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (!el) continue;
        const opts = Array.from(el.options)
          .filter(o => {
            const v = (o.value || '').trim();
            const t = (o.text || '').trim();
            return v && v !== '-1' && v !== '' && t && !/নির্বাচন করুন/i.test(t);
          })
          .map(o => ({ id: o.value, name: o.text.trim() }));
        if (opts.length) return opts;
      }
      return [];
    }, selector);
  }

  async selectOption(selector, label) {
    const normalized = BdrisNavigator.normalize(label);
    return await this.page.evaluate(({ sel, want }) => {
      const norm = (t) => String(t || '')
        .replace(/[\u09DC]/g, '\u09A1\u09BC')
        .replace(/[\u09DD]/g, '\u09A2\u09BC')
        .replace(/[\u09DF]/g, '\u09AF\u09BC')
        .replace(/[\u0981\u200C\u200D]/g, '')
        .replace(/\s+/g, ' ').trim();
      const selectors = sel.split(',').map(s => s.trim());
      for (const s of selectors) {
        const node = document.querySelector(s);
        if (!node) continue;
        const w = norm(want);
        const opt = Array.from(node.options).find(o => norm(o.text) === w) ||
          Array.from(node.options).find(o => {
            const t = norm(o.text);
            return t && (t.includes(w) || w.includes(t));
          });
        if (opt) {
          node.value = opt.value;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, { sel: selector, want: label });
  }

  async waitForOptions(selector, timeoutMs = 10000) {
    try {
      await this.page.waitForFunction(
        (sel) => {
          const selectors = sel.split(',').map(s => s.trim());
          for (const s of selectors) {
            const el = document.querySelector(s);
            if (el && el.options.length > 1) return true;
          }
          return false;
        },
        selector,
        { timeout: timeoutMs }
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get address options for a level, setting up parent cascade
   * This is the core method that replaces the fragile mirror logic
   *
   * Budget note (2026-10-25, proven from the code's own timeouts,
   * re-balanced 2026-10-26 for the country-first step below):
   * this runs inside the 30s GET_ADDRESS_OPTIONS executor budget
   * AFTER an up-to-8s HTTP attempt (AddressService). Worst case:
   * HTTP 8000ms + country wait 5000ms (only when the division list
   * starts empty) + 3 parents x (3000ms wait + 500ms sleep) +
   * 3 x 1200ms target retries = 8000 + 5000 + 10500 + 3600 =
   * 27100ms < 30000ms executor < 40000ms frontend. The waits
   * resolve immediately when options are already present; only
   * stuck-level detection gets slower in the absolute worst case.
   * The waitForOptions DEFAULT (10000ms) is unchanged — the submit
   * flow passes its own explicit timeouts and is untouched by this.
   * ensureFormPage() below adds no cost on the common path (the
   * page is already the form: one URL read + one selector
   * evaluate); only a non-form page pays a navigation, which the
   * old code skipped entirely and then failed instantly with a
   * misleading options-present: 0.
   */
  async getAddressOptions(level, parents = {}, form = 'birth') {
    const sel = this.getSelectors(form);
    const order = ['division', 'district', 'upazila', 'zone', 'ward'];
    const targetIdx = order.indexOf(level);

    if (targetIdx < 0) {
      throw new Error(`Invalid level: ${level}`);
    }

    // Form page first (proven defect, live banner 2026-10-26):
    // the old server.js check skipped navigation for ANY
    // bdris.gov.bd URL, so a session page that was not on
    // /br/application ran the cascade against selects that do not
    // exist there. If the form still is not loaded after the
    // navigation attempt, say so by name instead of letting the
    // first parent fail with a bare options-present: 0.
    const formCheck = await this.ensureFormPage(form);
    if (formCheck.formPresent === false) {
      throw new Error(`Playwright: form page not loaded (division select missing) on ${formCheck.pageUrl || 'unknown page'}; cannot run cascade`);
    }
    const pageUrl = formCheck.pageUrl;

    // Country first (proven defect, live banner 2026-10-26):
    // the old code attempted the first parent (division) with NO
    // wait and NO country selection, while the submit cascade
    // (StepHandler._fillAddressSection) selects country first and
    // then waits for the child list. gotoForm() only waits for the
    // division SELECTOR to exist, not for its options. A warm page
    // that never had country selected therefore has a
    // placeholder-only division select, and the first selectOption
    // failed instantly with: Parent option not found:
    // division="ঢাকা". Fix: if the division list starts empty,
    // select country ("বাংলাদেশ", the same candidate the submit
    // path uses) and wait for the division list before touching
    // any parent. When options are already present this costs
    // two evaluates and no wait.
    //
    // Second proven gap in the same block (live banner after
    // 1884319, still options present: 0): the old code IGNORED
    // selectOption's boolean, so a failed country selection —
    // country select missing, or no "বাংলাদেশ" option on that
    // page state — was invisible and the division parent error
    // took the blame. Now a division list that stays empty after
    // country selection throws naming the country state itself
    // (select present, options present, selection succeeded) and
    // the page, so the next banner distinguishes a country
    // failure from a division-population failure.
    if (sel.country) {
      const countryBefore = await this.getSelectState(sel.country);
      const divBefore = await this.getSelectState(sel.division);
      if (!divBefore.filteredCount) {
        const countryDone = await this.selectOption(sel.country, 'বাংলাদেশ');
        await this.waitForOptions(sel.division, 5000);
        const divAfter = await this.getSelectState(sel.division);
        if (!divAfter.filteredCount) {
          throw new Error(`Playwright: division list still empty after country selection (country select present: ${countryBefore.exists}, country options present: ${countryBefore.filteredCount}, country selection succeeded: ${countryDone}, division options present: ${divAfter.filteredCount}, page: ${pageUrl || 'unknown'})`);
        }
      }
    }

    // Set up parent cascade
    for (let i = 0; i < targetIdx; i++) {
      const pLevel = order[i];
      const pValue = parents[pLevel];
      if (!pValue) continue;

      const pSel = sel[pLevel];
      const cSel = sel[order[i + 1]];

      const done = await this.selectOption(pSel, pValue);
      if (!done) {
        // Name the options actually present, so the next live
        // banner distinguishes "list empty" (0) from "list present
        // but name mismatched" (>0) instead of both looking alike.
        const present = await this.getOptions(pSel).catch(() => []);
        throw new Error(`Parent option not found: ${pLevel}="${pValue}" (options present: ${present.length})`);
      }

      // Wait for child to populate (3000ms, not 5000ms, so the
      // added country step above keeps the cascade inside the
      // executor budget; waits resolve immediately on populate)
      if (cSel) {
        await this.waitForOptions(cSel, 3000);
      }
      await this.page.waitForTimeout(500);
    }

    // Get target options with retry (budget: 3 retries, see method note)
    let options = await this.getOptions(sel[level]);
    for (let i = 0; i < 3 && !options.length; i++) {
      await this.page.waitForTimeout(1200);
      options = await this.getOptions(sel[level]);
    }

    return options;
  }
}

module.exports = { BdrisNavigator, SELECTORS, BDRIS_BASE };
