/**
 * RequestNameLog — names-only request logging for the BDRIS Playwright engine.
 *
 * Alternative path 2 (2026-10-25): the next REAL application that runs
 * through OUR app must automatically record, server-side, the wire
 * details of the final submit/verify requests — so no DevTools /
 * Keep-log work is needed from the user, and a page navigation cannot
 * erase the log (the failure that lost the 2026-10-25 manual capture).
 *
 * NAMES ONLY, BY DESIGN. A log line contains:
 *   - timestamp (ISO)
 *   - request URL path (query VALUES stripped; query PARAMETER NAMES only)
 *   - HTTP method
 *   - content-type media type only (e.g. "application/json"), never the
 *     full header value and never any other header
 *   - payload FIELD NAMES only, recursively extracted from JSON bodies
 *     and form-data field names (leaf values are replaced by null,
 *     which means "present, value deliberately omitted" — null is
 *     never a value copied from the request)
 *
 * NEVER recorded, even in truncated form: cookies, Authorization /
 * CSRF / token headers, OTP values, phone numbers, personal names,
 * dates of birth, addresses, application numbers, document file
 * contents, and document URLs carrying ids. If a value cannot be
 * proven safe, it is dropped, not truncated. Path segments that look
 * like ids (digit runs) on non-canonical matched URLs are replaced
 * with ":id" before logging.
 *
 * OFF BY DEFAULT (safe-by-default, same pattern as BDRIS_HTTP_PATH):
 * enabled only when BDRIS_REQUEST_NAME_LOG is explicitly "on" (or
 * 1/true/yes/enabled). Unset/empty/unknown values are OFF.
 *
 * FAIL-OPEN: logging never blocks, alters, retries, or double-submits
 * the application flow. Every failure inside the logger is swallowed
 * and reported only through the optional onError callback. The
 * request handler itself is synchronous and never awaits anything.
 *
 * NOT live-verified: this module proves nothing about the wire
 * format. It only makes the NEXT app-driven application produce the
 * evidence (names only) that would prove it. Until a real
 * app-driven application writes a log line, the candidate submit /
 * verify payloads stay CANDIDATE.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ON_VALUES = new Set(['on', '1', 'true', 'yes', 'enabled']);

// Canonical submit/verify endpoints. Their paths carry no ids, so the
// full path is safe to record verbatim.
const CANONICAL_PATHS = new Set([
  '/api/br/application/register',
  '/api/otp/verify',
  '/api/application/receive',
]);

const KEYWORD_PATHS = ['register', 'verify', 'receive'];

const MAX_DEPTH = 8;
const MAX_KEYS = 1000;

function isRequestNameLogEnabled(env = process.env) {
  const raw = env && env.BDRIS_REQUEST_NAME_LOG !== undefined && env.BDRIS_REQUEST_NAME_LOG !== null
    ? String(env.BDRIS_REQUEST_NAME_LOG).trim().toLowerCase()
    : '';
  return ON_VALUES.has(raw);
}

function defaultLogFile() {
  return path.join(__dirname, '..', 'request-name-log.jsonl');
}

function resolveLogFile(options = {}) {
  if (options.logFile) return options.logFile;
  if (options.env && options.env.BDRIS_REQUEST_NAME_LOG_FILE) {
    return String(options.env.BDRIS_REQUEST_NAME_LOG_FILE);
  }
  if (process.env.BDRIS_REQUEST_NAME_LOG_FILE) {
    return process.env.BDRIS_REQUEST_NAME_LOG_FILE;
  }
  return defaultLogFile();
}

function isBdrisHost(hostname) {
  return hostname === 'bdris.gov.bd' || hostname.endsWith('.bdris.gov.bd');
}

// Does this URL look like a submit/verify request on the BDRIS site?
// Matching is deliberately broad (any bdris.gov.bd path containing
// register/verify/receive) so a renamed or additional submit endpoint
// (e.g. /api/application/receive vs /api/br/application/register)
// is still captured, while unrelated site traffic is ignored.
function matchesSubmitRequest(urlString) {
  try {
    const u = new URL(urlString);
    if (!isBdrisHost(u.hostname)) return false;
    const p = u.pathname.toLowerCase();
    if (CANONICAL_PATHS.has(u.pathname)) return true;
    return KEYWORD_PATHS.some((k) => p.includes(k));
  } catch (e) {
    return false;
  }
}

// Record a path safely: canonical endpoints verbatim; any other
// matched path with digit runs (possible ids) masked to ":id".
function safePath(urlString) {
  try {
    const u = new URL(urlString);
    if (CANONICAL_PATHS.has(u.pathname)) return u.pathname;
    return u.pathname.replace(/\d+/g, ':id');
  } catch (e) {
    return null;
  }
}

function queryParamNames(urlString) {
  try {
    const u = new URL(urlString);
    const names = [];
    for (const name of u.searchParams.keys()) {
      if (!names.includes(name)) names.push(name);
    }
    return names;
  } catch (e) {
    return [];
  }
}

// Recursively extract FIELD NAMES ONLY from a parsed JSON value.
// Leaves become null ("present, value omitted"). Depth and total-key
// caps keep a hostile or huge body from bloating the log.
function keysOnly(value, state) {
  if (state.count >= MAX_KEYS) {
    state.truncated = true;
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  if (state.depth >= MAX_DEPTH) {
    state.truncated = true;
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    state.depth += 1;
    // Merge element shapes: one representative element per distinct
    // shape, so arrays of objects collapse to a single key set.
    const merged = [];
    const seen = new Set();
    for (const el of value) {
      const shape = keysOnly(el, state);
      const key = JSON.stringify(shape);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(shape);
      }
      if (state.count >= MAX_KEYS) break;
    }
    state.depth -= 1;
    return merged;
  }
  state.depth += 1;
  const out = {};
  for (const key of Object.keys(value)) {
    state.count += 1;
    if (state.count > MAX_KEYS) {
      state.truncated = true;
      break;
    }
    out[key] = keysOnly(value[key], state);
  }
  state.depth -= 1;
  return out;
}

// Extract field names from a multipart body: only the name="..."
// attributes of each part header. File contents are never read into
// the output (only the field name token is kept).
function multipartFieldNames(bodyText) {
  const names = [];
  // The "; " / start anchor matters: without it, filename="..."
  // would also match (it contains name="..."), leaking a file name.
  const re = /(?:^|[;\s])name="([^"]*)"/g;
  let m;
  while ((m = re.exec(bodyText)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// Extract field names from a request body string, given its media
// type. Returns { kind, fields } where fields is either a keys-only
// structure (JSON), a list of names (form/multipart), or null when
// the body is empty or unrecognisable. Values are NEVER returned.
function extractBodyFieldNames(bodyText, mediaType) {
  if (bodyText === null || bodyText === undefined || bodyText === '') {
    return { kind: 'empty', fields: null };
  }
  const text = typeof bodyText === 'string' ? bodyText : String(bodyText);
  if (mediaType === 'application/json') {
    try {
      const parsed = JSON.parse(text);
      const state = { depth: 0, count: 0, truncated: false };
      const fields = keysOnly(parsed, state);
      return { kind: 'json', fields, truncated: state.truncated || undefined };
    } catch (e) {
      // Not JSON despite the media type: fall back to nothing rather
      // than echoing the body.
      return { kind: 'json-unparseable', fields: null };
    }
  }
  if (mediaType === 'application/x-www-form-urlencoded') {
    const names = [];
    try {
      for (const name of new URLSearchParams(text).keys()) {
        if (!names.includes(name)) names.push(name);
      }
    } catch (e) { /* fall through with what we have */ }
    return { kind: 'form', fields: names };
  }
  if (mediaType === 'multipart/form-data') {
    return { kind: 'multipart', fields: multipartFieldNames(text) };
  }
  // Unknown body type: record the kind only, never the body.
  return { kind: 'other', fields: null };
}

// Read a Playwright Request (method-style API) or a plain mock
// object (plain properties) without throwing, and build the
// names-only log entry. Returns null for non-matching requests.
function buildLogEntry(request) {
  try {
    if (!request) return null;
    const url = typeof request.url === 'function' ? request.url() : request.url;
    if (typeof url !== 'string' || !matchesSubmitRequest(url)) return null;

    const method = typeof request.method === 'function' ? request.method() : request.method;
    const headers = typeof request.headers === 'function' ? request.headers() : (request.headers || {});
    const rawContentType = headers ? (headers['content-type'] || headers['Content-Type'] || '') : '';
    // Media type only: strip parameters (e.g. "; boundary=...").
    const mediaType = String(rawContentType).split(';')[0].trim().toLowerCase() || null;

    // Body: prefer the buffer form (covers multipart), else postData.
    let bodyText = null;
    try {
      if (typeof request.postDataBuffer === 'function') {
        const buf = request.postDataBuffer();
        if (buf) bodyText = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
      } else if (request.postDataBuffer) {
        const buf = request.postDataBuffer;
        bodyText = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
      }
    } catch (e) { bodyText = null; }
    if (bodyText === null) {
      try {
        if (typeof request.postData === 'function') bodyText = request.postData();
        else if (request.postData !== undefined) bodyText = request.postData;
      } catch (e) { bodyText = null; }
    }
    if (typeof bodyText !== 'string') bodyText = bodyText === null || bodyText === undefined ? null : String(bodyText);

    const body = extractBodyFieldNames(bodyText, mediaType);
    return {
      ts: new Date().toISOString(),
      source: 'bdris-request-name-log',
      candidate: true,
      method: method ? String(method).toUpperCase() : null,
      path: safePath(url),
      queryParams: queryParamNames(url),
      contentType: mediaType,
      bodyKind: body.kind,
      bodyFields: body.fields,
      ...(body.truncated ? { truncated: true } : {}),
    };
  } catch (e) {
    // Never let logging break the caller; a null entry means "skip".
    return null;
  }
}

// Create a logger. `write` defaults to appending one JSON line to the
// log file (fire-and-forget, errors swallowed to onError). Tests pass
// a capturing `write` instead, so no file is touched in tests.
function createRequestNameLogger(options = {}) {
  const env = options.env || process.env;
  const enabled = options.enabled !== undefined ? !!options.enabled : isRequestNameLogEnabled(env);
  const logFile = resolveLogFile(options);
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const write = typeof options.write === 'function'
    ? options.write
    : (line) => {
      fs.promises.appendFile(logFile, line + '\n').catch((e) => onError(e));
    };

  // Synchronous, fail-open: never throws, never awaits.
  function handleRequest(request) {
    try {
      if (!enabled) return null;
      const entry = buildLogEntry(request);
      if (!entry) return null;
      try {
        write(JSON.stringify(entry));
      } catch (e) {
        onError(e);
      }
      return entry;
    } catch (e) {
      onError(e);
      return null;
    }
  }

  // Attach to a Playwright page. Idempotent: a page already carrying
  // the listener is left alone (warm-pool pages pass through both
  // BrowserManager.newPage and SessionManager.create).
  function attach(page) {
    try {
      if (!enabled) return false;
      if (!page || typeof page.on !== 'function') return false;
      if (page.__bdrisRequestNameLogAttached) return false;
      page.on('request', (request) => {
        try { handleRequest(request); } catch (e) { onError(e); }
      });
      try { page.__bdrisRequestNameLogAttached = true; } catch (e) { /* marker best-effort */ }
      return true;
    } catch (e) {
      onError(e);
      return false;
    }
  }

  return { enabled, logFile, handleRequest, attach };
}

// Convenience attach used by BrowserManager / SessionManager: honours
// the env flag, swallows every failure, never blocks page creation.
function attachRequestNameLog(page, options = {}) {
  try {
    const logger = createRequestNameLogger(options);
    return logger.attach(page);
  } catch (e) {
    return false;
  }
}

module.exports = {
  isRequestNameLogEnabled,
  matchesSubmitRequest,
  safePath,
  queryParamNames,
  keysOnly,
  multipartFieldNames,
  extractBodyFieldNames,
  buildLogEntry,
  createRequestNameLogger,
  attachRequestNameLog,
  defaultLogFile,
  CANONICAL_PATHS,
};
