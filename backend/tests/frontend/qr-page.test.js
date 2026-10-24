// Wiring guards for the QR + photo verification page:
//  - receipt downloads must go through the authenticated blob fetch
//    (the owner-only documents endpoint answers {"error":"NO_TOKEN"}
//    to a plain <a href>, which sends no login header — the same bug
//    that shipped in land.html and was fixed in 0d0ee36).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('qr-photo-verify.html downloads', () => {
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
  test('both receipt buttons are wired (success + failure)', () => {
    expect(html).toContain('qr-receipt.pdf');
    expect(html).toContain('qr-receipt-failed.pdf');
  });
});
