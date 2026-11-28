'use strict';

const path = require('path');
const PDFDocument = require('pdfkit');
const { buildTinCertificatePdf } = require('./tinCertificatePdf');

const FONT_DIR = path.join(__dirname, '..', '..', 'frontend', 'fonts');
const MARGIN = 44;
const INK = '#19382e';
const MUTED = '#496358';
const LINE = '#dbe8e0';
const EMERALD = '#07563e';
const PAPER = '#f2f8f4';

function drawPremiumReport(doc, label, record) {
  const width = doc.page.width - 2 * MARGIN;
  const portraitX = 106.5;
  const portraitY = 205.5;
  const portraitWidth = 91;
  const portraitHeight = 105;
  const tableX = 224.5;
  const tableWidth = 274;
  const footerY = doc.page.height - 52;
  const missing = 'NA';
  let page = 0;
  let y;

  function startPage() {
    page += 1;
    doc.roundedRect(MARGIN, 35, width, 72, 10).fill(EMERALD);
    doc.font('hind-bold').fontSize(12).fillColor('#d4eee2').text('All In One', MARGIN + 16, 45);
    doc.font('hind-bold').fontSize(21).fillColor('#fff')
      .text('এনআইডি তথ্য যাচাই প্রতিবেদন', MARGIN + 16, 64, { width: width - 32 });
    doc.font('hind').fontSize(11).fillColor('#d4eee2')
      .text(label, MARGIN + 16, 46, { width: width - 32, align: 'right' });
    doc.lineWidth(.6).strokeColor(LINE).moveTo(MARGIN, footerY).lineTo(MARGIN + width, footerY).stroke();
    doc.font('hind').fontSize(9).fillColor(MUTED).text('All In One · ব্যক্তিগত তথ্য', MARGIN, footerY + 8);
    doc.text(String(page), MARGIN, footerY + 8, { width, align: 'right' });
    y = page === 1 ? 212 : 126;
  }

  function ensureRoom(height) {
    if (y + height <= footerY - 14) return;
    doc.addPage();
    startPage();
  }

  function heading(title) {
    doc.rect(tableX, y, tableWidth, 23).fill('#d2e9eb');
    doc.font('hind-bold').fontSize(12).fillColor(EMERALD)
      .text(title, tableX + 7, y + 4, { width: tableWidth - 14 });
    y += 23;
  }

  function table(title, rows) {
    const labelWidth = 101;
    const valueWidth = tableWidth - labelWidth - 14;
    const measured = rows.map(([name, value]) => {
      const text = value || missing;
      doc.font('hind').fontSize(10.5);
      const labelHeight = doc.heightOfString(name, { width: labelWidth - 12 });
      const valueHeight = doc.heightOfString(text, { width: valueWidth });
      return { name, text, height: Math.max(21, Math.max(labelHeight, valueHeight) + 8) };
    });
    ensureRoom(23 + measured.reduce((sum, row) => sum + row.height, 0));
    heading(title);
    for (const { name, text, height } of measured) {
      doc.lineWidth(.5).strokeColor(LINE).rect(tableX, y, tableWidth, height).stroke();
      doc.moveTo(tableX + labelWidth, y).lineTo(tableX + labelWidth, y + height).stroke();
      doc.font('hind').fontSize(10.5).fillColor(MUTED)
        .text(name, tableX + 7, y + 4, { width: labelWidth - 12 });
      doc.fillColor(INK).text(text, tableX + labelWidth + 7, y + 4, { width: valueWidth });
      y += height;
    }
  }

  function address(title, value) {
    const text = value || missing;
    const textOptions = { width: tableWidth - 14, lineGap: 2 };
    doc.font('hind').fontSize(10.5);
    const height = doc.heightOfString(text, textOptions) + 15;
    ensureRoom(23 + height);
    heading(title);
    doc.lineWidth(.5).strokeColor(LINE).rect(tableX, y, tableWidth, height).stroke();
    doc.font('hind').fontSize(10.5).fillColor(INK).text(text, tableX + 7, y + 7, textOptions);
    y += height + 6;
  }

  startPage();
  doc.rect(portraitX, portraitY, portraitWidth, portraitHeight).fillAndStroke(PAPER, LINE);
  if (Buffer.isBuffer(record.portrait)) {
    try {
      const image = doc.openImage(record.portrait);
      if (image.width > 0 && image.height > 0 && image.width * image.height <= 4_000_000) {
        doc.image(image, portraitX, portraitY, { fit: [portraitWidth, portraitHeight], align: 'center', valign: 'center' });
      }
    } catch {
      // A malformed optional portrait does not prevent delivery of verified information.
    }
  }
  const portraitName = record.nameEn || record.nameBn;
  if (portraitName) {
    doc.font('hind').fontSize(9).fillColor(MUTED)
      .text(portraitName, portraitX, portraitY + portraitHeight + 6, { width: portraitWidth, align: 'center' });
  }
  table('জাতীয় পরিচিতি তথ্য', [
    ['জাতীয় পরিচয়পত্র নম্বর', record.nationalId], ['পিন নম্বর', record.pin],
    ['পুরনো পরিচয়পত্র নম্বর', record.oldNid], ['ভোটার এলাকা', record.voterArea], ['জন্মস্থান', record.birthPlace],
  ]);
  table('ব্যক্তিগত তথ্য', [
    ['নাম (বাংলা)', record.nameBn], ['নাম (ইংরেজি)', record.nameEn], ['জন্ম তারিখ', record.dateOfBirth],
    ['পিতার নাম', record.fatherName], ['মাতার নাম', record.motherName],
  ]);
  table('অন্যান্য তথ্য', [['লিঙ্গ', record.gender], ['ধর্ম', record.religion], ['পেশা', record.profession]]);
  address('বর্তমান ঠিকানা', record.presentAddress);
  address('স্থায়ী ঠিকানা', record.permanentAddress);
}

function buildAutoNidReportPdf({ type, label, record }) {
  return buildVerificationPdf({ type, label, record });
}

function buildAutoTinReportPdf(record) {
  // The TIN output is the NBR certificate itself, 100% like the sample
  // (backend/lib/tinCertificatePdf.js), not the All In One report style.
  return buildTinCertificatePdf(record);
}

function buildVerificationPdf({ type, label, record }) {
  const tin = type === 'tin';
  const title = tin ? 'TIN তথ্য যাচাই প্রতিবেদন' : 'এনআইডি তথ্য যাচাই প্রতিবেদন';
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: { Title: 'All In One - ' + (tin ? 'TIN' : 'NID') + ' Verification Report', Author: 'All In One' },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // Both bundled Hind Siliguri faces cover Bengali and Latin in mixed text.
    doc.registerFont('hind', path.join(FONT_DIR, 'ijwTs5juQtsyLLR5jN4cxBEofJs.ttf'));
    doc.registerFont('hind-bold', path.join(FONT_DIR, 'ijwOs5juQtsyLLR5jN4cxBEoRCf_4uE.ttf'));
    if (type === 'premium') {
      drawPremiumReport(doc, label, record);
      doc.end();
      return;
    }

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
        .text(title, MARGIN + 22, 76, { width: pageWidth - 44 });
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

    const identity = (tin ? [
      ['TIN নম্বর', record.tin],
      ['নাম', record.name],
      ['পিতার নাম', record.fatherName],
      ['মাতার নাম', record.motherName],
      ['পূর্বের TIN', record.previousTIN],
      ['কর অঞ্চল', record.taxZone],
      ['কর সার্কেল', record.taxCircle],
      ['স্থিতি', record.status],
      ['তারিখ', record.date],
    ] : [
      ['এনআইডি নম্বর', record.nationalId],
      ['পিন নম্বর', record.pin !== record.nationalId ? record.pin : ''],
      ['জন্মতারিখ', record.dateOfBirth],
      ['নাম (বাংলা)', record.nameBn],
      ['নাম (ইংরেজি)', record.nameEn],
      ['পিতার নাম', record.fatherName],
      ['মাতার নাম', record.motherName],
      ['লিঙ্গ', record.gender],
    ]).filter(([, value]) => value);
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

module.exports = { buildAutoNidReportPdf, buildAutoTinReportPdf };
