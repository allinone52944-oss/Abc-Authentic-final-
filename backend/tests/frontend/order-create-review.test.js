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
    expect(showReviewFn).toContain('কনফার্ম করলে ওয়ালেটে থাকবে'); // audit #44 — wallet part only, after the credit split
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

describe('order-create.html — fee breakdown with locked credit (audit #44)', () => {
  const html = read('frontend/order-create.html');
  const script = html.slice(html.indexOf('<script>', html.indexOf('app.js')));
  const initFn = script.slice(script.indexOf('async function init(){'), script.indexOf('function triggerDraftSave(){'));
  const showReviewFn = script.slice(script.indexOf('function showReview(){'), script.indexOf('function editAgain(){'));

  test('the page reads the per-service locked credit from GET /wallet', () => {
    expect(script).toContain("ABC.api('/wallet?limit=1')");
    expect(script).toContain('service_credits');
    expect(script).toContain('x.service_id === sid');
    expect(script).toContain('lockedCredit = Number');
  });

  test('the fee breakdown is shown (locked credit + wallet = total)', () => {
    expect(html).toContain('id="feeBreakdown"');
    expect(script).toContain('function feeSplit(price)');
    expect(script).toContain('function renderFeeBreakdown(price)');
    expect(script).toContain('লকড ক্রেডিট ৳');
    expect(script).toContain("+ ওয়ালেট ৳");
  });

  test('the balance warning is based on credit + wallet, not the wallet alone', () => {
    expect(initFn).toContain('userBal + lockedCredit < svcPrice');
    expect(initFn).toContain('svcPrice - userBal - lockedCredit');
    expect(initFn).not.toContain('if (userBal < svcPrice)');
    expect(initFn).toContain('লকড ক্রেডিট ৳');
  });

  test('the review uses the same split (credit first, then wallet)', () => {
    expect(showReviewFn).toContain('feeSplit(price)');
    expect(showReviewFn).toContain('লকড ক্রেডিট থেকে');
    expect(showReviewFn).toContain('ওয়ালেট থেকে');
    expect(showReviewFn).toContain('কনফার্ম করলে ওয়ালেটে থাকবে');
    // the shortfall flag counts the credit too
    expect(showReviewFn).toContain('userBal + lockedCredit < price');
  });
});

describe('order-create.html — coupon note + redeem link at checkout (audit #45)', () => {
  const html = read('frontend/order-create.html');
  const wallet = read('frontend/wallet.html');
  const script = html.slice(html.indexOf('<script>', html.indexOf('app.js')));
  const initFn = script.slice(script.indexOf('async function init(){'), script.indexOf('function triggerDraftSave(){'));

  test('a coupon note box with a redeem link sits on the order page', () => {
    expect(html).toContain('id="couponBox"');
    expect(html).toContain('কুপন কোড আছে?');
    expect(html).toContain('href="/wallet.html#couponCard"');
    expect(html).toContain('ওয়ালেটে রিডিম করুন →');
  });

  test('when this service has locked credit, the note says so in words', () => {
    expect(html).toContain('id="couponCreditNote"');
    expect(initFn).toContain('if (lockedCredit > 0)');
    expect(initFn).toContain("couponCreditNote");
    expect(initFn).toContain('লকড ক্রেডিট আছে — কনফার্ম করলে প্রথমে এখান থেকে কাটবে');
  });

  test('the wallet coupon card is the link target', () => {
    expect(wallet).toContain('id="couponCard"');
    expect(wallet).toContain('id="couponCode"');
  });
});

describe('order-create.html — one sample, one guided form (audit #46)', () => {
  const html = read('frontend/order-create.html');
  const script = html.slice(html.indexOf('<script>', html.indexOf('app.js')));
  const initFn = script.slice(script.indexOf('async function init(){'), script.indexOf('function triggerDraftSave(){'));

  test('the duplicate sample box is gone (no sampleWrap, no samplePre, no fill-into-input)', () => {
    expect(html).not.toContain('sampleWrap');
    expect(html).not.toContain('samplePre');
    expect(html).not.toContain('applySampleToInput');
    expect(html).not.toContain('ফরম্যাট ইনপুটে বসান');
    expect(html).not.toContain('ফরম্যাট রিসেট');
    expect(html).not.toContain('আপনার টাইপ করা তথ্য মুছে যাবে');
  });

  test('structured fields never show the free-text template', () => {
    // the structured branch renders only the fields; the sample is
    // referenced nowhere in it
    const structBranch = initFn.slice(initFn.indexOf("if(fields && fields.length > 0){"), initFn.indexOf('} else {'));
    expect(structBranch).not.toContain('rawSampleText');
  });

  test('the fallback is one guided form: read-only reference + EMPTY box, no auto-fill', () => {
    const fallback = initFn.slice(initFn.indexOf('} else {'));
    expect(fallback).toContain('নমুনা ফরম্যাট (শুধু দেখার জন্য)');
    expect(fallback).toContain("esc(rawSampleText)");
    expect(fallback).not.toContain('mdi.value = rawSampleText');
    expect(fallback).not.toContain('Auto-fill sample');
    expect(fallback).toContain('ফরম্যাট কপি');
    expect(fallback).toContain('উপরের নমুনা ফরম্যাটটি দেখে নিচের বক্সে আপনার সঠিক তথ্য লিখুন');
  });

  test('copySampleText still works (the one remaining sample action)', () => {
    expect(script).toContain('function copySampleText(){');
  });
});

describe('order-create.html — 10 MB check before submit, every path (audit #47)', () => {
  const html = read('frontend/order-create.html');
  const statusHtml = read('frontend/order-status.html');
  const script = html.slice(html.indexOf('<script>', html.indexOf('app.js')));
  const selectFn = script.slice(script.indexOf('function handleFileSelect(files){'), script.indexOf('function removeSelectedFile('));
  const docFbFn = script.slice(script.indexOf('function updateDocFeedback(inp, idx){'), script.indexOf('const LocalDraft'));
  const collectFn = script.slice(script.indexOf('function collectOrder(){'), script.indexOf('// Audit #40 — step 1'));

  test('one shared rule: 10 MB, the same limit the other pages use', () => {
    expect(script).toContain('const MAX_FILE_BYTES = 10 * 1024 * 1024;');
    expect(script).toContain('function fileTooBig(f)');
    expect(script).toContain('f.size > MAX_FILE_BYTES');
  });

  test('the multi-uploader (click + drag-drop) skips oversized files at selection', () => {
    expect(selectFn).toContain('fileTooBig(files[i])');
    expect(selectFn).toContain('১০ মেগাবাইটের বেশি');
    expect(selectFn).toContain('continue;');
  });

  test('a named-doc input rejects an oversized file at selection (clears it, shows why)', () => {
    expect(docFbFn).toContain('fileTooBig(f)');
    expect(docFbFn).toContain("inp.value = '';");
    expect(docFbFn).toContain('১০ মেগাবাইটের বেশি');
  });

  test('collectOrder re-checks every file before the paid POST (backstop)', () => {
    expect(collectFn).toContain('oversized');
    expect(collectFn).toContain('fileTooBig(inp.files[0])');
    expect(collectFn).toContain('fileTooBig(f)');
    expect(collectFn).toContain('১০ মেগাবাইটের বেশি');
    expect(collectFn).toContain('return null;');
  });

  test('recovery: the status-page warning points at the in-page upload, not the detail chat', () => {
    // fixed by #43 (in-page upload) and pinned here as #47's second half
    const box = statusHtml.slice(statusHtml.indexOf('id="docWarningBox"'), statusHtml.indexOf('id="docWarningBox"') + 600);
    expect(box).toContain('ফাইল যোগ করুন');
    expect(box).not.toContain('অর্ডার ডিটেইলস ও চ্যাট');
    expect(statusHtml).toContain('function uploadExtraDoc(files)');
  });
});
