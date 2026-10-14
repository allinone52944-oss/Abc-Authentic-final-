/* ============================================================
   All In One (Abc Authentic) - App shell (Phase 1)
   - Token storage (memory + localStorage for refresh flow)
   - api() helper with auto access-token refresh
   - Draft persistence: form drafts survive refresh/logout
   ============================================================ */
(function () {
  'use strict';

  // Visible JS error reporter: if any script throws on load/refresh, show it
  // on the page so the cause is visible without DevTools.
  function showFatal(msg) {
    try {
      let d = document.getElementById('abc-fatal');
      if (!d) {
        d = document.createElement('div');
        d.id = 'abc-fatal';
        d.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;background:#3a0d0d;color:#ffb4b4;border:1px solid #a33;padding:10px 12px;border-radius:8px;font-size:13px;white-space:pre-wrap;';
        (document.body || document.documentElement).appendChild(d);
      }
      d.textContent = '⚠️ পেজ ত্রুটি: ' + msg;
    } catch (e) {}
  }
  window.addEventListener('error', function (ev) {
    showFatal((ev.message || 'অজানা ত্রুটি') + (ev.lineno ? ' (লাইন ' + ev.lineno + ')' : ''));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    showFatal('Promise ব্যর্থ: ' + (r && r.message ? r.message : String(r)));
  });

  const LS_ACCESS = 'abc_access_token';
  const LS_REFRESH = 'abc_refresh_token';

  // Access token kept in memory primarily; mirrored to sessionStorage
  // so a page refresh does not force re-login within its lifetime.
  let accessToken = sessionStorage.getItem(LS_ACCESS) || null;

  function setTokens(access, refresh) {
    accessToken = access;
    if (access) sessionStorage.setItem(LS_ACCESS, access);
    else sessionStorage.removeItem(LS_ACCESS);
    if (refresh) localStorage.setItem(LS_REFRESH, refresh);
  }

  function clearTokens() {
    accessToken = null;
    sessionStorage.removeItem(LS_ACCESS);
    localStorage.removeItem(LS_REFRESH);
  }

  async function refreshAccess() {
    const rt = localStorage.getItem(LS_REFRESH);
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
    if (opts.body && typeof opts.body === 'object') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
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
    // Retry on 503/504 (transient server/tunnel issues), not on 4xx
    if ((r.status === 503 || r.status === 504) && _retry < 2) {
      await new Promise(function (res) { setTimeout(res, 1000 * (_retry + 1)); });
      return api(path, opts, _retry + 1);
    }
    if (r.status === 401 && accessToken) {
      // Try one silent refresh (deduplicated), then retry
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
      localStorage.removeItem('abc_draft_' + key);
    },
  };

  window.ABC = { api, setTokens, clearTokens, refreshAccess, Drafts };

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
})();
