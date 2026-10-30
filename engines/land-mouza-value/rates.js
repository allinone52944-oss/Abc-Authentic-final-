// ============================================================
// Land mouza-value LOOKUP data — PROOF SCOPE ONLY.
// One office, one mouza, one schedule period. Rates are per
// SHATANGSHO, transcribed from the office schedule scan.
// No portal is called and no endpoint is guessed: this file is
// the schedule data itself, entered once and read back.
//
// Mapping rule (strict): the engine's class list is নাল, বাড়ী,
// ভিটা, বাগান, পুকুর, ডোবা, বাণিজ্যিক. ONLY exact-name matches
// are lookup classes. Columns that do not match an engine class
// (খাল, দোকান, পতিত, বিলা, বাঁশঝাড়, পথ, টিলা/পাহাড়,
// ফলবাগান, গার্ডেন, বিবিধ) are stored under `otherColumns`
// for reference ONLY — lookupMouzaRate never returns them, and
// দোকান is NEVER mapped to বাণিজ্যিক. বাণিজ্যিক therefore has
// no lookup rate in this proof.
//
// P flag: the schedule footnote marks P rows as "no sale deed
// registered, so the previous value remains in force". The P
// number IS the applicable rate; `p: true` only carries the
// note so the UI can show it.
// ============================================================

const OFFICES = {
  boalkhali: {
    // Display name only — no source site name, link or branding
    // is stored here or shown to customers.
    name: 'বোয়ালখালী',
    period: '2025-2026',
    mouzas: {
      'কধুরখীল': {
        // Lookup classes: exact-name matches only, per shatangsho.
        rates: {
          'নাল': { rate: 121421 },
          'বাড়ী': { rate: 157248 },
          'ভিটা': { rate: 140752 },
          'বাগান': { rate: 147838 },
          'পুকুর': { rate: 109707 },
          'ডোবা': { rate: 100000, p: true },
        },
        // NOT lookup classes — reference only, never returned.
        otherColumns: {
          'খাল': 162756,
          'দোকান': { rate: 1400000, p: true },
          'পতিত': { rate: 50000, p: true },
          'বিলা': 212528,
          'বাঁশঝাড়': 500000,
          'পথ': 256000,
          'টিলা/পাহাড়': null,
          'ফলবাগান': null,
          'গার্ডেন': null,
        },
        // Informational only — never a lookup class.
        notes: 'বিবিধ: কবরস্থান 478571 (তথ্য মাত্র)',
      },
    },
  },
};

function norm(s) { return String(s == null ? '' : s).trim(); }

/**
 * lookupMouzaRate(office, mouza, cls)
 * Returns null when there is no lookup rate (unknown office,
 * unknown mouza, or a class with no exact-name rate — including
 * বাণিজ্যিক, which has no lookup rate in this proof).
 * Otherwise { office, officeName, mouza, class, rate, period, p }.
 * Rate is ALWAYS per shatangsho.
 */
function lookupMouzaRate(office, mouza, cls) {
  const o = OFFICES[norm(office)];
  if (!o) return null;
  const m = o.mouzas[norm(mouza)];
  if (!m) return null;
  const r = m.rates[norm(cls)];
  if (!r) return null;
  return {
    office: norm(office),
    officeName: o.name,
    mouza: norm(mouza),
    class: norm(cls),
    rate: r.rate,
    period: o.period,
    p: r.p === true,
  };
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
function listLookupClasses(office, mouza) {
  const o = OFFICES[norm(office)];
  if (!o) return [];
  const m = o.mouzas[norm(mouza)];
  if (!m) return [];
  return Object.keys(m.rates);
}

module.exports = { OFFICES, lookupMouzaRate, listLookupOffices, listLookupClasses };
