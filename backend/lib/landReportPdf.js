// ============================================================
// Land report PDF (Bengali) — the delivery document for the
// three DLRMS land services (খতিয়ান খোঁজ / নামে সন্ধান / জমি
// যাচাই). Data comes from the official land-record channel;
// the report is an information summary — the footer says
// plainly that it is NOT a government certified copy.
//
// Font discipline (same as receiptPdf.js): the bundled Noto
// Sans Bengali has no Latin glyphs, so Latin-only runs render
// in Helvetica; everything else in the Bengali fonts. Numbers
// are shown in Bengali digits like the portal itself.
// ============================================================
const path = require('path');

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
function toBn(v) {
  return String(v == null ? '' : v).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);
}
/** '0.0544' → '০.০৫৪৪ একর (৫.৪৪ শতাংশ)' */
function landText(totalLand) {
  const v = parseFloat(totalLand);
  if (!Number.isFinite(v)) return '—';
  const shot = Math.round(v * 100 * 100) / 100;
  return toBn(v) + ' একর (' + toBn(shot) + ' শতাংশ)';
}

function buildLandReportPdf({ kind, ref, when, area, records, totalLand, verdicts, claimNote,
  lines, totalMinimum, deedBasis, declaredPrice, breakdown, scheduleVersion,
  oldScheduleVersion, hasOldComparison, checks }) {
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
        // Bengali digits only in runs WITHOUT Latin letters: a
        // Latin run renders in Helvetica, where Bengali digits
        // have no glyphs and would print as boxes.
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

      const TITLES = {
        search: 'খতিয়ান তথ্য রিপোর্ট',
        scan: 'নামে সম্পত্তি সন্ধান রিপোর্ট',
        verify: 'জমি যাচাই রিপোর্ট',
        mouza: 'মৌজা মূল্য রিপোর্ট',
      };

      // Header — deliberately NO app/brand name, NO source name,
      // NO link, NO watermark (owner's customer-document rules
      // for the mouza report; the same neutrality is kept for
      // the other land reports). For mouza the header must NOT
      // claim a government-record source: rates are entered by
      // the shopkeeper from a schedule they have checked.
      doc.font('bn').fontSize(10.5).fillColor('#6b7280').text(
        kind === 'mouza' ? 'মৌজা মূল্য রিপোর্ট' : 'সরকারি ভূমি রেকর্ডের সারাংশ', X, y + 2, { width: W, align: 'right' });
      y += 26;
      doc.strokeColor('#d6c9ae').lineWidth(1.4).moveTo(X, y).lineTo(X + W, y).stroke();
      y += 16;
      doc.font('bn-bold').fontSize(17).fillColor('#14532d').text(TITLES[kind] || TITLES.search, X, y, { width: W });
      y += 28;
      row('তারিখ ও সময়', whenBn);
      row('রেফারেন্স', ref);
      divider();

      // Area block — same for every kind
      heading('এলাকা');
      if (area) {
        row('বিভাগ', area.division || '—');
        row('জেলা', area.district || '—');
        row('উপজেলা / থানা', area.upazila || '—');
        row('মৌজা', (area.mouza || '—') + (area.jl ? ' (জে. এল. নং: ' + area.jl + ')' : ''));
        if (area.officeName) row('সাব-রেজিস্ট্রার অফিস', area.officeName);
      }
      if (kind === 'mouza') {
        row('তালিকার সংস্করণ', scheduleVersion || '2025-2026');
        if (oldScheduleVersion) row('পুরনো তালিকার সংস্করণ', oldScheduleVersion);
      }
      divider();

      if (kind === 'verify' && Array.isArray(verdicts)) {
        heading('দাবি বনাম সরকারি রেকর্ড');
        for (const v of verdicts) {
          ensure(52);
          doc.font('bn-bold').fontSize(11.5).fillColor('#111827').text(v.label, X, y, { width: 200 });
          doc.font('bn-bold').fontSize(11.5).fillColor(v.match ? '#16a34a' : '#dc2626')
            .text(v.match ? 'মিলেছে' : 'মেলেনি', X + W - 70, y, { width: 70, align: 'right' });
          y += 20;
          row('  দাবি', v.claim == null || v.claim === '' ? '—' : v.claim, { h: 20 });
          row('  রেকর্ড', v.record == null || v.record === '' ? '—' : v.record, { h: 22 });
        }
        if (claimNote) {
          ensure(30);
          doc.font('bn').fontSize(10.5).fillColor('#374151').text(claimNote, X, y, { width: W });
          y += 28;
        }
        divider();
      }

      if (kind === 'mouza') {
        const mlines = Array.isArray(lines) ? lines : [];
        heading('ইনপুট ও লাইন ধরে হিসাব (' + toBn(mlines.length) + 'টি লাইন)');
        mlines.forEach((l, i) => {
          ensure(104);
          doc.font('bn-bold').fontSize(12).fillColor('#14532d')
            .text((i + 1) + '. ' + (l.mouza || '—') + ' — ' + (l.class || '—'), X, y, { width: W });
          y += 21;
          row('শতাংশপ্রতি হার', toBn(l.rate) + ' টাকা');
          row('পরিমাণ', toBn(l.qtyShatangsho) + ' শতাংশ'
            + (l.unit && l.unit !== 'shatangsho' ? ' (' + toBn(l.amount) + ' ' + (l.unit === 'katha' ? 'কাঠা' : 'বিঘা') + ')' : ''));
          row('লাইন মূল্য', toBn(l.value) + ' টাকা', { bold: true });
          if (l.oldRate !== undefined) {
            row('পুরনো হার / পুরনো মূল্য', toBn(l.oldRate) + ' টাকা / ' + toBn(l.oldValue) + ' টাকা'
              + ' (পার্থক্য: ' + toBn(l.delta) + ' টাকা)');
          }
          if (i < mlines.length - 1) divider();
        });
        divider();
        heading('মোট ও ভিত্তি');
        row('মোট সর্বনিম্ন মূল্য', toBn(totalMinimum) + ' টাকা', { bold: true, color: '#14532d' });
        if (declaredPrice !== null && declaredPrice !== undefined) {
          row('ঘোষিত দাম', toBn(declaredPrice) + ' টাকা');
        }
        row('দলিলের ভিত্তি (বেশিটা)', toBn(deedBasis) + ' টাকা', { bold: true, color: '#14532d' });
        divider();
        heading('শ্রেণিভিত্তিক ভাগ');
        Object.entries(breakdown || {}).forEach(([k, v]) => row(k, toBn(v) + ' টাকা'));
        divider();
        heading('যাচাই');
        (checks || []).forEach((c) => {
          ensure(28);
          doc.font('bn').fontSize(10.5).fillColor('#374151').text('• ' + c, X, y, { width: W });
          y += 24;
        });
        if (!hasOldComparison) {
          ensure(28);
          doc.font('bn').fontSize(10.5).fillColor('#374151')
            .text('• পুরনো বনাম নতুন হারের তুলনা দেওয়া হয়নি — দুটো তালিকার হারই দেওয়া থাকলে তবেই তুলনা দেখানো হয়।', X, y, { width: W });
          y += 24;
        }
      }

      const list = Array.isArray(records) ? records : [];
      if (kind !== 'mouza') {
      heading(kind === 'scan' ? 'পাওয়া খতিয়ানসমূহ (' + toBn(list.length) + 'টি)' : 'খতিয়ানের তথ্য');
      list.forEach((r, i) => {
        ensure(104);
        doc.font('bn-bold').fontSize(12).fillColor('#14532d')
          .text('খতিয়ান নং: ' + toBn(r.KHATIAN_NO) + (r._surveyName ? ' (জরিপ: ' + r._surveyName + ')' : ''), X, y, { width: W });
        y += 21;
        row('মালিকের নাম', r.OWNERS || '—');
        row('দাগ নম্বর', r.DAGS || '—');
        row('জমির পরিমাণ', landText(r.TOTAL_LAND));
        if (i < list.length - 1) divider();
      });
      }

      if (kind === 'scan' && list.length) {
        divider();
        row('মোট জমি (সব খতিয়ান মিলিয়ে)', landText(totalLand), { bold: true, color: '#14532d' });
      }

      y += 10;
      divider();
      const footers = kind === 'mouza' ? [
        'সীমা (পরিষ্কার করে): এই রিপোর্ট সার্টিফাইড কপি নয়, মালিকানা / স্বত্ব / দখলের প্রমাণ নয়, বাজারমূল্য নয়, চূড়ান্ত দলিল বিল নয়।',
        'হারগুলো দোকানদারের যাচাই করা তালিকা থেকে বসানো হয়েছে; স্বয়ংক্রিয় তালিকা-খোঁজা এখনো তৈরি হয়নি। দলিল করার আগে শ্রেণি, পরিমাণ ও বর্তমান তালিকা সাব-রেজিস্ট্রার অফিসে মিলিয়ে নিন।',
        'দলিলের ফি / করের হার এখানে সরকারি হার হিসেবে ধরা হয়নি — সেগুলো অফিস থেকে নিশ্চিত করে হিসাব করতে হবে।',
        'যাচাই তালিকা: (১) শ্রেণি ঠিক আছে কিনা, (২) পরিমাণ ঠিক আছে কিনা, (৩) বর্তমান তালিকার সংস্করণ ঠিক আছে কিনা, (৪) সাব-রেজিস্ট্রার অফিসে হার মিলেছে কিনা।',
      ] : [
        'তথ্য সূত্র: ভূমি মন্ত্রণালয়ের ডিজিটাল ভূমি রেকর্ড পোর্টালের সরকারি রেকর্ড।',
        'দ্রষ্টব্য: এই রিপোর্টটি তথ্যের সারাংশ — এটি সরকারি সার্টিফাইড কপি নয়। অফিসিয়াল কাজে (নামজারি, ঋণ, আদালত) সার্টিফাইড কপি প্রয়োজন হবে।',
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

module.exports = { buildLandReportPdf, toBn, landText };
