// Past-applications list (2026-11-07) — a filed BDRIS application
// appears in History with its tracking number, a link to the filing
// page, and its stored original Form-1 PDF when retrievable: the
// download comes from the owner-only endpoint
// (GET /api/bdris-apply/applications/:ackNo/original — a
// re-download of the already-paid copy, no new charge) via the
// normal documents button, and a view button opens the same copy
// in a new tab. No bare static /bdris-original-*.pdf link is ever
// built client-side (no token in a URL).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('history.html — BDRIS filings (past-applications list)', () => {
  const html = read('frontend/history.html');

  test('bdris icon + kind filter option exist', () => {
    expect(html).toContain("bdris:'📋'");
    expect(html).toContain('<option value="bdris">বিডিআরআইএস আবেদন</option>');
  });

  test('a BDRIS item renders a filing-page link, a PDF download and a view button', () => {
    expect(html).toContain('আবেদন দেখুন');
    expect(html).toContain('আসল PDF তৈরি');
    expect(html).toContain('আসল PDF দেখুন');
    expect(html).toContain('viewHist(');
    expect(html).toContain('original_pdf_available');
  });

  test('the BDRIS download/view go through the owner-only endpoint, never a bare static file', () => {
    // the download is the generic documents button (dlHist) fed by
    // the API's documents array — the page never builds a
    // /bdris-original-*.pdf URL itself, and the view opens the same
    // blob URL in a new tab
    expect(html).toContain('function viewHist(');
    expect(html).toContain('window.open(');
    expect(html).not.toContain('bdris-original');
  });
});
