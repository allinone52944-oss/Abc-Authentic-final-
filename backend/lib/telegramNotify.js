'use strict';

// Public-group notifications. Only masked customer data and abbreviated order
// references leave the site. Configuration is read from TELEGRAM_BOT_TOKEN,
// TELEGRAM_CHAT_ID and TELEGRAM_ANIMATED_STICKER_ID at send time.
const DEFAULT_CHAT_ID = '-1005862040443';
const SEND_TIMEOUT_MS = 5000;
const currency = new Intl.NumberFormat('bn-BD', { maximumFractionDigits: 2 });

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
  if (p.length <= 2) return '***';
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

function label(value, fallback) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return escapeHtml(text.slice(0, 140) || fallback);
}

function amountLine(title, amount) {
  const value = Number(amount);
  return amount != null && Number.isFinite(value) && value >= 0
    ? `${title} <b>৳${currency.format(value)}</b>` : '';
}

function methodLabel(method) {
  const m = String(method || '').trim().toLowerCase();
  if (['bkash_payment', 'bkash_personal', 'bkash'].includes(m)) return 'bKash';
  if (m === 'nagad') return 'Nagad';
  if (m === 'rocket') return 'Rocket';
  return label(method, '—');
}

function orderLine(orderId) {
  const raw = String(orderId ?? '').trim();
  if (!raw) return '';
  const reference = raw.length > 8 ? raw.slice(0, 8) + '…' : raw;
  return `অর্ডার <code>#${escapeHtml(reference)}</code>`;
}

function buildMessage(headline, params, fields) {
  const customer = `গ্রাহক <b>${maskName(params.userName)}</b> · ${maskPhone(params.userPhone)}`;
  return [
    headline,
    '',
    fields.filter(Boolean).join('\n'),
    '',
    customer,
    `<i>${dhakaTime()} · ঢাকা</i>`,
  ].join('\n');
}

function serviceMessage(headline, params, amountTitle = 'ফি') {
  return buildMessage(headline, params, [
    `সেবা <b>${label(params.serviceLabel, 'ডিজিটাল সেবা')}</b>`,
    amountLine(amountTitle, params.fee),
    orderLine(params.orderId),
  ]);
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

async function sendNotice(text, fetchImpl, withSticker = true) {
  const sent = await postTelegram('sendMessage', {
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  }, fetchImpl);
  const fileId = sent && withSticker && stickerId();
  if (fileId) await postTelegram('sendSticker', { sticker: fileId, disable_notification: true }, fetchImpl);
  return sent;
}

function notifyOrder(params = {}, fetchImpl = globalThis.fetch) {
  return sendNotice(serviceMessage('📥 <b>নতুন অর্ডার</b>', params), fetchImpl);
}

function notifyRecharge(params = {}, fetchImpl = globalThis.fetch) {
  const text = buildMessage('💳 <b>রিচার্জ সফল</b>', params, [
    amountLine('ওয়ালেটে যোগ হয়েছে', params.amount),
    `মাধ্যম <b>${methodLabel(params.method)}</b>`,
  ]);
  return sendNotice(text, fetchImpl);
}

function notifyVerify(params = {}, fetchImpl = globalThis.fetch) {
  const text = buildMessage('🔍 <b>যাচাই সফল</b>', params, [
    `সেবা <b>${label(params.type, 'যাচাই')}</b>`,
  ]);
  return sendNotice(text, fetchImpl);
}

function notifySuccess(params = {}, fetchImpl = globalThis.fetch) {
  return sendNotice(serviceMessage('🎉 <b>অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে।</b>', params), fetchImpl);
}

function notifyPaidFailure(params = {}, fetchImpl = globalThis.fetch) {
  return sendNotice(serviceMessage('⚠️ <b>চার্জ হয়েছে, রিপোর্ট পাওয়া যায়নি</b>', params, 'কাটা হয়েছে'), fetchImpl, false);
}

// Some engines charge at Create and render later. Only the first generated
// PDF for an order should announce completion, including concurrent downloads.
async function notifyReportReady(db, { userId, orderId, engineId, serviceLabel }) {
  if (!token() || !orderId) return false;
  try {
    const { rows: [order] } = await db.query(
      `UPDATE orders o
          SET data = o.data || '{"telegram_report_announced":true}'::jsonb
         FROM users u
        WHERE o.id = $1 AND o.user_id = $2 AND u.id = o.user_id
          AND o.status = 'completed' AND o.data->>'engine' = $3
          AND o.data->>'telegram_report_announced' IS DISTINCT FROM 'true'
        RETURNING u.name, u.phone, o.price`,
      [orderId, userId, engineId],
    );
    if (order) return notifySuccess({
      userName: order.name, userPhone: order.phone, serviceLabel, fee: order.price, orderId,
    });
  } catch (_) {
    // Group notifications cannot fail a document download.
  }
  return false;
}

module.exports = {
  notifyOrder,
  notifyRecharge,
  notifyVerify,
  notifySuccess,
  notifyPaidFailure,
  notifyReportReady,
  maskName,
  maskPhone,
  dhakaTime,
  DEFAULT_CHAT_ID,
};
