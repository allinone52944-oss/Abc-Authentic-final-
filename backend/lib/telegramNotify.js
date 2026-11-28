'use strict';

// Telegram group notifications for site activity (2026-11-28).
//
// Every paid order / successful recharge / successful verification
// posts one formatted message to the "ABC Authentic Updates" group
// via the @abc_authentic_bot Bot API — plus, when configured, one
// animated sticker alongside it (animated emoji in the text +
// animated sticker = the two motion options the owner picked).
// A completed job also posts a premium success message
// ("অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে।") so the group
// — visible to everyone — sees the work succeeded, not just that
// an order was placed.
//
// Configuration — all from process.env, read at call time:
//   TELEGRAM_BOT_TOKEN          Bot API token from @BotFather. REQUIRED.
//                               If unset, every function below is a
//                               silent no-op: it never throws, never
//                               blocks the request, never logs.
//   TELEGRAM_CHAT_ID            Destination chat. Optional; defaults to
//                               the "ABC Authentic Updates" supergroup
//                               (-1005862040443). Env wins when set.
//   TELEGRAM_ANIMATED_STICKER_ID  file_id of an animated sticker to send
//                               after each text message. Optional: when
//                               unset, only the text message is sent
//                               (sticker never blocks the text).
//
//   How to obtain a sticker file_id (do NOT commit the token):
//     1. Pick any animated sticker set (e.g. from @Stickers).
//     2. curl "https://api.telegram.org/bot<TOKEN>/getStickerSet?name=<set_name>"
//        and copy a sticker's file_id from the response, OR send an
//        animated sticker to the bot and read its file_id from
//        getUpdates. 3. Set TELEGRAM_ANIMATED_STICKER_ID to that
//        file_id on the server (server .env, never git). No file_id
//        is ever invented here.
//
// Privacy — the group is visible to everyone, so NO identifier ever
// leaves the server in full: names show only the first 2 characters
// + '***', phones show first 2 + last 2 digits with the middle
// masked. NID / BRN / TIN / DOB and any other identifier are never
// included. All interpolated values are HTML-escaped (parse_mode
// is HTML).
//
// Safety — the token lives only in the request URL, which is never
// logged. Every failure (no token, network error, non-OK response,
// timeout) is swallowed silently so a Telegram outage can never
// fail an order, a recharge, or a verification.

const DEFAULT_CHAT_ID = '-1005862040443';
const SEND_TIMEOUT_MS = 5000;
const DIVIDER = '━━━━━━━━━━━━━━━━━━';

function token() {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim() || null;
}

function chatId() {
  return (process.env.TELEGRAM_CHAT_ID || '').trim() || DEFAULT_CHAT_ID;
}

function stickerId() {
  return (process.env.TELEGRAM_ANIMATED_STICKER_ID || '').trim() || null;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// First 2 characters only, then '***' (e.g. জাগাতপ্রিয়া → জা***).
// Array.from keeps multi-byte characters intact.
function maskName(name) {
  const n = String(name || '').trim();
  if (!n) return '***';
  return escapeHtml(Array.from(n).slice(0, 2).join('')) + '***';
}

// First 2 + last 2 characters, middle masked (01712345678 → 01XXXXXXX78).
function maskPhone(phone) {
  const p = String(phone || '').trim();
  if (!p) return '***';
  if (p.length <= 4) return escapeHtml(p.slice(0, 2)) + 'X'.repeat(Math.max(0, p.length - 2));
  return escapeHtml(p.slice(0, 2)) + 'X'.repeat(p.length - 4) + escapeHtml(p.slice(-2));
}

// '28 Nov 2026, 07:00 PM' in Asia/Dhaka.
function dhakaTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`;
}

function methodLabel(method) {
  const m = String(method || '').trim().toLowerCase();
  if (m === 'bkash_payment' || m === 'bkash_personal' || m === 'bkash') return 'bKash';
  if (m === 'nagad') return 'Nagad';
  if (m === 'rocket') return 'Rocket';
  return m ? escapeHtml(method) : '—';
}

function userLines(userName, userPhone) {
  return `👤 <b>${maskName(userName)}</b> ✦\n📱 ${maskPhone(userPhone)}`;
}

function buildOrderMessage({ userName, userPhone, serviceLabel, fee, orderId }) {
  const amount = Number(fee) || 0;
  return [
    '✅ <b>নতুন অর্ডার</b>',
    DIVIDER,
    userLines(userName, userPhone),
    `🔧 ${escapeHtml(serviceLabel || 'সেবা')}`,
    `💰 ফি: ৳${amount}`,
    `🆔 অর্ডার: #${escapeHtml(orderId == null ? '' : String(orderId))}`,
    `🕐 ${dhakaTime()}`,
  ].join('\n');
}

function buildRechargeMessage({ userName, userPhone, amount, method }) {
  const amt = Number(amount) || 0;
  return [
    '💰 <b>রিচার্জ সফল</b>',
    DIVIDER,
    userLines(userName, userPhone),
    `💵 অ্যামাউন্ট: ৳${amt}`,
    `💳 মাধ্যম: ${methodLabel(method)}`,
    `🕐 ${dhakaTime()}`,
  ].join('\n');
}

function buildVerifyMessage({ userName, userPhone, type }) {
  return [
    '🔍 <b>ভেরিফাই সফল</b>',
    DIVIDER,
    userLines(userName, userPhone),
    `📄 টাইপ: ${escapeHtml(type || 'যাচাই')}`,
    `🕐 ${dhakaTime()}`,
  ].join('\n');
}

// Premium success message for the GROUP (visible to everyone):
// the work is DONE, not just ordered. Headline wording is
// owner-approved (2026-11-28) — do not reword it.
function buildSuccessMessage({ userName, userPhone, serviceLabel, fee, orderId }) {
  const amount = Number(fee) || 0;
  return [
    '🎉 <b>অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে।</b>',
    DIVIDER,
    userLines(userName, userPhone),
    `🔧 ${escapeHtml(serviceLabel || 'সেবা')}`,
    `💰 ফি: ৳${amount}`,
    `🆔 অর্ডার: #${escapeHtml(orderId == null ? '' : String(orderId))}`,
    `🕐 ${dhakaTime()}`,
  ].join('\n');
}

async function postTelegram(method, body, fetchImpl) {
  const tok = token();
  if (!tok) return false;
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${tok}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId(), ...body }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return Boolean(res && res.ok);
  } catch (_) {
    // Swallowed by design: Telegram must never fail an order,
    // recharge, or verification. Nothing sensitive is logged.
    return false;
  }
}

// Internal: POST a text message. Returns false (no throw) when the
// token is missing or the send fails.
async function sendTelegram(text, fetchImpl = globalThis.fetch) {
  return postTelegram('sendMessage', { text, parse_mode: 'HTML' }, fetchImpl);
}

// Internal: POST the configured animated sticker, if any. No-op
// (false, no throw) when no sticker is configured or the send fails.
async function sendSticker(fetchImpl = globalThis.fetch) {
  const fileId = stickerId();
  if (!fileId) return false;
  return postTelegram('sendSticker', { sticker: fileId }, fetchImpl);
}

// Send the text message, then the animated sticker (when configured).
// The sticker never blocks or replaces the text.
async function sendTextAndSticker(text, fetchImpl = globalThis.fetch) {
  await sendTelegram(text, fetchImpl);
  await sendSticker(fetchImpl);
}

// New paid engine order / paid lookup. Fire-and-forget from the
// caller: the returned promise never rejects.
async function notifyOrder(params, fetchImpl = globalThis.fetch) {
  if (!token()) return false;
  await sendTextAndSticker(buildOrderMessage(params || {}), fetchImpl);
  return true;
}

// Successful wallet recharge credit. Fire-and-forget; never rejects.
async function notifyRecharge(params, fetchImpl = globalThis.fetch) {
  if (!token()) return false;
  await sendTextAndSticker(buildRechargeMessage(params || {}), fetchImpl);
  return true;
}

// Successful verification (no paid order attached). Fire-and-forget;
// never rejects.
async function notifyVerify(params, fetchImpl = globalThis.fetch) {
  if (!token()) return false;
  await sendTextAndSticker(buildVerifyMessage(params || {}), fetchImpl);
  return true;
}

// Completed work (order delivered / filing submitted / verification
// passed). Posts the premium success message to the GROUP, where
// everyone sees it. Fire-and-forget; never rejects.
async function notifySuccess(params, fetchImpl = globalThis.fetch) {
  if (!token()) return false;
  await sendTextAndSticker(buildSuccessMessage(params || {}), fetchImpl);
  return true;
}

module.exports = {
  notifyOrder,
  notifyRecharge,
  notifyVerify,
  notifySuccess,
  maskName,
  maskPhone,
  dhakaTime,
  DEFAULT_CHAT_ID,
};
