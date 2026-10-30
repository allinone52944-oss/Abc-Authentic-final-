/**
 * REGISTER-SCRIPT PROBE (2026-10-30): read-only diagnostic that settles
 * WHERE the form page itself calls /api/br/application/register, without
 * any filing, OTP, or application data.
 *
 * Why this exists: the live endpoint probe proved register EXISTS and
 * demands OTP for an empty body, but the repo holds only the URL
 * constant — the page-JS call site and payload are unknown — and the
 * browser-tool route to inspect page scripts failed (no DevTools
 * access there). This module searches the requesting user's OWN warm
 * form page: script refs come from the page, external script texts
 * are fetched server-side with the seeded client (public static
 * assets), and everything returned is reduced to paths, booleans,
 * counts, and payload key NAMES only. It ALSO reports the form's OWN
 * submit POST construction (the 2026-10-25 submit evidence came from
 * the page's INLINE handler, so inline scripts are searched in-page
 * and the DOM form's input names are collected): exact URL, method,
 * content type, mechanism, and payload field NAMES, diffed against
 * the engine's buildSubmitPayload wire list (extraVsEngine /
 * missingVsEngine) — the browser-POST-vs-engine-POST difference is
 * the actual wall being debugged (direct POST returns the static
 * shell while the browser POST files).
 *
 * Privacy contract (hard, tested):
 *  - Returned: script pathnames (origin + query stripped), inline
 *    presence, found booleans, match counts, HTTP method if visible,
 *    and payload key NAMES only.
 *  - NEVER returned: script text, page content, form values, cookies,
 *    tokens, CSRF values, phone numbers, OTPs, names, dates, or any
 *    other value. Field-name extraction only ever captures the LEFT
 *    side of a `key:` pair, the FIRST argument of `.append('key')`,
 *    or the key side of `?key=` — values are structurally unreachable.
 *  - Inline scripts are searched INSIDE the page (collectWarmPageScripts
 *    runs in page context and returns only the reduced result), so
 *    inline script text never leaves the page either.
 *  - The in-page reducer inside collectWarmPageScripts is a literal
 *    mirror of reduceRegisterText below (Playwright serializes only
 *    the page function's own source, so it cannot close over module
 *    constants). A parity test proves both reducers agree on samples.
 *
 * Run: node --test engines/bdris-apply/v2/tests/probe-register-script.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const SEARCH_STRING = 'application/register';
const MAX_SCRIPTS = 100;
const MAX_MATCH_WINDOWS = 10;
const WINDOW_CHARS = 600;
const MAX_FIELD_NAMES = 200;
const MAX_FIELD_NAME_LEN = 128;

// The form's OWN submit path (SUBMIT_PATH = FORM_PATH in client.js).
const SUBMIT_NEEDLE = '/br/application';

// ENGINE SUBMIT WIRE LIST (2026-10-30): every field name the engine's
// direct POST actually sends, taken from buildSubmitPayload() +
// submitApplication() in http/client.js: the returned object keys
// (attachments sent once per id under the single name 'attachments')
// plus '_csrf' appended by submitApplication. Generated from the
// prefix/suffix lists so a typo cannot silently drop a field; a test
// proves this list equals a live buildSubmitPayload() call's keys.
const ENGINE_SUBMIT_TOP = [
  'officeAddressType', 'officeId', 'geoLocationId',
  'personInfoForBirth.personFirstNameBn', 'personInfoForBirth.personLastNameBn',
  'personInfoForBirth.personFirstNameEn', 'personInfoForBirth.personLastNameEn',
  'personInfoForBirth.personNameBn', 'personInfoForBirth.personNameEn',
  'personInfoForBirth.personBirthDate', 'personInfoForBirth.thChild',
  'personInfoForBirth.gender', 'personInfoForBirth.religionOther',
  'personInfoForBirth.personNid', 'religion',
  'personInfoForBirth.father.id', 'personInfoForBirth.father.ubrn',
  'personInfoForBirth.father.personBirthDate', 'personInfoForBirth.father.personNameBn',
  'personInfoForBirth.father.personNameEn', 'personInfoForBirth.father.passportNumber',
  'personInfoForBirth.father.personNationality',
  'personInfoForBirth.mother.id', 'personInfoForBirth.mother.ubrn',
  'personInfoForBirth.mother.personBirthDate', 'personInfoForBirth.mother.personNameBn',
  'personInfoForBirth.mother.personNameEn', 'personInfoForBirth.mother.passportNumber',
  'personInfoForBirth.mother.personNationality',
  'relationWithApplicant', 'applicantBrn', 'applicantDob', 'applicantName',
  'declaration', 'email', 'phone', 'otp', 'attachments',
];
const ADDRESS_PREFIXES = ['birthPlace', 'permAddr', 'prsntAddr'];
const ADDRESS_SUFFIXES = [
  'Country', 'Div', 'Dist', 'CityCorpCantOrUpazila', 'PaurasavaOrUnion',
  'WardInCityCorp', 'Area', 'WardInPaurasavaOrUnion', 'City', 'PostOfc',
  'PostOfcEn', 'PostCode', 'VilAreaTownBn', 'VilAreaTownEn', 'HouseRoadBn',
  'HouseRoadEn', 'LocationId', 'En', 'Bn',
];
const ENGINE_SUBMIT_FIELDS = [
  ...ENGINE_SUBMIT_TOP,
  ...ADDRESS_PREFIXES.flatMap((p) => ADDRESS_SUFFIXES.map((s) => p + s)),
  '_csrf',
].sort();
const ENGINE_SUBMIT_SET = new Set(ENGINE_SUBMIT_FIELDS);

// Tokens that are never payload field names: JS keywords plus the
// transport keys of a request-building call (method/headers/body/...).
// Dropping a genuine payload field named e.g. 'type' is accepted:
// this reduction is a heuristic, and silence beats noise here.
const KEY_STOPLIST = new Set([
  'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'default', 'break', 'continue', 'var', 'let', 'const', 'new',
  'typeof', 'instanceof', 'in', 'of', 'void', 'delete', 'true', 'false',
  'null', 'undefined', 'this', 'try', 'catch', 'finally', 'throw',
  'await', 'async', 'yield', 'class', 'extends', 'super', 'import',
  'export', 'from', 'get', 'set', 'static',
  'method', 'headers', 'body', 'url', 'credentials', 'mode', 'cache',
  'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive',
  'signal', 'duplex', 'dataType', 'contentType', 'processData',
  'crossDomain', 'xhrFields', 'timeout', 'withCredentials',
  'responseType', 'mimeType', 'data', 'type',
]);

function methodFromWindow(win) {
  const m = win.match(/method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/i)
    || win.match(/type\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i)
    || win.match(/\.(get|post|put|patch|delete)\s*\(/i);
  return m ? m[1].toUpperCase() : null;
}

function fieldNamesFromWindow(win, out) {
  const patterns = [
    /['"]([A-Za-z_$][A-Za-z0-9_$]*)['"]\s*:/g,
    /(?:^|[{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g,
    /\.append\(\s*['"]([^'"]{1,128})['"]/g,
    /[?&]([A-Za-z0-9_$]+)=/g,
  ];
  for (const re of patterns) {
    let hit;
    while ((hit = re.exec(win)) !== null) {
      const raw = String(hit[1] || '');
      // FormData/query keys may carry dots (dotted form names); keep
      // only identifier/dot characters so no value fragment survives.
      const name = raw.replace(/[^A-Za-z0-9_$.]/g, '').slice(0, MAX_FIELD_NAME_LEN);
      if (name && !KEY_STOPLIST.has(name)) out.add(name);
    }
  }
}

/**
 * Server-side reduction of one fetched script text: found flag, match
 * count, HTTP method if visible in a window around a match, and
 * payload key NAMES only. Never returns text, values, or lines.
 */
function reduceRegisterText(text) {
  if (typeof text !== 'string' || !text) {
    return { found: false, matchCount: 0, method: null, fieldNames: [] };
  }
  const matchCount = text.split(SEARCH_STRING).length - 1;
  if (matchCount === 0) {
    return { found: false, matchCount: 0, method: null, fieldNames: [] };
  }
  const names = new Set();
  let method = null;
  let windows = 0;
  let idx = -1;
  while (windows < MAX_MATCH_WINDOWS && (idx = text.indexOf(SEARCH_STRING, idx + 1)) >= 0) {
    const win = text.slice(Math.max(0, idx - WINDOW_CHARS), idx + WINDOW_CHARS);
    if (!method) method = methodFromWindow(win);
    fieldNamesFromWindow(win, names);
    windows += 1;
  }
  return {
    found: true,
    matchCount,
    method,
    fieldNames: [...names].sort().slice(0, MAX_FIELD_NAMES),
  };
}

function submitMethodFromWindow(win) {
  const m = win.match(/method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/i)
    || win.match(/type\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i)
    || win.match(/\.post\s*\(/i)
    || win.match(/open\s*\(\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i);
  if (/\.post\s*\(/i.test(win)) return 'POST';
  return m ? m[1].toUpperCase() : null;
}

function submitContentTypeFromWindow(win) {
  if (/FormData/.test(win)) return 'multipart/form-data';
  if (/application\/json/.test(win)) return 'application/json';
  if (/application\/x-www-form-urlencoded/.test(win)) return 'application/x-www-form-urlencoded';
  return null;
}

function submitMechanismFromFlags(f) {
  if (f.form) return 'formdata-form';
  if (f.formData) return 'formdata-append';
  if (f.json) return 'json';
  if (f.native) return 'native';
  return 'unknown';
}

/**
 * Server-side reduction of the form's OWN submit POST construction in
 * one script text: windows around the submit path '/br/application'
 * count as submit evidence ONLY when they also show a POST
 * construction (method/type POST, .post(, open('POST', FormData, or
 * .append(). Returns URL (pathname of the quoted literal, else the
 * needle itself), method, content type, mechanism (heuristic), and
 * payload key NAMES only. found=false when no evidence window exists
 * — a bare page-URL mention is not a submit construction.
 */
function extractSubmitPost(text) {
  const empty = {
    found: false, url: null, method: null, contentType: null,
    mechanism: 'unknown', jsFieldNames: [],
  };
  if (typeof text !== 'string' || !text) return empty;
  const names = new Set();
  const flags = { form: false, formData: false, json: false, native: false };
  let url = null;
  let method = null;
  let contentType = null;
  let windows = 0;
  let idx = -1;
  while (windows < MAX_MATCH_WINDOWS && (idx = text.indexOf(SUBMIT_NEEDLE, idx + 1)) >= 0) {
    // Exact form path only: a following '/' means a sub-path endpoint
    // (e.g. /br/application/register), NOT the form's own POST.
    if (text[idx + SUBMIT_NEEDLE.length] === '/') continue;
    const win = text.slice(Math.max(0, idx - WINDOW_CHARS), idx + WINDOW_CHARS);
    const hasPost = /method\s*:\s*['"]POST['"]/i.test(win)
      || /type\s*:\s*['"]POST['"]/i.test(win)
      || /\.post\s*\(/i.test(win)
      || /open\s*\(\s*['"]POST['"]/i.test(win)
      || /FormData/.test(win)
      || /\.append\s*\(/i.test(win);
    if (!hasPost) continue;
    // The quoted literal in this window must itself resolve to the
    // exact form path; any other br/application mention (an API
    // path, a referer) is not the submit construction.
    const um = win.match(/['"]([^'"]*br\/application[^'"]*)['"]/);
    let cand = SUBMIT_NEEDLE;
    if (um) {
      try { cand = new URL(um[1], 'https://bdris.gov.bd').pathname; } catch { cand = SUBMIT_NEEDLE; }
    }
    if (cand !== SUBMIT_NEEDLE) continue;
    windows += 1;
    if (!url) url = cand;
    if (!method) method = submitMethodFromWindow(win);
    if (!contentType) contentType = submitContentTypeFromWindow(win);
    if (/FormData\s*\(\s*[^)]*(form|document|querySelector|getElementById|getElementsBy|\bthis\b)/i.test(win)) flags.form = true;
    if (/FormData/.test(win)) flags.formData = true;
    if (/JSON\.stringify/.test(win)) flags.json = true;
    if (/\.submit\s*\(/.test(win)) flags.native = true;
    fieldNamesFromWindow(win, names);
  }
  if (windows === 0) return empty;
  return {
    found: true,
    url,
    method,
    contentType,
    mechanism: submitMechanismFromFlags(flags),
    jsFieldNames: [...names].sort().slice(0, MAX_FIELD_NAMES),
  };
}

function scriptPathname(src, pageUrl) {
  try {
    return new URL(src, pageUrl).pathname;
  } catch {
    return null;
  }
}

function sameOrigin(src, pageUrl) {
  try {
    return new URL(src, pageUrl).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Page function (runs INSIDE the warm page via page.evaluate; must stay
 * self-contained — no module-scope references, Playwright serializes
 * only this function's own source).
 *
 * Returns { url, scripts: [{src, inline}], inline: [reduced...] } where
 * inline[] aligns with the inline scripts in order. Each inline entry
 * is the reduced result only (found, matchCount, method, fieldNames) —
 * inline script text never leaves the page.
 */
function collectWarmPageScripts() {
  function reduceInline(t) {
    const needle = 'application/register';
    let matchCount = 0;
    let pos = -1;
    while ((pos = t.indexOf(needle, pos + 1)) >= 0) matchCount += 1;
    if (matchCount === 0) {
      return { found: false, matchCount: 0, method: null, fieldNames: [] };
    }
    const stop = {};
    const stopList = ('function return if else for while do switch case default break continue '
      + 'var let const new typeof instanceof in of void delete true false null undefined this '
      + 'try catch finally throw await async yield class extends super import export from get set static '
      + 'method headers body url credentials mode cache redirect referrer referrerPolicy integrity keepalive '
      + 'signal duplex dataType contentType processData crossDomain xhrFields timeout withCredentials '
      + 'responseType mimeType data type').split(' ');
    for (let i = 0; i < stopList.length; i++) stop[stopList[i]] = true;
    const names = {};
    let method = null;
    let windows = 0;
    let idx = -1;
    while (windows < 10 && (idx = t.indexOf(needle, idx + 1)) >= 0) {
      const win = t.slice(Math.max(0, idx - 600), idx + 600);
      if (!method) {
        const m = win.match(/method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/i)
          || win.match(/type\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i)
          || win.match(/\.(get|post|put|patch|delete)\s*\(/i);
        if (m) method = m[1].toUpperCase();
      }
      const patterns = [
        /['"]([A-Za-z_$][A-Za-z0-9_$]*)['"]\s*:/g,
        /(?:^|[{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g,
        /\.append\(\s*['"]([^'"]{1,128})['"]/g,
        /[?&]([A-Za-z0-9_$]+)=/g,
      ];
      for (let p = 0; p < patterns.length; p++) {
        let hit;
        while ((hit = patterns[p].exec(win)) !== null) {
          const name = String(hit[1] || '').replace(/[^A-Za-z0-9_$.]/g, '').slice(0, 128);
          if (name && !stop[name]) names[name] = true;
        }
      }
      windows += 1;
    }
    return {
      found: true,
      matchCount,
      method,
      fieldNames: Object.keys(names).sort().slice(0, 200),
    };
  }
  function reduceSubmitInline(t) {
    var needle = '/br/application';
    var names = {};
    var stop = {};
    var stopList = ('function return if else for while do switch case default break continue '
      + 'var let const new typeof instanceof in of void delete true false null undefined this '
      + 'try catch finally throw await async yield class extends super import export from get set static '
      + 'method headers body url credentials mode cache redirect referrer referrerPolicy integrity keepalive '
      + 'signal duplex dataType contentType processData crossDomain xhrFields timeout withCredentials '
      + 'responseType mimeType data type').split(' ');
    for (var si = 0; si < stopList.length; si++) stop[stopList[si]] = true;
    var flags = { form: false, formData: false, json: false, native: false };
    var url = null;
    var method = null;
    var contentType = null;
    var windows = 0;
    var idx = -1;
    while (windows < 10 && (idx = t.indexOf(needle, idx + 1)) >= 0) {
      if (t[idx + needle.length] === '/') continue;
      var win = t.slice(Math.max(0, idx - 600), idx + 600);
      var hasPost = /method\s*:\s*['"]POST['"]/i.test(win)
        || /type\s*:\s*['"]POST['"]/i.test(win)
        || /\.post\s*\(/i.test(win)
        || /open\s*\(\s*['"]POST['"]/i.test(win)
        || /FormData/.test(win)
        || /\.append\s*\(/i.test(win);
      if (!hasPost) continue;
      var um2 = win.match(/['"]([^'"]*br\/application[^'"]*)['"]/);
      var cand = '/br/application';
      if (um2) {
        try { cand = new URL(um2[1], 'https://bdris.gov.bd').pathname; } catch (e) { cand = '/br/application'; }
      }
      if (cand !== '/br/application') continue;
      windows += 1;
      if (!url) url = cand;
      if (!method) {
        var mm = win.match(/method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/i)
          || win.match(/type\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i)
          || win.match(/open\s*\(\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i);
        if (/\.post\s*\(/i.test(win)) method = 'POST';
        else if (mm) method = mm[1].toUpperCase();
      }
      if (!contentType) {
        if (/FormData/.test(win)) contentType = 'multipart/form-data';
        else if (/application\/json/.test(win)) contentType = 'application/json';
        else if (/application\/x-www-form-urlencoded/.test(win)) contentType = 'application/x-www-form-urlencoded';
      }
      if (/FormData\s*\(\s*[^)]*(form|document|querySelector|getElementById|getElementsBy|\bthis\b)/i.test(win)) flags.form = true;
      if (/FormData/.test(win)) flags.formData = true;
      if (/JSON\.stringify/.test(win)) flags.json = true;
      if (/\.submit\s*\(/.test(win)) flags.native = true;
      var patterns = [
        /['"]([A-Za-z_$][A-Za-z0-9_$]*)['"]\s*:/g,
        /(?:^|[{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g,
        /\.append\(\s*['"]([^'"]{1,128})['"]/g,
        /[?&]([A-Za-z0-9_$]+)=/g,
      ];
      for (var p = 0; p < patterns.length; p++) {
        var hit;
        while ((hit = patterns[p].exec(win)) !== null) {
          var name = String(hit[1] || '').replace(/[^A-Za-z0-9_$.]/g, '').slice(0, 128);
          if (name && !stop[name]) names[name] = true;
        }
      }
    }
    if (windows === 0) {
      return { found: false, url: null, method: null, contentType: null, mechanism: 'unknown', jsFieldNames: [] };
    }
    var mechanism = 'unknown';
    if (flags.form) mechanism = 'formdata-form';
    else if (flags.formData) mechanism = 'formdata-append';
    else if (flags.json) mechanism = 'json';
    else if (flags.native) mechanism = 'native';
    return {
      found: true, url: url, method: method, contentType: contentType,
      mechanism: mechanism, jsFieldNames: Object.keys(names).sort().slice(0, 200),
    };
  }
  const scripts = [];
  const inline = [];
  const all = document.querySelectorAll('script');
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    if (s.src) {
      scripts.push({ src: s.src, inline: false });
    } else {
      scripts.push({ src: '', inline: true });
      inline.push(reduceInline(s.textContent || ''));
    }
  }
  // Submit construction, aggregated over ALL inline scripts (the
  // 2026-10-25 evidence for the submit shape came from this inline
  // handler), plus the page's own form field names: a FormData(form)
  // or native submit sends exactly these input names, so they are
  // part of the browser POST even when no JS literal names them.
  // Names only — never values, never actions with query strings
  // (pathnames only; getAttribute so an absent action stays absent
  // instead of resolving to the page URL).
  const submitAgg = {
    found: false, url: null, method: null, contentType: null,
    mechanism: 'unknown', jsFieldNames: [],
  };
  const submitNames = {};
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    if (s.src) continue;
    const sub = reduceSubmitInline(s.textContent || '');
    if (!sub.found) continue;
    submitAgg.found = true;
    if (!submitAgg.url) submitAgg.url = sub.url;
    if (!submitAgg.method) submitAgg.method = sub.method;
    if (!submitAgg.contentType) submitAgg.contentType = sub.contentType;
    if (submitAgg.mechanism === 'unknown') submitAgg.mechanism = sub.mechanism;
    for (let k = 0; k < sub.jsFieldNames.length; k++) submitNames[sub.jsFieldNames[k]] = true;
  }
  submitAgg.jsFieldNames = Object.keys(submitNames).sort().slice(0, 200);
  const formFieldNames = {};
  const formActions = [];
  const forms = document.querySelectorAll('form');
  for (let i = 0; i < forms.length; i++) {
    const f = forms[i];
    const act = (typeof f.getAttribute === 'function') ? f.getAttribute('action') : null;
    if (act) {
      try { formActions.push(new URL(act, location.href).pathname); } catch (e) { /* keep raw out */ }
    }
    const els = (typeof f.querySelectorAll === 'function') ? f.querySelectorAll('input, select, textarea') : [];
    for (let j = 0; j < els.length; j++) {
      if (els[j].name) formFieldNames[els[j].name] = true;
    }
  }
  return {
    url: location.href,
    scripts,
    inline,
    submit: submitAgg,
    formFieldNames: Object.keys(formFieldNames).sort().slice(0, 300),
    formActions: [...new Set(formActions)].sort(),
  };
}

/**
 * Orchestration: refs from the warm page, external texts via the
 * seeded client's fetchText(pathname), reduction to paths/booleans/
 * counts/names only. Per-script fetch failure or a cross-origin src
 * (which the base-bound client cannot fetch) is reported honestly
 * as fetchFailed/skipped — never as "not found" proof.
 */
async function probePageScripts({ page, fetchText }) {
  const refs = await page.evaluate(collectWarmPageScripts);
  const pageUrl = (refs && typeof refs.url === 'string') ? refs.url : '';
  const list = (refs && Array.isArray(refs.scripts)) ? refs.scripts : [];
  const inlineResults = (refs && Array.isArray(refs.inline)) ? refs.inline : [];
  const scripts = [];
  let foundAny = false;
  let inlineIdx = 0;
  const extSubmits = [];
  for (const ref of list.slice(0, MAX_SCRIPTS)) {
    if (ref.inline || !ref.src) {
      const r = inlineResults[inlineIdx++] || { found: false, matchCount: 0, method: null, fieldNames: [] };
      const entry = { path: null, inline: true, found: !!r.found, matchCount: r.matchCount || 0 };
      if (entry.found) {
        foundAny = true;
        entry.method = r.method || null;
        entry.fieldNames = Array.isArray(r.fieldNames) ? r.fieldNames : [];
      }
      scripts.push(entry);
      continue;
    }
    const path = scriptPathname(ref.src, pageUrl);
    if (!path || !sameOrigin(ref.src, pageUrl)) {
      scripts.push({ path, inline: false, found: false, matchCount: 0, skipped: true });
      continue;
    }
    let text;
    try {
      text = await fetchText(path);
    } catch {
      text = null;
    }
    if (typeof text !== 'string') {
      scripts.push({ path, inline: false, found: false, matchCount: 0, fetchFailed: true });
      continue;
    }
    const ctx = reduceRegisterText(text);
    const entry = { path, inline: false, found: ctx.found, matchCount: ctx.matchCount };
    if (ctx.found) {
      foundAny = true;
      entry.method = ctx.method;
      entry.fieldNames = ctx.fieldNames;
    }
    scripts.push(entry);
    const sub = extractSubmitPost(text);
    if (sub.found) extSubmits.push({ path, sub });
  }
  // SUBMIT-POST AGGREGATION (2026-10-30 correction): the form's own
  // submit construction, wherever it lives — inline handler first
  // (the 2026-10-25 evidence came from there), then external
  // scripts. fieldNames is the UNION of JS-built keys and the DOM
  // form's input names: a FormData(form)/native submit sends exactly
  // those DOM names, so the union is the superset of what the
  // browser POST could carry; jsFieldNames/formFieldNames stay
  // separate so any diff entry can be attributed. extraVsEngine =
  // handler names the engine does NOT send; missingVsEngine =
  // engine names the handler evidence does NOT show. Both are
  // NAMES only.
  const inlineSubmit = (refs && refs.submit && typeof refs.submit === 'object')
    ? refs.submit
    : { found: false, url: null, method: null, contentType: null, mechanism: 'unknown', jsFieldNames: [] };
  const formFieldNames = [...new Set(
    (refs && Array.isArray(refs.formFieldNames)) ? refs.formFieldNames : [],
  )].sort().slice(0, 300);
  const formActions = [...new Set(
    (refs && Array.isArray(refs.formActions)) ? refs.formActions : [],
  )].sort();
  const jsNames = new Set(Array.isArray(inlineSubmit.jsFieldNames) ? inlineSubmit.jsFieldNames : []);
  for (const { sub } of extSubmits) {
    for (const n of sub.jsFieldNames) jsNames.add(n);
  }
  const foundIn = [];
  if (inlineSubmit.found) foundIn.push('inline');
  for (const { path: p } of extSubmits) foundIn.push(p);
  const jsEvidence = inlineSubmit.found || extSubmits.length > 0;
  const formEvidence = formActions.length > 0;
  let submitUrl = inlineSubmit.url || null;
  let submitMethod = inlineSubmit.method || null;
  let submitContentType = inlineSubmit.contentType || null;
  let submitMechanism = inlineSubmit.mechanism || 'unknown';
  if (!submitUrl) {
    const first = extSubmits.find((s) => s.sub.url);
    if (first) submitUrl = first.sub.url;
  }
  if (!submitMethod) {
    const first = extSubmits.find((s) => s.sub.method);
    if (first) submitMethod = first.sub.method;
  }
  if (!submitContentType) {
    const first = extSubmits.find((s) => s.sub.contentType);
    if (first) submitContentType = first.sub.contentType;
  }
  if (submitMechanism === 'unknown') {
    const first = extSubmits.find((s) => s.sub.mechanism && s.sub.mechanism !== 'unknown');
    if (first) submitMechanism = first.sub.mechanism;
  }
  let urlSource = null;
  if (submitUrl) urlSource = 'js';
  else if (formEvidence) { submitUrl = formActions[0]; urlSource = 'form-action'; }
  if (!jsEvidence && formEvidence) submitMechanism = 'native';
  const fieldNames = [...new Set([...jsNames, ...formFieldNames])].sort();
  const fieldSet = new Set(fieldNames);
  const submitPost = {
    found: jsEvidence || formEvidence,
    foundIn,
    url: submitUrl,
    urlSource,
    method: submitMethod,
    contentType: submitContentType,
    mechanism: (jsEvidence || formEvidence) ? submitMechanism : 'unknown',
    jsFieldNames: [...jsNames].sort(),
    formFieldNames,
    formActions,
    fieldNames,
    extraVsEngine: fieldNames.filter((n) => !ENGINE_SUBMIT_SET.has(n)),
    missingVsEngine: ENGINE_SUBMIT_FIELDS.filter((n) => !fieldSet.has(n)),
  };
  return { ok: true, found: foundAny, scripts, truncated: list.length > MAX_SCRIPTS, submitPost };
}

module.exports = {
  SEARCH_STRING,
  MAX_SCRIPTS,
  SUBMIT_NEEDLE,
  ENGINE_SUBMIT_FIELDS,
  reduceRegisterText,
  extractSubmitPost,
  scriptPathname,
  collectWarmPageScripts,
  probePageScripts,
};
