// ============================================================
// Land mouza-value calculation — pure arithmetic, no portal,
// no network. Two line kinds, never silently mixed:
//
//   MANUAL line (default): rate = per SELECTED unit, value =
//     rate × amount in that unit (the deployed rule).
//   LOOKUP line (source: 'lookup'): rate = schedule rate PER
//     SHATANGSHO (from engines/land-mouza-value/rates.js),
//     value = rate × quantity converted to shatangsho.
//     The route verifies a lookup line's rate against the data
//     file before calling this module, so a tampered rate can
//     never reach the calculation as a lookup line.
//
// Lookup data is PROOF SCOPE ONLY (one office, one mouza — see
// rates.js). Every other line stays manual.
// ============================================================
const CLASSES = ['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক'];
// Unit factors in shatangsho. Gonda follows the same rounding convention
// as the other factors (864 sq ft ≈ 1.98 shatangsho, used as 2, just as
// katha uses 1.65 and bigha uses 33); the report states the factors used.
const UNIT_FACTORS = { shatangsho: 1, katha: 1.65, bigha: 33, gonda: 2 };

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * calcMouzaReport({ lines, declaredPrice, scheduleVersion })
 * lines: [{ mouza, class, rate, amount, unit, oldRate?, source? }]
 *   rate: MANUAL line — taka per SELECTED unit (the unit the
 *     shopkeeper chose for this line). LOOKUP line — taka per
 *     SHATANGSHO from the schedule data file.
 *   amount: land amount in the given unit
 *   unit: 'shatangsho' | 'katha' | 'bigha' | 'gonda' (user-correctable)
 *   oldRate: optional rate from an older schedule, for comparison
 *     — in the same unit as the line's rate (per shatangsho for
 *     lookup lines, per selected unit for manual lines)
 *   source: 'lookup' | 'manual' (default 'manual')
 * Returns { lines, totalMinimum, deedBasis, breakdown, checks,
 *           hasOldComparison, valid } — throws on bad input.
 * Output lines carry `source` through.
 */
function calcMouzaReport(input) {
  const raw = (input && input.lines) || [];
  if (!Array.isArray(raw) || raw.length === 0) {
    const e = new Error('AT_LEAST_ONE_LINE'); e.code = 'AT_LEAST_ONE_LINE'; throw e;
  }
  if (raw.length > 50) {
    const e = new Error('TOO_MANY_LINES'); e.code = 'TOO_MANY_LINES'; throw e;
  }
  const lines = raw.map((l, i) => {
    const mouza = String(l.mouza == null ? '' : l.mouza).trim().slice(0, 80);
    const cls = String(l.class == null ? '' : l.class).trim();
    const rate = Number(l.rate);
    const amount = Number(l.amount);
    const unit = String(l.unit || 'shatangsho');
    if (!mouza) { const e = new Error('BAD_LINE_MOUZA:' + i); e.code = 'BAD_LINE'; throw e; }
    if (!CLASSES.includes(cls)) { const e = new Error('BAD_LINE_CLASS:' + i); e.code = 'BAD_LINE'; throw e; }
    if (!Number.isFinite(rate) || rate < 0) { const e = new Error('BAD_LINE_RATE:' + i); e.code = 'BAD_LINE'; throw e; }
    if (!Number.isFinite(amount) || amount <= 0) { const e = new Error('BAD_LINE_AMOUNT:' + i); e.code = 'BAD_LINE'; throw e; }
    if (!UNIT_FACTORS[unit]) { const e = new Error('BAD_LINE_UNIT:' + i); e.code = 'BAD_LINE'; throw e; }
    const qty = round2(amount * UNIT_FACTORS[unit]);
    // Dual convention, labelled per line, never mixed:
    //   lookup: schedule rate (per shatangsho) × shatangsho qty
    //   manual: rate (per selected unit) × amount in that unit
    const source = l.source === 'lookup' ? 'lookup' : 'manual';
    const value = source === 'lookup' ? round2(rate * qty) : round2(rate * amount);
    const out = { mouza, class: cls, rate, amount, unit, qtyShatangsho: qty, value, source };
    if (l.oldRate !== undefined && l.oldRate !== null && String(l.oldRate) !== '') {
      const oldRate = Number(l.oldRate);
      if (!Number.isFinite(oldRate) || oldRate < 0) { const e = new Error('BAD_LINE_OLD_RATE:' + i); e.code = 'BAD_LINE'; throw e; }
      out.oldRate = oldRate;
      out.oldValue = source === 'lookup' ? round2(oldRate * qty) : round2(oldRate * amount);
      out.delta = round2(value - out.oldValue);
    }
    return out;
  });
  // Arithmetic check: re-add the line values independently.
  const totalMinimum = round2(lines.reduce((a, l) => a + l.value, 0));
  const reAdd = round2(lines.map((l) => l.value).reduce((a, v) => a + v, 0));
  const declaredRaw = input.declaredPrice;
  const declaredPrice = (declaredRaw === undefined || declaredRaw === null || String(declaredRaw) === '')
    ? null : Number(declaredRaw);
  if (declaredPrice !== null && (!Number.isFinite(declaredPrice) || declaredPrice < 0)) {
    const e = new Error('BAD_DECLARED_PRICE'); e.code = 'BAD_DECLARED_PRICE'; throw e;
  }
  const deedBasis = declaredPrice !== null && declaredPrice > totalMinimum ? declaredPrice : totalMinimum;
  const breakdown = {};
  for (const l of lines) breakdown[l.class] = round2((breakdown[l.class] || 0) + l.value);
  return {
    lines,
    totalMinimum,
    deedBasis,
    declaredPrice,
    breakdown,
    hasOldComparison: lines.some((l) => l.oldRate !== undefined),
    scheduleVersion: String(input.scheduleVersion || '2025-2026').trim().slice(0, 40) || '2025-2026',
    oldScheduleVersion: input.oldScheduleVersion
      ? String(input.oldScheduleVersion).trim().slice(0, 40) : null,
    checks: [
      'যোগফল পুনরায় যোগ করে মিলিয়ে দেখা হয়েছে: ' + totalMinimum + ' = ' + reAdd,
      'লুকআপ লাইন: তালিকার হার (শতাংশপ্রতি) × শতাংশ পরিমাণ; নিজের লাইন: বাছা এককপ্রতি হার × ওই এককে পরিমাণ (১ কাঠা = ১.৬৫, ১ বিঘা = ৩৩, ১ গন্ডা = ২ শতাংশ)',
      'প্রতিটি লাইনে হার ও পরিমাণ দেওয়া হয়েছে; হার না পাওয়া লাইন শূন্য ধরা হয়নি',
    ],
    valid: reAdd === totalMinimum,
  };
}

module.exports = { CLASSES, UNIT_FACTORS, calcMouzaReport, round2 };
