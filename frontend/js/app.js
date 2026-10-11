/* ============================================================
   All In One (Abc Authentic) - App shell (Phase 1)
   - Token storage (memory + localStorage for refresh flow)
   - api() helper with auto access-token refresh
   - Draft persistence: form drafts survive refresh/logout
   ============================================================ */
(function () {
  'use strict';

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
      const r = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!r.ok) { clearTokens(); return false; }
      const d = await r.json();
      setTokens(d.access_token, d.refresh_token || rt);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers || {});
    if (accessToken) opts.headers['Authorization'] = 'Bearer ' + accessToken;
    if (opts.body && typeof opts.body === 'object') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    let r = await fetch('/api' + path, opts);
    if (r.status === 401 && accessToken) {
      // Try one silent refresh, then retry
      if (await refreshAccess()) {
        opts.headers['Authorization'] = 'Bearer ' + accessToken;
        r = await fetch('/api' + path, opts);
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
})();
