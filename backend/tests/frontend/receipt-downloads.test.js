// Bug-class guard: receipt downloads must go through an authenticated
// blob fetch. Delivery files sit behind owner-only endpoints (header
// auth); a plain <a href> sends no login header and the server answers
// {"error":"NO_TOKEN"}. History downloads via ABC.api → blob; every
// page that shows a receipt button must do the same.
// (First shipped in land.html — fixed in 0d0ee36; the same pattern was
// then found in qr-photo-verify.html, bdris-certificate.html and
// death-verify.html.)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('qr-photo-verify.html receipt downloads', () => {
  const html = read('frontend/qr-photo-verify.html');
  test('receipt downloads use an authenticated blob fetch (dlPdf)', () => {
    expect(html).toContain('async function dlPdf(');
    expect(html).toContain('URL.createObjectURL(blob)');
    expect(html).toContain("dlPdf(\\'");
  });
  test('no raw receipt href remains', () => {
    expect(html).not.toContain('href="\' + d.receipt');
    expect(html).not.toContain("href='\" + d.receipt");
  });
  // Owner decision 2026-11-03 (commit 3a51649): the QR failure
  // screen shows a premium error with NO receipt button — the
  // failed receipt PDF still lands in the customer's History via
  // the backend, it is just not offered on the failure screen.
  test('success receipt button is wired; failure screen has NO receipt button', () => {
    expect(html).toContain('qr-receipt.pdf');
    expect(html).not.toContain('qr-receipt-failed.pdf');
  });
});

describe('bdris-certificate.html failure-receipt download', () => {
  const html = read('frontend/bdris-certificate.html');
  test('failure receipt uses an authenticated blob fetch (dlReceipt)', () => {
    expect(html).toContain('async function dlReceipt(');
    expect(html).toContain('URL.createObjectURL(blob)');
    expect(html).toContain('cert-receipt-failed.pdf');
  });
  test('no raw receipt href remains', () => {
    expect(html).not.toContain('<a href=');
    expect(html).toContain('>📄 ব্যর্থতার রসিদ ডাউনলোড</button>');
  });
  test('the certificate-generating dlPdf() is untouched', () => {
    expect(html).toContain('async function dlPdf(){');
    expect(html).toContain("onclick=\"dlPdf()\"");
  });
});

describe('death-verify.html failure-receipt download', () => {
  const html = read('frontend/death-verify.html');
  test('failure receipt uses an authenticated blob fetch (dlReceipt)', () => {
    expect(html).toContain('async function dlReceipt(');
    expect(html).toContain('URL.createObjectURL(blob)');
    expect(html).toContain('death-receipt-failed.pdf');
  });
  test('no raw receipt href remains', () => {
    expect(html).not.toContain('<a href=');
    expect(html).toContain('>📄 ব্যর্থতার রসিদ ডাউনলোড</button>');
  });
  test('the certificate-generating dlPdf() is untouched', () => {
    expect(html).toContain('async function dlPdf(){');
    expect(html).toContain("onclick=\"dlPdf()\"");
  });
});
