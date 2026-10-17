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
    division: '#permAddrDiv, select[name="permAddrDiv"]',
    district: '#permAddrDist, select[name="permAddrDist"]',
    upazila: '#permAddrCityCorpCantOrUpazila, select[name="permAddrCityCorpCantOrUpazila"]',
    zone: '#permAddrPaurasavaOrUnion, select[name="permAddrPaurasavaOrUnion"], #permAddrWardInCityCorp, select[name="permAddrWardInCityCorp"]',
    ward: '#permAddrWardInPaurasavaOrUnion, select[name="permAddrWardInPaurasavaOrUnion"]',
  },
  prsnt: {
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
   */
  async getAddressOptions(level, parents = {}, form = 'birth') {
    const sel = this.getSelectors(form);
    const order = ['division', 'district', 'upazila', 'zone', 'ward'];
    const targetIdx = order.indexOf(level);

    if (targetIdx < 0) {
      throw new Error(`Invalid level: ${level}`);
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
        throw new Error(`Parent option not found: ${pLevel}="${pValue}"`);
      }

      // Wait for child to populate
      if (cSel) {
        await this.waitForOptions(cSel, 10000);
      }
      await this.page.waitForTimeout(500);
    }

    // Get target options with retry
    let options = await this.getOptions(sel[level]);
    for (let i = 0; i < 5 && !options.length; i++) {
      await this.page.waitForTimeout(1200);
      options = await this.getOptions(sel[level]);
    }

    return options;
  }
}

module.exports = { BdrisNavigator, SELECTORS, BDRIS_BASE };
