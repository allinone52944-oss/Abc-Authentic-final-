/**
 * Frontend unit tests — js/app.js (app shell).
 *
 * app.js is an IIFE (not a module); it exposes `window.ABC = { api,
 * setTokens, clearTokens, refreshAccess, Drafts }`. Tests load the real
 * script with lightweight stubs for sessionStorage / localStorage /
 * fetch / window / document / navigator — no jsdom, no network.
 *
 * Focus: the token-refresh flow incl. fix #17 (api() clears stale tokens
 * when the silent refresh fails) and Drafts persistence.
 */

const APP_PATH = '../../../frontend/js/app.js';

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => m.set(String(k), String(v)),
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => m.clear(),
  };
}

function installGlobals() {
  global.localStorage = makeStorage();
  global.sessionStorage = makeStorage();
  global.fetch = jest.fn();
  global.navigator = {};
  global.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener: jest.fn(),
  };
  global.window = {
    addEventListener: jest.fn(),
    matchMedia: () => ({ matches: false }),
    navigator: {},
  };
}

function loadApp() {
  jest.resetModules();
  const ABC = require(APP_PATH).default || global.window.ABC;
  return global.window.ABC;
}

const okJson = (data) => ({ ok: true, status: 200, json: async () => data });
const errStatus = (status) => ({ ok: false, status, json: async () => ({}) });

beforeEach(() => {
  installGlobals();
});

afterEach(() => {
  delete global.localStorage;
  delete global.sessionStorage;
  delete global.fetch;
  delete global.navigator;
  delete global.document;
  delete global.window;
});

describe('app.js loads', () => {
  test('exposes window.ABC with the expected API surface', () => {
    const ABC = loadApp();
    expect(ABC).toBeDefined();
    for (const k of ['api', 'setTokens', 'clearTokens', 'refreshAccess']) {
      expect(typeof ABC[k]).toBe('function');
    }
    expect(typeof ABC.Drafts).toBe('object');
    expect(typeof ABC.Drafts.save).toBe('function');
  });

  test('restores a persisted access token from sessionStorage on load', async () => {
    global.sessionStorage.setItem('abc_access_token', 'persisted-acc');
    const ABC = loadApp();
    global.fetch.mockResolvedValueOnce(okJson({}));
    await ABC.api('/ping');
    expect(global.fetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer persisted-acc');
  });
});

describe('setTokens / clearTokens', () => {
  test('setTokens stores access in sessionStorage and refresh in localStorage', () => {
    const ABC = loadApp();
    ABC.setTokens('a1', 'r1');
    expect(global.sessionStorage.getItem('abc_access_token')).toBe('a1');
    expect(global.localStorage.getItem('abc_refresh_token')).toBe('r1');
  });

  test('setTokens(null) removes the access token but keeps a provided refresh token', () => {
    const ABC = loadApp();
    ABC.setTokens('a1', 'r1');
    ABC.setTokens(null, 'r2');
    expect(global.sessionStorage.getItem('abc_access_token')).toBeNull();
    expect(global.localStorage.getItem('abc_refresh_token')).toBe('r2');
  });

  test('clearTokens wipes both storages and the in-memory token', async () => {
    const ABC = loadApp();
    ABC.setTokens('a1', 'r1');
    ABC.clearTokens();
    expect(global.sessionStorage.getItem('abc_access_token')).toBeNull();
    expect(global.localStorage.getItem('abc_refresh_token')).toBeNull();
    global.fetch.mockResolvedValueOnce(okJson({}));
    await ABC.api('/ping');
    expect(global.fetch.mock.calls[0][1].headers['Authorization']).toBeUndefined();
  });
});

describe('api() — happy paths', () => {
  test('sends Bearer token and returns the response untouched', async () => {
    const ABC = loadApp();
    ABC.setTokens('acc1', 'ref1');
    const resp = okJson({ hello: 'world' });
    global.fetch.mockResolvedValueOnce(resp);
    const r = await ABC.api('/users/me');
    expect(r).toBe(resp);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/users/me');
    expect(opts.headers['Authorization']).toBe('Bearer acc1');
  });

  test('sends no Authorization header when not logged in', async () => {
    const ABC = loadApp();
    global.fetch.mockResolvedValueOnce(okJson({}));
    await ABC.api('/public/settings');
    expect(global.fetch.mock.calls[0][1].headers['Authorization']).toBeUndefined();
  });

  test('JSON-stringifies object bodies and sets Content-Type', async () => {
    const ABC = loadApp();
    global.fetch.mockResolvedValueOnce(okJson({}));
    await ABC.api('/auth/login', { method: 'POST', body: { phone: '01700000000', password: 'x' } });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ phone: '01700000000', password: 'x' });
  });

  test('preserves FormData / Blob / URLSearchParams bodies without JSON-stringifying', async () => {
    const ABC = loadApp();
    global.fetch.mockResolvedValueOnce(okJson({}));
    const fd = new FormData();
    fd.append('foo', 'bar');
    await ABC.api('/upload', { method: 'POST', body: fd });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['Content-Type']).toBeUndefined();
    expect(opts.body).toBe(fd);
  });

  test('preserves a FormData-like body from another realm (instanceof fails)', async () => {
    const ABC = loadApp();
    global.fetch.mockResolvedValueOnce(okJson({}));
    // A FormData created in another frame/realm fails `instanceof FormData`
    // here. Regression (nid extract NO_FILE): api() used to JSON.stringify it
    // into "{}", silently dropping the uploaded file.
    class ForeignFormData {
      append() {}
      get() { return null; }
      getAll() { return []; }
    }
    const fd = new ForeignFormData();
    expect(fd instanceof FormData).toBe(false);
    await ABC.api('/nid-engine/extract', { method: 'POST', body: fd });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['Content-Type']).toBeUndefined();
    expect(opts.body).toBe(fd);
  });

  test('getAccessToken returns active in-memory access token', () => {
    const ABC = loadApp();
    ABC.setTokens('my-token-123', 'ref-1');
    expect(ABC.getAccessToken()).toBe('my-token-123');
    ABC.clearTokens();
    expect(ABC.getAccessToken()).toBeNull();
  });

  test('preserves caller-supplied headers and works with no opts', async () => {
    const ABC = loadApp();
    ABC.setTokens('acc1', 'ref1');
    global.fetch.mockResolvedValueOnce(okJson({}));
    await ABC.api('/x', { headers: { 'X-Custom': 'yes' } });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-Custom']).toBe('yes');
    expect(opts.headers['Authorization']).toBe('Bearer acc1');
    global.fetch.mockResolvedValueOnce(okJson({}));
    await expect(ABC.api('/y')).resolves.toBeDefined();
  });

  test('non-401 errors are returned as-is without a refresh attempt', async () => {
    const ABC = loadApp();
    ABC.setTokens('acc1', 'ref1');
    global.fetch.mockResolvedValueOnce(errStatus(500));
    const r = await ABC.api('/orders');
    expect(r.status).toBe(500);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.localStorage.getItem('abc_refresh_token')).toBe('ref1');
  });
});

describe('api() — 401 + silent refresh', () => {
  function mockRefreshSuccess(newAccess, newRefresh) {
    global.fetch.mockImplementation(async (url, opts) => {
      if (url === '/api/auth/refresh') {
        return okJson({ access_token: newAccess, ...(newRefresh ? { refresh_token: newRefresh } : {}) });
      }
      if (opts.headers['Authorization'] === 'Bearer old-acc') return errStatus(401);
      return okJson({ retried: true });
    });
  }

  test('happy path: 401 → refresh → retry with the new token', async () => {
    const ABC = loadApp();
    ABC.setTokens('old-acc', 'good-refresh');
    mockRefreshSuccess('new-acc', 'new-ref');
    const r = await ABC.api('/orders');
    expect(r.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(3); // original, refresh, retry
    const refreshCall = global.fetch.mock.calls.find((c) => c[0] === '/api/auth/refresh');
    expect(refreshCall[1].method).toBe('POST');
    expect(JSON.parse(refreshCall[1].body)).toEqual({ refresh_token: 'good-refresh' });
    const retryCall = global.fetch.mock.calls[2];
    expect(retryCall[0]).toBe('/api/orders');
    expect(retryCall[1].headers['Authorization']).toBe('Bearer new-acc');
    expect(global.sessionStorage.getItem('abc_access_token')).toBe('new-acc');
    expect(global.localStorage.getItem('abc_refresh_token')).toBe('new-ref');
  });

  test('fresh tab: no access token anywhere, refresh token in localStorage → recovers instead of bouncing to login', async () => {
    // sessionStorage is per-tab: a page opened in a NEW tab starts
    // with NO access token, while the refresh token (localStorage)
    // is shared. api() must still attempt the silent refresh.
    global.localStorage.setItem('abc_refresh_token', 'tab-refresh');
    const ABC = loadApp();
    expect(ABC.getAccessToken()).toBeFalsy();
    global.fetch.mockImplementation(async (url, opts) => {
      if (url === '/api/auth/refresh') {
        return okJson({ access_token: 'fresh-acc', refresh_token: 'fresh-ref' });
      }
      if (opts.headers['Authorization'] === 'Bearer fresh-acc') return okJson({ retried: true });
      return errStatus(401); // first call carries no/stale auth
    });
    const r = await ABC.api('/orders');
    expect(r.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(3); // original, refresh, retry
    expect(global.sessionStorage.getItem('abc_access_token')).toBe('fresh-acc');
    expect(global.localStorage.getItem('abc_refresh_token')).toBe('fresh-ref');
  });

  test('keeps the old refresh token when the refresh response omits it', async () => {
    const ABC = loadApp();
    ABC.setTokens('old-acc', 'keep-me');
    mockRefreshSuccess('new-acc', null);
    await ABC.api('/orders');
    expect(global.localStorage.getItem('abc_refresh_token')).toBe('keep-me');
  });

  test('FIX #17: refresh rejected (401) → stale tokens are cleared', async () => {
    const ABC = loadApp();
    ABC.setTokens('stale-acc', 'bad-refresh');
    global.fetch.mockImplementation(async (url) => (
      url === '/api/auth/refresh' ? errStatus(401) : errStatus(401)
    ));
    const r = await ABC.api('/orders');
    expect(r.status).toBe(401); // original response is returned
    expect(global.sessionStorage.getItem('abc_access_token')).toBeNull();
    expect(global.localStorage.getItem('abc_refresh_token')).toBeNull();
    // in-memory token is gone too: the next call carries no Authorization
    global.fetch.mockClear();
    global.fetch.mockResolvedValueOnce(okJson({}));
    await ABC.api('/ping');
    expect(global.fetch.mock.calls[0][1].headers['Authorization']).toBeUndefined();
  });

  test('FIX #17: no refresh token stored → refresh skipped, tokens cleared', async () => {
    // access token in memory only (e.g. restored session), no refresh token
    global.sessionStorage.setItem('abc_access_token', 'acc-only');
    const ABC = loadApp();
    global.fetch.mockResolvedValueOnce(errStatus(401));
    const r = await ABC.api('/orders');
    expect(r.status).toBe(401);
    expect(global.fetch).toHaveBeenCalledTimes(1); // no refresh attempt
    expect(global.sessionStorage.getItem('abc_access_token')).toBeNull();
  });

  test('FIX #17: refresh network failure → tokens cleared (documented behavior)', async () => {
    const ABC = loadApp();
    ABC.setTokens('acc1', 'ref1');
    global.fetch.mockImplementation(async (url) => {
      if (url === '/api/auth/refresh') throw new Error('network down');
      return errStatus(401);
    });
    const r = await ABC.api('/orders');
    expect(r.status).toBe(401);
    expect(global.sessionStorage.getItem('abc_access_token')).toBeNull();
    expect(global.localStorage.getItem('abc_refresh_token')).toBeNull();
  });

  test('401 with no in-memory access token → no refresh attempt at all', async () => {
    const ABC = loadApp();
    global.fetch.mockResolvedValueOnce(errStatus(401));
    const r = await ABC.api('/protected');
    expect(r.status).toBe(401);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('refreshAccess() directly', () => {
  test('returns false without calling fetch when no refresh token is stored', async () => {
    const ABC = loadApp();
    expect(await ABC.refreshAccess()).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns false on network error and keeps existing tokens', async () => {
    const ABC = loadApp();
    ABC.setTokens('a1', 'r1');
    global.fetch.mockRejectedValueOnce(new Error('down'));
    expect(await ABC.refreshAccess()).toBe(false);
    // refreshAccess itself does not clear on exception — api() does the clearing
    expect(global.localStorage.getItem('abc_refresh_token')).toBe('r1');
  });
});

describe('Drafts persistence', () => {
  test('save/load round-trips an object under the abc_draft_ prefix', () => {
    const ABC = loadApp();
    ABC.Drafts.save('recharge', { amount: 500, method: 'bKash' });
    expect(global.localStorage.getItem('abc_draft_recharge')).toBe(
      JSON.stringify({ amount: 500, method: 'bKash' }),
    );
    expect(ABC.Drafts.load('recharge')).toEqual({ amount: 500, method: 'bKash' });
  });

  test('load returns null for a missing key', () => {
    const ABC = loadApp();
    expect(ABC.Drafts.load('nope')).toBeNull();
  });

  test('load returns null for corrupted JSON instead of throwing', () => {
    const ABC = loadApp();
    global.localStorage.setItem('abc_draft_broken', '{not-json');
    expect(ABC.Drafts.load('broken')).toBeNull();
  });

  test('clear removes the draft', () => {
    const ABC = loadApp();
    ABC.Drafts.save('k', { a: 1 });
    ABC.Drafts.clear('k');
    expect(ABC.Drafts.load('k')).toBeNull();
  });

  test('save never throws (circular object / storage failure are swallowed)', () => {
    const ABC = loadApp();
    const circular = {};
    circular.self = circular;
    expect(() => ABC.Drafts.save('circ', circular)).not.toThrow();
    global.localStorage.setItem = () => { throw new Error('quota exceeded'); };
    expect(() => ABC.Drafts.save('q', { a: 1 })).not.toThrow();
  });
});

describe("Drafts.get and Idempotency helpers", () => {
  test("Drafts.get aliases Drafts.load", () => {
    const ABC = loadApp();
    ABC.Drafts.save("test_key", { foo: "bar" });
    expect(ABC.Drafts.get("test_key")).toEqual({ foo: "bar" });
  });

  test("Idempotency generates and reuses key from sessionStorage", () => {
    const ABC = loadApp();
    const k1 = ABC.Idempotency.getOrCreate("form1");
    expect(k1).toBeTruthy();
    const k2 = ABC.Idempotency.getOrCreate("form1");
    expect(k2).toBe(k1);
    ABC.Idempotency.clear("form1");
    expect(global.sessionStorage.getItem("abc_idem_form1")).toBeNull();
  });
});

describe('api() — Fix 14 retry safety: timeout preserved, unkeyed writes never retried, retry progress shown', () => {
  // Record every setTimeout delay the code schedules (abort timers +
  // backoff sleeps), calling through to the real (or fake) timer.
  function recordDelays() {
    const delays = [];
    const base = global.setTimeout;
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
      delays.push(ms);
      return base(fn, ms, ...rest);
    });
    return { delays, restore: () => spy.mockRestore() };
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('a custom timeout survives all retries (was reset to 15s by `delete opts.timeout`)', async () => {
    jest.useFakeTimers();
    const { delays, restore } = recordDelays();
    try {
      const ABC = loadApp();
      global.fetch
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(okJson({ ok: true }));
      const p = ABC.api('/ping', { timeout: 60000 });
      await jest.advanceTimersByTimeAsync(10000);
      const r = await p;
      expect(r.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(3);
      // Three attempts, each with its own 60s abort timer; the 1s/2s
      // backoffs in between. No 15s timer may appear.
      expect(delays.filter((d) => d === 60000)).toHaveLength(3);
      expect(delays).toContain(1000);
      expect(delays).toContain(2000);
      expect(delays).not.toContain(15000);
    } finally { restore(); }
  });

  test('default timeout stays 15s per attempt (retry math: 15+1+15+2+15 = 48s worst case)', async () => {
    jest.useFakeTimers();
    const { delays, restore } = recordDelays();
    try {
      const ABC = loadApp();
      global.fetch
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('offline'));
      const p = ABC.api('/ping');
      await jest.advanceTimersByTimeAsync(10000);
      const r = await p;
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'NETWORK_ERROR' });
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(delays.filter((d) => d === 15000)).toHaveLength(3);
    } finally { restore(); }
  });

  test('unkeyed mutating POST is NOT retried on network failure (fails fast as synthetic 503)', async () => {
    const ABC = loadApp();
    global.fetch.mockRejectedValueOnce(new Error('offline'));
    const r = await ABC.api('/orders', { method: 'POST', body: { service_id: 's1' } });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'NETWORK_ERROR' });
  });

  test('unkeyed mutating POST is NOT retried on 503/504 (the 503 is returned as-is)', async () => {
    const ABC = loadApp();
    global.fetch.mockResolvedValue(errStatus(503));
    const r = await ABC.api('/wallet/recharge', { method: 'POST', body: { method: 'bkash_payment', trxid: 'ABC123' } });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(503);
  });

  test('GET still retries on network failure and on 503', async () => {
    jest.useFakeTimers();
    try {
      const ABC = loadApp();
      global.fetch
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(errStatus(503))
        .mockResolvedValueOnce(okJson({ ok: true }));
      const p = ABC.api('/services');
      await jest.advanceTimersByTimeAsync(10000);
      const r = await p;
      expect(r.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    } finally { jest.useRealTimers(); }
  });

  test('keyed mutating POST retries with the SAME idempotency key on every attempt', async () => {
    jest.useFakeTimers();
    try {
      const ABC = loadApp();
      global.fetch
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(okJson({ ok: true }));
      const p = ABC.api('/orders', { method: 'POST', body: { service_id: 's1', idempotency_key: 'k1' } });
      await jest.advanceTimersByTimeAsync(10000);
      const r = await p;
      expect(r.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(3);
      for (const [, opts] of global.fetch.mock.calls) {
        expect(JSON.parse(opts.body).idempotency_key).toBe('k1');
      }
    } finally { jest.useRealTimers(); }
  });

  test('keyed FormData POST retries; key in the query string counts too', async () => {
    jest.useFakeTimers();
    try {
      const ABC = loadApp();
      const fd = new FormData();
      fd.append('idempotency_key', 'fd-key');
      fd.append('photo', 'x');
      global.fetch
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(okJson({ ok: true }));
      const p = ABC.api('/qr-photo-verify/verify', { method: 'POST', body: fd });
      await jest.advanceTimersByTimeAsync(5000);
      expect((await p).ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);

      global.fetch
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(okJson({ ok: true }));
      const p2 = ABC.api('/passport/pdf?passport_no=X&idempotency_key=k9', { method: 'POST', body: '<html></html>' });
      await jest.advanceTimersByTimeAsync(5000);
      expect((await p2).ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(4);
    } finally { jest.useRealTimers(); }
  });

  test('the 401 refresh re-fetch keeps the caller timeout (was a hardcoded 20s)', async () => {
    const { delays, restore } = recordDelays();
    try {
      const ABC = loadApp();
      ABC.setTokens('old-acc', 'good-refresh');
      global.fetch.mockImplementation(async (url, opts) => {
        if (url === '/api/auth/refresh') {
          return okJson({ access_token: 'new-acc', refresh_token: 'new-ref' });
        }
        if (opts.headers['Authorization'] === 'Bearer old-acc') return errStatus(401);
        return okJson({ retried: true });
      });
      const r = await ABC.api('/orders', { timeout: 60000 });
      expect(r.ok).toBe(true);
      // Initial attempt + the post-refresh re-fetch, both at 60s.
      expect(delays.filter((d) => d === 60000)).toHaveLength(2);
      expect(delays).not.toContain(20000);
    } finally { restore(); }
  });

  test('retry progress: a note appears during the retry and hides when it settles', async () => {
    jest.useFakeTimers();
    const created = [];
    const appended = [];
    global.document.createElement = (tag) => {
      const el = { tag, style: {}, setAttribute: jest.fn(), appendChild: jest.fn(), addEventListener: jest.fn(), textContent: '' };
      created.push(el);
      return el;
    };
    global.document.body.appendChild = (el) => { appended.push(el); };
    try {
      const ABC = loadApp();
      global.fetch
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(okJson({ ok: true }));
      const p = ABC.api('/services');
      // Halfway through the 1s backoff the note must already be up.
      await jest.advanceTimersByTimeAsync(500);
      expect(appended).toHaveLength(1);
      const note = appended[0];
      expect(note.id).toBe('abcRetryNote');
      expect(note.textContent).toContain('আবার চেষ্টা করা হচ্ছে');
      expect(note.style.display).not.toBe('none');
      await jest.advanceTimersByTimeAsync(5000);
      const r = await p;
      expect(r.ok).toBe(true);
      expect(note.style.display).toBe('none');
    } finally { jest.useRealTimers(); }
  });
});
