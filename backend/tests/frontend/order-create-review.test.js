// Audit #40 — no review/summary step before payment. One click used to
// cut the wallet; now the order page shows a "তথ্য + ফাইল + ফি" review
// and the wallet is cut only on the confirm click inside the review.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('order-create.html — review step before payment (audit #40)', () => {
  const html = read('frontend/order-create.html');
  const script = html.slice(html.indexOf('<script>', html.indexOf('app.js')));
  const showReviewFn = script.slice(script.indexOf('function showReview(){'), script.indexOf('function editAgain(){'));
  const submitFn = script.slice(script.indexOf('async function submit(){'), script.indexOf('init();'));

  test('the main button opens the review, it does not confirm the order', () => {
    expect(html).toContain('id="submitBtn"');
    expect(html).toContain('পর্যালোচনা করুন →');
    expect(html).not.toContain('>অর্ডার নিশ্চিত করুন →</button>');
    expect(script).toContain('sbBtn.onclick = showReview');
  });

  test('a review box exists (hidden until review) with back + confirm', () => {
    expect(html).toContain('id="reviewBox"');
    expect(html).toContain('display:none');
    expect(html).toContain('id="reviewBody"');
    expect(html).toContain('id="reviewBackBtn"');
    expect(html).toContain('onclick="editAgain()"');
    expect(html).toContain('id="reviewConfirmBtn"');
    expect(html).toContain('onclick="submit()"');
    expect(html).toContain('ফিরে গিয়ে ঠিক করুন');
  });

  test('the review shows তথ্য + ফাইল + ফি (fee, balance, balance after)', () => {
    expect(showReviewFn).toContain('তথ্য');
    expect(showReviewFn).toContain('ফাইল');
    expect(showReviewFn).toContain('সেবার ফি');
    expect(showReviewFn).toContain('ওয়ালেট ব্যালেন্স');
    expect(showReviewFn).toContain('কনফার্ম করলে কাটার পর থাকবে');
    expect(showReviewFn).toContain('কাটা হবে');
  });

  test('no wallet charge happens in the review step — the POST lives in confirm only', () => {
    expect(showReviewFn).not.toContain("ABC.api('/orders'");
    expect(submitFn).toContain("ABC.api('/orders'");
    // the confirm re-collects (the review is a snapshot) and posts
    expect(submitFn).toContain('collectOrder()');
    expect(script).toContain('function collectOrder(){');
  });

  test('a failed confirm returns to the form (review hidden, main button back)', () => {
    expect(submitFn).toContain('editAgain()');
    expect(script).toContain("document.getElementById('reviewBox').style.display = 'none'");
    expect(script).toContain("document.getElementById('submitBtn').style.display = 'block'");
  });

  test('the review warns when the balance cannot cover the fee', () => {
    expect(showReviewFn).toContain('ব্যালেন্স অপর্যাপ্ত');
  });
});
