/**
 * HttpGeoService — zone/ward lists over the BDRIS HTTP geo API.
 * Since 2026-10-26 the geo client is seeded from a warm Playwright
 * page (seedFromPage): a bare fetch bootstrap is proven blocked
 * with 403, so it is never attempted from AddressService anymore.
 *
 * Why this exists (2026-10-25, production HEAD 424f355):
 * The birthplace form degraded paurasavaUnion to a text input and
 * left Ward empty for Dhaka South City Corporation, and reselecting
 * did not help. The Playwright path for zone/ward is:
 *   frontend fetchAddrOpts 25s timeout
 *   < backend executor 30s timeout
 *   < navigator worst case: 3 parents x (10s waitForOptions + 0.5s)
 *     + 5 x 1.2s target retries = 37.5s
 * so a slow site AJAX guarantees the frontend gives up first, and
 * every backend failure (timeout, parent-not-found, session) was
 * collapsed to [] by the socket handler + frontend Array.isArray
 * check, then silently degraded to text — a text zone can never
 * unlock Ward. The HTTP geo API is direct JSON (bootstrap + a
 * handful of GETs, no page render, no 10s waits), so it fits the
 * frontend timeout in the normal case. It is NOT live-proven yet:
 * TSPD/bot protection may still block a fetch-based bootstrap, so
 * every failure here must fall back to the Playwright path in
 * AddressService, never be hidden and never be cached when empty.
 *
 * Proven API facts used here (pasted form source + DESIGN.md):
 *  - first parent bangladeshId = "1", first order = 1, type 1 = division
 *  - follow response targetGeoOrder, never order+1
 *  - cityCorp zone call (PROVEN 2026-10-26 by the user-supplied live
 *    request URL): parent=cityCorp id, order 3, type 8, ward=true —
 *    e.g. /5689?ward=true&geoGroup=birthPlace&geoOrder=3&geoType=8
 *    returns the 10 zones (geoLevelId 6) with targetGeoOrder 5.
 *    The old call used type 6 here and was wrong; order 3 and
 *    ward=true were already correct.
 *  - upazila: order 3, type 3; its next level is paurasava (type 4)
 *    and union (type 5) — both are merged for the paurasavaUnion
 *    field, because that field holds both kinds
 *  - ward under a zone (cityCorp branch): the mock-verified pattern
 *    is parent=zoneId, order 5, type 6, ward=true; a second attempt
 *    uses the zone list's own targetGeoOrder with type 13
 *    (paurasavaUnionWard) before giving up to Playwright
 *  - names are matched on nameBn, with the same Bengali normaliser
 *    as BdrisNavigator (decomposed characters, ZWJ/ZWNJ, spaces)
 *  - NEVER hardcoded zone/ward data; NEVER cache an empty result
 *    (the client's GeoCache already refuses empty, and this module
 *    throws on empty instead of returning [])
 */

'use strict';

const { BdrisHttpClient } = require('../http/client');

const GEO_GROUP_BY_FORM = {
  birth: 'birthPlace',
  perm: 'permAddr',
  prsnt: 'prsntAddr',
};

function normalizeBn(text) {
  return String(text || '')
    .replace(/[\u09DC]/g, '\u09A1\u09BC')
    .replace(/[\u09DD]/g, '\u09A2\u09BC')
    .replace(/[\u09DF]/g, '\u09AF\u09BC')
    .replace(/[\u0981\u200C\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findByName(entries, name) {
  const want = normalizeBn(name);
  if (!want) return null;
  return entries.find((e) => normalizeBn(e.nameBn) === want)
    || entries.find((e) => {
      const n = normalizeBn(e.nameBn);
      return n && (n.includes(want) || want.includes(n));
    })
    || null;
}

function toOptions(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries || []) {
    const name = String(e.nameBn || e.nameEn || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ id: e.id, name });
  }
  return out;
}

class HttpGeoService {
  constructor(opts = {}) {
    this.client = opts.client || null;
    this.clientFactory = opts.clientFactory || null;
    this.base = opts.base || 'https://bdris.gov.bd';
    this._bootstrapPromise = null;
    this.lastSeedError = null;
  }

  async _getClient() {
    if (this.client) return this.client;
    if (this.clientFactory) {
      this.client = await this.clientFactory();
      return this.client;
    }
    this.client = new BdrisHttpClient({ base: this.base });
    return this.client;
  }

  /**
   * Seed the geo client from a warm Playwright page (its cookies +
   * page CSRF) instead of a standalone fetch bootstrap.
   * Returns true when the client is ready for geo calls, false
   * otherwise (lastSeedError names why). A false result means the
   * caller must NOT fall back to a bare fetch bootstrap — the live
   * banner of 2026-10-26 proved a bare fetch form-GET is blocked
   * with 403, so a bare bootstrap cannot succeed. An already
   * bootstrapped client (tests, or a previous seed) needs no page.
   *
   * CSRF sources, in the form's own util.js order (proven from the
   * pasted form source, 2026-10-25): (1) meta _csrf /
   * _csrf_headerName, (2) the inline `csrf` variable with header
   * X-CSRF-TOKEN, (3) the hidden input[name="_csrf"] field (the
   * form's own submit field). The previous code read ONLY (1), so
   * the live banner of 2026-10-26 read "Browser page has no meta
   * _csrf token" on a warm page that carries its token inline —
   * seeding never reached the geo call at all. This method does
   * NOT navigate: if the page is not the form page, it fails with
   * a page-state error naming the actual page URL, and navigation
   * is left to the Playwright path (BdrisNavigator.ensureFormPage),
   * which owns page movement and must not hijack a mid-flow page
   * from inside a seed attempt.
   */
  async seedFromPage(page) {
    const client = await this._getClient();
    if (client.bootstrapped) return true;
    if (typeof client.seedFromBrowser !== 'function') {
      this.lastSeedError = new Error('HttpGeo: client cannot be seeded from a browser session');
      return false;
    }
    if (!page) {
      this.lastSeedError = new Error('HttpGeo: no warm Playwright session to seed from (bare fetch proven 403, not attempted)');
      return false;
    }
    try {
      const ctx = typeof page.context === 'function' ? page.context() : (page._context || null);
      const cookies = ctx && typeof ctx.cookies === 'function' ? await ctx.cookies() : [];
      const extracted = typeof page.evaluate === 'function'
        ? await page.evaluate(() => {
          const meta = document.querySelector('meta[name="_csrf"]');
          const metaHeader = document.querySelector('meta[name="_csrf_headerName"]');
          let token = (meta && meta.content) || null;
          let headerName = (metaHeader && metaHeader.content) || null;
          let source = token ? 'meta' : null;
          if (!token) {
            // Inline `csrf` (util.js fallback, header X-CSRF-TOKEN).
            // A top-level `const csrf` is not a window property, so
            // try the identifier itself as well as window.csrf.
            let inline = null;
            try { inline = (typeof window !== 'undefined' && window.csrf) || null; } catch (e) { /* next */ }
            if (!inline) {
              try { inline = (typeof csrf !== 'undefined') ? csrf : null; } catch (e) { /* next */ }
            }
            if (inline && typeof inline === 'object') inline = inline.token || inline.value || null;
            if (typeof inline === 'string' && inline) {
              token = inline; headerName = 'X-CSRF-TOKEN'; source = 'inline';
            }
          }
          if (!token) {
            const hidden = document.querySelector('input[name="_csrf"]');
            if (hidden && hidden.value) {
              token = hidden.value; headerName = headerName || 'X-CSRF-TOKEN'; source = 'hidden';
            }
          }
          let pageUrl = null;
          try { pageUrl = location.href; } catch (e) { /* unknown */ }
          return { token, headerName, source, pageUrl };
        })
        : {};
      // Older test doubles return only {token, headerName}; accept them.
      const token = extracted.token || null;
      const headerName = extracted.headerName || (token ? 'X-CSRF-TOKEN' : null);
      let pageUrl = extracted.pageUrl || null;
      if (!pageUrl && typeof page.url === 'function') {
        try { pageUrl = page.url(); } catch (e) { /* unknown */ }
      }
      if (!token) {
        this.lastSeedError = new Error(
          `HttpGeo: Browser page has no CSRF token (meta _csrf: no, inline csrf: no, hidden _csrf field: no) on page ${pageUrl || 'unknown'}; cannot build API headers.`,
        );
        return false;
      }
      client.seedFromBrowser({ cookies, csrfToken: token, csrfHeaderName: headerName });
      this.lastSeedError = null;
      return true;
    } catch (e) {
      this.lastSeedError = e;
      return false;
    }
  }

  async ensureBootstrapped() {
    const client = await this._getClient();
    if (client.bootstrapped) return client;
    if (!this._bootstrapPromise) {
      this._bootstrapPromise = (async () => {
        await client.bootstrap();
        return client;
      })().catch((e) => {
        this._bootstrapPromise = null;
        // A failed bootstrap must not poison later calls: drop the
        // client so the next call builds a fresh session+token.
        this.client = null;
        throw e;
      });
    }
    return this._bootstrapPromise;
  }

  geoGroupFor(form) {
    return GEO_GROUP_BY_FORM[form] || 'birthPlace';
  }

  /**
   * Walk division -> district -> upazila/cityCorp by nameBn.
   * Returns {upazilaEntry, upazilaTargetOrder, isCityCorp}.
   * Throws GEO_NOT_FOUND / GEO_EMPTY with a clear reason — never [].
   */
  async walkToUpazila(parents, form) {
    const client = await this.ensureBootstrapped();
    const geoGroup = this.geoGroupFor(form);
    const divisionName = parents.division || '';
    const districtName = parents.district || '';
    const upazilaName = parents.upazila || '';
    if (!divisionName || !districtName || !upazilaName) {
      const e = new Error('HttpGeo: division, district and upazila names are all required');
      e.code = 'GEO_PARENTS_MISSING';
      throw e;
    }
    const divRes = await client.getGeo('1', 1, 1, { geoGroup });
    if (!divRes.entries.length) throw Object.assign(new Error('HttpGeo: division list is empty'), { code: 'GEO_EMPTY' });
    const division = findByName(divRes.entries, divisionName);
    if (!division) throw Object.assign(new Error(`HttpGeo: division not found: ${divisionName}`), { code: 'GEO_NOT_FOUND' });
    const distRes = await client.getGeo(division.id, divRes.targetGeoOrder, 2, { geoGroup });
    if (!distRes.entries.length) throw Object.assign(new Error('HttpGeo: district list is empty'), { code: 'GEO_EMPTY' });
    const district = findByName(distRes.entries, districtName);
    if (!district) throw Object.assign(new Error(`HttpGeo: district not found: ${districtName}`), { code: 'GEO_NOT_FOUND' });
    // City corp first (the reported failure), then upazila, then cantonment.
    for (const geoType of [8, 3, 7]) {
      const res = await client.getGeo(district.id, distRes.targetGeoOrder, geoType, { geoGroup });
      const entry = findByName(res.entries, upazilaName);
      if (entry) {
        return { upazilaEntry: entry, upazilaTargetOrder: res.targetGeoOrder, isCityCorp: geoType === 8 };
      }
    }
    throw Object.assign(new Error(`HttpGeo: upazila/city-corp not found: ${upazilaName}`), { code: 'GEO_NOT_FOUND' });
  }

  async getZoneOptions(parents, form = 'birth') {
    const client = await this.ensureBootstrapped();
    const geoGroup = this.geoGroupFor(form);
    const { upazilaEntry, upazilaTargetOrder, isCityCorp } = await this.walkToUpazila(parents, form);
    let entries = [];
    let zoneTargetOrder = null;
    if (isCityCorp) {
      // Proven live URL (2026-10-26): /5689?ward=true&geoGroup=birthPlace
      // &geoOrder=3&geoType=8 — the zone call uses the PARENT cityCorp
      // type 8, not the child zone type 6. Order (upazilaTargetOrder = 3)
      // and ward=true were already correct.
      const res = await client.getGeo(upazilaEntry.id, upazilaTargetOrder, 8, { ward: true, geoGroup });
      entries = res.entries;
      zoneTargetOrder = res.targetGeoOrder;
    } else {
      // Paurasava (4) + union (5) merged: the paurasavaUnion field
      // holds both kinds under one upazila.
      const merged = [];
      for (const geoType of [4, 5]) {
        const res = await client.getGeo(upazilaEntry.id, upazilaTargetOrder, geoType, { geoGroup });
        if (zoneTargetOrder === null) zoneTargetOrder = res.targetGeoOrder;
        merged.push(...res.entries);
      }
      entries = merged;
    }
    const options = toOptions(entries);
    if (!options.length) {
      throw Object.assign(new Error('HttpGeo: zone list is empty'), { code: 'GEO_EMPTY' });
    }
    return { options, zoneTargetOrder, upazilaEntry, isCityCorp };
  }

  async getWardOptions(parents, form = 'birth') {
    const client = await this.ensureBootstrapped();
    const geoGroup = this.geoGroupFor(form);
    const zoneName = parents.zone || '';
    if (!zoneName) {
      const e = new Error('HttpGeo: zone name is required for ward');
      e.code = 'GEO_PARENTS_MISSING';
      throw e;
    }
    const { options: zoneOptions, zoneTargetOrder, isCityCorp } = await this.getZoneOptions(parents, form);
    const zoneEntry = zoneOptions.find((o) => normalizeBn(o.name) === normalizeBn(zoneName))
      || zoneOptions.find((o) => {
        const n = normalizeBn(o.name);
        const w = normalizeBn(zoneName);
        return n && (n.includes(w) || w.includes(n));
      });
    if (!zoneEntry) {
      throw Object.assign(new Error(`HttpGeo: zone not found: ${zoneName}`), { code: 'GEO_NOT_FOUND' });
    }
    // CityCorp branch, mock-verified pattern first: parent=zone,
    // order 5, type 6, ward=true. Then the zone list's own target
    // order with type 13. First non-empty list wins; empty is never
    // returned as a success.
    const attempts = [];
    if (isCityCorp) attempts.push([5, 6, true]);
    if (zoneTargetOrder) attempts.push([zoneTargetOrder, 13, false]);
    if (isCityCorp) attempts.push([zoneTargetOrder || 5, 6, true]);
    attempts.push([7, 13, false]);
    const seenAttempts = new Set();
    for (const [order, geoType, ward] of attempts) {
      const key = `${order}|${geoType}|${ward}`;
      if (seenAttempts.has(key)) continue;
      seenAttempts.add(key);
      const res = await client.getGeo(zoneEntry.id, order, geoType, { ward, geoGroup });
      const options = toOptions(res.entries);
      if (options.length) return { options };
    }
    throw Object.assign(new Error('HttpGeo: ward list is empty'), { code: 'GEO_EMPTY' });
  }
}

module.exports = { HttpGeoService, normalizeBn, GEO_GROUP_BY_FORM };
