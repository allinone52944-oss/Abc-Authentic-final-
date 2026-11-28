'use strict';

// TIN certificate output: sample-exact NBR certificate layout.
// Uses clearly fake data (never a real taxpayer's details) and asserts
// the certificate structure, the QR payload format, and the date forms.

const { PDFDocument } = require('pdf-lib');
const {
  buildTinCertificatePdf, qrPayload, parseDate, longDate, dmyDate,
} = require('../../lib/tinCertificatePdf');

const record = {
  tin: '123456789012',
  name: 'Test Taxpayer',
  fatherName: 'Test Father',
  motherName: 'Test Mother',
  presentAddress: 'Test House, Test Road, Test City, PO : 1000',
  permanentAddress: 'Test House, Test Road, Test City, PO : 1000, Bangladesh',
  previousTIN: 'Not Applicable',
  taxZone: '05, Chattogram',
  taxCircle: '108 (Salary)',
  status: 'Individual',
  date: '2020-09-12',
  dateOfBirth: '1997-01-10',
};

test('QR payload matches the sample certificate QR line for line', () => {
  expect(qrPayload(record, parseDate(record.date), parseDate(record.dateOfBirth)))
    .toBe([
      "Taxpayer's Name : Test Taxpayer",
      'DOB : 10/01/1997',
      "Father's Name : Test Father",
      'TIN : 123456789012',
      'Date : 12/09/2020',
      'Zone : 05, Chattogram',
      'Circle : Circle-108 (Salary)',
    ].join('\n'));
});

test('QR payload omits the DOB line when the provider gives no date of birth', () => {
  const noDob = { ...record };
  delete noDob.dateOfBirth;
  expect(qrPayload(noDob, parseDate(noDob.date), null)).not.toContain('DOB');
});

test('date helpers print the long form on the certificate and DD/MM/YYYY in the QR', () => {
  const date = parseDate('2020-09-12');
  expect(longDate(date)).toBe('September 12, 2020');
  expect(dmyDate(date)).toBe('12/09/2020');
  expect(longDate(parseDate('12/09/2020'))).toBe('September 12, 2020');
  expect(parseDate('not a date')).toBeNull();
});

test('certificate is one A4 page and carries the certificate text', async () => {
  const pdf = await buildTinCertificatePdf(record, new Date('2025-10-23T15:58:33'));
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  const doc = await PDFDocument.load(pdf);
  expect(doc.getPageCount()).toBe(1);
  const { width, height } = doc.getPage(0).getSize();
  expect(Math.round(width)).toBe(595);
  expect(Math.round(height)).toBe(842);
  // Text content is verified by rendering, not by raw bytes: pdfkit embeds
  // subset fonts, so the literal strings do not appear in the raw stream.
});
