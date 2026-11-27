'use strict';

const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, '..', '..', 'frontend', 'fonts');
const MARGIN = 44;
const INK = '#19382e';
const MUTED = '#496358';
const LINE = '#dbe8e0';
const EMERALD = '#07563e';
const PAPER = '#f2f8f4';

function buildAutoNidReportPdf({ label, record }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: { Title: 'All In One - NID Verification Report', Author: 'All In One' },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // Both bundled Hind Siliguri faces cover Bengali and Latin in mixed text.
    doc.registerFont('hind', path.join(FONT_DIR, 'ijwTs5juQtsyLLR5jN4cxBEofJs.ttf'));
    doc.registerFont('hind-bold', path.join(FONT_DIR, 'ijwOs5juQtsyLLR5jN4cxBEoRCf_4uE.ttf'));

    const pageWidth = doc.page.width - 2 * MARGIN;
    const footerTop = doc.page.height - 63;
    const bodyBottom = footerTop - 18;
    const labelWidth = 124;
    const valueX = MARGIN + labelWidth;
    const valueWidth = pageWidth - labelWidth - 12;
    let pageNumber = 0;
    let cursorY;

    function drawPage() {
      pageNumber += 1;
      doc.roundedRect(MARGIN, 40, pageWidth, 106, 13).fill(EMERALD);
      doc.font('hind-bold').fontSize(12).fillColor('#d4eee2')
        .text('All In One', MARGIN + 22, 55, { width: pageWidth - 44 });
      doc.font('hind-bold').fontSize(24).fillColor('#ffffff')
        .text('এনআইডি তথ্য যাচাই প্রতিবেদন', MARGIN + 22, 76, { width: pageWidth - 44 });
      doc.font('hind').fontSize(12).fillColor('#d4eee2')
        .text(label, MARGIN + 22, 112, { width: pageWidth - 44 });

      doc.lineWidth(0.75).strokeColor(LINE)
        .moveTo(MARGIN, footerTop).lineTo(MARGIN + pageWidth, footerTop).stroke();
      doc.font('hind').fontSize(10).fillColor(MUTED)
        .text('ব্যক্তিগত তথ্য', MARGIN, footerTop + 9, { width: pageWidth / 2 });
      doc.text(String(pageNumber), MARGIN + pageWidth / 2, footerTop + 9, {
        width: pageWidth / 2, align: 'right',
      });
      cursorY = 165;
    }

    function ensureSpace(height) {
      if (cursorY + height <= bodyBottom) return;
      doc.addPage();
      drawPage();
    }

    function sectionTitle(title, minimumContentHeight) {
      ensureSpace(32 + minimumContentHeight);
      doc.font('hind-bold').fontSize(15).fillColor(EMERALD)
        .text(title, MARGIN, cursorY, { width: pageWidth });
      cursorY += 28;
    }

    function detailRow(title, value) {
      doc.font('hind').fontSize(12);
      const valueOptions = { width: valueWidth, lineGap: 2 };
      const height = Math.max(34, doc.heightOfString(value, valueOptions) + 14);
      ensureSpace(height);
      doc.font('hind-bold').fontSize(11).fillColor(MUTED)
        .text(title, MARGIN + 10, cursorY + 8, { width: labelWidth - 16 });
      doc.font('hind').fontSize(12).fillColor(INK)
        .text(value, valueX, cursorY + 7, valueOptions);
      cursorY += height;
      doc.lineWidth(0.65).strokeColor(LINE)
        .moveTo(MARGIN, cursorY).lineTo(MARGIN + pageWidth, cursorY).stroke();
    }

    const identity = [
      ['এনআইডি নম্বর', record.nationalId],
      ['পিন নম্বর', record.pin !== record.nationalId ? record.pin : ''],
      ['জন্মতারিখ', record.dateOfBirth],
      ['নাম (বাংলা)', record.nameBn],
      ['নাম (ইংরেজি)', record.nameEn],
      ['পিতার নাম', record.fatherName],
      ['মাতার নাম', record.motherName],
      ['লিঙ্গ', record.gender],
    ].filter(([, value]) => value);
    const addresses = [
      ['বর্তমান ঠিকানা', record.presentAddress],
      ['স্থায়ী ঠিকানা', record.permanentAddress],
    ].filter(([, value]) => value);
    const addressOptions = { width: pageWidth - 28, lineGap: 2 };
    const addressHeight = (value) => {
      doc.font('hind').fontSize(12);
      return doc.heightOfString(value, addressOptions) + 40;
    };

    drawPage();
    sectionTitle('পরিচয়ের তথ্য', 34);
    for (const [title, value] of identity) detailRow(title, value);

    if (addresses.length) {
      cursorY += 18;
      sectionTitle('ঠিকানা', addressHeight(addresses[0][1]));
      for (const [title, value] of addresses) {
        const height = addressHeight(value);
        ensureSpace(height);
        doc.roundedRect(MARGIN, cursorY, pageWidth, height, 9).fillAndStroke(PAPER, LINE);
        doc.font('hind-bold').fontSize(11.5).fillColor(EMERALD)
          .text(title, MARGIN + 14, cursorY + 10, addressOptions);
        doc.font('hind').fontSize(12).fillColor(INK)
          .text(value, MARGIN + 14, cursorY + 27, addressOptions);
        cursorY += height + 10;
      }
    }

    doc.end();
  });
}

module.exports = { buildAutoNidReportPdf };
