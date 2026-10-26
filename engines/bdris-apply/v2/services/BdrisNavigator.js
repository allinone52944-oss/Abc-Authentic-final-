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
  constructor(page, opts = {}) {
    this.page = page;
    // Optional fresh-page factory (wired only by the server geo
    // handler, which owns the browser and the session): async () =>
    // a brand-new page. Used once per navigator when the current
    // page is a content-less stub at the form URL — see
    // ensureFormPage. Test doubles and all other callers omit it
    // and keep the old reload behaviour.
    this.createFreshPage = typeof opts.createFreshPage === 'function'
      ? opts.createFreshPage : null;
    this._freshPageUsed = false;
    // Last navigation diagnostics (safe only: status, final URL,
    // content-type, redirect count — never body text, never field
    // values, never cookie/token values). Every page.goto() in
    // this file records here; getPageState() attaches a snapshot
    // so any error built from describePageState() carries it.
    this.lastNavigation = null;
    this.lastSiteNavigation = null;
  }

  // Record a goto() response, if the page returns one (real
  // Playwright does; test doubles return undefined and are left
  // alone). Redirect count walks the request's redirectedFrom
  // chain, guarded at every step.
  _recordNavigation(resp, slot = 'lastNavigation') {
    if (!resp || typeof resp.status !== 'function') return;
    let status = null; let finalUrl = null; let contentType = null; let redirectCount = 0;
    try { status = resp.status(); } catch (e) { /* unknown */ }
    try { finalUrl = typeof resp.url === 'function' ? resp.url() : null; } catch (e) { /* unknown */ }
    try {
      const headers = typeof resp.headers === 'function' ? resp.headers() : {};
      contentType = headers['content-type'] || headers['Content-Type'] || null;
    } catch (e) { /* unknown */ }
    try {
      let req = typeof resp.request === 'function' ? resp.request() : null;
      while (req && typeof req.redirectedFrom === 'function' && req.redirectedFrom()) {
        redirectCount++;
        req = req.redirectedFrom();
        if (redirectCount > 20) break;
      }
    } catch (e) { /* unknown */ }
    this[slot] = { status, finalUrl, contentType, redirectCount };
  }

  static describeNavigation(nav) {
    if (!nav) return 'unknown';
    return `status=${nav.status}, final URL=${nav.finalUrl || 'unknown'}, ` +
      `redirects=${nav.redirectCount}, content-type=${nav.contentType || 'unknown'}`;
  }

  // In-site navigation to the form (2026-10-26 senior
  // investigation): OriginalFetcher._openPrintForm proved, on
  // another BDRIS page, that a direct deep goto is WAF-blocked
  // ("Please type on browser") while homepage -> real-link click
  // works. No homepage link to /br/application is proven in
  // code, so this is a FALLBACK, not the primary attempt: it
  // only runs after a direct goto yields a stub. It goes to the
  // homepage, clicks the first anchor whose href is (or ends
  // with) /br/application — an evaluate click, so a collapsed
  // nav dropdown does not need a hover — then polls for form
  // content. Returns { foundLink, state }; never throws.
  async gotoFormViaSite(homepageTimeout = 15000, pollIterations = 20) {
    try {
      const resp = await this.page.goto(`${BDRIS_BASE}/`, {
        waitUntil: 'domcontentloaded',
        timeout: homepageTimeout,
      });
      this._recordNavigation(resp, 'lastSiteNavigation');
    } catch (e) { /* state check below decides */ }
    let foundLink = false;
    if (typeof this.page.evaluate === 'function') {
      foundLink = await this.page.evaluate(() => {
        try {
          const links = document.querySelectorAll
            ? Array.from(document.querySelectorAll('a[href]')) : [];
          const link = links.find((a) => {
            try {
              const h = a.getAttribute ? (a.getAttribute('href') || '') : '';
              const path = h.split('?')[0].split('#')[0];
              return path === 'br/application' || path === '/br/application' || path.endsWith('/br/application');
            } catch (e) { return false; }
          });
          if (!link) return false;
          try { link.click(); } catch (e) { return false; }
          return true;
        } catch (e) { return false; }
      }).catch(() => false);
    }
    const state = await this.waitForFormContent(pollIterations);
    this.lastSiteNavigation = {
      ...(this.lastSiteNavigation || {}), foundLink,
    };
    return { foundLink, state };
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
    // Homepage-first (2026-10-26, live-proven): a direct deep link to
    // /br/application always yields a stub page (live test: only the
    // "type on browser" instruction, no form, even after reload),
    // while the same URL reached via the homepage's Birth
    // Registration link renders the real form. The old order tried
    // the direct link first and only fell back to the homepage
    // after a full poll, wasting every session's first attempt on
    // a page that can never be the form. Try the homepage route
    // first; keep the direct link only as a fallback, and still
    // throw (never report a false ready) if neither yields form
    // content. Pages without evaluate() (test doubles) keep the
    // old direct-only behaviour, exactly as before.
    if (typeof this.page.evaluate === 'function') {
      const firstVia = await this.gotoFormViaSite().catch(() => null);
      if (firstVia && firstVia.state && firstVia.state.formContent) return;
      const resp = await this.page.goto(`${BDRIS_BASE}/br/application`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }).catch((e) => { this._gotoError = e; return null; });
      this._recordNavigation(resp);
      await this.page.waitForSelector(
        SELECTORS.birth.division,
        { timeout: 3000 }
      ).catch(() => {});
      let state = await this.waitForFormContent(30).catch(() => null);
      if (state && !state.formContent) {
        throw new Error(
          `Playwright: form content not loaded on ${BDRIS_BASE}/br/application ` +
          `(${BdrisNavigator.describePageState(state)}; navigation: ` +
          `${BdrisNavigator.describeNavigation(this.lastNavigation)}; ` +
          `in-site navigation: ${firstVia
            ? (firstVia.foundLink ? 'link clicked, still no form content'
              : 'no /br/application link found on homepage')
            : 'not attempted'})`,
        );
      }
      return;
    }
    const resp = await this.page.goto(`${BDRIS_BASE}/br/application`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    }).catch((e) => { this._gotoError = e; return null; });
    this._recordNavigation(resp);
    await this.page.waitForSelector(
      SELECTORS.birth.division,
      { timeout: 3000 }
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

  // Full structural page state, for diagnostics only: no field
  // values, no body text, only presence facts and lengths. This is
  // what distinguishes the three live cases that all used to look
  // alike: (a) a bot-challenge/stub page at the form URL (no form
  // element, no token, no division), (b) a real form page whose
  // requested address section is not rendered (form element and/or
  // token present, some divisions present, requested one missing),
  // (c) a slow render (content appears after a wait/reload).
  async getPageState() {
    const divisionSels = {
      birth: SELECTORS.birth.division,
      perm: SELECTORS.perm.division,
      prsnt: SELECTORS.prsnt.division,
    };
    const raw = await this.page.evaluate((divSels) => {
      const exists = (selList) => {
        for (const s of String(selList).split(',').map(x => x.trim())) {
          try { if (document.querySelector(s)) return true; } catch (e) { /* next */ }
        }
        return false;
      };
      const divisions = {};
      for (const [k, v] of Object.entries(divSels)) divisions[k] = exists(v);
      const formElement = !!(document.querySelector('form#birth_application_form') || document.querySelector('form'));
      const hasMetaCsrf = !!document.querySelector('meta[name="_csrf"]');
      const hasHiddenCsrf = !!document.querySelector('input[name="_csrf"]');
      let title = '';
      try { title = document.title || ''; } catch (e) { /* unknown */ }
      let bodyTextLength = 0;
      try { bodyTextLength = (document.body && document.body.innerText ? document.body.innerText.length : 0); } catch (e) { /* unknown */ }
      // Safe diagnostics only (2026-10-26 investigation): counts,
      // never text or values. scriptCount separates a bare error
      // page from a challenge page that loads scripts; cookieCount
      // (count only, never names/values) shows whether the page
      // even received a session. Old test doubles lack scripts /
      // cookie, so both default to 0.
      let scriptCount = 0;
      try { scriptCount = document.scripts ? document.scripts.length : 0; } catch (e) { /* unknown */ }
      let cookieCount = 0;
      try {
        const c = document.cookie || '';
        cookieCount = c ? c.split(';').map(s => s.trim()).filter(Boolean).length : 0;
      } catch (e) { /* unknown */ }
      return {
        formElement, hasMetaCsrf, hasHiddenCsrf, title, bodyTextLength, divisions,
        scriptCount, cookieCount,
        formContent: formElement || hasMetaCsrf || hasHiddenCsrf ||
          divisions.birth || divisions.perm || divisions.prsnt,
      };
    }, divisionSels).catch(() => ({
      formElement: false, hasMetaCsrf: false, hasHiddenCsrf: false,
      title: '', bodyTextLength: 0, scriptCount: 0, cookieCount: 0,
      divisions: { birth: false, perm: false, prsnt: false }, formContent: false,
    }));
    // Attach the last navigation snapshot (status / final URL /
    // redirects / content-type) so describePageState() can name
    // it without a separate channel.
    raw.navigation = this.lastNavigation || null;
    return raw;
  }

  // Poll (bounded iterations, so test doubles with an instant
  // waitForTimeout still terminate) until any form content appears.
  // Also records whether the body length changed across the poll:
  // a changing length means the page is still rendering (slow
  // render), an unchanged 44 means a persistent stub — the two
  // cases the old single snapshot could not separate.
  async waitForFormContent(maxIterations = 30) {
    let firstLength = null;
    for (let i = 0; i < maxIterations; i++) {
      const state = await this.getPageState();
      if (firstLength === null) firstLength = state.bodyTextLength;
      if (state.formContent) {
        state.contentChanged = firstLength !== state.bodyTextLength;
        return state;
      }
      if (typeof this.page.waitForTimeout === 'function') {
        await this.page.waitForTimeout(500);
      }
    }
    const final = await this.getPageState();
    final.contentChanged = firstLength !== null && firstLength !== final.bodyTextLength;
    return final;
  }

  // Human-readable one-line summary of a page state, for errors.
  static describePageState(state) {
    if (!state) return 'unknown';
    const d = state.divisions || {};
    let out = `form element: ${state.formElement}, page title: "${String(state.title || '').slice(0, 80)}", ` +
      `body text length: ${state.bodyTextLength}, divisions present: ` +
      `birth=${!!d.birth} perm=${!!d.perm} prsnt=${!!d.prsnt}, ` +
      `CSRF: meta=${!!state.hasMetaCsrf} hidden=${!!state.hasHiddenCsrf}`;
    if (typeof state.scriptCount === 'number') out += `, scripts: ${state.scriptCount}`;
    if (typeof state.cookieCount === 'number') out += `, cookies: ${state.cookieCount}`;
    if (typeof state.contentChanged === 'boolean') out += `, content changed during poll: ${state.contentChanged}`;
    if (state.navigation) out += `, navigation: ${BdrisNavigator.describeNavigation(state.navigation)}`;
    if (state.siteNavigation) out += `, in-site navigation: ${state.siteNavigation}`;
    return out;
  }

  // Guarantee the page is the form page before a cascade runs.
  // Proven defects, from code + the live banner of 2026-10-26
  // (page at /br/application with no CSRF token and no division
  // select):
  //  (1) The old check judged "form" by URL + ONE select only, and
  //      waited just 3s after a domcontentloaded reload. A
  //      challenge/stub page at the same URL, or a slow JS render,
  //      therefore failed with a bare "division select missing"
  //      that said nothing about whether ANY form content existed.
  //  (2) It never distinguished "no form content at all" from
  //      "real form page, requested section not rendered" — for
  //      the permanent-address case the second is a different
  //      failure (the Playwright cascade cannot read a section
  //      that is not in the page, whatever the URL says).
  // This version classifies by full page state, waits for content
  // (up to ~15s of 500ms polls) instead of a single 3s selector
  // wait, and memoizes per page URL + form so the server handler
  // and the cascade do not each pay a fresh 15s wait (which would
  // together breach the 30s executor budget). Test doubles
  // without url()/goto() are left alone: formPresent is null and
  // the caller proceeds to its own diagnostic instead of
  // throwing here.
  async ensureFormPage(form = 'birth') {
    const sel = this.getSelectors(form);
    if (typeof this.page.url !== 'function') {
      return { navigated: false, pageUrl: null, formPresent: null };
    }
    let url = null;
    try { url = this.page.url(); } catch (e) { /* unknown */ }
    const memoKey = `${url || ''}|${form}`;
    if (this._formCheckMemo && this._formCheckMemo.key === memoKey) {
      return this._formCheckMemo.result;
    }
    const classify = (state, navigated, pageUrl) => {
      const requestedExists = !!(state.divisions && state.divisions[form]);
      let formPresent;
      if (requestedExists) formPresent = true;
      else if (state.formContent) formPresent = 'section-missing';
      else formPresent = false;
      const result = { navigated, pageUrl, formPresent, pageState: state };
      this._formCheckMemo = { key: memoKey, result };
      return result;
    };
    // Already on the form URL: check content first (cheap path).
    if (url && url.includes('/br/application')) {
      const state = await this.getPageState();
      if (state.formContent) {
        return classify(state, false, url);
      }
      // Proven defect (live banner after bba3e7e, page at
      // /br/application with form element false, title '', body
      // length 44, no divisions, no token): the session page was a
      // content-less stub, and every later geo call reloaded THAT
      // SAME page in THAT SAME context and re-inherited the stub
      // — while the session itself survived every failed load
      // (see server.js: a failed gotoForm left the session in the
      // map, and the next INIT reused it without re-navigating).
      // Reloading a stale stub cannot fix a stale stub. When the
      // server wires a fresh-page factory, try ONE fresh page
      // instead of the reload: it replaces the reload+poll cost
      // (goto 20s + 15s poll) with a bounded fresh attempt (goto
      // 10s + 10s poll), so the geo path stays inside the 30s
      // executor budget. If the factory throws, or the fresh page
      // is also a stub, fall through / classify as before — the
      // banner then names the fresh page's state, not a timeout.
      // The flag guarantees at most one fresh attempt per
      // navigator, so a second ensureFormPage call (handler, then
      // cascade, same instance, memo shared) cannot loop.
      if (typeof this.createFreshPage === 'function' && !this._freshPageUsed) {
        this._freshPageUsed = true;
        try {
          const fresh = await this.createFreshPage();
          if (fresh) {
            this.page = fresh;
            if (typeof this.page.goto === 'function') {
              try {
                const resp = await this.page.goto(`${BDRIS_BASE}/br/application`, {
                  waitUntil: 'domcontentloaded',
                  timeout: 10000,
                });
                this._recordNavigation(resp);
              } catch (e) { /* state check below decides */ }
            }
            // Short direct poll (3s), then the in-site path
            // (homepage -> real link, 5s goto + 3s poll) instead
            // of a long direct poll: total fresh attempt stays
            // ~21s worst, so fresh attempt + 8s HTTP geo stays
            // ~29s, inside the 30s geo executor budget (G1: the
            // old ~28s fresh attempt + 8s HTTP = 36s breached it,
            // and the executor race discarded the result at 30s).
            const after = await this.waitForFormContent(6);
            let newUrl = url;
            try { newUrl = this.page.url(); } catch (e) { /* unknown */ }
            if (after.formContent) return classify(after, true, newUrl);
            const via = await this.gotoFormViaSite(5000, 6).catch(() => null);
            if (via && via.state && via.state.formContent) {
              let viaUrl = newUrl;
              try { viaUrl = this.page.url(); } catch (e) { /* unknown */ }
              return classify(via.state, true, viaUrl);
            }
            after.siteNavigation = via
              ? (via.foundLink ? 'link clicked, still no form content'
                : 'no /br/application link found on homepage')
              : 'not attempted';
            return classify(after, true, newUrl);
          }
        } catch (e) { /* fall through to the reload path below */ }
      }
      // No form content at all: reload once and wait for content,
      // capped so this branch alone cannot breach the 30s executor
      // budget (G3: was 20s goto + 15s poll = 35s).
      if (typeof this.page.goto === 'function') {
        try {
          const resp = await this.page.goto(`${BDRIS_BASE}/br/application`, {
            waitUntil: 'domcontentloaded',
            timeout: 10000,
          });
          this._recordNavigation(resp);
        } catch (e) { /* state check below decides */ }
        const after = await this.waitForFormContent(20);
        let newUrl = url;
        try { newUrl = this.page.url(); } catch (e) { /* unknown */ }
        return classify(after, true, newUrl);
      }
      return classify(state, false, url);
    }
    // Not on the form URL at all: navigate, then wait for content.
    if (typeof this.page.goto !== 'function') {
      const state = await this.getPageState().catch(() => null);
      return { navigated: false, pageUrl: url, formPresent: false, pageState: state };
    }
    try {
      const resp = await this.page.goto(`${BDRIS_BASE}/br/application`, {
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      });
      this._recordNavigation(resp);
    } catch (e) { /* state check below decides */ }
    if (typeof this.page.waitForSelector === 'function') {
      await this.page.waitForSelector(sel.division, { timeout: 3000 }).catch(() => {});
    }
    const after = await this.waitForFormContent(20);
    let newUrl = url;
    try { newUrl = this.page.url(); } catch (e) { /* unknown */ }
    return classify(after, true, newUrl);
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
          }) ||
          // Live-proven 2026-10-26 (Cox's Bazar): the site lists a zone
          // as "P.M. Khali" (dots + space) while the frontend list
          // offers "PMKhali" — exact and includes matching both fail
          // because dots/spaces are kept by norm(). Compare a loose
          // key with dots, dashes and spaces stripped, so such
          // spelling variants match. This only ADDS matches after
          // the stricter checks fail; it never overrides them.
          Array.from(node.options).find(o => {
            const loose = (t) => norm(t).replace(/[\.\-\u2010-\u2015,\u0964]/g, '').replace(/\s+/g, '');
            const t = loose(o.text);
            const wl = loose(want);
            return t && wl && (t === wl || t.includes(wl) || wl.includes(t));
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
      throw new Error(`Playwright: form content not loaded on ${formCheck.pageUrl || 'unknown page'} (${BdrisNavigator.describePageState(formCheck.pageState)}); cannot run cascade`);
    }
    if (formCheck.formPresent === 'section-missing') {
      throw new Error(`Playwright: requested address section not rendered on the form page (form=${form}, ${BdrisNavigator.describePageState(formCheck.pageState)}); the Playwright cascade cannot read a section that is not in the page`);
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
        // Diagnostic (2026-10-26, live banner): a count alone cannot
        // tell a real-name mismatch from a wrong-parent cascade, so
        // name the options the site actually has (public geo names
        // only, capped). The "Parent option not found" prefix and
        // the count are kept verbatim for existing tests/logs.
        const presentNames = present.slice(0, 12).map(o => o.name).join(', ');
        throw new Error(`Parent option not found: ${pLevel}="${pValue}" (options present: ${present.length}${presentNames ? ` — site-এ আছে: ${presentNames}` : ''})`);
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
