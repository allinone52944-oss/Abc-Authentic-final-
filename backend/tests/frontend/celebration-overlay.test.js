/**
 * Regression guard — wallet celebration overlay (cbOverlay).
 *
 * Found 2026-10-23 at Pankaj's request to audit the celebration popup:
 *  1. Its two buttons were dead — #cbInstantBtn ("এখনই ওয়ালেটে যোগ
 *     করুন") and #cbCopyBtn had NO click handlers anywhere; the first
 *     was also misleading (the money is already credited by the time
 *     the overlay shows).
 *  2. The amount count-up ended on Math.round(amount), so a fractional
 *     cashback like ৳10.75 displayed as ৳11 — wrong figure on screen
 *     (the credit itself was exact).
 *  3. claimDailyCashback + instantRedeemCode fired celebrate() AND a
 *     success alert() — a double popup for one event; the
 *     service-locked explanation now lives inside the overlay.
 *  4. The title was hard-coded to "কুপন তৈরি হয়েছে" even when
 *     redeeming an existing coupon.
 */

const fs = require('fs');
const path = require('path');

const WALLET = path.join(__dirname, '..', '..', '..', 'frontend', 'wallet.html');
const src = fs.readFileSync(WALLET, 'utf8');

describe('wallet celebration overlay', () => {
  test('the dead/misleading instant-add button is gone', () => {
    expect(src).not.toMatch(/cbInstantBtn/);
  });

  test('copy button is wired to a real handler', () => {
    expect(src).toMatch(/id="cbCopyBtn"[^>]*onclick="copyCelebrationCode\(\)"/);
    expect(src).toMatch(/function copyCelebrationCode\(\)/);
  });

  test('amount is formatted exactly (2dp), never Math.round-ed', () => {
    expect(src).not.toMatch(/Math\.round\(amount/);
    expect(src).toMatch(/maximumFractionDigits:\s*2/);
  });

  test('no success alert() duplicates the celebration overlay', () => {
    expect(src).not.toMatch(/alert\('🎉 অভিনন্দন/);
    expect(src).not.toMatch(/alert\('🔒 অভিনন্দন/);
  });

  test('celebrate() takes a per-flow title and overlay note', () => {
    expect(src).toMatch(/function celebrate\(amount,\s*code,\s*opts\)/);
    expect(src).toMatch(/id="cbNote"/);
    expect(src).toMatch(/কুপন রিডিম সফল হয়েছে/);
  });
});
