'use strict';

// Sample-exact NBR TIN Certificate output.
// Layout measurements are taken from a genuine NBR TIN certificate PDF
// (A4, Arial 10/13pt, triple border, emblem + watermark + QR).
// The record comes from the BDX TIN lookup (backend/lib/bdxTinClient.js):
//   tin, name, fatherName, motherName, presentAddress, permanentAddress,
//   previousTIN, taxZone, taxCircle, status, date, dateOfBirth (optional).
// Liberation Sans is metric-compatible with the sample's Arial, so the
// line breaks match the sample when the same sizes and widths are used.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const FONT_DIR = path.join(__dirname, '..', '..', 'frontend', 'fonts');
const ASSET_DIR = path.join(__dirname, 'tin-certificate', 'assets');
const EMBLEM = path.join(ASSET_DIR, 'emblem.png');
const WATERMARK = path.join(ASSET_DIR, 'watermark.png');

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const LEFT = 49;
const RIGHT_EDGE = 546; // text wraps to ~x=544 like the sample
const TEXT_W = RIGHT_EDGE - LEFT;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function circleText(record) {
  const raw = clean(record.taxCircle).replace(/^(Taxes\s+Circle-?|Circle-?)\s*/i, '');
  return raw ? 'Taxes Circle-' + raw : '';
}

function zoneText(record) {
  const raw = clean(record.taxZone).replace(/^Taxes\s+Zone\s*/i, '');
  return raw ? 'Taxes Zone ' + raw : '';
}

function circleShort(record) {
  const raw = clean(record.taxCircle).replace(/^(Taxes\s+Circle-?|Circle-?)\s*/i, '');
  return raw ? 'Circle-' + raw : '';
}

// The API date can arrive as ISO, DD/MM/YYYY, or a long English date.
// The certificate prints the long form ("September 12, 2020") and the
// QR carries DD/MM/YYYY ("12/09/2020").
function parseDate(value) {
  const text = clean(value);
  if (!text) return null;
  const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function longDate(date, fallback) {
  if (!date) return fallback;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function dmyDate(date, fallback) {
  if (!date) return fallback;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

function lastUpdateText(now) {
  const pad = (n) => String(n).padStart(2, '0');
  let hours = now.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()} ` +
    `${pad(hours)}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${ampm}`;
}

function qrPayload(record, certDate, dobDate) {
  const lines = [
    `Taxpayer's Name : ${clean(record.name)}`,
  ];
  if (dobDate) lines.push(`DOB : ${dmyDate(dobDate, '')}`);
  lines.push(
    `Father's Name : ${clean(record.fatherName)}`,
    `TIN : ${clean(record.tin)}`,
    `Date : ${dmyDate(certDate, clean(record.date))}`,
    `Zone : ${clean(record.taxZone)}`,
    `Circle : ${circleShort(record)}`,
  );
  return lines.join('\n');
}

async function buildTinCertificatePdf(record, now = new Date()) {
  const certDate = parseDate(record.date);
  const dobDate = parseDate(record.dateOfBirth);
  const circle = circleText(record);
  const zone = zoneText(record);
  const qr = await QRCode.toBuffer(qrPayload(record, certDate, dobDate), {
    errorCorrectionLevel: 'H',
    margin: 0,
    width: 600,
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: { Title: 'TIN Certificate', Author: 'National Board of Revenue (NBR)' },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('arial', path.join(FONT_DIR, 'LiberationSans-Regular.ttf'));
    doc.registerFont('arial-bold', path.join(FONT_DIR, 'LiberationSans-Bold.ttf'));

    // Triple border, like the sample: rects at 36 / 38 / 40.
    doc.lineWidth(1).strokeColor('#000000');
    doc.rect(36, 36, 523, 701.1).stroke();
    doc.rect(38, 38, 519, 697.1).stroke();
    doc.rect(40, 40, 515, 693.1).stroke();

    // Top emblem, 60 x 59.3 at (270, 65.1).
    if (fs.existsSync(EMBLEM)) doc.image(EMBLEM, 270, 65.1, { width: 60, height: 59.3 });

    // Titles, 13pt, centred. The sample centres on x=300 (a 600-wide
    // box), not on the 595-wide page centre, so use width 600 at x=0.
    doc.font('arial-bold').fontSize(13).fillColor('#000000');
    doc.text("Government of the People's Republic of Bangladesh", 0, 137.8, { width: 600, align: 'center' });
    doc.text('National Board of Revenue', 0, 164.1, { width: 600, align: 'center' });
    doc.font('arial').fontSize(13);
    doc.text("Taxpayer's Identification Number (TIN) Certificate", 0, 190.3, { width: 600, align: 'center' });
    const tinLine = `TIN : ${clean(record.tin)}`;
    doc.font('arial-bold').fontSize(13);
    doc.text(tinLine, 0, 216.5, { width: 600, align: 'center' });
    const tinWidth = doc.widthOfString(tinLine);
    const tinX = 300 - tinWidth / 2;
    doc.lineWidth(0.87).moveTo(tinX, 230.9).lineTo(tinX + tinWidth, 230.9).stroke();

    // Watermark emblem behind the body, 334 x 335 at (125, 207).
    if (fs.existsSync(WATERMARK)) doc.image(WATERMARK, 125, 207, { width: 334, height: 335 });

    // Certify paragraph, 10pt. Values in bold, exactly as the sample words it.
    // The sample's lines are 15pt apart, so lineGap 3.5 on the 11.5pt default.
    const bodyY = 261.7;
    doc.font('arial').fontSize(10).fillColor('#000000');
    doc.text('This is to Certify that ', LEFT, bodyY, { width: TEXT_W, lineGap: 3.5, continued: true });
    doc.font('arial-bold').text(`${clean(record.name)} `, { continued: true });
    doc.font('arial').text('is a Registered Taxpayer of National Board of Revenue under the jurisdiction of ', { continued: true });
    doc.font('arial-bold').text(`${circle} `, { continued: true });
    doc.font('arial').text(', Taxes Zone ', { continued: true });
    doc.font('arial-bold').text(`${zone.replace(/^Taxes Zone /, '')}.`);

    // Particulars, 10pt, one line each, 21.1pt apart, labels regular, values bold.
    const rows = [
      ["Taxpayer's Particulars :", null, true],
      [`1) Name : `, clean(record.name)],
      [`2) Father's Name : `, clean(record.fatherName)],
      [`3) Mother's Name : `, clean(record.motherName)],
      [`4.a) Current Address : `, clean(record.presentAddress)],
      [`4.b) Permanent Address : `, clean(record.permanentAddress)],
      [`5) Previous TIN : `, clean(record.previousTIN) || 'Not Applicable'],
      [`6) Status : `, clean(record.status)],
    ];
    let y = 297.8;
    for (const [label, value, heading] of rows) {
      if (heading) {
        doc.font('arial-bold').fontSize(10).text(label, LEFT, y, { width: TEXT_W });
      } else {
        doc.font('arial').fontSize(10).text(label, LEFT, y, { width: TEXT_W, continued: true });
        doc.font('arial-bold').text(value || '', { continued: false });
      }
      y += 21.1;
    }

    // Date line, 10pt.
    doc.font('arial').fontSize(10)
      .text(`Date : ${longDate(certDate, clean(record.date))}`, LEFT, 504.7, { width: TEXT_W });

    // QR code, 150 x 150 at (225, 520.6), with the red NBR mark in the centre.
    doc.image(qr, 225, 520.6, { width: 150, height: 150 });
    const qrCx = 225 + 75;
    const qrCy = 520.6 + 75;
    doc.rect(qrCx - 17, qrCy - 7, 34, 14).fill('#ffffff');
    doc.rect(qrCx - 17, qrCy - 7, 34, 14).fill('#e11d2e');
    doc.font('arial-bold').fontSize(9).fillColor('#ffffff')
      .text('NBR', qrCx - 17, qrCy - 5.5, { width: 34, align: 'center' });
    doc.fillColor('#000000');

    // Please Note block, 6pt.
    doc.font('arial-bold').fontSize(10).text('Please Note:', 51, 563.2);
    doc.lineWidth(0.67).moveTo(51, 574.3).lineTo(111, 574.3).stroke();
    const notes = [
      '1. A Taxpayer is liable to file the Return of Income under',
      'section 166 of the Income Tax Act, 2023.',
      '2. Failure to file Return of Income under Section 166 is',
      'liable to-',
      '   (a) Penalty under section 266; and',
      '   (b) Prosecution under section 311 of the Income Tax',
      '        Act, 2023.',
    ];
    doc.font('arial').fontSize(6);
    notes.forEach((line, i) => doc.text(line, 51, 575.3 + i * 9, { width: 300 }));

    // Deputy Commissioner block, 6pt.
    doc.font('arial-bold').fontSize(6).text('Deputy Commissioner of Taxes', 389, 581.3);
    doc.font('arial').fontSize(6);
    doc.text(circle, 389, 590.3);
    doc.text(zone, 389, 599.3);
    doc.text('Address : Phone :', 389, 608.3);

    // Last Update, 6pt, right edge at 551.
    const lastUpdate = `Last Update : ${lastUpdateText(now)}`;
    doc.font('arial').fontSize(6)
      .text(lastUpdate, 0, 684.4, { width: 551, align: 'right' });

    // N. B. line, 6pt, centred and underlined.
    const nb = 'N. B: This is a system generated certificate and requires no manual signature.';
    doc.font('arial').fontSize(6);
    doc.text(nb, 0, 702.0, { width: 600, align: 'center' });
    const nbWidth = doc.widthOfString(nb);
    const nbX = 300 - nbWidth / 2;
    doc.lineWidth(0.4).moveTo(nbX, 708.7).lineTo(nbX + nbWidth, 708.7).stroke();

    doc.end();
  });
}

module.exports = { buildTinCertificatePdf, qrPayload, parseDate, longDate, dmyDate };
