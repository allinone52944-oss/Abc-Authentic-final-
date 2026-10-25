/**
 * AddressService — Address cascade operations
 *
 * Principles:
 * - Single entry point for all address queries
 * - Static data for division/district (fast)
 * - Engine for zone/ward (realtime from BDRIS)
 * - No frontend mirroring needed
 */

const { BdrisNavigator } = require('./BdrisNavigator');
const { HttpGeoService } = require('./HttpGeoService');

// 2026-10-25 geo cache: zone/ward তালিকা engine-এর live fetch থেকে
// আসা ফলই শুধু ক্যাশে থাকে (কখনো hardcoded/static নয় — সেই স্থায়ী
// নিয়ম অক্ষুণ্ণ), ২৪ ঘণ্টা মেয়াদ, in-memory মাত্র (engine restart-এ
// মুছে যায়, পরের fetch আবার live)। খালি ফল কখনো ক্যাশ হয় না —
// নইলে একবারের flaky খালি তালিকা ২৪ ঘণ্টা আটকে থাকত।
// Cache module-level, কারণ প্রতিটা GET_ADDRESS_OPTIONS-এ নতুন
// AddressService বানানো হয় — instance cache কোনো কাজে আসত না।
// Ward তালিকা public, ইউজার-নির্দিষ্ট নয়, তাই সব সেশন শেয়ার করা নিরাপদ।
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GEO_CACHE = new Map();
function geoCacheKey(level, parents = {}, form = 'birth') {
  const norm = (s) => BdrisNavigator.normalize(String(s || '')).trim();
  return [String(form), String(level), norm(parents.division), norm(parents.district), norm(parents.upazila), norm(parents.zone)].join('|');
}
function geoCacheGet(key) {
  const hit = GEO_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > GEO_CACHE_TTL_MS) { GEO_CACHE.delete(key); return null; }
  return hit.opts.slice();
}
function geoCacheSet(key, opts) {
  if (!Array.isArray(opts) || !opts.length) return;
  GEO_CACHE.set(key, { opts: opts.slice(), at: Date.now() });
}

/**
 * Race a promise against a budget. Never rejects: resolves
 * {timeout:true} on budget expiry, {ok:true,value} / {ok:false,error}
 * otherwise. The loser promise is settled (not left to reject
 * unhandled) by the .then() wrapping below.
 */
async function withBudget(promise, ms, label) {
  let timer = null;
  const settled = promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true, label }), ms);
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class AddressService {
  constructor(navigator, opts = {}) {
    this.navigator = navigator || null; // BdrisNavigator instance, or null for HTTP-only use
    this.staticCache = null;
    // Injectable for tests: opts.httpGeo (instance) or opts.httpGeoFactory.
    // Production default is a lazy HttpGeoService (no Playwright page).
    this.httpGeo = opts.httpGeo || null;
    this.httpGeoFactory = opts.httpGeoFactory || null;
    // PROVEN budget (2026-10-25, code arithmetic — not a live guess):
    // GET_ADDRESS_OPTIONS executor = 30000ms (server.js), frontend =
    // 40000ms. The HTTP fetch path has NO timeout of its own
    // (http/client.js request/bootstrap/getGeo), so a hung bootstrap
    // could eat the whole 30s and the Playwright fallback would never
    // even start. Bounding HTTP at 8000ms guarantees the fallback
    // still gets ~20s, and the trimmed Playwright worst case
    // (3 x (5000+500) + 3 x 1200 = 20100ms, BdrisNavigator) fits:
    // 8000 + 20100 = 28100 < 30000 < 40000. The budget only cuts a
    // slow/hung HTTP attempt; a healthy HTTP round (a few seconds)
    // is untouched, and a budget cut still tries Playwright after.
    this.httpTimeoutMs = opts.httpTimeoutMs || 8000;
  }

  async _getHttpGeo() {
    if (this.httpGeo) return this.httpGeo;
    if (this.httpGeoFactory) {
      this.httpGeo = await this.httpGeoFactory();
      return this.httpGeo;
    }
    this.httpGeo = new HttpGeoService();
    return this.httpGeo;
  }

  async loadStaticData() {
    if (this.staticCache) return this.staticCache;
    // Static BD geo data (divisions, districts, upazilas)
    // Loaded from bd-geo.json
    try {
      const fs = require('fs');
      const path = require('path');
      const geoPath = path.join(__dirname, '../../../frontend/bd-geo.json');
      const data = JSON.parse(fs.readFileSync(geoPath, 'utf8'));
      this.staticCache = data;
      return data;
    } catch (e) {
      return null;
    }
  }

  getStaticOptions(level, parents = {}) {
    if (!this.staticCache) return [];
    // Implementation depends on bd-geo.json structure
    // Returns [] if not available, caller falls back to engine
    try {
      const { divisions } = this.staticCache;
      if (level === 'division') {
        return Object.keys(divisions || {}).map(name => ({ id: name, name }));
      }
      if (level === 'district' && parents.division) {
        const div = divisions[parents.division];
        if (div && div.districts) {
          return Object.keys(div.districts).map(name => ({ id: name, name }));
        }
      }
      if (level === 'upazila' && parents.division && parents.district) {
        const div = divisions[parents.division];
        const dist = div?.districts?.[parents.district];
        if (dist && dist.upazilas) {
          return dist.upazilas.map(name => ({ id: name, name }));
        }
      }
    } catch (e) {
      // Fall through to engine
    }
    return [];
  }

  /**
   * Get options for an address level
   * - division/district/upazila: static first, engine fallback
   * - zone/ward: always engine (realtime from BDRIS, never hardcoded)
   */
  async getOptions(level, parents = {}, form = 'birth') {
    // Zone/ward MUST come from a live fetch (user requirement: realtime,
    // no hardcode) — cache holds only non-empty live results.
    // 2026-10-25 fix: HTTP geo FIRST, Playwright second, both inside
    // one budget: HTTP capped at httpTimeoutMs (default 8000ms) +
    // Playwright worst case 20100ms = 28100ms < executor 30000ms
    // (server.js) < frontend 40000ms. Before this, the Playwright
    // worst case alone was 3 x (10000+500) + 5 x 1200 = 37500ms and
    // HTTP had no timeout at all, so a slow site or hung fetch
    // guaranteed an executor TIMEOUT before the fallback could ever
    // return — that budget impossibility is proven from the code's
    // own timeout values, whatever the live site did on the day.
    // If HTTP fails (e.g. TSPD blocks a fetch bootstrap — unproven
    // live, NOT assumed here), Playwright is still tried. If BOTH
    // fail, this THROWS instead of returning [], so the frontend
    // can show an error and a retry instead of silently degrading
    // paurasavaUnion to a text input that can never unlock Ward.
    if (level === 'zone' || level === 'ward') {
      const key = geoCacheKey(level, parents, form);
      const cached = geoCacheGet(key);
      if (cached) return cached;
      let httpError = null;
      // HTTP runs under a budget (see constructor): without it, a
      // hung fetch could consume the whole 30s executor budget and
      // the Playwright fallback below would never start. On budget
      // expiry the fallback still runs; the timeout is recorded in
      // httpError so the composed error names it.
      try {
        const httpGeo = await this._getHttpGeo();
        const attempt = level === 'zone'
          ? httpGeo.getZoneOptions(parents, form)
          : httpGeo.getWardOptions(parents, form);
        const raced = await withBudget(attempt, this.httpTimeoutMs, 'HttpGeo');
        if (raced.timeout) {
          httpError = new Error(`HttpGeo: timed out after ${this.httpTimeoutMs}ms (HTTP budget; Playwright fallback running next)`);
        } else if (!raced.ok) {
          httpError = raced.error;
        } else if (Array.isArray(raced.value.options) && raced.value.options.length) {
          geoCacheSet(key, raced.value.options);
          return raced.value.options;
        } else {
          httpError = new Error('HttpGeo: empty result');
        }
      } catch (e) {
        httpError = e;
      }
      let pwError = null;
      if (this.navigator) {
        try {
          const opts = await this.navigator.getAddressOptions(level, parents, form);
          if (Array.isArray(opts) && opts.length) {
            geoCacheSet(key, opts);
            return opts;
          }
          pwError = new Error('Playwright: empty result');
        } catch (e) {
          pwError = e;
        }
      } else {
        pwError = new Error('Playwright: no navigator (HTTP-only mode)');
      }
      const err = new Error(
        `Zone/ward fetch failed (level=${level}): HTTP: ${httpError ? httpError.message : 'unknown'}; Playwright: ${pwError ? pwError.message : 'unknown'}`,
      );
      err.code = 'ZONE_WARD_FETCH_FAILED';
      err.httpError = httpError;
      err.playwrightError = pwError;
      throw err;
    }

    // Others: try static first
    await this.loadStaticData();
    const staticOpts = this.getStaticOptions(level, parents);
    if (staticOpts.length) return staticOpts;

    // Fallback to engine
    if (!this.navigator) throw new Error('AddressService: no navigator for non-zone/ward fallback');
    return await this.navigator.getAddressOptions(level, parents, form);
  }
}

function clearGeoCache() {
  GEO_CACHE.clear();
}

module.exports = { AddressService, clearGeoCache, geoCacheKey };
