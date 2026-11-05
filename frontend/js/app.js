/* ============================================================
   All In One (Abc Authentic) - App shell (Phase 1)
   - Token storage (memory + localStorage for refresh flow)
   - api() helper with auto access-token refresh
   - Draft persistence: form drafts survive refresh/logout
   ============================================================ */
(function () {
  'use strict';

  // Audit #77 — a JS error must never show its technical detail
  // (message + line number) to the user. The detail goes to the
  // console only; the user sees one friendly line plus a reload
  // button. (Before: the banner read "⚠️ পেজ ত্রুটি: <message>
  // (লাইন N)" on screen.)
  function showFatal(msg) {
    try {
      if (typeof console !== 'undefined' && console.error) console.error('[abc-fatal]', msg);
      let d = document.getElementById('abc-fatal');
      if (!d) {
        d = document.createElement('div');
        d.id = 'abc-fatal';
        d.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;background:#3a0d0d;color:#ffb4b4;border:1px solid #a33;padding:10px 12px;border-radius:8px;font-size:13px;white-space:pre-wrap;display:flex;gap:10px;align-items:center;';
        const s = document.createElement('span');
        s.id = 'abc-fatal-text';
        s.textContent = '⚠️ পেজে সমস্যা হয়েছে — রিফ্রেশ করুন।';
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = '🔄 রিফ্রেশ করুন';
        b.style.cssText = 'margin-left:auto;background:#fff;color:#3a0d0d;border:none;border-radius:6px;padding:6px 12px;font-size:13px;font-weight:bold;cursor:pointer;flex:none;';
        b.addEventListener('click', () => { try { location.reload(); } catch (e) {} });
        d.appendChild(s);
        d.appendChild(b);
        (document.body || document.documentElement).appendChild(d);
      }
    } catch (e) {}
  }
  window.addEventListener('error', function (ev) {
    showFatal((ev.message || 'অজানা ত্রুটি') + (ev.lineno ? ' (লাইন ' + ev.lineno + ')' : ''));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    showFatal('Promise ব্যর্থ: ' + (r && r.message ? r.message : String(r)));
  });

  // Audit #73 — one inline-message component for all customer pages.
  // alert() blocks the page and shows no reason or retry; showPageMsg
  // renders the same message as a dismissible banner at the top of the
  // page (textContent only — no HTML injection). Errors stay until
  // dismissed; ok/info auto-hide after 6s.
  let _pageMsgTimer = null;
  function showPageMsg(text, kind) {
    try {
      kind = (kind === 'ok' || kind === 'info') ? kind : 'err';
      let d = document.getElementById('abc-page-msg');
      if (!d) {
        d = document.createElement('div');
        d.id = 'abc-page-msg';
        d.setAttribute('role', 'status');
        const s = document.createElement('span');
        s.id = 'abc-page-msg-text';
        const x = document.createElement('button');
        x.type = 'button';
        x.setAttribute('aria-label', 'বন্ধ');
        x.textContent = '✕';
        x.style.cssText = 'margin-left:auto;background:transparent;border:none;font-size:16px;cursor:pointer;color:inherit;flex:none;padding:0 0 0 10px;';
        x.addEventListener('click', () => { d.remove(); });
        d.appendChild(s);
        d.appendChild(x);
        (document.body || document.documentElement).appendChild(d);
      }
      d.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;z-index:99998;display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:10px;font-size:14px;line-height:1.5;box-shadow:0 8px 30px rgba(0,0,0,.25);' + (
        kind === 'ok' ? 'background:#f0fdf4;border:1px solid #86efac;color:#166534;' :
        kind === 'info' ? 'background:#eff6ff;border:1px solid #93c5fd;color:#1e40af;' :
        'background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;');
      d.querySelector('#abc-page-msg-text').textContent = String(text || '');
      if (_pageMsgTimer) { clearTimeout(_pageMsgTimer); _pageMsgTimer = null; }
      if (kind !== 'err') _pageMsgTimer = setTimeout(() => { try { d.remove(); } catch (e) {} }, 6000);
    } catch (e) {}
  }

  // Bengali mapping for HTTP failures (download/upload/cancel).
  // Never shows a raw status or code — only the Bengali reason + retry.
  function httpErrBn(status, action) {
    const a = action || 'কাজটি';
    if (!status) return 'ইন্টারনেট সংযোগ নেই — সংযোগ ফিরলে আবার চেষ্টা করুন।';
    if (status === 404) return a + ' ব্যর্থ হয়েছে — ফাইলটি পাওয়া যায়নি।';
    if (status === 403) return a + ' ব্যর্থ হয়েছে — অনুমতি নেই।';
    if (status === 413) return 'ফাইলটি অনেক বড় — ১০ মেগাবাইটের কম ফাইল দিন।';
    if (status === 429) return 'অনেক রিকোয়েস্ট — একটু পরে আবার চেষ্টা করুন।';
    if (status >= 500) return a + ' ব্যর্থ হয়েছে — সার্ভারে সমস্যা হয়েছে, আবার চেষ্টা করুন।';
    return a + ' ব্যর্থ হয়েছে — আবার চেষ্টা করুন।';
  }

  // Bengali mapping for API error codes. A server Bengali message
  // (d.message) wins; a known code maps; anything else gets the
  // generic Bengali fallback — a raw code never reaches the user.
  const API_ERR_BN = {
    ALREADY_REDEEMED_TODAY: 'আজকের ক্যাশব্যাক ইতোমধ্যে সংগ্রহ করা হয়েছে।',
    ALREADY_REDEEMED: 'কুপনটি ইতোমধ্যে রিডিম করা হয়েছে।',
    INVALID_CODE: 'কুপন কোডটি সঠিক নয় — আবার দেখে বসান।',
    EXPIRED_CODE: 'কুপন কোডটির মেয়াদ শেষ হয়ে গেছে।',
    NOT_YOUR_CODE: 'এই কুপন কোডটি আপনার নয়।',
    INSUFFICIENT_BALANCE: 'ব্যালেন্স অপর্যাপ্ত — রিচার্জ করুন।',
    CHARGE_FAILED: 'চার্জ ব্যর্থ হয়েছে — আবার চেষ্টা করুন।',
    PRICE_FETCH_FAILED: 'সেবার ফি আনা যায়নি — আবার চেষ্টা করুন।',
    SERVICE_NOT_FOUND: 'সেবাটি পাওয়া যায়নি।',
    NOT_FOUND: 'পাওয়া যায়নি।',
    NO_ACCESS: 'এই কাজের অনুমতি নেই।',
    NETWORK_ERROR: 'ইন্টারনেট সংযোগ নেই — সংযোগ ফিরলে আবার চেষ্টা করুন।',
    RATE_LIMITED: 'অনেক রিকোয়েস্ট — একটু পরে আবার চেষ্টা করুন।',
    FAILED: 'ব্যর্থ হয়েছে — আবার চেষ্টা করুন।',
    ORDER_FAILED: 'অর্ডার তৈরি হয়নি — আবার চেষ্টা করুন।',
  };
  function apiErrBn(d, fallback) {
    d = d || {};
    if (d.message) return String(d.message);
    if (d.error && API_ERR_BN[d.error]) return API_ERR_BN[d.error];
    return fallback || 'ব্যর্থ হয়েছে — আবার চেষ্টা করুন।';
  }

  const LS_ACCESS = 'abc_access_token';
  const LS_REFRESH = 'abc_refresh_token';

  // Access token kept in memory primarily; mirrored to sessionStorage
  // so a page refresh does not force re-login within its lifetime.
  let accessToken = null;
  try {
    accessToken = sessionStorage.getItem(LS_ACCESS) || null;
  } catch (e) {}

  function setTokens(access, refresh) {
    accessToken = access;
    try {
      if (access) sessionStorage.setItem(LS_ACCESS, access);
      else sessionStorage.removeItem(LS_ACCESS);
    } catch (e) {}
    try {
      if (refresh) localStorage.setItem(LS_REFRESH, refresh);
    } catch (e) {}
  }

  function clearTokens() {
    accessToken = null;
    try {
      sessionStorage.removeItem(LS_ACCESS);
      localStorage.removeItem(LS_REFRESH);
    } catch (e) {}
  }

  async function refreshAccess() {
    let rt = null;
    try {
      rt = localStorage.getItem(LS_REFRESH);
    } catch (e) {}
    if (!rt) return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let r;
      try {
        r = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: rt }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      // Only clear tokens on 401 (invalid/expired refresh token).
      // On 429/5xx, the token may still be valid — don't log the user out.
      if (r.status === 401) { clearTokens(); return false; }
      if (!r.ok) return false;
      const d = await r.json().catch(() => null);
      if (!d || !d.access_token) return false;
      setTokens(d.access_token, d.refresh_token || rt);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Deduplicate concurrent token refreshes (race condition fix)
  let _refreshPromise = null;
  function refreshAccessDedup() {
    if (_refreshPromise) return _refreshPromise;
    _refreshPromise = refreshAccess().finally(() => { _refreshPromise = null; });
    return _refreshPromise;
  }

  async function api(path, opts, _retry) {
    if (typeof path !== 'string' || !path) {
      throw new TypeError('api(path): path must be a non-empty string');
    }
    _retry = _retry || 0;
    // Clone opts to avoid mutating caller's object (signal/body)
    opts = Object.assign({}, opts || {});
    opts.headers = Object.assign({}, opts.headers || {});
    if (accessToken) opts.headers['Authorization'] = 'Bearer ' + accessToken;

    // Realm-safe body detection. instanceof alone can fail when the body was
    // created in another frame/realm (or the global is wrapped), which let a
    // FormData fall through to JSON.stringify() below — silently turning a
    // file upload into "{}" and dropping the file (nid extract NO_FILE bug).
    const _body = opts.body;
    const isBinaryOrForm = !!_body && (
      (typeof FormData !== 'undefined' && _body instanceof FormData) ||
      (typeof Blob !== 'undefined' && _body instanceof Blob) ||
      (typeof ArrayBuffer !== 'undefined' && (_body instanceof ArrayBuffer || ArrayBuffer.isView(_body))) ||
      (typeof URLSearchParams !== 'undefined' && _body instanceof URLSearchParams) ||
      // Duck-type fallback: anything with the FormData interface is a form.
      (typeof _body.append === 'function' && typeof _body.get === 'function' && typeof _body.getAll === 'function')
    );
    // JSON-encode exactly what the old code did — any non-form object body —
    // so the ONLY behavior change is that a form body is now always detected.
    if (_body && typeof _body === 'object' && !isBinaryOrForm) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(_body);
    }
    // Timeout: don't hang forever on flaky network (tunnel)
    // Default 15s, but allow override via opts.timeout (e.g., PDF generation needs 60s)
    const timeoutMs = opts.timeout || 15000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    delete opts.timeout;
    opts.signal = ctrl.signal;
    let r;
    try {
      r = await fetch('/api' + path, opts);
    } catch (e) {
      clearTimeout(timer);
      // Network failure/timeout → retry with backoff (tunnel flakiness),
      // then synthetic 503 so callers handle uniformly
      if (_retry < 2) {
        await new Promise(function (res) { setTimeout(res, 1000 * (_retry + 1)); });
        return api(path, opts, _retry + 1);
      }
      return new Response(JSON.stringify({ error: 'NETWORK_ERROR' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    clearTimeout(timer);
    // Retry on 503/504 (transient server/tunnel issues), not on 4xx.
    // Callers may pass skip503Retry when a 503 is deterministic for
    // them (e.g. QR verify's GATEWAY_NOT_CONFIGURED) so the user
    // is not made to wait through two pointless retries.
    if ((r.status === 503 || r.status === 504) && _retry < 2 && !opts.skip503Retry) {
      await new Promise(function (res) { setTimeout(res, 1000 * (_retry + 1)); });
      return api(path, opts, _retry + 1);
    }
    // 401 recovery: try one silent refresh (deduplicated), then
    // retry. This must ALSO run when this tab has no access token
    // at all (fresh tab/window — sessionStorage is per-tab) but a
    // refresh token survives in localStorage; without it, opening
    // any page in a new tab bounced straight to the login screen
    // even though the user was still logged in (2026-10-23).
    let _storedRefresh = null;
    try { _storedRefresh = localStorage.getItem(LS_REFRESH); } catch (e) {}
    if (r.status === 401 && (accessToken || _storedRefresh)) {
      let refreshed = false;
      try { refreshed = await refreshAccessDedup(); } catch (e) { refreshed = false; }
      if (refreshed) {
        opts.headers['Authorization'] = 'Bearer ' + accessToken;
        const ctrl2 = new AbortController();
        const timer2 = setTimeout(() => ctrl2.abort(), 20000);
        opts.signal = ctrl2.signal;
        try {
          r = await fetch('/api' + path, opts);
        } catch (e) {
          return new Response(JSON.stringify({ error: 'NETWORK_ERROR' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        } finally {
          clearTimeout(timer2);
        }
      } else {
        // Refresh failed - clear stale tokens
        clearTokens();
      }
    }
    return r;
  }

  // ---- Draft persistence (survives refresh AND logout) ----
  const Drafts = {
    get(key) { return this.load(key); },
    save(key, obj) {
      try { localStorage.setItem('abc_draft_' + key, JSON.stringify(obj)); } catch (e) {}
    },
    load(key) {
      try {
        const v = localStorage.getItem('abc_draft_' + key);
        return v ? JSON.parse(v) : null;
      } catch (e) { return null; }
    },
    clear(key) {
      try { localStorage.removeItem('abc_draft_' + key); } catch (e) {}
    },
  };

  // ---- Idempotency helper (dedupes duplicate order submits) ----
  const Idempotency = {
    getOrCreate(key) {
      try {
        const stored = sessionStorage.getItem('abc_idem_' + key);
        if (stored) return stored;
        const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : 'idem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem('abc_idem_' + key, id);
        return id;
      } catch (_) {
        return 'idem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      }
    },
    clear(key) {
      try { sessionStorage.removeItem('abc_idem_' + key); } catch (_) {}
    },
  };

  window.ABC = { api, setTokens, clearTokens, refreshAccess, Drafts, Idempotency, getAccessToken: () => accessToken, showPageMsg, httpErrBn, apiErrBn };

  // ---- PWA: service worker (v6, push-only, no caching) ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  let deferredPrompt = null;
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone && !localStorage.getItem('abc_install_dismissed')) showInstallBanner();
  });

  function showInstallBanner() {
    if (document.getElementById('abc-install-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'abc-install-banner';
    bar.innerHTML =
      '<span>📱 <b>Abc Authentic</b> অ্যাপটি ইনস্টল করুন — হোম স্ক্রিনে যোগ করুন</span>' +
      '<button id="abc-install-go">ইনস্টল</button>' +
      '<button id="abc-install-x" aria-label="বন্ধ">✕</button>';
    const css = document.createElement('style');
    css.textContent =
      '#abc-install-banner{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;' +
      'display:flex;align-items:center;gap:10px;background:#2b1d14;border:1px solid #d4af37;' +
      'border-radius:14px;padding:12px 14px;color:#f5e6c8;font-size:14px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.5);animation:abcSlideUp .4s ease;}' +
      '#abc-install-banner button{border:none;border-radius:10px;padding:10px 16px;font-weight:bold;cursor:pointer;}' +
      '#abc-install-go{background:linear-gradient(135deg,#d4af37,#b8941f);color:#2b1d14;white-space:nowrap;}' +
      '#abc-install-x{background:transparent;color:#c9a961;font-size:16px;padding:8px 10px;}' +
      '@keyframes abcSlideUp{from{transform:translateY(120%);opacity:0;}to{transform:none;opacity:1;}}';
    document.head.appendChild(css);
    document.body.appendChild(bar);
    document.getElementById('abc-install-go').addEventListener('click', async () => {
      bar.remove();
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => {});
      deferredPrompt = null;
    });
    document.getElementById('abc-install-x').addEventListener('click', () => {
      bar.remove();
      try { localStorage.setItem('abc_install_dismissed', '1'); } catch (e) {}
    });
  }

  window.ABC.showInstallBanner = showInstallBanner;

  // a11y: keyboard activation for mobile tabbar tabs (divs with click handlers)
  document.addEventListener('keydown', function (ev) {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target && ev.target.classList &&
        ev.target.classList.contains('m-tab') && !ev.target.classList.contains('on')) {
      ev.preventDefault();
      ev.target.click();
    }
  });
})();
