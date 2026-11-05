// ============================================================
// Land mouza-value LOOKUP data — PROOF + BATCH 1.
// Boalkhali (proof) + 5 Chattogram offices (batch 1), all
// 2025-2026. Rates are per SHATANGSHO, transcribed from the
// office schedule scans. No portal is called and no endpoint
// is guessed: this file is the schedule data itself, entered
// once and read back.
//
// Mapping rule (strict): the engine's class list is নাল, বাড়ী,
// ভিটা, বাগান, পুকুর, ডোবা, বাণিজ্যিক. ONLY exact-name matches
// are lookup classes. Columns that do not match an engine class
// (খাল, দোকান, পতিত, বিলা, বাঁশঝাড়, পথ, টিলা/পাহাড়,
// ফলবাগান, গার্ডেন, বিবিধ) are stored under `otherColumns`
// for reference ONLY — lookupMouzaRate never returns them, and
// দোকান is NEVER mapped to বাণিজ্যিক. বাণিজ্যিক therefore has
// no lookup rate anywhere. A class with no rate in the source
// (X / — / blank / n/a, or a column the office table lacks)
// is ABSENT from `rates` — never 0 — so lookup returns
// found:false for it while sibling classes still work.
//
// P flag: the schedule footnote marks P rows as "no sale deed
// registered, so the previous value remains in force". The P
// number IS the applicable rate; `p: true` only carries the
// note so the UI can show it.
//
// Batch-1 specifics (all machine-transcribed from
// rates-chattogram-batch1.md, 0-mismatch verified):
// - THANA QUALIFIER (Chandgaon only): one file holds 3 thanas
//   and বাকলিয়া / চান্দগাঁও / চর মোহরা appear in several with
//   different rates, so those names carry `variants` (one per
//   thana) instead of a single entry. A lookup without thana
//   that matches several variants is AMBIGUOUS (see below),
//   never merged. Unambiguous names are plain entries.
// - `jl` is stored where the schedule gives one (Chandgaon,
//   Pahartali); elsewhere it is absent, never invented.
// - SANDWIP POURO: the পুকুর rate is the gram value; where the
//   schedule also prints a pouro value it is kept as
//   `pouroPukur` and surfaced as a note, never substituted.
// - Gachbaria "বাড়ীভিটি" is a joint reference class and is
//   NOT entered as বাড়ী or ভিটা. Rangunia has no বাড়ী column
//   (ভিটা is never passed off as বাড়ী). Pahartali plot rows
//   are not mouzas and are NOT entered.
// ============================================================

// ---- Batch 2 (Chattogram district remaining, 2025-2026): machine-transcribed
// from rates-chattogram-batch2.md (862 mouza rows, 4254 class-rates, verified
// 0-mismatch against reader JSON). 11 office entries cover the district's 15
// remaining checklist entries: mirsharai-jorarganj, fatikchhari and
// hathazari-fateyabad are COMBINED schedules (one document, no per-row office
// split printed), so each covers several checklist entries.
// - COLLISION RULE (extends the Chandgaon thana rule): thana-distinguished
//   names -> variants[]; a printed qualifier under the name (Sadar Shikalbaha
//   "borof" notes) -> name suffix, plain entries (Sandwip (chor)/(bak)
//   precedent); JL-only collisions (Patiya, Raozan) -> "(JL <printed>)" suffix;
//   kromik-only collision (Sitakunda Latifpur, no JL/thana) -> "(krom <n>)" suffix.
// - Sadar period caveat: no Sadar page prints an end date, only "effective from
//   1 Jan 2025"; included as 2025-2026 because its Nov 2024 approval and the
//   01/01/2023-31/10/2024 deed basis match the other schedules' cycle exactly.
// - Sadar geo upazila is Kotowali (office location); the office covers 5 thanas.
// - "Vita/bastu vita" (Adhunagar, Satkania) maps to vita ONLY (Rangunia
//   precedent: vita is never passed off as bari). Text cells (e.g. Satkania
//   "chhonkhola 2277" in doba) stay no-rate, never converted.
// - Zero-engine-rate rows (6) stay as entries with rates:{} (in the table, but
//   no lookup rate) rather than being dropped or reported as not-in-table.
// Audit #64 — the 16MB OFFICES table used to live in this file, so
// every backend start parsed all 488 offices (~1s, 16MB) even though
// a request touches one office. The table is now split by office
// into rates/<officeId>.json (one file per office, generated from
// this file's old OFFICES object — same bytes, same keys), and this
// module loads an office's file only when it is actually read.
// The public API is unchanged (same exports, same synchronous
// lookups); OFFICES is a Proxy: property reads load that office's
// shard on first use and cache it, Object.keys/values/entries work
// off the shard directory listing, and unknown offices read as
// undefined. Requiring this module parses no rate data at all.
// To add an office: drop rates/<id>.json ({name, period, mouzas})
// with the same shape as the other shards. The batch provenance
// comments above still describe where each batch came from.
const fs = require('fs');
const path = require('path');
const RATES_DIR = path.join(__dirname, 'rates');
const _officeCache = new Map();
function _officeIds() {
  try {
    return fs.readdirSync(RATES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  } catch (_) { return []; }
}
function _loadOffice(id) {
  if (_officeCache.has(id)) return _officeCache.get(id);
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(RATES_DIR, id + '.json'), 'utf8'));
  } catch (_) { rec = undefined; }
  _officeCache.set(id, rec);
  return rec;
}
const OFFICES = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop !== 'string') return undefined;
    return _loadOffice(prop);
  },
  has(_t, prop) {
    return typeof prop === 'string' && _officeIds().includes(prop);
  },
  ownKeys() { return _officeIds(); },
  getOwnPropertyDescriptor(_t, prop) {
    if (typeof prop === 'string' && _officeIds().includes(prop)) {
      return { enumerable: true, configurable: true };
    }
    return undefined;
  },
});

function norm(s) { return String(s == null ? '' : s).trim(); }

// One mouza record resolves to a list of rate variants: a plain
// entry is a single variant; a qualified name (Chandgaon
// collisions) carries `variants`, one per thana.
function variantsOf(rec) {
  if (!rec) return [];
  if (Array.isArray(rec.variants)) return rec.variants;
  return [rec];
}

function hitFrom(officeId, o, mouza, variant, cls) {
  const r = variant.rates[norm(cls)];
  if (!r) return null;
  const hit = {
    office: officeId,
    officeName: o.name,
    mouza: norm(mouza),
    class: norm(cls),
    rate: r.rate,
    period: o.period,
    p: r.p === true,
  };
  if (variant.thana) hit.thana = variant.thana;
  if (variant.jl) hit.jl = variant.jl;
  // Sandwip pouro note: only meaningful for পুকুর lookups, and
  // it never replaces the gram rate (the gram value stays).
  if (norm(cls) === 'পুকুর' && variant.pouroPukur) {
    hit.pouroPukur = variant.pouroPukur;
    hit.pouroNote = 'পৌর এলাকার হার: ' + variant.pouroPukur + ' টাকা — গ্রাম-মান দেখানো হয়েছে';
  }
  return hit;
}

/**
 * lookupMouzaRate(office, mouza, cls, thana?)
 * Returns null when there is no lookup rate (unknown office,
 * unknown mouza, or a class with no exact-name rate — including
 * বাণিজ্যিক, which has no lookup rate anywhere).
 * Otherwise { office, officeName, mouza, class, rate, period, p,
 * thana?, jl?, pouroPukur?, pouroNote? }.
 * Rate is ALWAYS per shatangsho.
 * AMBIGUITY (qualified names only): when several variants carry
 * a rate for the class and no thana is given, returns
 * { ambiguous: true, options: [thana names] } instead of a
 * rate — the caller must ask for the thana. A variant that
 * lacks the class rate does NOT count toward ambiguity, so a
 * query matching exactly one variant returns that rate.
 * A thana given for an unqualified mouza matches nothing — the
 * mouza has no thana to match, so it is a miss (found:false),
 * never a silent fallback to the single variant.
 */
function lookupMouzaRate(office, mouza, cls, thana) {
  const o = OFFICES[norm(office)];
  if (!o) return null;
  const rec = o.mouzas[norm(mouza)];
  if (!rec) return null;
  const variants = variantsOf(rec);
  const t = norm(thana);
  if (t) {
    const v = variants.find((x) => norm(x.thana) === t);
    return v ? hitFrom(norm(office), o, mouza, v, cls) : null;
  }
  const hits = variants.map((v) => hitFrom(norm(office), o, mouza, v, cls)).filter(Boolean);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  return {
    ambiguous: true,
    office: norm(office),
    officeName: o.name,
    mouza: norm(mouza),
    class: norm(cls),
    period: o.period,
    options: hits.map((h) => h.thana),
  };
}

/** Classes shown on a mouza rate card, in order. বাণিজ্যিক has
 * no lookup rate anywhere, so its card entry is always null —
 * picking it leads to the manual-rate path with a plain WHY. */
const CARD_CLASSES = ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক'];

/**
 * lookupMouzaCard(office, mouza, thana?)
 * Whole-mouza rate card for the guided wizard: ALL classes'
 * rates in one call, so the customer can SEE what exists
 * before picking a class.
 * Returns null when the office has no lookup data at all
 * (OFFICE_NOT_COVERED at the route).
 * Returns { notInTable: true, ... } when the office is covered
 * but the mouza is not in its table (MOUZA_NOT_IN_TABLE).
 * Returns { ambiguous: true, options: [thanas] } when several
 * thana variants exist and no thana was given — the card cannot
 * pick one variant's rates, so the caller must ask "কোন থানা?".
 * (Unlike the single-class lookup, there is no single-variant
 * shortcut here: a card shows every class, so any multi-variant
 * mouza is ambiguous until a thana is picked.)
 * Otherwise { office, officeName, mouza, thana?, jl?, period,
 * rates: { class: { rate: number|null, p: bool,
 * pouroPukur?, pouroNote? } } } — a null rate means the table
 * has no rate for that class (never 0).
 */
function lookupMouzaCard(office, mouza, thana) {
  const o = OFFICES[norm(office)];
  if (!o) return null;
  const rec = o.mouzas[norm(mouza)];
  if (!rec) {
    return { notInTable: true, office: norm(office), officeName: o.name, mouza: norm(mouza) };
  }
  const variants = variantsOf(rec);
  const t = norm(thana);
  if (t) {
    const v = variants.find((x) => norm(x.thana) === t);
    if (!v) {
      return { badThana: true, office: norm(office), officeName: o.name, mouza: norm(mouza), thana: t };
    }
    return cardFrom(norm(office), o, mouza, v);
  }
  if (variants.length > 1) {
    return {
      ambiguous: true,
      office: norm(office),
      officeName: o.name,
      mouza: norm(mouza),
      period: o.period,
      options: variants.map((v) => v.thana),
    };
  }
  return cardFrom(norm(office), o, mouza, variants[0]);
}

function cardFrom(officeId, o, mouza, variant) {
  const rates = {};
  for (const cls of CARD_CLASSES) {
    const r = variant.rates[cls];
    if (!r) { rates[cls] = { rate: null, p: false }; continue; }
    const entry = { rate: r.rate, p: r.p === true };
    if (cls === 'পুকুর' && variant.pouroPukur) {
      entry.pouroPukur = variant.pouroPukur;
      entry.pouroNote = 'পৌর এলাকার হার: ' + variant.pouroPukur + ' টাকা — গ্রাম-মান দেখানো হয়েছে';
    }
    rates[cls] = entry;
  }
  const card = {
    office: officeId,
    officeName: o.name,
    mouza: norm(mouza),
    period: o.period,
    rates,
  };
  if (variant.thana) card.thana = variant.thana;
  if (variant.jl) card.jl = variant.jl;
  return card;
}

/** Offices available for lookup: [{ id, name, period, mouzas: [names] }]. */
function listLookupOffices() {
  return Object.entries(OFFICES).map(([id, o]) => ({
    id,
    name: o.name,
    period: o.period,
    mouzas: Object.keys(o.mouzas),
  }));
}

/** Lookup classes for one office+mouza: [class names with a rate]. */
/** For qualified names this is the union across variants. */
function listLookupClasses(office, mouza) {
  const o = OFFICES[norm(office)];
  if (!o) return [];
  const rec = o.mouzas[norm(mouza)];
  if (!rec) return [];
  const out = [];
  for (const v of variantsOf(rec)) {
    for (const c of Object.keys(v.rates)) if (!out.includes(c)) out.push(c);
  }
  return out;
}

module.exports = { OFFICES, lookupMouzaRate, lookupMouzaCard, listLookupOffices, listLookupClasses };
