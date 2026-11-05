// Audit R1 — the per-success/failure receipt system is REMOVED from
// the result screens; the user is informed premium-ly instead.
// (User's words, 2026-11-05: "proti sofol/bifol-e j rasid system
// ache ta bad diye premium vabe janabe".)
// The split follows the owner's 2026-11-03 precedent (commit
// 3a51649: QR failure screen, premium error, NO receipt button —
// the receipt PDF still lands in History via the backend):
//   - Result screens offer NO receipt download on success or on
//     failure. The informing is the page's own result state
//     (success: outcome + charge + balance; failure: real reason
//     + 'কোনো টাকা কাটা হয়নি' + next step) plus a history link.
//   - The BACKEND is untouched: receipt PDFs are still generated
//     and stored as order documents, so History keeps the PDF
//     download copy (the history PDF-copy rule, 2026-11-05).
//   - DELIVERABLE PDFs are untouched: the khatian summary report,
//     the land reports and the certificates still download from
//     their result screens (authenticated blob fetch, NO_TOKEN
//     guard — first shipped in land.html, fixed in 0d0ee36).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('qr-photo-verify.html — no receipt on the result screen (audit R1)', () => {
  const html = read('frontend/qr-photo-verify.html');
  test('success shows the informing + history link, no receipt button', () => {
    expect(html).not.toContain('qr-receipt.pdf');
    expect(html).not.toContain('রসিদ ডাউনলোড');
    expect(html).not.toContain('async function dlPdf(');
    expect(html).toContain('যাচাই সফল!');
    expect(html).toContain('ইতিহাসে দেখুন →');
  });
  test('failure screen still has NO receipt button (2026-11-03 precedent)', () => {
    expect(html).not.toContain('qr-receipt-failed.pdf');
  });
  test('the note promises the record in history, not a receipt', () => {
    expect(html).toContain('সফল যাচাইয়ের রেকর্ড আপনার');
    expect(html).not.toContain('রসিদটি আপনার');
  });
});

describe('birth-final.html — no failure-receipt button (audit R1)', () => {
  const html = read('frontend/birth-final.html');
  test('the failure box informs (no charge + history), no receipt download', () => {
    expect(html).not.toContain('async function dlReceipt(');
    expect(html).not.toContain('cert-receipt-failed.pdf');
    expect(html).not.toContain('ব্যর্থতার রসিদ ডাউনলোড');
    expect(html).toContain('✅ কোনো টাকা কাটা হয়নি');
    expect(html).toContain('ইতিহাসে দেখুন →');
  });
  test('no raw receipt href remains', () => {
    expect(html).not.toContain('href="\' + d.receipt');
  });
  test('the certificate-generating dlPdf() is untouched', () => {
    expect(html).toContain('async function dlPdf(){');
    expect(html).toContain("onclick=\"dlPdf()\"");
  });
});

describe('death-final.html — no failure-receipt button (audit R1)', () => {
  const html = read('frontend/death-final.html');
  test('the failure box informs (no charge + history), no receipt download', () => {
    expect(html).not.toContain('async function dlReceipt(');
    expect(html).not.toContain('death-receipt-failed.pdf');
    expect(html).not.toContain('ব্যর্থতার রসিদ ডাউনলোড');
    expect(html).toContain('✅ কোনো টাকা কাটা হয়নি');
    expect(html).toContain('ইতিহাসে দেখুন →');
  });
  test('no raw receipt href remains', () => {
    expect(html).not.toContain('href="\' + d.receipt');
  });
  test('the certificate-generating dlPdf() is untouched', () => {
    expect(html).toContain('async function dlPdf(){');
    expect(html).toContain("onclick=\"dlPdf()\"");
  });
});

describe('land-khatian.html — failure offers no download, success keeps the deliverable (audit R1)', () => {
  const html = read('frontend/land-khatian.html');
  test('the failure box shows the history link only', () => {
    expect(html).toContain('appendDownloadAndHistory(e, null)');
    expect(html).not.toContain('appendReceiptAndHistory');
  });
  test('the success box still downloads the summary report (the deliverable)', () => {
    expect(html).toContain('appendDownloadAndHistory(o, receiptUrl)');
    expect(html).toContain('📄 সারাংশ রিপোর্ট (PDF) ডাউনলোড');
    expect(html).toContain('async function dlPdf(');
    expect(html).toContain('URL.createObjectURL(blob)');
  });
});

describe('land.html — failed lookup offers no receipt (audit R1)', () => {
  const html = read('frontend/land.html');
  test('no receipt button on failure; the report downloads stay', () => {
    expect(html).not.toContain('land-receipt.pdf');
    expect(html).not.toContain('📄 রসিদ (PDF) ডাউনলোড করুন');
    expect(html).toContain('📄 রিপোর্ট (PDF) ডাউনলোড করুন');
    expect(html).toContain('async function dlPdf(');
  });
});

describe('land-mouza-map.html — no receipt promise (audit R1)', () => {
  const html = read('frontend/land-mouza-map.html');
  test('the note promises the record in history, not a receipt', () => {
    expect(html).toContain('এই কাজের রেকর্ড আপনার');
    expect(html).not.toContain('রসিদটি আপনার');
  });
});
