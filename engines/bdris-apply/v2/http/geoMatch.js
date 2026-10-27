/**
 * Shared Bengali geo-name matcher — the ONE matcher for every HTTP
 * geo lookup, working path and probe chain alike.
 *
 * Why shared (2026-10-27, live-proven): the Stage A probe's
 * walkGeoChain matched by STRICT nameBn equality and failed live
 * at step 1 — no entry strictly equal to "চট্টগ্রাম" under parent
 * 1 — while the working path's walkToUpazila calls the SAME
 * endpoint and succeeds, because it matches loosely. Two matchers
 * had drifted apart; the probe inherited the strict one. From now
 * on both paths use findGeoEntry below, so a name the working path
 * can match can never fail the probe chain on matching alone.
 *
 * Order matters (do not reorder without a live reason):
 *  1. exact normalized equality
 *  2. substring-includes either way (covers "চট্টগ্রাম বিভাগ")
 *  3. loose equality/includes after stripping dots, dashes,
 *     commas, danda and spaces (covers "P.M. Khali" vs "PMKhali")
 *
 * Node built-ins only. No network, no state.
 */

'use strict';

function normalizeBn(text) {
  return String(text || '')
    .replace(/[\u09DC]/g, '\u09A1\u09BC')
    .replace(/[\u09DD]/g, '\u09A2\u09BC')
    .replace(/[\u09DF]/g, '\u09AF\u09BC')
    .replace(/[\u0981\u200C\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findGeoEntry(entries, name) {
  const want = normalizeBn(name);
  if (!want) return null;
  const loose = (t) => normalizeBn(t).replace(/[\.\-\u2010-\u2015,\u0964]/g, '').replace(/\s+/g, '');
  const wantLoose = loose(name);
  return entries.find((e) => normalizeBn(e.nameBn) === want)
    || entries.find((e) => {
      const n = normalizeBn(e.nameBn);
      return n && (n.includes(want) || want.includes(n));
    })
    // Same live-proven dot/space spelling variant as the Playwright
    // path: "P.M. Khali" vs "PMKhali" must match here too, or the
    // HTTP ward fetch fails even when the zone list is present.
    || entries.find((e) => {
      const n = loose(e.nameBn);
      return n && wantLoose && (n === wantLoose || n.includes(wantLoose) || wantLoose.includes(n));
    })
    || null;
}

module.exports = { normalizeBn, findGeoEntry };
