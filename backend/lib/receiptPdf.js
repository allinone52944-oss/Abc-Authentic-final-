// ============================================================
// Premium receipt PDF (Bengali, pdfkit + bundled Noto Sans
// Bengali) — ONE card design shared by every verification-style
// service (QR + photo verify, certificate verify, death
// verify): a drawn seal (green tick / red cross, vector-drawn
// so no glyph is missing from the Bengali font), a details
// table and, on failure, a bold "no charge taken" line.
// Approved sample design, 2026-10-22.
//
// The bundled Noto Sans Bengali has NO Latin glyphs — any Latin
// run drawn in it prints as boxes. Latin-only values therefore
// render in pdfkit's built-in Helvetica, and mixed Bengali
// strings spell QR out as কিউআর.
// ============================================================
const path = require('path');

function buildReceiptPdf({ serviceLabel, outcome, reason, successLine, subjectLabel, subjectValue, chargeText, ref, when, footers }) {
  return new Promise((resolve, reject) => {
    try {
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const fontReg = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansBengali-Regular.ttf');
      const fontBold = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansBengali-Bold.ttf');
      doc.registerFont('bn', fontReg);
      doc.registerFont('bn-bold', fontBold);

      const ok = outcome !== 'failed';
      const accent = ok ? '#16a34a' : '#dc2626';
      const X = 48; const W = 499;
      const bnTxt = (s) => String(s == null ? '' : s).replace(/QR/g, 'কিউআর');
      const valFont = (v, bold) => (/[A-Za-z]/.test(String(v))
        ? (bold ? 'Helvetica-Bold' : 'Helvetica')
        : (bold ? 'bn-bold' : 'bn'));
      const whenBn = bnTxt(when).replace('AM', 'পূর্বাহ্ন').replace('PM', 'অপরাহ্ন');

      // Header (brand name is Latin → Helvetica)
      doc.font('Helvetica-Bold').fontSize(19).fillColor('#6f4e2e').text('Abc Authentic', X, 46, { width: 300 });
      doc.font('bn').fontSize(10).fillColor('#6b7280')
        .text('ডিজিটাল রসিদ', X, 52, { width: W, align: 'right' });
      doc.strokeColor('#d6c9ae').lineWidth(1.4).moveTo(X, 82).lineTo(X + W, 82).stroke();

      // Card
      doc.roundedRect(X, 98, W, 302, 14).fillAndStroke('#fffdf8', '#d6c9ae');

      // Seal (vector-drawn tick / cross inside a filled circle)
      doc.circle(86, 148, 25).fill(accent);
      doc.strokeColor('#ffffff').lineWidth(4.5).lineCap('round');
      if (ok) {
        doc.moveTo(75, 148).lineTo(83, 156).lineTo(98, 139).stroke();
      } else {
        doc.moveTo(77, 139).lineTo(95, 157).stroke();
        doc.moveTo(95, 139).lineTo(77, 157).stroke();
      }

      // Title + subtitle
      doc.font('bn-bold').fontSize(16.5).fillColor(accent)
        .text(ok ? 'যাচাই সফল হয়েছে' : 'যাচাই সফল হয়নি', 126, 128, { width: 400 });
      doc.font('bn').fontSize(11.5).fillColor('#374151')
        .text(bnTxt(ok
          ? (successLine || 'যাচাই সফলভাবে সম্পন্ন হয়েছে।')
          : ('কারণ: ' + (reason || 'তথ্য মেলেনি'))),
          126, 154, { width: 398 });

      // Divider inside the card
      doc.strokeColor('#eadfc8').lineWidth(1).moveTo(72, 198).lineTo(523, 198).stroke();

      // Details rows
      const rows = [
        ['সেবা', serviceLabel || 'যাচাই', false],
        [subjectLabel || 'বিষয়', subjectValue || '—', false],
        ['তারিখ ও সময়', whenBn, false],
        ['সেবা চার্জ', chargeText || '', true],
        ['রেফারেন্স', ref, false],
      ];
      rows.forEach(([label, value, bold], i) => {
        const y = 214 + i * 31;
        // Font is chosen from the DRAWN text (after the QR→কিউআর
        // spelling), never the raw value: a mixed string that
        // becomes pure Bengali must stay in the Bengali font.
        const drawn = bnTxt(value);
        doc.font('bn').fontSize(11).fillColor('#6b7280').text(label, 72, y, { width: 138 });
        doc.font(valFont(drawn, bold)).fontSize(11.5)
          .fillColor(bold ? accent : '#111827')
          .text(drawn, 218, y, { width: 305 });
      });

      // Footers (all-Bengali wording — Latin would print as boxes)
      let fy = 424;
      for (const line of (footers || [])) {
        doc.font('bn').fontSize(9.5).fillColor('#6b7280').text(bnTxt(line), X, fy, { width: W });
        fy += 26;
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { buildReceiptPdf };
