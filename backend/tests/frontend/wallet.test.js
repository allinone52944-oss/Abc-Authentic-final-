/**
 * Frontend regression — wallet.html cashback hub dedup (2026-10-21).
 *
 * The cashback create/redeem buttons used to render TWICE for the same
 * recharge: once inside the "Cashback Hub" card (renderCashbackHub) and
 * once on the recharge's own card in the transaction list (loadWallet).
 * The hub is now summary-only; the buttons live in exactly one place.
 * These tests pin that invariant against the real source file.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '../../../frontend/wallet.html'),
  'utf8',
);

function slice(from, to) {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('markers not found: ' + from + ' / ' + to);
  return SRC.slice(a, b);
}

const hub = slice('function renderCashbackHub', 'async function loadWallet');
const txList = slice('async function loadWallet', 'async function generateCashbackCoupon');

describe('wallet cashback hub — buttons in exactly one place', () => {
  test('hub renders NO coupon action buttons (summary only)', () => {
    expect(hub).not.toContain('generateCashbackCoupon(this.dataset.id');
    expect(hub).not.toContain('instantRedeemCode(this.dataset.code');
    expect(hub).not.toContain('copyCode(this.dataset.code');
  });

  test('hub still shows summary counts for eligible + unredeemed', () => {
    expect(hub).toContain('ক্যাশব্যাক প্রাপ্য');
    expect(hub).toContain('রিডিমের জন্য প্রস্তুত');
  });

  test('transaction list keeps the single create + redeem buttons', () => {
    expect(txList).toContain('generateCashbackCoupon(this.dataset.id');
    expect(txList).toContain('instantRedeemCode(this.dataset.code');
  });

  test('redeemed state stays a single badge in the transaction list', () => {
    expect(txList).toContain("coupon.status === 'redeemed'");
    expect(txList).toContain('ব্যালেন্সে জমা হয়েছে');
  });
});
