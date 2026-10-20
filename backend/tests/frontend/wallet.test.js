/**
 * Frontend regression — wallet.html cashback layout.
 *
 * History:
 *  - 2026-10-21 (dedup): create/redeem buttons rendered twice for the
 *    same recharge (hub card + transaction card). Hub became summary-only.
 *  - 2026-10-21 (daily rule, owner spec): cashback is claimed ONCE per
 *    day on the combined total of all unclaimed approved recharges.
 *    Per-recharge coupon creation is removed from the UI entirely;
 *    the hub carries the single daily claim button (cbDailySlot),
 *    filled by loadDailyCashback() from GET /cashback/today.
 * These tests pin the current invariants against the real source file.
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
const txList = slice('async function loadWallet', 'async function loadDailyCashback');
const daily = slice('async function loadDailyCashback', 'async function instantRedeemCode');

describe('wallet cashback — daily claim, one button, one place', () => {
  test('per-recharge coupon creation is gone from the UI', () => {
    expect(SRC).not.toContain('generateCashbackCoupon');
    expect(SRC).not.toContain('/cashback/generate');
  });

  test('hub renders NO action buttons itself (summary + daily slot only)', () => {
    expect(hub).not.toContain('instantRedeemCode(this.dataset.code');
    expect(hub).toContain('cbDailySlot');
    expect(hub).toContain('ক্যাশব্যাক প্রাপ্য');
    expect(hub).toContain('রিডিমের জন্য প্রস্তুত');
  });

  test('daily claim UI is driven by /cashback/today and /cashback/redeem', () => {
    expect(daily).toContain("ABC.api('/cashback/today')");
    expect(daily).toContain('claimDailyCashback');
    expect(SRC).toContain("ABC.api('/cashback/redeem'");
    expect(daily).toContain('আজকের ক্যাশব্যাক সংগ্রহ করুন');
    expect(daily).toContain('আজকের ক্যাশব্যাক সংগ্রহ করা হয়েছে');
  });

  test('transaction list keeps coupon redeem + redeemed badge (old coupons stay usable)', () => {
    expect(txList).toContain('instantRedeemCode(this.dataset.code');
    expect(txList).toContain("coupon.status === 'redeemed'");
    expect(txList).toContain('ব্যালেন্সে জমা হয়েছে');
  });
});
