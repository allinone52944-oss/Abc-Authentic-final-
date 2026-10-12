// ============================================================
// All In One (Abc Authentic) - WhatsApp test sender
// Usage:
//   node scripts/test-whatsapp.js 01712345678
//   WHATSAPP_TEST_TO=01712345678 node scripts/test-whatsapp.js
// Loads backend/.env. Only sends when WHATSAPP_ENABLED=true and
// WHATSAPP_ACCESS_TOKEN is set. Safe to run anytime: without
// config it exits 0 and reports NOT_CONFIGURED.
// ============================================================
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const wa = require('../utils/whatsapp');

async function main() {
  const to = process.argv[2] || process.env.WHATSAPP_TEST_TO;
  console.log('[test] WHATSAPP_ENABLED =', process.env.WHATSAPP_ENABLED || '(unset)');
  console.log('[test] isConfigured() =', wa.isConfigured());

  if (!to) {
    console.log('[test] No recipient. Pass a BD number: node scripts/test-whatsapp.js 01712345678');
    process.exit(0);
  }
  if (!wa.isConfigured()) {
    console.log('[test] WhatsApp not configured (need WHATSAPP_ENABLED=true + PHONE_NUMBER_ID + ACCESS_TOKEN). Skipping send.');
    process.exit(0);
  }
  const msg =
    '☕ All In One (Abc Authentic) — টেস্ট মেসেজ\n' +
    'WhatsApp Cloud API সংযোগ সফল! ✅\n' +
    'বিশ্বাস ও সেবার ঠিকানা';
  console.log('[test] Sending to', to, '...');
  const r = await wa.sendTextMessage(to, msg);
  console.log('[test] Result:', JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => { console.error('[test] FAILED:', e.message); process.exit(1); });
