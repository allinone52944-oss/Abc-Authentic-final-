// Audit #39 — a filed BDRIS application appears in History with its
// tracking number, a link to the filing page, and a PDF-ready note.
// The original Form-1 PDF is NOT offered as a direct download: it
// needs JWT + a paid charge token from the filing page, so a direct
// link here would be a fake download link (history PDF-copy rule).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('history.html — BDRIS filings (audit #39)', () => {
  const html = read('frontend/history.html');

  test('bdris icon + kind filter option exist', () => {
    expect(html).toContain("bdris:'📋'");
    expect(html).toContain('<option value="bdris">বিডিআরআইএস আবেদন</option>');
  });

  test('a BDRIS item renders a filing-page link and a PDF-ready note', () => {
    expect(html).toContain('আবেদন দেখুন');
    expect(html).toContain('আসল PDF তৈরি — আবেদন পাতা থেকে নামান');
    expect(html).toContain('original_pdf_available');
  });

  test('no direct PDF download is offered for a BDRIS item', () => {
    // the bdris render branch builds a link button only; it never
    // puts a documents download in the item (bounded to the extra
    // block — dlHist for other kinds lives elsewhere in the file)
    const start = html.indexOf("it.kind === 'bdris'");
    const branch = html.slice(start, html.indexOf("return '<div class=\"hist-item\">'", start));
    expect(branch).not.toMatch(/downloadPdf|dlHist|href=.*\.pdf/i);
  });
});
