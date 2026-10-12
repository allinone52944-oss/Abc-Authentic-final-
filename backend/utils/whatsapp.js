// ============================================================
// All In One (Abc Authentic) - WhatsApp Cloud API client
// Sends order/recharge notifications via Meta WhatsApp Cloud API
// (graph.facebook.com v21.0). Free tier: 1000 msgs/month.
// Config from env: WHATSAPP_ENABLED, WHATSAPP_PHONE_NUMBER_ID,
// WHATSAPP_ACCESS_TOKEN. Admin toggle: settings.whatsapp.enabled.
// Never throws to callers: returns { ok, error }.
// Bengali UTF-8 is sent as-is (JSON handles it natively).
// ============================================================
const { safeLog } = require('../security');

const API_VERSION = 'v21.0';
const API_BASE = `https://graph.facebook.com/${API_VERSION}`;

function isConfigured() {
  return (
    process.env.WHATSAPP_ENABLED === 'true' &&
    !!process.env.WHATSAPP_PHONE_NUMBER_ID &&
    !!process.env.WHATSAPP_ACCESS_TOKEN
  );
}

// Admin DB toggle (settings.whatsapp = { enabled, business_number }).
// Missing setting => allowed (env is the master switch).
async function adminToggleOn(db) {
  try {
    const r = await db.query("SELECT value FROM settings WHERE key = 'whatsapp'");
    if (!r.rows.length) return true;
    const v = typeof r.rows[0].value === 'string'
      ? JSON.parse(r.rows[0].value)
      : r.rows[0].value;
    return v.enabled !== false;
  } catch (e) {
    safeLog('[whatsapp] toggle check failed, defaulting ON:', e.message);
    return true;
  }
}

async function canSend(db) {
  if (!isConfigured()) return false;
  return adminToggleOn(db);
}

// 01XXXXXXXXX -> 8801XXXXXXXXX (WhatsApp API needs country code,
// no leading +). Already-international numbers pass through.
function normalizeBdPhone(phone) {
  let p = String(phone || '').replace(/[\s\-()]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (/^01[3-9]\d{8}$/.test(p)) return '880' + p.slice(1);
  if (/^8801[3-9]\d{8}$/.test(p)) return p;
  return null; // not a usable BD mobile number
}

async function graphPost(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.message) || `HTTP_${res.status}`;
      safeLog('[whatsapp] API error:', msg);
      return { ok: false, error: msg };
    }
    return { ok: true, id: data.messages && data.messages[0] && data.messages[0].id };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'TIMEOUT' : (e.message || 'REQUEST_FAILED');
    safeLog('[whatsapp] request failed:', msg);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function sendTextMessage(to, message) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (process.env.WHATSAPP_ENABLED !== 'true' || !phoneId || !token) {
    safeLog('[whatsapp] not configured, skipping message to', to);
    return { ok: false, error: 'WHATSAPP_NOT_CONFIGURED' };
  }
  const recipient = normalizeBdPhone(to);
  if (!recipient) {
    safeLog('[whatsapp] invalid recipient number, skipping');
    return { ok: false, error: 'INVALID_RECIPIENT' };
  }
  const text = String(message || '').slice(0, 4000);
  if (!text) return { ok: false, error: 'EMPTY_MESSAGE' };
  return graphPost(`/${phoneId}/messages`, {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'text',
    text: { body: text, preview_url: false },
  });
}

async function sendTemplateMessage(to, templateName, languageCode, components) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (process.env.WHATSAPP_ENABLED !== 'true' || !phoneId || !token) {
    safeLog('[whatsapp] not configured, skipping template to', to);
    return { ok: false, error: 'WHATSAPP_NOT_CONFIGURED' };
  }
  const recipient = normalizeBdPhone(to);
  if (!recipient) return { ok: false, error: 'INVALID_RECIPIENT' };
  if (!templateName) return { ok: false, error: 'MISSING_TEMPLATE' };
  return graphPost(`/${phoneId}/messages`, {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode || 'bn' },
      components: components || [],
    },
  });
}

// ---- Editable message templates (admin settings) ----------------
// Admin can edit these in Settings -> WhatsApp. Placeholders in
// {braces} are replaced with real values at send time.
// DB key: settings.whatsapp = { enabled, business_number,
//   order_completed_msg, recharge_approved_msg }
const DEFAULT_TEMPLATES = {
  order_completed_msg:
    '🎉 অভিনন্দন! আপনার অর্ডারটি সফল হয়েছে\n' +
    'অর্ডার #: {order_number}\n' +
    'সার্ভিস: {service_name}\n' +
    'ধন্যবাদ Abc Authentic-এর সাথে থাকার জন্য!',
  recharge_approved_msg:
    '✅ রিচার্জ সফল!\n' +
    'পরিমাণ: ৳{amount}\n' +
    'বর্তমান ব্যালেন্স: ৳{balance}\n' +
    'ধন্যবাদ!',
};

// Admin-editable templates merged over defaults. Missing/empty
// template => default (also covers DBs seeded before templates existed).
async function getTemplates(db) {
  const out = Object.assign({}, DEFAULT_TEMPLATES);
  try {
    const r = await db.query("SELECT value FROM settings WHERE key = 'whatsapp'");
    if (r.rows.length) {
      const v = typeof r.rows[0].value === 'string'
        ? JSON.parse(r.rows[0].value)
        : r.rows[0].value;
      if (typeof v.order_completed_msg === 'string' && v.order_completed_msg.trim())
        out.order_completed_msg = v.order_completed_msg;
      if (typeof v.recharge_approved_msg === 'string' && v.recharge_approved_msg.trim())
        out.recharge_approved_msg = v.recharge_approved_msg;
    }
  } catch (e) {
    safeLog('[whatsapp] template load failed, using defaults:', e.message);
  }
  return out;
}

// Replace {placeholders} with vars. Unknown placeholders are left as-is
// so a typo in the admin template never silently deletes text.
function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, key) =>
    (vars && vars[key] !== undefined && vars[key] !== null) ? String(vars[key]) : m
  );
}

// ---- Bengali message builders (defaults; admin templates override) --
function orderCompletedMessage({ name, orderId, serviceName, status }) {
  return renderTemplate(DEFAULT_TEMPLATES.order_completed_msg, {
    name: name || '',
    order_number: String(orderId || '').slice(0, 8),
    service_name: serviceName || '',
    status: status || '',
  });
}

function rechargeApprovedMessage({ name, amount, newBalance }) {
  return renderTemplate(DEFAULT_TEMPLATES.recharge_approved_msg, {
    name: name || '',
    amount: amount,
    balance: (newBalance !== undefined && newBalance !== null) ? newBalance : '',
  });
}

// ---- High-level notifiers (never throw) -----------------------
// Fetch user + service, check toggles, send. Fire-and-forget safe.
async function notifyOrderCompleted(db, order) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    const u = await db.query(
      'SELECT name, whatsapp FROM users WHERE id = $1', [order.user_id]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    let serviceName = '';
    try {
      const s = await db.query(
        'SELECT name FROM services WHERE id = $1', [order.service_id]
      );
      serviceName = (s.rows[0] && s.rows[0].name) || '';
    } catch (_) { /* service name is optional */ }
    const tpl = await getTemplates(db);
    const msg = renderTemplate(tpl.order_completed_msg, {
      name: user.name || '',
      order_number: String(order.id || '').slice(0, 8),
      service_name: serviceName,
      status: order.status,
    });
    const r = await sendTextMessage(user.whatsapp, msg);
    safeLog('[whatsapp] order notify', order.id, '->', r.ok ? 'sent' : r.error);
    return r;
  } catch (e) {
    safeLog('[whatsapp] notifyOrderCompleted failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

async function notifyRechargeApproved(db, tx) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    const u = await db.query(
      'SELECT name, whatsapp, balance FROM users WHERE id = $1', [tx.user_id]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const tpl = await getTemplates(db);
    const msg = renderTemplate(tpl.recharge_approved_msg, {
      name: user.name || '',
      amount: Number(tx.amount),
      balance: user.balance,
    });
    const r = await sendTextMessage(user.whatsapp, msg);
    safeLog('[whatsapp] recharge notify', tx.id || '', '->', r.ok ? 'sent' : r.error);
    return r;
  } catch (e) {
    safeLog('[whatsapp] notifyRechargeApproved failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

module.exports = {
  isConfigured,
  canSend,
  normalizeBdPhone,
  sendTextMessage,
  sendTemplateMessage,
  DEFAULT_TEMPLATES,
  getTemplates,
  renderTemplate,
  orderCompletedMessage,
  rechargeApprovedMessage,
  notifyOrderCompleted,
  notifyRechargeApproved,
};
