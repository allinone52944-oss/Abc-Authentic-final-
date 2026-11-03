'use strict';

// ============================================================
// Khatian search summary PDF (Bengali) — the delivery
// document for engine land-khatian (SPEC Phase 1).
//
// Modelled on backend/lib/landReportPdf.js (same font
// discipline: the bundled Noto Sans Bengali has no Latin
// glyphs, so Latin-only runs render in Helvetica; numbers
// in Bengali digits).
//
// Customer-document rules (same as the mouza report):
// NO watermark, NO source site name, NO source link, NO
// branding, NO raw scan. The disclaimer block states
// plainly, in Bengali, that this is a SUMMARY, NOT a
// certified copy, NOT ownership/title/possession proof,
// and that official work needs verification at the
// government portal.
// ============================================================
const path = require('path');
const { toBn, landText } = require('./landReportPdf');

// The stale line rendered in a store-served PDF (and
// mirrored in the API response + page banner). Null for
// live PDFs and for store results without a collection
// date — live PDFs are unchanged.
function staleLine(source, collectedAt) {
  if (source !== 'store' || !collectedAt) return null;
  const staleBn = toBn(new Date(collectedAt).toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' })
    .replace('AM', 'পূর্বাহ্ন').replace('PM', 'অপরাহ্ন'));
  return 'সংরক্ষিত তথ্য — শেষ আপডেট: ' + staleBn + ' — লাইভ পোর্টাল থেকে যাচাই করা হয়নি';
}

function buildKhatianSummaryPdf({ ref, when, area, items, totalLand, totalMatches, capped, source, collectedAt }) {
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

      const X = 48; const W = 499; const BOTTOM = 770;
      let y = 46;
      const valFont = (v, bold) => (/[A-Za-z]/.test(String(v)) ? (bold ? 'Helvetica-Bold' : 'Helvetica') : (bold ? 'bn-bold' : 'bn'));
      const whenBn = toBn(String(when || '').replace('AM', 'পূর্বাহ্ন').replace('PM', 'অপরাহ্ন'));

      function ensure(h) { if (y + h > BOTTOM) { doc.addPage(); y = 48; } }
      function row(label, value, opts) {
        const o = opts || {};
        const h = o.h || 24;
        ensure(h);
        const drawn = /[A-Za-z]/.test(String(value)) ? String(value) : toBn(value);
        doc.font('bn').fontSize(11).fillColor('#6b7280').text(label, X, y, { width: 128 });
        doc.font(valFont(drawn, o.bold)).fontSize(11.5)
          .fillColor(o.color || '#111827')
          .text(drawn, X + 138, y, { width: W - 138 });
        y += h;
      }
      function heading(text, color) {
        ensure(34);
        doc.font('bn-bold').fontSize(13).fillColor(color || '#1f2937').text(text, X, y, { width: W });
        y += 24;
      }
      function divider() {
        ensure(14);
        doc.strokeColor('#eadfc8').lineWidth(1).moveTo(X, y).lineTo(X + W, y).stroke();
        y += 12;
      }

      doc.font('bn').fontSize(10.5).fillColor('#6b7280').text('খতিয়ান অনুসন্ধান সারাংশ', X, y + 2, { width: W, align: 'right' });
      y += 26;
      doc.strokeColor('#d6c9ae').lineWidth(1.4).moveTo(X, y).lineTo(X + W, y).stroke();
      y += 16;
      doc.font('bn-bold').fontSize(17).fillColor('#14532d').text('খতিয়ান অনুসন্ধান সারাংশ', X, y, { width: W });
      y += 28;
      // Store (stale) delivery: the staleness is visible in
      // the PDF itself, not only in the API response or the
      // page banner. Live PDFs are unchanged.
      const stale = staleLine(source, collectedAt);
      if (stale) {
        ensure(28);
        doc.font('bn').fontSize(11).fillColor('#92400e')
          .text(stale, X, y, { width: W });
        y += 26;
      }
      row('তারিখ ও সময়', whenBn);
      row('রেফারেন্স', ref);
      divider();

      heading('এলাকা');
      if (area) {
        row('বিভাগ', area.division || '—');
        row('জেলা', area.district || '—');
        row('উপজেলা / থানা', area.upazila || '—');
        row('মৌজা', (area.mouza || '—') + (area.jl ? ' (জে. এল. নং: ' + area.jl + ')' : ''));
      }
      divider();

      const list = Array.isArray(items) ? items : [];
      heading('পাওয়া খতিয়ানসমূহ (' + toBn(list.length) + 'টি)');
      list.forEach((r, i) => {
        ensure(104);
        doc.font('bn-bold').fontSize(12).fillColor('#14532d')
          .text('খতিয়ান নং: ' + toBn(r.khatianNo) + (r.surveyName ? ' (জরিপ: ' + r.surveyName + ')' : ''), X, y, { width: W });
        y += 21;
        row('মালিকের নাম', r.owners || '—');
        row('দাগ নম্বর', r.dags || '—');
        row('জমির পরিমাণ', landText(r.totalLand));
        if (Array.isArray(r.halSabek) && r.halSabek.length) {
          row('হাল-সাবেক তথ্য', toBn(r.halSabek.length) + 'টি রেকর্ড পাওয়া গেছে');
        }
        if (i < list.length - 1) divider();
      });
      if (list.length) {
        divider();
        row('মোট জমি (সব খতিয়ান মিলিয়ে)', landText(totalLand), { bold: true, color: '#14532d' });
      }
      if (capped) {
        ensure(28);
        doc.font('bn').fontSize(10.5).fillColor('#374151')
          .text('দ্রষ্টব্য: মোট ' + toBn(totalMatches) + 'টি মিলের মধ্যে প্রথম ' + toBn(list.length) +
            'টি এখানে দেখানো হয়েছে — বাকিগুলো দেখতে অনুসন্ধান আরও নির্দিষ্ট করুন (খতিয়ান নম্বর বা দাগ নম্বর দিন)।', X, y, { width: W });
        y += 28;
      }

      y += 10;
      divider();
      const footers = [
        'সীমা (পরিষ্কার করে): এই রিপোর্টটি তথ্যের সারাংশ মাত্র — এটি সরকারি সার্টিফাইড কপি নয়।',
        'এই সারাংশ মালিকানা / স্বত্ব / দখলের প্রমাণ নয়। অফিসিয়াল কাজে (নামজারি, ঋণ, আদালত) সার্টিফাইড কপি প্রয়োজন হবে — প্রয়োজনে সরকারি পোর্টালে যাচাই করে নিন।',
      ];
      for (const line of footers) {
        ensure(28);
        doc.font('bn').fontSize(9.5).fillColor('#6b7280').text(line, X, y, { width: W });
        y += 24;
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { buildKhatianSummaryPdf, staleLine };
