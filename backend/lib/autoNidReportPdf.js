'use strict';

const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { buildTinCertificatePdf } = require('./tinCertificatePdf');

const FONT_DIR = path.join(__dirname, '..', '..', 'frontend', 'fonts');
const SERVER_COPY_ASSETS = path.join(__dirname, 'nid-server-copy', 'assets');
const MARGIN = 44;
const INK = '#19382e';
const MUTED = '#496358';
const LINE = '#dbe8e0';
const EMERALD = '#07563e';
const PAPER = '#f2f8f4';

// The SV Copy Premium output is the NIDW portal "Server Copy" itself, laid
// out exactly like the portal print (backend/lib/nid-server-copy/assets/
// portal-background.png carries the banner, search chrome, table gridlines
// and border; the text below is overlaid at the template's measured
// positions). Data values come from the lookup record verbatim — nothing is
// reformatted, added or dropped; only the presentation follows the template.
const COPY = {
  // Portal chrome (template page 595.92 x 841.92; A4 differs by 0.6pt).
  background: { x: 16.5, y: 0, width: 562.5, height: 798.8 },
  // Left column.
  portrait: { x: 106.5, y: 205.5, width: 91, height: 105 },
  qr: { x: 114.8, y: 351.8, size: 75 },
  portraitName: { x: 106.5, y: 317, width: 91 },
  // Right-column tables.
  labelX: 225,
  valueX: 326,
  tableRight: 498.5,
};

// The portal QR encodes name, PIN and date of birth joined by ⇋ (U+21CB).
function serverCopyQrPayload(record) {
  return [record.nameEn || '', record.pin || record.nationalId || '', record.dateOfBirth || ''].join('⇋');
}

async function makeServerCopyQr(record) {
  return QRCode.toBuffer(serverCopyQrPayload(record), {
    errorCorrectionLevel: 'M',
    margin: 0,
    width: 150,
  });
}

function drawServerCopyReport(doc, record, qr) {
  const missing = 'N/A';
  const value = (text) => text || missing;
  const ink = '#070707';

  // Portal chrome: banner, search UI, table gridlines, border.
  doc.image(path.join(SERVER_COPY_ASSETS, 'portal-background.png'),
    COPY.background.x, COPY.background.y,
    { width: COPY.background.width, height: COPY.background.height });

  // Search section (static portal chrome text).
  doc.font('serif-bold').fontSize(12).fillColor('#ffe000')
    .text('National Identity Registration Wing (NIDW)', 185, 64);
  doc.font('serif-bold').fontSize(10.5).fillColor('#ff2fa1')
    .text('Select Your Search Category', 225, 87);
  doc.font('serif').fontSize(8.2).fillColor('#ffffff').text('Home', 517, 92);
  doc.font('serif').fontSize(9).fillColor('#087904')
    .text('Search By NID / Voter No.', 270, 102);
  doc.font('serif').fontSize(9).fillColor('#0777b8')
    .text('Search By Form No.', 270, 114);
  doc.font('serif-bold').fontSize(9).fillColor('#fc0000')
    .text('NID or Voter No*', 185, 135);
  doc.font('serif').fontSize(9).fillColor('#8f8f8f').text('NID', 270, 135);
  doc.font('serif').fontSize(8.2).fillColor('#ffffff').text('Submit', 370, 137);

  // Portrait + name + QR (left column).
  doc.rect(COPY.portrait.x, COPY.portrait.y, COPY.portrait.width, COPY.portrait.height)
    .fillAndStroke('#ffffff', '#dbe8e0');
  if (Buffer.isBuffer(record.portrait)) {
    try {
      const image = doc.openImage(record.portrait);
      if (image.width > 0 && image.height > 0 && image.width * image.height <= 4_000_000) {
        doc.image(image, COPY.portrait.x, COPY.portrait.y,
          { fit: [COPY.portrait.width, COPY.portrait.height], align: 'center', valign: 'center' });
      }
    } catch {
      // A malformed optional portrait does not prevent delivery of verified information.
    }
  }
  if (record.nameEn) {
    doc.font('serif-bold').fontSize(9.8).fillColor(ink)
      .text(record.nameEn, COPY.portraitName.x, COPY.portraitName.y,
        { width: COPY.portraitName.width, align: 'center', lineGap: 1 });
  }
  if (Buffer.isBuffer(qr)) {
    doc.image(qr, COPY.qr.x, COPY.qr.y, { width: COPY.qr.size, height: COPY.qr.size });
  }

  // Right-column tables. Each row is [labelY, valueY, label, value, labelFont, valueFont].
  function heading(title, y) {
    doc.font('hind-bold').fontSize(12).fillColor(ink).text(title, COPY.labelX, y);
  }
  function row(labelY, valueY, label, text, labelFont, valueFont, labelSize = 10.5, valueSize = 10.5) {
    doc.font(labelFont).fontSize(labelSize).fillColor(ink)
      .text(label, COPY.labelX, labelY, { width: COPY.valueX - COPY.labelX - 6 });
    doc.font(valueFont).fontSize(valueSize).fillColor(ink)
      .text(text, COPY.valueX, valueY, { width: COPY.tableRight - COPY.valueX });
  }

  heading('জাতীয় পরিচিতি তথ্য', 215);
  row(239, 237, 'জাতীয় পরিচয় পত্র নম্বর', value(record.nationalId), 'hind', 'serif', 9.8);
  row(261, 259, 'পিন নম্বর', value(record.pin), 'hind', 'serif', 9.8);
  row(281, 279, 'পূর্ববর্তী পরিচয়পত্র নম্বর', value(record.oldNid), 'hind', 'serif', 9.8);
  row(301, 299, 'ভোটার এলাকা', value(record.voterArea), 'hind', 'hind');
  row(323, 321, 'জন্মস্থান', value(record.birthPlace), 'hind', 'hind');

  heading('ব্যক্তিগত তথ্য', 343);
  row(366, 364, 'নাম (বাংলা)', value(record.nameBn), 'hind', 'hind-bold');
  row(390, 387, 'নাম (ইংরেজি)', value(record.nameEn), 'hind', 'serif');
  row(409, 407, 'জন্ম তারিখ', value(record.dateOfBirth), 'hind', 'serif');
  row(431, 431, 'পিতার নাম', value(record.fatherName), 'hind', 'hind');
  row(451, 451, 'মাতার নাম', value(record.motherName), 'hind', 'hind');

  heading('অন্যান্য তথ্য', 470);
  row(498, 498, 'লিঙ্গ', value(record.gender), 'hind', 'hind');
  row(519, 519, 'ধর্ম', value(record.religion), 'hind', 'hind');
  row(541, 541, 'পেশা', value(record.profession), 'hind', 'hind');

  // Addresses wrap inside the template's cells (9pt, 12pt line pitch).
  function address(title, y, text) {
    heading(title, y);
    doc.font('hind').fontSize(9).fillColor(ink)
      .text(value(text), COPY.labelX, y + 22,
        { width: COPY.tableRight - COPY.labelX, lineGap: 3 });
  }
  address('বর্তমান ঠিকানা', 582, record.presentAddress);
  address('স্থায়ী ঠিকানা', 656, record.permanentAddress);

  // Footer disclaimers.
  doc.font('hind').fontSize(9).fillColor('#ff0000')
    .text('উপরে প্রদর্শিত তথ্যসমূহ জাতীয় পরিচয়পত্র সংশ্লিষ্ট, ভোটার তালিকার সাথে সরাসরি সম্পর্কযুক্ত নয়।',
      0, 736, { width: doc.page.width, align: 'center' });
  doc.font('serif').fontSize(9).fillColor('#030303')
    .text("This is Software Generated Report From Bangladesh Election Commission, Signature & Seal Aren't Required.",
      0, 747, { width: doc.page.width, align: 'center' });
}

function buildAutoNidReportPdf({ type, label, record }) {
  return buildVerificationPdf({ type, label, record });
}

function buildAutoTinReportPdf(record) {
  // The TIN output is the NBR certificate itself, 100% like the sample
  // (backend/lib/tinCertificatePdf.js), not the All In One report style.
  return buildTinCertificatePdf(record);
}

async function buildVerificationPdf({ type, label, record }) {
  const tin = type === 'tin';
  const title = tin ? 'TIN তথ্য যাচাই প্রতিবেদন' : 'এনআইডি তথ্য যাচাই প্রতিবেদন';
  // The premium server copy carries a QR (name ⇋ PIN ⇋ DOB), generated here
  // so the draw step stays synchronous.
  const qr = type === 'premium' ? await makeServerCopyQr(record) : null;
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
    // Liberation Serif is metrically identical to the template's Times New Roman.
    doc.registerFont('serif', path.join(FONT_DIR, 'LiberationSerif-Regular.ttf'));
    doc.registerFont('serif-bold', path.join(FONT_DIR, 'LiberationSerif-Bold.ttf'));
    if (type === 'premium') {
      drawServerCopyReport(doc, record, qr);
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

module.exports = { buildAutoNidReportPdf, buildAutoTinReportPdf, serverCopyQrPayload };
