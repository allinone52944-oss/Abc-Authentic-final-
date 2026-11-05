// ============================================================
// Mouza rate-card PDF — the FREE download on wizard step 2.
// A clean copy of exactly the card the customer already sees
// on screen, in the unit they picked. Rates come from rates.js
// through lookupMouzaCard — the SAME source as GET
// /mouza-rates — converted by UNIT_FACTORS from calc.js, so
// card and PDF can never disagree. No charge, no order, no DB:
// this only saves what is already visible on screen.
// The PDF carries NO watermark, NO source site name, NO link,
// NO branding — only the card, its period, and the honesty
// line that it is not a certified copy (same neutrality as
// the paid mouza report in landReportPdf.js).
// ============================================================
const path = require('path');
const { UNIT_FACTORS } = require('../../engines/land-mouza-value/calc');

const RATE_CARD_UNIT_LABELS = { shatangsho: 'শতাংশ', katha: 'কাঠা', bigha: 'বিঘা', gonda: 'গন্ডা' };
const RATE_CARD_UNITS = Object.keys(RATE_CARD_UNIT_LABELS);

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
function toBn(v) {
  return String(v == null ? '' : v).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);
}
// Indian grouping like the wizard's bnGrouped: 121421 → ১,২১,৪২১.
// Grouping runs on Latin digits first, then converts — the
// Bengali font has no Latin glyphs, so a Latin run would print
// as boxes (same discipline as landReportPdf.js).
function groupBn(v) {
  const num = Number(v);
  if (!Number.isFinite(num)) return toBn(v);
  const rounded = Math.round(Math.abs(num) * 100) / 100;
  const parts = String(rounded).split('.');
  let intStr = parts[0];
  let grouped = intStr;
  if (intStr.length > 3) {
    const last3 = intStr.slice(-3);
    let rest = intStr.slice(0, -3);
    const pairs = [];
    while (rest.length > 2) { pairs.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
    if (rest) pairs.unshift(rest);
    grouped = pairs.join(',') + ',' + last3;
  }
  if (parts[1]) grouped += '.' + parts[1];
  return toBn((num < 0 ? '-' : '') + grouped);
}

/** Per-shatangsho table rate → rate in the chosen unit. Null
 * stays null (no rate for that class) — never 0. Unknown unit
 * returns null; the route validates the unit first (400). */
function convertCardRate(rate, unit) {
  if (rate == null) return null;
  const f = UNIT_FACTORS[unit];
  if (f == null) return null;
  return Math.round(rate * f * 100) / 100;
}

/** Whole card → display rows in the chosen unit, card order
 * kept (the card object already lists classes in order). */
function rateCardRows(card, unit) {
  const rows = [];
  for (const [cls, r] of Object.entries((card && card.rates) || {})) {
    rows.push({
      cls,
      rate: convertCardRate(r.rate, unit),
      p: r.p === true,
      pouroNote: r.pouroNote || '',
    });
  }
  return rows;
}

function buildMouzaRateCardPdf({ card, unit, when }) {
  return new Promise((resolve, reject) => {
    try {
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.registerFont('bn', path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansBengali-Regular.ttf'));
      doc.registerFont('bn-bold', path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansBengali-Bold.ttf'));
      doc.info.Title = 'মৌজার হার তালিকা';

      const X = 48; const W = 499; const BOTTOM = 770;
      let y = 46;
      function ensure(h) { if (y + h > BOTTOM) { doc.addPage(); y = 48; } }
      function row(label, value, opts) {
        const o = opts || {};
        const h = o.h || 24;
        ensure(h);
        // Bengali digits only in runs WITHOUT Latin letters: a
        // Latin run renders in Helvetica, where Bengali digits
        // have no glyphs — and a Latin digit inside the Bengali
        // font prints as a box. Same rule as landReportPdf.js.
        const drawn = /[A-Za-z]/.test(String(value)) ? String(value) : toBn(value);
        doc.font('bn').fontSize(11).fillColor('#6b7280').text(label, X, y, { width: 128 });
        doc.font(o.bold ? 'bn-bold' : 'bn').fontSize(11.5)
          .fillColor(o.color || '#111827')
          .text(drawn, X + 138, y, { width: W - 138 });
        y += h;
      }
      function heading(text) {
        ensure(34);
        doc.font('bn-bold').fontSize(13).fillColor('#1f2937').text(text, X, y, { width: W });
        y += 24;
      }
      function divider() {
        ensure(14);
        doc.strokeColor('#eadfc8').lineWidth(1).moveTo(X, y).lineTo(X + W, y).stroke();
        y += 12;
      }

      const unitLabel = RATE_CARD_UNIT_LABELS[unit] || RATE_CARD_UNIT_LABELS.shatangsho;
      doc.font('bn-bold').fontSize(17).fillColor('#14532d').text('মৌজার হার তালিকা', X, y, { width: W });
      y += 28;
      row('তারিখ ও সময়', toBn(String(when || '').replace('AM', 'পূর্বাহ্ন').replace('PM', 'অপরাহ্ন')));
      divider();
      heading('মৌজা');
      row('অফিস', card.officeName || '—');
      row('মৌজা', card.mouza || '—');
      if (card.thana) row('থানা', card.thana);
      if (card.jl) row('জে. এল. নং', card.jl);
      row('তালিকা', card.period || '—');
      row('হার প্রতি', unitLabel);
      divider();
      heading('শ্রেণিভিত্তিক হার');
      for (const r of rateCardRows(card, unit)) {
        ensure(26);
        doc.font('bn-bold').fontSize(12).fillColor('#111827').text(r.cls, X, y, { width: 128 });
        const line = r.rate == null
          ? 'হার নেই'
          : groupBn(r.rate) + ' টাকা';
        doc.font('bn').fontSize(12).fillColor(r.rate == null ? '#92400e' : '#14532d')
          .text(line, X + 138, y, { width: W - 138 });
        y += 24;
        if (r.rate != null && r.p) {
          ensure(20);
          doc.font('bn').fontSize(10.5).fillColor('#374151')
            .text('আগের বছরের হার বহাল আছে', X + 138, y, { width: W - 138 });
          y += 18;
        }
        if (r.rate != null && r.pouroNote) {
          ensure(20);
          doc.font('bn').fontSize(10.5).fillColor('#374151')
            .text(toBn(r.pouroNote), X + 138, y, { width: W - 138 });
          y += 18;
        }
      }
      divider();
      ensure(48);
      doc.font('bn').fontSize(11).fillColor('#374151').text(
        rateCardDisclaimer(),
        X, y, { width: W });
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {
  RATE_CARD_UNIT_LABELS, RATE_CARD_UNITS,
  toBn, groupBn, convertCardRate, rateCardRows, buildMouzaRateCardPdf,
  rateCardDisclaimer,
};

// Audit #13 — the rate card IS the manual table's copy: say so.
// The table is hand-entered (engines/land-mouza-value/rates.js);
// no portal schedule lookup exists, so the card is never
// portal-verified — the disclaimer must not imply otherwise.
function rateCardDisclaimer() {
  return 'এই তালিকা সার্টিফাইড কপি নয় — এটি ম্যানুয়াল হার-টেবিলের একটি অনুলিপি মাত্র; সরকারি পোর্টাল থেকে যাচাই করা হয়নি। চূড়ান্ত তথ্যের জন্য সাব-রেজিস্ট্রার অফিসে যাচাই করুন।';
}
