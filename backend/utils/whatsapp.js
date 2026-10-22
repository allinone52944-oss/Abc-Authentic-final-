// ============================================================
// All In One (Abc Authentic) - WhatsApp Cloud API client
// Sends order/recharge notifications via Meta WhatsApp Cloud API
// (graph.facebook.com v21.0). Free tier: 1000 msgs/month.
// Config: env (WHATSAPP_ENABLED, WHATSAPP_PHONE_NUMBER_ID,
// WHATSAPP_ACCESS_TOKEN) + admin DB settings (settings.whatsapp =
// { enabled, business_number, phone_number_id, access_token, ... }).
// DB values (when set/non-empty) take precedence over env, so the
// admin can configure everything from Settings without VM access.
// Never throws to callers: returns { ok, error }.
// Bengali UTF-8 is sent as-is (JSON handles it natively).
// The access token is NEVER logged or returned in API responses.
// ============================================================
const { safeLog } = require('../security');

const API_VERSION = 'v21.0';
const API_BASE = `https://graph.facebook.com/${API_VERSION}`;

// Sync env-only check (used by CLI test script). For the merged
// DB+env config use async getConfig(db) / canSend(db).
function isConfigured() {
  return (
    process.env.WHATSAPP_ENABLED === 'true' &&
    !!process.env.WHATSAPP_PHONE_NUMBER_ID &&
    !!process.env.WHATSAPP_ACCESS_TOKEN
  );
}

// Read the admin's settings.whatsapp row (missing => {}). Never throws.
async function readDbWhatsapp(db) {
  if (!db) return {};
  try {
    const r = await db.query("SELECT value FROM settings WHERE key = 'whatsapp'");
    if (!r.rows.length) return {};
    const v = typeof r.rows[0].value === 'string'
      ? JSON.parse(r.rows[0].value)
      : r.rows[0].value;
    return (v && typeof v === 'object') ? v : {};
  } catch (e) {
    safeLog('[whatsapp] settings read failed:', e.message);
    return {};
  }
}

const _nonEmpty = (x) => typeof x === 'string' && x.trim() !== '';

// Unified config: DB values (when set/non-empty) override env.
// enabled = (env WHATSAPP_ENABLED === 'true' OR DB enabled === true)
//           AND NOT (DB enabled === false). Admin toggle off in DB
// always wins (explicit false disables sending).
async function getConfig(db) {
  const s = await readDbWhatsapp(db);
  const phone_number_id = _nonEmpty(s.phone_number_id)
    ? s.phone_number_id.trim()
    : (process.env.WHATSAPP_PHONE_NUMBER_ID || '');
  const access_token = _nonEmpty(s.access_token)
    ? s.access_token.trim()
    : (process.env.WHATSAPP_ACCESS_TOKEN || '');
  const enabledByEnv = process.env.WHATSAPP_ENABLED === 'true';
  const enabledByDb = s.enabled === true;
  const explicitlyOff = s.enabled === false;
  const enabled = (enabledByEnv || enabledByDb) && !explicitlyOff;
  return { enabled, phone_number_id, access_token };
}

async function canSend(db) {
  const cfg = await getConfig(db);
  return !!(cfg.enabled && cfg.phone_number_id && cfg.access_token);
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

// Internal: POST with an already-resolved config (avoids double DB read).
// The token is never logged.
async function graphPostWith(cfg, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${cfg.access_token}`,
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

// Backward-compatible wrapper: db optional (env-only when omitted).
async function graphPost(path, body, db) {
  const cfg = await getConfig(db);
  return graphPostWith(cfg, path, body);
}

async function sendTextMessage(to, message, db) {
  const cfg = await getConfig(db);
  if (!cfg.enabled || !cfg.phone_number_id || !cfg.access_token) {
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
  return graphPostWith(cfg, `/${cfg.phone_number_id}/messages`, {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'text',
    text: { body: text, preview_url: false },
  });
}

async function sendTemplateMessage(to, templateName, languageCode, components, db) {
  const cfg = await getConfig(db);
  if (!cfg.enabled || !cfg.phone_number_id || !cfg.access_token) {
    safeLog('[whatsapp] not configured, skipping template to', to);
    return { ok: false, error: 'WHATSAPP_NOT_CONFIGURED' };
  }
  const recipient = normalizeBdPhone(to);
  if (!recipient) return { ok: false, error: 'INVALID_RECIPIENT' };
  if (!templateName) return { ok: false, error: 'MISSING_TEMPLATE' };
  return graphPostWith(cfg, `/${cfg.phone_number_id}/messages`, {
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

// Test the configured credentials against the Graph API.
// Never returns or logs the token. db optional (env-only when omitted).
async function testConnection(db) {
  try {
    const cfg = await getConfig(db);
    if (!cfg.phone_number_id || !cfg.access_token) {
      return { ok: false, error: 'WHATSAPP_NOT_CONFIGURED' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(
        `${API_BASE}/${encodeURIComponent(cfg.phone_number_id)}?fields=display_phone_number`,
        {
          signal: controller.signal,
          headers: { 'Authorization': `Bearer ${cfg.access_token}` },
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data.error && data.error.message) || `HTTP_${res.status}`;
        safeLog('[whatsapp] test connection failed:', msg);
        return { ok: false, error: msg };
      }
      return { ok: true, number: data.display_phone_number || '' };
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'TIMEOUT' : (e.message || 'REQUEST_FAILED');
      safeLog('[whatsapp] test connection request failed:', msg);
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    safeLog('[whatsapp] testConnection failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

// ---- Editable message templates (admin settings) ----------------
// Admin can edit these in Settings -> WhatsApp. Placeholders in
// {braces} are replaced with real values at send time.
// DB key: settings.whatsapp = { enabled, business_number, phone_number_id,
//   access_token, order_completed_msg, recharge_approved_msg }
// (access_token is never returned to the client; see routes/admin.js)
const DEFAULT_TEMPLATES = {
  order_completed_msg:
    '{greeting} 🎉\n' +
    'আপনার {service_name} সেবাটি সফলভাবে সম্পন্ন হয়েছে ✅\n' +
    'অর্ডার নম্বর: {order_number}\n' +
    'ডেলিভারি ফাইলটি আপনার অ্যাকাউন্টের ইতিহাস (History) থেকে যেকোনো সময় আবার ডাউনলোড করতে পারবেন।\n' +
    'Abc Authentic-এর সঙ্গে থাকার জন্য আন্তরিক ধন্যবাদ।',
  recharge_approved_msg:
    '{greeting}\n' +
    'আপনার ৳{amount} রিচার্জ সফলভাবে সম্পন্ন হয়েছে ✅\n' +
    'বর্তমান ওয়ালেট ব্যালেন্স: ৳{balance}\n' +
    'Abc Authentic-এ আস্থা রাখার জন্য আন্তরিক ধন্যবাদ।',
};

// Check if a specific notification type is enabled (default: true)
async function isNotifyEnabled(db, key) {
  try {
    const r = await db.query("SELECT value FROM settings WHERE key = 'whatsapp'");
    if (r.rows.length) {
      const v = typeof r.rows[0].value === 'string'
        ? JSON.parse(r.rows[0].value)
        : r.rows[0].value;
      if (v.notify && typeof v.notify[key] === 'boolean') return v.notify[key];
    }
  } catch (_) {}
  return true; // default enabled
}

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

// Religion-aware greeting (users.religion: islam|hindu|buddhist|
// christian|other). It travels INSIDE the first template variable so
// one set of approved Meta templates greets everyone appropriately:
// islam → আসসালামু আলাইকুম, hindu/buddhist → নমস্কার, else → শুভেচ্ছা.
function greetingFor(user) {
  const name = (user && user.name) || '';
  const rel = String((user && user.religion) || '').trim().toLowerCase();
  let word = 'শুভেচ্ছা';
  if (rel === 'islam' || rel === 'muslim') word = 'আসসালামু আলাইকুম';
  else if (rel === 'hindu' || rel === 'buddhist') word = 'নমস্কার';
  return name ? word + ' ' + name : word;
}

// ---- Meta TEMPLATE delivery (the permanent fix for silent drops) --
// Business-initiated free text only DELIVERS inside Meta's 24-hour
// customer-service window. Outside it the Graph API still accepts the
// request (we logged 'sent') but the message never reaches the phone.
// Approved TEMPLATE messages are the only format Meta delivers
// unconditionally, so every notification goes out as a template first.
// Template names default to the built-ins below (create templates with
// EXACTLY these names in WhatsApp Manager, language bn, category
// Utility); settings.whatsapp.meta_templates can override per event.
// If the template send fails (e.g. not yet approved), we fall back to
// free text so users inside the 24h window are still reached, and the
// log line says which path was taken.
const DEFAULT_META_TEMPLATES = {
  recharge_approved: 'abc_recharge_approved',
  recharge_rejected: 'abc_recharge_rejected',
  recharge_mismatch: 'abc_recharge_mismatch',
  order_completed: 'abc_order_completed',
  order_failed: 'abc_order_failed',
  order_cancelled: 'abc_order_cancelled',
  service_completed: 'abc_service_completed',
  service_failed: 'abc_service_failed',
  cashback_received: 'abc_cashback_received',
  trxid_warning: 'abc_trxid_notice',
};

async function getMetaTemplates(db) {
  const out = Object.assign({}, DEFAULT_META_TEMPLATES);
  try {
    const r = await db.query("SELECT value FROM settings WHERE key = 'whatsapp'");
    if (r.rows.length) {
      const v = typeof r.rows[0].value === 'string'
        ? JSON.parse(r.rows[0].value)
        : r.rows[0].value;
      if (v && v.meta_templates && typeof v.meta_templates === 'object') {
        for (const k of Object.keys(out)) {
          if (typeof v.meta_templates[k] === 'string' && v.meta_templates[k].trim()) {
            out[k] = v.meta_templates[k].trim();
          }
        }
      }
    }
  } catch (_) { /* defaults stand */ }
  return out;
}

async function dispatch(db, eventKey, user, { text, params }) {
  const names = await getMetaTemplates(db);
  const tplName = names[eventKey];
  if (tplName) {
    const components = (params && params.length)
      ? [{
          type: 'body',
          parameters: params.map((t) => ({ type: 'text', text: String(t == null ? '' : t) })),
        }]
      : [];
    const r = await sendTemplateMessage(user.whatsapp, tplName, 'bn', components, db);
    if (r.ok) {
      safeLog('[whatsapp]', eventKey, 'template -> sent');
      return r;
    }
    safeLog('[whatsapp]', eventKey, 'template failed (' + r.error + '), falling back to text');
  }
  const r = await sendTextMessage(user.whatsapp, text, db);
  safeLog('[whatsapp]', eventKey, 'text ->', r.ok ? 'sent' : r.error);
  return r;
}

// ---- Bengali message builders (defaults; admin templates override) --
function orderCompletedMessage({ name, greeting, orderId, serviceName, status }) {
  return renderTemplate(DEFAULT_TEMPLATES.order_completed_msg, {
    name: name || '',
    greeting: greeting || name || '',
    order_number: String(orderId || '').slice(0, 8),
    service_name: serviceName || '',
    status: status || '',
  });
}

function rechargeApprovedMessage({ name, greeting, amount, newBalance }) {
  return renderTemplate(DEFAULT_TEMPLATES.recharge_approved_msg, {
    name: name || '',
    greeting: greeting || name || '',
    amount: amount,
    balance: (newBalance !== undefined && newBalance !== null) ? newBalance : '',
  });
}

// ---- High-level notifiers (never throw) -----------------------
// Fetch user + service, check toggles, send. Fire-and-forget safe.
async function notifyOrderCompleted(db, order) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'order_completed'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [order.user_id]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    let serviceName = '';
    try {
      const s = await db.query(
        'SELECT name, name_bn FROM services WHERE id = $1', [order.service_id]
      );
      serviceName = (s.rows[0] && (s.rows[0].name_bn || s.rows[0].name)) || '';
    } catch (_) { /* service name is optional */ }
    const tpl = await getTemplates(db);
    const msg = renderTemplate(tpl.order_completed_msg, {
      name: user.name || '',
      greeting: greetingFor(user),
      order_number: String(order.id || '').slice(0, 8),
      service_name: serviceName,
      status: order.status,
    });
    return dispatch(db, 'order_completed', user, {
      text: msg,
      params: [greetingFor(user), serviceName, String(order.id || '').slice(0, 8)],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyOrderCompleted failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

async function notifyOrderFailed(db, order) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'order_failed'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [order.user_id]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    let serviceName = '';
    try {
      const s = await db.query(
        'SELECT name, name_bn FROM services WHERE id = $1', [order.service_id]
      );
      serviceName = (s.rows[0] && (s.rows[0].name_bn || s.rows[0].name)) || '';
    } catch (_) {}
    const short = String(order.id || '').slice(0, 8);
    const msg =
      `${greetingFor(user)}\n` +
      `দুঃখিত — আপনার ${serviceName} সেবাটি (অর্ডার নম্বর: ${short}) সম্পন্ন করা যায়নি।\n` +
      'কোনো টাকা কেটে থাকলে তা আপনার ওয়ালেটে ফেরত দেওয়া হয়েছে। সহায়তার জন্য আমাদের সাপোর্টে যোগাযোগ করুন।';
    return dispatch(db, 'order_failed', user, {
      text: msg,
      params: [greetingFor(user), serviceName, short],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyOrderFailed failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

async function notifyOrderCancelled(db, order) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'order_cancelled'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [order.user_id]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const short = String(order.id || '').slice(0, 8);
    const msg =
      `${greetingFor(user)}\n` +
      `আপনার অর্ডার (নম্বর: ${short}) বাতিল করা হয়েছে।\n` +
      'কেটে নেওয়া টাকা আপনার ওয়ালেটে ফেরত দেওয়া হয়েছে।';
    return dispatch(db, 'order_cancelled', user, {
      text: msg,
      params: [greetingFor(user), short],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyOrderCancelled failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

async function notifyRechargeApproved(db, tx) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'recharge_approved'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, balance, religion FROM users WHERE id = $1', [tx.user_id]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const tpl = await getTemplates(db);
    const msg = renderTemplate(tpl.recharge_approved_msg, {
      name: user.name || '',
      greeting: greetingFor(user),
      amount: Number(tx.amount),
      balance: user.balance,
    });
    return dispatch(db, 'recharge_approved', user, {
      text: msg,
      params: [greetingFor(user), Number(tx.amount), user.balance],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyRechargeApproved failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}


// Recharge request cancelled because the SMS amount and the claimed
// amount disagree. More informative than the generic rejected message.
async function notifyRechargeMismatch(db, tx, smsAmount) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'recharge_rejected'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [tx.user_id]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const msg =
      `${greetingFor(user)}\n` +
      `আপনার রিচার্জের অনুরোধে ৳${Number(tx.amount)} লেখা ছিল, কিন্তু প্রাপ্ত SMS অনুযায়ী এসেছে ৳${Number(smsAmount)} — পরিমাণে অমিল থাকায় অনুরোধটি বাতিল হয়েছে, টাকা যোগ হয়নি।\n` +
      'সঠিক পরিমাণ লিখে আবার চেষ্টা করুন।';
    return dispatch(db, 'recharge_mismatch', user, {
      text: msg,
      params: [greetingFor(user), Number(tx.amount), Number(smsAmount)],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyRechargeMismatch failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

async function notifyRechargeRejected(db, tx) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'recharge_rejected'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [tx.user_id]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const msg =
      `${greetingFor(user)}\n` +
      `দুঃখিত — আপনার ৳${Number(tx.amount)} রিচার্জের অনুরোধটি সম্পন্ন করা যায়নি ❌\n` +
      'তথ্য যাচাই করে আবার চেষ্টা করুন। প্রয়োজনে আমাদের সাপোর্টে যোগাযোগ করুন।';
    return dispatch(db, 'recharge_rejected', user, {
      text: msg,
      params: [greetingFor(user), Number(tx.amount)],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyRechargeRejected failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

// A standalone engine service finished (NID card built, BDRIS
// application submitted, certificate / death-verify PDF issued).
// One generic notifier so every service a customer takes from any
// engine confirms back to them on WhatsApp.
async function notifyServiceCompleted(db, userId, serviceLabel) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'service_completed'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [userId]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const label = String(serviceLabel || 'সেবা');
    const text =
      `${greetingFor(user)} 🎉\n` +
      `আপনার ${label} সফলভাবে সম্পন্ন হয়েছে ✅\n` +
      'ফাইলটি আপনার অ্যাকাউন্টের ইতিহাস (History) থেকে যেকোনো সময় আবার ডাউনলোড করতে পারবেন।\n' +
      'Abc Authentic-এর সঙ্গে থাকার জন্য আন্তরিক ধন্যবাদ।';
    return dispatch(db, 'service_completed', user, {
      text,
      params: [greetingFor(user), label],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyServiceCompleted failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

// Mirror of notifyServiceCompleted for a FAILED engine service
// (e.g. a QR + photo verification that did not match). The
// customer is told it failed, why, and — most importantly —
// that no money was taken. Template: abc_service_failed.
async function notifyServiceFailed(db, userId, serviceLabel, reason, retryHint) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'service_failed'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [userId]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const label = String(serviceLabel || 'সেবা');
    const why = String(reason || 'তথ্য মেলেনি');
    const retry = String(retryHint || 'তথ্য ঠিক করে আবার চেষ্টা করুন। সহায়তা লাগলে আমাদের সাপোর্টে যোগাযোগ করুন।');
    const text =
      `${greetingFor(user)}\n` +
      `দুঃখিত — আপনার ${label} সফল হয়নি ❌\n` +
      `কারণ: ${why}\n` +
      `কোনো টাকা কাটা হয়নি। ${retry}`;
    return dispatch(db, 'service_failed', user, {
      text,
      params: [greetingFor(user), label],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyServiceFailed failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

// Fraud guard: a recharge was attempted with an already-used TrxID
// (one payment claimed twice). The attempt is blocked by the caller;
// this warns the attempter on WhatsApp.
async function notifyDuplicateTrxid(db, userId, attempt) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'trxid_warning'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [userId]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const trxid = String((attempt && attempt.trxid) || '');
    const text =
      `${greetingFor(user)}\n` +
      `⚠️ সতর্কবার্তা: এই TrxID (${trxid}) ইতিমধ্যে একবার ব্যবহার করা হয়েছে — একই পেমেন্ট দিয়ে দ্বিতীয়বার রিচার্জ করা যাবে না। আপনার চেষ্টাটি আটকে দেওয়া হয়েছে।\n` +
      'বারবার এমন চেষ্টা করলে অ্যাকাউন্ট ব্লক করা হতে পারে। কোনো ভুল হয়ে থাকলে আমাদের সাপোর্টে যোগাযোগ করুন।';
    return dispatch(db, 'trxid_warning', user, {
      text,
      params: [greetingFor(user), trxid],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyDuplicateTrxid failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

// Cashback received (daily claim or per-recharge coupon). One
// wording for both money shapes: plain wallet credit, or a
// service-locked credit when the admin scoped cashback to one
// service. Template-first ('abc_cashback_received'), free-text
// fallback inside the 24h window.
async function notifyCashbackReceived(db, userId, { amount, code, serviceLocked, kind } = {}) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'cashback_received'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [userId]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const amt = String(Number(amount) || 0);
    const coupon = String(code || '');
    const where = kind === 'coupon'
      ? 'কুপনটি ব্যবহারের সময় ছাড় পাবেন'
      : serviceLocked
        ? 'টাকাটি নির্দিষ্ট সেবার ক্রেডিট হিসেবে যোগ হয়েছে'
        : 'টাকাটি আপনার ওয়ালেটে যোগ হয়েছে';
    const text =
      `${greetingFor(user)}\n` +
      `অভিনন্দন! 🎉 আপনার ক্যাশব্যাক ৳${amt} পেয়েছেন ✅\n` +
      `${where}।\n` +
      `কুপন কোড: ${coupon}\n` +
      'Abc Authentic-এর সঙ্গে থাকার জন্য আন্তরিক ধন্যবাদ।';
    const sent = await dispatch(db, user, 'cashback_received',
      [greetingFor(user), amt, coupon], text);
    if (!sent.ok) safeLog('[whatsapp] cashback notify not sent:', sent.error);
    return sent;
  } catch (e) {
    safeLog('[whatsapp] notifyCashbackReceived failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  isConfigured,
  getConfig,
  normalizeBdPhone,
  sendTextMessage,
  sendTemplateMessage,
  getMetaTemplates,
  greetingFor,
  testConnection,
  renderTemplate,
  orderCompletedMessage,
  rechargeApprovedMessage,
  notifyOrderCompleted,
  notifyOrderFailed,
  notifyOrderCancelled,
  notifyRechargeApproved,
  notifyRechargeMismatch,
  notifyRechargeRejected,
  notifyServiceCompleted,
  notifyServiceFailed,
  notifyCashbackReceived,
  notifyDuplicateTrxid,
};
// M-22 (2026-10-15): removed never-used exports (canSend, graphPost,
// DEFAULT_TEMPLATES, getTemplates) — dead API surface. sendTemplateMessage
// and getMetaTemplates returned 2026-10-21: template delivery is now the
// primary notification path (see dispatch above).
