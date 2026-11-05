// Audit #51 — the legacy manual-submit path conflicts with the order
// path (same manual service: charged via order-create, free via
// manual-submit) and is linked from nowhere. The unify-vs-remove
// choice is the user's; this pins the safe part implemented now:
// the fee/status is stated clearly on the page itself.
// (POST /api/manual/submit charges nothing — its own code comment
// calls it 'the payment-free track'; the audit's live-check question
// is answered from code.)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('manual-submit.html — fee/status stated clearly (audit #51)', () => {
  const html = read('frontend/manual-submit.html');

  test('the page says plainly that no fee is cut on this path', () => {
    expect(html).toContain('এই পথে কোনো ফি কাটা হয় না');
    expect(html).toContain('আমার অর্ডার');
  });

  test('the page says submissions land in its own list, not in orders, and links out to the order flow', () => {
    expect(html).toContain("'আমার অর্ডার'-এ নয়");
    expect(html).toContain('href="/services.html"');
    expect(html).toContain('href="/orders.html"');
  });

  test('the service dropdown no longer shows a price suffix implying a charge here', () => {
    expect(html).not.toContain("(s.name_bn || s.name) + (s.price ? ' (৳' + s.price + ')' : '')");
    expect(html).toContain('opt.textContent = (s.name_bn || s.name);');
  });

  test('picking a priced service shows its order fee + an order link', () => {
    expect(html).toContain('এই সেবার অর্ডার ফি ৳');
    expect(html).toContain('এই ম্যানুয়াল পথে জমা দিলে এখন কোনো ফি কাটা হয় না');
    expect(html).toContain("/order-create.html?service=' + encodeURIComponent(matched.id)");
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
