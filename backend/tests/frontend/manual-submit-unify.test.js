// Audit #51 — the legacy manual-submit path is UNIFIED into the
// order flow (user's call: merge, not remove, not leave-as-is).
// manual-submit.html is now a redirect to order-create.html (the
// file stays so old bookmarks/direct URLs keep working); new manual
// applications are orders; pre-unification manual_submissions rows
// stay viewable in the single orders view (orders.html legacy
// section, fed by GET /manual/mine).
// (POST /api/manual/submit charges nothing — its own code comment
// calls it 'the payment-free track'; the audit's live-check question
// is answered from code. The legacy endpoint stays for the admin
// queue's in-flight rows; no UI path reaches it any more.)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('manual-submit.html — redirects to the order flow (audit #51)', () => {
  const html = read('frontend/manual-submit.html');

  test('the page forwards to order-create.html with location.replace', () => {
    expect(html).toContain('location.replace(');
    expect(html).toContain("'/order-create.html'");
  });

  test('a picked service rides along as ?service= (both param names accepted)', () => {
    expect(html).toContain("q.get('service')");
    expect(html).toContain("q.get('service_id')");
    expect(html).toContain("'?service=' + encodeURIComponent(svc)");
  });

  test('no-JS fallback: meta refresh + a visible link to the order flow', () => {
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('url=/order-create.html');
    expect(html).toContain('id="goLink"');
    expect(html).toContain('href="/order-create.html"');
  });

  test('no submit path remains on the page (no form, no manual POST)', () => {
    expect(html).not.toContain('/api/manual/submit');
    expect(html).not.toContain('doSubmit');
    expect(html).not.toContain('rawText');
    expect(html).not.toContain('আবেদন জমা দিন');
  });

  test('the page says old manual applications are on the orders page', () => {
    expect(html).toContain('href="/orders.html"');
    expect(html).toContain('আমার অর্ডার');
  });
});

describe('orders.html — legacy manual submissions stay viewable (audit #51)', () => {
  const html = read('frontend/orders.html');

  test('the orders page fetches the legacy manual list', () => {
    expect(html).toContain("'/manual/mine'");
    expect(html).toContain('loadLegacyManual');
  });

  test('the legacy section is a labelled card, hidden until rows exist', () => {
    expect(html).toContain('আগের ম্যানুয়াল আবেদনসমূহ');
    expect(html).toContain('id="legacyManualCard"');
    expect(html).toContain("card.style.display = 'block'");
  });

  test('legacy rows show service, date, status, and document downloads', () => {
    expect(html).toContain('legacyManualList');
    expect(html).toContain('LEGACY_MANUAL_ST');
    expect(html).toContain("'/manual/' + m.id + '/documents/'");
    expect(html).toContain('dlLegacyManualDoc');
  });

  test('the legacy section loads with the orders list, and never breaks it', () => {
    const initFn = html.slice(html.indexOf('async function init(){'), html.indexOf('async function load(){'));
    expect(initFn).toContain('loadLegacyManual();');
    // failure-tolerant: a failed fetch hides the section, it never throws
    expect(html).toContain('catch(e) { /* legacy section stays hidden */ }');
  });
});

describe('order-create.html — manual services go through the order flow, fee shown (audit #51)', () => {
  const html = read('frontend/order-create.html');

  test('the fee is shown before submit (price badge + wallet balance)', () => {
    expect(html).toContain("document.getElementById('svcPrice').textContent='৳'+bnNum(svcPrice);");
    expect(html).toContain('অর্ডার কনফার্ম করার সাথে সাথে ওয়ালেট থেকে ফি কর্তন হবে');
  });

  test('the review step shows the fee before any money moves', () => {
    expect(html).toContain('reviewBox');
    expect(html).toContain('নিশ্চিত করলেই ওয়ালেট থেকে ফি কাটা হবে');
  });

  test('the manual fallback form keeps the template + free-text capability', () => {
    expect(html).toContain('manualDetailsInput');
    expect(html).toContain("data-field=\"_manual_form\"");
    expect(html).toContain('manual_sample');
  });

  test('submitting creates a charged order (POST /orders, wallet cut on confirm)', () => {
    expect(html).toContain("ABC.api('/orders'");
    expect(html).toContain("method: 'POST'");
    expect(html).toContain('order-status.html?id=');
  });
});

describe('POST /orders accepts manual-type services (audit #51)', () => {
  const route = read('backend/routes/user.js');

  test('no service-type gate rejects manual services; the charge runs for any active service', () => {
    const post = route.slice(route.indexOf("router.post('/orders'"), route.indexOf('// GET /api/orders'));
    expect(post).toContain("SELECT * FROM services WHERE id = $1 AND status = 'active'");
    expect(post).toContain('payForService');
    expect(post).not.toContain("type !== 'manual'");
    expect(post).not.toContain("type === 'manual'");
  });
});

describe('POST /api/manual/submit — no charge (audit #51)', () => {
  const route = read('backend/routes/manual.js');

  test('the submit handler never charges the wallet', () => {
    const submit = route.slice(route.indexOf("customerManual.post('/submit'"), route.indexOf('// ADMIN router'));
    expect(submit).not.toContain('payForService');
    expect(submit).not.toContain('serviceCredits');
    // the route's own comment names the design: 'the payment-free track'
    expect(route).toContain('payment-free track');
  });
});
