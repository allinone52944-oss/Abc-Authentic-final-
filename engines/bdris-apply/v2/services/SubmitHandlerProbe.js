/**
 * SUBMIT-HANDLER PROBE (2026-10-30): read-only diagnostic that settles
 * WHAT the warm form page's own JavaScript does AT SUBMIT TIME — the
 * one thing a static DOM read cannot see.
 *
 * Why this exists: 8 direct submits all returned the byte-identical
 * static shell (118673 chars). Killed with journal proof: XHR-vs-
 * navigation headers, DOM field alignment, and cookie freshness (the
 * 8th attempt's reseed REFRESHED cookies + CSRF from the live warm
 * page 1 second before submit and the shell was still identical).
 * The engine's POST now matches the browser's on headers, fields,
 * and cookies as far as every probe can see. What remains unknown is
 * submit-time behavior: a submit listener that appends fields, a
 * TSPD clearance token read at submit time, or a form attribute the
 * DOM read missed. This module searches the requesting user's OWN
 * warm form page (external + inline scripts, same collection as the
 * register-script probe) and returns ONLY names/booleans/counts and
 * form markup attributes — never script text, page content, values,
 * cookies, tokens, or CSRF values.
 *
 * Privacy contract (hard, tested):
 *  - Returned: script pathnames (origin + query stripped), inline
 *    presence, found booleans, match counts, mechanism labels,
 *    appended/header/storage key NAMES only, and the form's action/
 *    method/enctype attribute strings (markup, not values).
 *  - NEVER returned: script text, page content, form values, cookies,
 *    tokens, CSRF values, phone numbers, OTPs, names, dates, or any
 *    other value. Name extraction only ever captures the FIRST
 *    argument of .append()/.setAttribute()/setRequestHeader()/
 *    getItem()/setItem(), the key side of a cookie assignment, or
 *    an identifier matching a token-ish pattern — values are
 *    structurally unreachable.
 *  - Inline scripts are searched INSIDE the page (the page function
 *    returns only the reduced result), so inline script text never
 *    leaves the page either.
 *  - The in-page reducers mirror the server reducers (same regexes,
 *    same mechanism priority, same stoplist). A parity test proves
 *    both agree on samples.
 *
 * Run: node --test engines/bdris-apply/v2/tests/probe-submit-handler.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const MAX_SCRIPTS = 100;
const MAX_NAMES = 200;
const MAX_NAME_LEN = 128;
const WINDOW_CHARS = 600;
const MAX_MATCH_WINDOWS = 10;

// The form's OWN submit path (SUBMIT_PATH = FORM_PATH in client.js).
const SUBMIT_NEEDLE = '/br/application';
const FORM_ACTION = '/br/application';

// Tokens that are never payload/storage key names: JS keywords plus
// the transport keys of a request-building call. Dropping a genuine
// key named e.g. 'type' is accepted: this reduction is a heuristic,
// and silence beats noise here.
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
  'getItem', 'setItem', 'removeItem',
]);

function cleanName(raw, out) {
  const name = String(raw || '').replace(/[^A-Za-z0-9_$.]/g, '').slice(0, MAX_NAME_LEN);
  if (name && !KEY_STOPLIST.has(name)) out.add(name);
}

function appendNamesFromText(text, out) {
  // FormData.append('key', ...) / URLSearchParams.append('key', ...)
  // first arguments, plus hidden-input name assignments.
  const patterns = [
    /\.append\(\s*['"]([^'"]{1,128})['"]/g,
    /\.setAttribute\(\s*['"]name['"]\s*,\s*['"]([^'"]{1,128})['"]/g,
    /\.name\s*=\s*['"]([^'"]{1,128})['"]/g,
  ];
  for (const re of patterns) {
    let hit;
    while ((hit = re.exec(text)) !== null) cleanName(hit[1], out);
  }
}

function cleanHeaderName(raw, out) {
  // HTTP header names legitimately contain hyphens (X-TSPD-Token,
  // Content-Type) — unlike payload keys, hyphens are preserved.
  const name = String(raw || '').replace(/[^A-Za-z0-9_$.\\-]/g, '').slice(0, MAX_NAME_LEN);
  if (name && !KEY_STOPLIST.has(name)) out.add(name);
}

function headerNamesFromText(text, out) {
  const re = /\.setRequestHeader\(\s*['"]([^'"]{1,128})['"]/g;
  let hit;
  while ((hit = re.exec(text)) !== null) cleanHeaderName(hit[1], out);
}

function submitMechanismFromFlags(f) {
  if (f.formDataForm) return 'formdata-form';
  if (f.formDataAppend) return 'formdata-append';
  if (f.json) return 'json';
  if (f.fetch) return 'fetch';
  if (f.xhr) return 'xhr';
  if (f.native) return 'native';
  return 'unknown';
}

/**
 * Server-side reduction of one script text for SUBMIT-HANDLER
 * evidence. A bare FormData + append (the page's async file-upload
 * code does exactly that for /admin/doc/upload) is NOT submit
 * evidence: FormData evidence only counts under a submit context
 * (a submit listener, a .submit( call, or a submit-request window
 * for the exact form path). found is therefore: a .submit( call, or
 * submit context + (FormData body evidence | fetch | XHR).
 * matchCount counts only evidence that contributes to found, so
 * found is exactly matchCount > 0. appendedFieldNames/headerNames
 * are populated ONLY when found — a non-handler script's appends/
 * headers are not submit evidence.
 */
function reduceSubmitHandlerText(text) {
  const empty = {
    found: false, matchCount: 0, mechanism: 'unknown',
    appendedFieldNames: [], headerNames: [],
  };
  if (typeof text !== 'string' || !text) return empty;
  const listener = (text.match(/addEventListener\s*\(\s*['"]submit['"]/g) || []).length
    + (text.match(/onsubmit\s*=/g) || []).length;
  const submitCalls = (text.match(/\.submit\s*\(/g) || []).length;
  const formDataForms = (text.match(/new\s+FormData\s*\(\s*[^)]*(form|document|querySelector|getElementById|getElementsBy|\bthis\b|event\.target|e\.target)/gi) || []).length;
  const hasFormData = /new\s+FormData\s*\(/.test(text);
  const appends = (text.match(/\.append\s*\(/g) || []).length;
  // Submit-request windows: the form path with a POST construction
  // nearby (fetch/ajax/open('POST'/FormData/.append). A bare page-URL
  // mention is not submit evidence; a sub-path (/br/application/...)
  // is not the form POST.
  let windows = 0;
  let idx = -1;
  while (windows < MAX_MATCH_WINDOWS && (idx = text.indexOf(SUBMIT_NEEDLE, idx + 1)) >= 0) {
    if (text[idx + SUBMIT_NEEDLE.length] === '/') continue;
    const win = text.slice(Math.max(0, idx - WINDOW_CHARS), idx + WINDOW_CHARS);
    const um = win.match(/['"]([^'"]*br\/application[^'"]*)['"]/);
    let cand = SUBMIT_NEEDLE;
    if (um) {
      try { cand = new URL(um[1], 'https://bdris.gov.bd').pathname; } catch { cand = SUBMIT_NEEDLE; }
    }
    if (cand !== SUBMIT_NEEDLE) continue;
    const hasPost = /method\s*:\s*['"]POST['"]/i.test(win)
      || /type\s*:\s*['"]POST['"]/i.test(win)
      || /\.post\s*\(/i.test(win)
      || /open\s*\(\s*['"]POST['"]/i.test(win)
      || /FormData/.test(win)
      || /fetch\s*\(/.test(win)
      || /\$\.ajax\s*\(/.test(win);
    if (!hasPost) continue;
    windows += 1;
  }
  const submitContext = listener > 0 || submitCalls > 0 || windows > 0;
  const bodyEvidence = formDataForms > 0 || (hasFormData && appends > 0);
  const fetchCall = /fetch\s*\(/.test(text);
  const xhrCall = /XMLHttpRequest/.test(text) || /\$\.ajax\s*\(/.test(text) || /jQuery\.ajax\s*\(/.test(text);
  const found = submitCalls > 0 || (submitContext && (bodyEvidence || fetchCall || xhrCall));
  if (!found) return empty;
  let count = listener + submitCalls + windows;
  if (submitContext) {
    count += formDataForms;
    if (hasFormData) count += appends;
  }
  const flags = {
    formDataForm: submitContext && formDataForms > 0,
    formDataAppend: submitContext && hasFormData && appends > 0,
    json: /JSON\.stringify/.test(text),
    fetch: fetchCall,
    xhr: xhrCall,
    native: submitCalls > 0,
  };
  const appended = new Set();
  appendNamesFromText(text, appended);
  const headers = new Set();
  headerNamesFromText(text, headers);
  return {
    found: true,
    matchCount: count,
    mechanism: submitMechanismFromFlags(flags),
    appendedFieldNames: [...appended].sort().slice(0, MAX_NAMES),
    headerNames: [...headers].sort().slice(0, MAX_NAMES),
  };
}

/**
 * Server-side reduction of one script text for TSPD storage. mention
 * is true when the text itself names TSPD; the caller also treats a
 * /TSPD/ pathname as a TSPD script. Storage names are populated
 * regardless and surfaced only for TSPD scripts by the aggregator.
 */
function reduceTspdText(text) {
  const empty = {
    mention: false,
    storage: { cookies: [], localStorage: [], sessionStorage: [], headers: [], tokenVariables: [] },
  };
  if (typeof text !== 'string' || !text) return empty;
  const mention = text.includes('TSPD');
  const cookies = new Set();
  const localStorage = new Set();
  const sessionStorage = new Set();
  const headers = new Set();
  const tokenVariables = new Set();
  let hit;
  const cookieAssign = /document\.cookie\s*=\s*['"]([A-Za-z0-9_$]+)=/g;
  while ((hit = cookieAssign.exec(text)) !== null) cleanName(hit[1], cookies);
  const cookieFn = /(?:getCookie|setCookie|get_cookie|set_cookie)\s*\(\s*['"]([^'"]{1,128})['"]/g;
  while ((hit = cookieFn.exec(text)) !== null) cleanName(hit[1], cookies);
  for (const [store, out] of [[ 'localStorage', localStorage ], [ 'sessionStorage', sessionStorage ]]) {
    const re = new RegExp(store + '\\.(?:getItem|setItem|removeItem)\\s*\\(\\s*[\'"]([^\'"]{1,128})[\'"]', 'g');
    while ((hit = re.exec(text)) !== null) cleanName(hit[1], out);
    const idxRe = new RegExp(store + '\\s*\\[\\s*[\'"]([^\'"]{1,128})[\'"]\\s*\\]', 'g');
    while ((hit = idxRe.exec(text)) !== null) cleanName(hit[1], out);
    const propRe = new RegExp(store + '\\.([A-Za-z_$][A-Za-z0-9_$]*)', 'g');
    while ((hit = propRe.exec(text)) !== null) cleanName(hit[1], out);
  }
  headerNamesFromText(text, headers);
  // Token-ish identifiers near a TSPD mention (heuristic): variable
  // names starting with tspd/fingerprint/challenge/clearance.
  if (mention) {
    let idx = -1;
    let windows = 0;
    while (windows < MAX_MATCH_WINDOWS && (idx = text.indexOf('TSPD', idx + 1)) >= 0) {
      const win = text.slice(Math.max(0, idx - WINDOW_CHARS), idx + WINDOW_CHARS);
      const re = /\b(tspd|fingerprint|challenge|clearance)[A-Za-z0-9_$]*/gi;
      while ((hit = re.exec(win)) !== null) cleanName(hit[0], tokenVariables);
      windows += 1;
    }
  }
  return {
    mention,
    storage: {
      cookies: [...cookies].sort().slice(0, MAX_NAMES),
      localStorage: [...localStorage].sort().slice(0, MAX_NAMES),
      sessionStorage: [...sessionStorage].sort().slice(0, MAX_NAMES),
      headers: [...headers].sort().slice(0, MAX_NAMES),
      tokenVariables: [...tokenVariables].sort().slice(0, MAX_NAMES),
    },
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
 * Page function (runs INSIDE the warm page via page.evaluate; must
 * stay self-contained — no module-scope references, Playwright
 * serializes only this function's own source).
 *
 * Returns { url, scripts: [{src, inline}], inline: [reduced...],
 * forms: [{action, method, enctype}], inlineReadAtSubmit } where
 * inline[] aligns with the inline scripts in order. Each inline entry
 * is the reduced result only (handler evidence + TSPD mention +
 * storage names when mentioned) — inline script text never leaves
 * the page. forms carry getAttribute strings only (null when the
 * attribute is absent — an absent method means the GET default, and
 * an absent action stays absent instead of resolving to the page
 * URL). inlineReadAtSubmit is true when any handler inline script
 * mentions TSPD or contains a TSPD storage name as a quoted literal.
 */
function collectSubmitHandlerEvidence() {
  var STOP = {};
  var stopList = ('function return if else for while do switch case default break continue '
    + 'var let const new typeof instanceof in of void delete true false null undefined this '
    + 'try catch finally throw await async yield class extends super import export from get set static '
    + 'method headers body url credentials mode cache redirect referrer referrerPolicy integrity keepalive '
    + 'signal duplex dataType contentType processData crossDomain xhrFields timeout withCredentials '
    + 'responseType mimeType data type getItem setItem removeItem').split(' ');
  for (var si = 0; si < stopList.length; si++) STOP[stopList[si]] = true;
  function clean(raw, out) {
    var name = String(raw || '').replace(/[^A-Za-z0-9_$.]/g, '').slice(0, 128);
    if (name && !STOP[name]) out[name] = true;
  }
  function cleanHeader(raw, out) {
    // HTTP header names legitimately contain hyphens — preserved.
    var name = String(raw || '').replace(/[^A-Za-z0-9_$.\\-]/g, '').slice(0, 128);
    if (name && !STOP[name]) out[name] = true;
  }
  function mechanismOf(f) {
    if (f.formDataForm) return 'formdata-form';
    if (f.formDataAppend) return 'formdata-append';
    if (f.json) return 'json';
    if (f.fetch) return 'fetch';
    if (f.xhr) return 'xhr';
    if (f.native) return 'native';
    return 'unknown';
  }
  function reduceHandler(t) {
    // Mirror of reduceSubmitHandlerText: bare FormData + append (the
    // page's async file-upload code) is NOT submit evidence — body
    // evidence only counts under a submit context (listener,
    // .submit( call, or submit-request window for the exact path).
    var listener = 0;
    var m = t.match(/addEventListener\s*\(\s*['"]submit['"]/g) || [];
    var o = t.match(/onsubmit\s*=/g) || [];
    listener = m.length + o.length;
    var sc = t.match(/\.submit\s*\(/g) || [];
    var submitCalls = sc.length;
    var ff = t.match(/new\s+FormData\s*\(\s*[^)]*(form|document|querySelector|getElementById|getElementsBy|\bthis\b|event\.target|e\.target)/gi) || [];
    var formDataForms = ff.length;
    var hasFD = /new\s+FormData\s*\(/.test(t);
    var ap = t.match(/\.append\s*\(/g) || [];
    var appends = ap.length;
    var windows = 0;
    var idx = -1;
    var needle = '/br/application';
    while (windows < 10 && (idx = t.indexOf(needle, idx + 1)) >= 0) {
      if (t[idx + needle.length] === '/') continue;
      var win = t.slice(Math.max(0, idx - 600), idx + 600);
      var um = win.match(/['"]([^'"]*br\/application[^'"]*)['"]/);
      var cand = '/br/application';
      if (um) {
        try { cand = new URL(um[1], 'https://bdris.gov.bd').pathname; } catch (e) { cand = '/br/application'; }
      }
      if (cand !== '/br/application') continue;
      var hasPost = /method\s*:\s*['"]POST['"]/i.test(win)
        || /type\s*:\s*['"]POST['"]/i.test(win)
        || /\.post\s*\(/i.test(win)
        || /open\s*\(\s*['"]POST['"]/i.test(win)
        || /FormData/.test(win)
        || /fetch\s*\(/.test(win)
        || /\$\.ajax\s*\(/.test(win);
      if (!hasPost) continue;
      windows += 1;
    }
    var submitContext = listener > 0 || submitCalls > 0 || windows > 0;
    var bodyEvidence = formDataForms > 0 || (hasFD && appends > 0);
    var fetchCall = /fetch\s*\(/.test(t);
    var xhrCall = /XMLHttpRequest/.test(t) || /\$\.ajax\s*\(/.test(t) || /jQuery\.ajax\s*\(/.test(t);
    var found = submitCalls > 0 || (submitContext && (bodyEvidence || fetchCall || xhrCall));
    if (!found) {
      return { found: false, matchCount: 0, mechanism: 'unknown', appendedFieldNames: [], headerNames: [] };
    }
    var count = listener + submitCalls + windows;
    if (submitContext) {
      count += formDataForms;
      if (hasFD) count += appends;
    }
    var flags = {
      formDataForm: submitContext && formDataForms > 0,
      formDataAppend: submitContext && hasFD && appends > 0,
      json: /JSON\.stringify/.test(t),
      fetch: fetchCall,
      xhr: xhrCall,
      native: submitCalls > 0,
    };
    var appended = {};
    var headers = {};
    var pats = [
      /\.append\(\s*['"]([^'"]{1,128})['"]/g,
      /\.setAttribute\(\s*['"]name['"]\s*,\s*['"]([^'"]{1,128})['"]/g,
      /\.name\s*=\s*['"]([^'"]{1,128})['"]/g,
    ];
    for (var p = 0; p < pats.length; p++) {
      var hit;
      while ((hit = pats[p].exec(t)) !== null) clean(hit[1], appended);
    }
    var hp = /\.setRequestHeader\(\s*['"]([^'"]{1,128})['"]/g;
    while ((hit = hp.exec(t)) !== null) cleanHeader(hit[1], headers);
    return {
      found: true, matchCount: count, mechanism: mechanismOf(flags),
      appendedFieldNames: Object.keys(appended).sort().slice(0, 200),
      headerNames: Object.keys(headers).sort().slice(0, 200),
    };
  }
  function reduceTspd(t) {
    var mention = t.indexOf('TSPD') >= 0;
    var cookies = {};
    var ls = {};
    var ss = {};
    var headers = {};
    var vars = {};
    var hit;
    var ca = /document\.cookie\s*=\s*['"]([A-Za-z0-9_$]+)=/g;
    while ((hit = ca.exec(t)) !== null) clean(hit[1], cookies);
    var cf = /(?:getCookie|setCookie|get_cookie|set_cookie)\s*\(\s*['"]([^'"]{1,128})['"]/g;
    while ((hit = cf.exec(t)) !== null) clean(hit[1], cookies);
    var stores = [['localStorage', ls], ['sessionStorage', ss]];
    for (var s = 0; s < stores.length; s++) {
      var name = stores[s][0];
      var out = stores[s][1];
      var re1 = new RegExp(name + '\\.(?:getItem|setItem|removeItem)\\s*\\(\\s*[\'"]([^\'"]{1,128})[\'"]', 'g');
      while ((hit = re1.exec(t)) !== null) clean(hit[1], out);
      var re2 = new RegExp(name + '\\s*\\[\\s*[\'"]([^\'"]{1,128})[\'"]\\s*\\]', 'g');
      while ((hit = re2.exec(t)) !== null) clean(hit[1], out);
      var re3 = new RegExp(name + '\\.([A-Za-z_$][A-Za-z0-9_$]*)', 'g');
      while ((hit = re3.exec(t)) !== null) clean(hit[1], out);
    }
    var hp2 = /\.setRequestHeader\(\s*['"]([^'"]{1,128})['"]/g;
    while ((hit = hp2.exec(t)) !== null) cleanHeader(hit[1], headers);
    if (mention) {
      var idx = -1;
      var windows = 0;
      while (windows < 10 && (idx = t.indexOf('TSPD', idx + 1)) >= 0) {
        var win = t.slice(Math.max(0, idx - 600), idx + 600);
        var re = /\b(tspd|fingerprint|challenge|clearance)[A-Za-z0-9_$]*/gi;
        while ((hit = re.exec(win)) !== null) clean(hit[0], vars);
        windows += 1;
      }
    }
    return {
      mention: mention,
      storage: {
        cookies: Object.keys(cookies).sort().slice(0, 200),
        localStorage: Object.keys(ls).sort().slice(0, 200),
        sessionStorage: Object.keys(ss).sort().slice(0, 200),
        headers: Object.keys(headers).sort().slice(0, 200),
        tokenVariables: Object.keys(vars).sort().slice(0, 200),
      },
    };
  }
  var scripts = [];
  var inline = [];
  var all = document.querySelectorAll('script');
  for (var i = 0; i < all.length; i++) {
    var s = all[i];
    if (s.src) {
      scripts.push({ src: s.src, inline: false });
    } else {
      scripts.push({ src: '', inline: true });
      var txt = s.textContent || '';
      var h = reduceHandler(txt);
      var tp = reduceTspd(txt);
      inline.push({
        found: h.found, matchCount: h.matchCount, mechanism: h.mechanism,
        appendedFieldNames: h.appendedFieldNames, headerNames: h.headerNames,
        tspdMention: tp.mention, storage: tp.storage,
      });
    }
  }
  // TSPD storage names from tspd-mentioned inline scripts, then
  // readAtSubmit: any handler inline script that mentions TSPD or
  // contains a storage name as a quoted literal.
  var inlineStorage = [];
  for (var j = 0; j < inline.length; j++) {
    if (!inline[j].tspdMention) continue;
    var st = inline[j].storage;
    var keys = ['cookies', 'localStorage', 'sessionStorage', 'headers', 'tokenVariables'];
    for (var k = 0; k < keys.length; k++) {
      for (var n = 0; n < st[keys[k]].length; n++) inlineStorage.push(st[keys[k]][n]);
    }
  }
  var inlineReadAtSubmit = false;
  // Second pass over inline scripts in order (inline[] aligns with
  // the non-src scripts in order).
  var inlinePos = 0;
  for (var b = 0; b < all.length; b++) {
    if (all[b].src) continue;
    var e = inline[inlinePos++];
    if (!e || !e.found) continue;
    if (e.tspdMention) { inlineReadAtSubmit = true; break; }
    var bt = all[b].textContent || '';
    for (var q = 0; q < inlineStorage.length; q++) {
      var lit = inlineStorage[q];
      if (bt.indexOf("'" + lit + "'") >= 0 || bt.indexOf('"' + lit + '"') >= 0) {
        inlineReadAtSubmit = true;
        break;
      }
    }
    if (inlineReadAtSubmit) break;
  }
  var forms = [];
  var allForms = document.querySelectorAll('form');
  for (var f = 0; f < allForms.length; f++) {
    var form = allForms[f];
    var get = (typeof form.getAttribute === 'function') ? form.getAttribute.bind(form) : function () { return null; };
    var act = get('action');
    var pathname = null;
    if (act) {
      try { pathname = new URL(act, location.href).pathname; } catch (err) { pathname = null; }
    }
    forms.push({ action: pathname, method: get('method'), enctype: get('enctype') });
  }
  return { url: location.href, scripts: scripts, inline: inline, forms: forms, inlineReadAtSubmit: inlineReadAtSubmit };
}

/**
 * Orchestration: refs from the warm page, external texts via the
 * seeded client's fetchText(pathname), reduction to paths/booleans/
 * counts/names/markup-attributes only. Per-script fetch failure or a
 * cross-origin src is reported honestly as fetchFailed/skipped —
 * never as "not found" proof.
 */
async function probeSubmitHandler({ page, fetchText }) {
  const refs = await page.evaluate(collectSubmitHandlerEvidence);
  const pageUrl = (refs && typeof refs.url === 'string') ? refs.url : '';
  const list = (refs && Array.isArray(refs.scripts)) ? refs.scripts : [];
  const inlineResults = (refs && Array.isArray(refs.inline)) ? refs.inline : [];
  const forms = (refs && Array.isArray(refs.forms)) ? refs.forms : [];
  const scripts = [];
  const handlerFoundIn = [];
  const handlerAppended = new Set();
  const handlerHeaders = new Set();
  let handlerFound = false;
  let handlerMechanism = 'unknown';
  const tspdPaths = [];
  const tspdStorage = { cookies: new Set(), localStorage: new Set(), sessionStorage: new Set(), headers: new Set(), tokenVariables: new Set() };
  const externalTexts = [];
  let inlineIdx = 0;
  for (const ref of list.slice(0, MAX_SCRIPTS)) {
    if (ref.inline || !ref.src) {
      const r = inlineResults[inlineIdx++] || { found: false, matchCount: 0, mechanism: 'unknown', appendedFieldNames: [], headerNames: [], tspdMention: false, storage: null };
      const entry = { path: null, inline: true, found: !!r.found, matchCount: r.matchCount || 0 };
      if (entry.found) {
        handlerFound = true;
        if (handlerMechanism === 'unknown') handlerMechanism = r.mechanism || 'unknown';
        handlerFoundIn.push('inline');
        entry.mechanism = r.mechanism || 'unknown';
        entry.appendedFieldNames = Array.isArray(r.appendedFieldNames) ? r.appendedFieldNames : [];
        entry.headerNames = Array.isArray(r.headerNames) ? r.headerNames : [];
        for (const n of entry.appendedFieldNames) handlerAppended.add(n);
        for (const n of entry.headerNames) handlerHeaders.add(n);
      }
      if (r.tspdMention) {
        tspdPaths.push('inline');
        if (r.storage) {
          for (const k of Object.keys(tspdStorage)) {
            for (const n of (r.storage[k] || [])) tspdStorage[k].add(n);
          }
        }
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
    externalTexts.push({ path, text });
    const h = reduceSubmitHandlerText(text);
    const tp = reduceTspdText(text);
    const entry = { path, inline: false, found: h.found, matchCount: h.matchCount };
    if (h.found) {
      handlerFound = true;
      if (handlerMechanism === 'unknown') handlerMechanism = h.mechanism;
      handlerFoundIn.push(path);
      entry.mechanism = h.mechanism;
      entry.appendedFieldNames = h.appendedFieldNames;
      entry.headerNames = h.headerNames;
      for (const n of h.appendedFieldNames) handlerAppended.add(n);
      for (const n of h.headerNames) handlerHeaders.add(n);
    }
    // TSPD implementation scripts live at a /TSPD/ path. An external
    // script that merely MENTIONS the name (e.g. a handler reading a
    // TSPD storage key) is a consumer, not the implementation: it
    // counts toward readAtSubmit below, but not toward tspd.scripts
    // or tspd.storage. (Inline scripts have no path, so a mention is
    // the only signal there — see the inline branch above.)
    if (path.includes('TSPD')) {
      tspdPaths.push(path);
      for (const k of Object.keys(tspdStorage)) {
        for (const n of tp.storage[k]) tspdStorage[k].add(n);
      }
    }
    scripts.push(entry);
  }
  // readAtSubmit: any handler script mentions TSPD, or contains a
  // TSPD storage name as a quoted literal (external texts checked
  // here; inline contribution came from the page function).
  let readAtSubmit = !!(refs && refs.inlineReadAtSubmit);
  if (!readAtSubmit) {
    const storageNames = new Set();
    for (const k of Object.keys(tspdStorage)) {
      for (const n of tspdStorage[k]) storageNames.add(n);
    }
    for (const { text } of externalTexts) {
      const h = reduceSubmitHandlerText(text);
      if (!h.found) continue;
      if (text.includes('TSPD')) { readAtSubmit = true; break; }
      for (const n of storageNames) {
        if (text.includes(`'${n}'`) || text.includes(`"${n}"`)) { readAtSubmit = true; break; }
      }
      if (readAtSubmit) break;
    }
  }
  const form = forms.find((f) => f.action === FORM_ACTION) || forms[0] || null;
  return {
    ok: true,
    truncated: list.length > MAX_SCRIPTS,
    form: form ? { action: form.action, method: form.method, enctype: form.enctype } : null,
    formCount: forms.length,
    submitHandler: {
      found: handlerFound,
      mechanism: handlerFound ? handlerMechanism : 'unknown',
      appendedFieldNames: [...handlerAppended].sort(),
      headerNames: [...handlerHeaders].sort(),
      foundIn: [...new Set(handlerFoundIn)],
    },
    tspd: {
      scripts: [...new Set(tspdPaths)],
      storage: {
        cookies: [...tspdStorage.cookies].sort(),
        localStorage: [...tspdStorage.localStorage].sort(),
        sessionStorage: [...tspdStorage.sessionStorage].sort(),
        headers: [...tspdStorage.headers].sort(),
        tokenVariables: [...tspdStorage.tokenVariables].sort(),
      },
      readAtSubmit,
    },
    scripts,
  };
}

module.exports = {
  MAX_SCRIPTS,
  SUBMIT_NEEDLE,
  FORM_ACTION,
  reduceSubmitHandlerText,
  reduceTspdText,
  scriptPathname,
  collectSubmitHandlerEvidence,
  probeSubmitHandler,
};
