/**
 * Regression guard — post-login landing page.
 *
 * VoiceAlert (voice alerts) and PushNotify (push subscription) live ONLY
 * in admin.js / admin.html. Login used to send everyone — admins too —
 * to /dashboard.html, where neither exists, so an admin sitting on the
 * user dashboard got no voice alerts and a stale push subscription
 * (Pankaj, 2026-10-22: "admin id diye duklei 1st a admin user dashboard
 * ase"). Login now sends admins to /admin.html by default; an explicit
 * ?next= still wins and customers are unchanged.
 */

const fs = require('fs');
const path = require('path');

const LOGIN_HTML = path.join(__dirname, '..', '..', '..', 'frontend', 'login.html');
const src = fs.readFileSync(LOGIN_HTML, 'utf8');

test('login redirect: admin default is /admin.html, customer default is /dashboard.html, ?next= wins', () => {
  // The single redirect site in doLogin() (the OTP verify path funnels
  // through doLogin too).
  expect(src).toContain("get('next')");
  expect(src).toMatch(/d\.user && d\.user\.role === 'admin' \? '\/admin\.html' : '\/dashboard\.html'/);
  // No bare "everyone to dashboard" fallback may remain.
  expect(src).not.toContain("get('next') || '/dashboard.html'");
});

test('login: success path re-enables the button and pageshow resets it (BFCache frozen-button fix)', () => {
  // doLogin() used to leave #lg_btn disabled on the success path;
  // returning to the page (browser back / BFCache) showed it frozen
  // at "⏳ যাচাই করা হচ্ছে...".
  expect(src).toMatch(/btn\.disabled = false;\s*\n\s*btn\.textContent = 'লগইন করুন →';\s*\n\s*location\.href = next;/);
  expect(src).toMatch(/window\.addEventListener\('pageshow'/);
  expect(src).toMatch(/btn\.disabled = false; btn\.textContent = 'লগইন করুন →';/);
});
