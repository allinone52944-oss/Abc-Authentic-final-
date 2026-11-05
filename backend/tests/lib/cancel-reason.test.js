// Audit #28 — the cancel reason is stored and shown, and the
// refund box shows the real wallet/credit split. The migration
// cannot run against a live DB in tests, so its contents are
// pinned statically; the read paths are covered by route tests.
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

describe('migration 050_cancel_reason_refund_split.sql', () => {
  const mig = read('database/migrations/050_cancel_reason_refund_split.sql');

  test('adds cancel_reason + refund split columns', () => {
    expect(mig).toContain('ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT');
    expect(mig).toContain('ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_balance NUMERIC(12,2)');
    expect(mig).toContain('ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_credit NUMERIC(12,2)');
    expect(mig).toContain('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cancel_reason TEXT');
  });

  test('it is the next migration number (runs after 049)', () => {
    const files = fs.readdirSync(path.join(repoRoot, 'database', 'migrations'))
      .filter((f) => f.endsWith('.sql')).sort();
    expect(files[files.length - 1]).toBe('050_cancel_reason_refund_split.sql');
  });
});

test('order PUT stores the reason + the refund split', () => {
  const src = read('backend/routes/admin.js');
  expect(src).toContain('cancel_reason = COALESCE($3, cancel_reason)');
  expect(src).toContain('UPDATE orders SET refund_balance = $1, refund_credit = $2 WHERE id = $3');
});

test('transaction reject stores the reason and tells the customer', () => {
  const src = read('backend/routes/admin.js');
  expect(src).toContain("cancel_reason = COALESCE($1, cancel_reason), admin_id = $2");
  expect(src).toContain("(txReason ? ' কারণ: ' + txReason : '')");
});

test('WhatsApp reject notice carries the stored reason', () => {
  const src = read('backend/utils/whatsapp.js');
  expect(src).toContain("(tx.cancel_reason ? ('কারণ: ' + tx.cancel_reason + '\\n') : '')");
});

test('customer endpoints return the reason + the split', () => {
  const user = read('backend/routes/user.js');
  expect(user).toContain('o.cancel_reason, o.refund_balance, o.refund_credit,');
  expect(user).toContain('status, created_at, cancel_reason,');
});

test('order-status page: failed gets a hero box, refund shows the real split', () => {
  const src = read('frontend/order-status.html');
  expect(src).toContain("} else if (st === 'failed') {");
  expect(src).toContain('function refundDesc(o)');
  expect(src).toContain('ওই সেবার ক্রেডিটে ফেরত দেওয়া হয়েছে');
  expect(src).toContain("(' কারণ: ' + o.cancel_reason)");
  expect(src).not.toContain('আপনার অর্ডারের সম্পূর্ণ ৳');
});

test('wallet page: rejected rows and polls show the stored reason', () => {
  const src = read('frontend/wallet.html');
  expect(src).toContain("(t.cancel_reason ? '<br>কারণ: ' + esc(t.cancel_reason)");
  expect(src).toContain("(tx.cancel_reason ? '<br>কারণ: ' + esc(tx.cancel_reason)");
  expect(src).toContain("(ex.status === 'rejected' && ex.cancel_reason ? '<br>কারণ: ' + esc(ex.cancel_reason)");
});

test('admin recharge-reject modal collects the reason', () => {
  const src = read('frontend/js/admin.js');
  expect(src).toContain('id="admTxRejectReason"');
  expect(src).toContain('body: reason ? { cancel_reason: reason } : {}');
});
