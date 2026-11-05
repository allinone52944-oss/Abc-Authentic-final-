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
  service_failed: 'abc_verify_failed',
  cashback_received: 'abc_cashback_received',
  welcome: 'abc_welcome',
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
async function notifyOrderCompleted(db, order, opts) {
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
    const short = String(order.id || '').slice(0, 8);
    // Admin-order fix (2026-11-03): the completed template promises a
    // downloadable delivery file. When the order has NO admin-uploaded
    // delivery file, that promise is false — send plain text with no
    // file sentence instead. The 'order_completed_nofile' event has no
    // Meta template mapping, so dispatch goes straight to text (the
    // template path could otherwise re-introduce the file sentence).
    if (opts && opts.hasDeliveryFile === false) {
      const text =
        `${greetingFor(user)} 🎉\n` +
        `আপনার ${serviceName} সেবাটি সফলভাবে সম্পন্ন হয়েছে ✅\n` +
        `অর্ডার নম্বর: ${short}\n` +
        'Abc Authentic-এর সঙ্গে থাকার জন্য আন্তরিক ধন্যবাদ।';
      return dispatch(db, 'order_completed_nofile', user, {
        text,
        params: [greetingFor(user), serviceName, short],
      });
    }
    const tpl = await getTemplates(db);
    const msg = renderTemplate(tpl.order_completed_msg, {
      name: user.name || '',
      greeting: greetingFor(user),
      order_number: short,
      service_name: serviceName,
      status: order.status,
    });
    return dispatch(db, 'order_completed', user, {
      text: msg,
      params: [greetingFor(user), serviceName, short],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyOrderCompleted failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

// Admin-order fix (2026-11-03): delivered gets its OWN message — the
// completed template/text must not be reused for delivery, or the
// customer gets the same "completed" message twice for one delivery.
// Plain text (no Meta template mapping yet, so dispatch falls back
// to text); the file sentence appears only when the order actually
// has an admin-uploaded delivery file.
async function notifyOrderDelivered(db, order, opts) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'order_delivered'))) return { ok: false, error: 'NOTIFY_OFF' };
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
    const short = String(order.id || '').slice(0, 8);
    const hasFile = !!(opts && opts.hasDeliveryFile);
    let text =
      `${greetingFor(user)} 🎉\n` +
      `আপনার ${serviceName} সেবাটি ডেলিভার্ড হয়েছে ✅\n` +
      `অর্ডার নম্বর: ${short}\n`;
    if (hasFile) {
      text += 'ডেলিভারি ফাইলটি আপনার অ্যাকাউন্টের ইতিহাস (History) থেকে যেকোনো সময় আবার ডাউনলোড করতে পারবেন।\n';
    }
    text += 'Abc Authentic-এর সঙ্গে থাকার জন্য আন্তরিক ধন্যবাদ।';
    return dispatch(db, 'order_delivered', user, {
      text,
      params: [greetingFor(user), serviceName, short],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyOrderDelivered failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

// Admin-order fix (2026-11-03): refunds previously notified nobody.
// The split matters: a credit part goes back to service credit, not
// the wallet — never tell the customer the whole amount is in the
// wallet when part of it is locked credit. Plain text (no Meta
// template mapping yet, so dispatch falls back to text).
async function notifyOrderRefunded(db, order, opts) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'order_refunded'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [order.user_id]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const short = String(order.id || '').slice(0, 8);
    const amount = Number(order.price) || 0;
    const creditPart = opts && opts.creditPart ? Number(opts.creditPart) : 0;
    const balancePart = opts && opts.balancePart !== undefined && opts.balancePart !== null
      ? Number(opts.balancePart) : amount;
    let text =
      `${greetingFor(user)}\n` +
      `আপনার অর্ডার (নম্বর: ${short}) রিফান্ড করা হয়েছে।\n`;
    if (creditPart > 0 && balancePart > 0) {
      text += `৳${balancePart} আপনার ওয়ালেটে এবং ৳${creditPart} ওই সেবার ক্রেডিটে ফেরত দেওয়া হয়েছে।`;
    } else if (creditPart > 0) {
      text += `৳${creditPart} ওই সেবার ক্রেডিটে ফেরত দেওয়া হয়েছে।`;
    } else {
      text += `৳${amount} আপনার ওয়ালেটে ফেরত দেওয়া হয়েছে।`;
    }
    return dispatch(db, 'order_refunded', user, {
      text,
      params: [greetingFor(user), short, String(amount)],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyOrderRefunded failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

// Auto-refund line for failed/cancelled notices (2026-11-03):
// only parts that actually moved are named; no refund (price 0,
// or this transition did not move money) → no money sentence at
// all. Never claim money that did not move.
function refundLineForNotice(opts) {
  if (!opts || !opts.refunded) return '';
  const credit = Number(opts.creditPart) || 0;
  const balance = (opts.balancePart !== undefined && opts.balancePart !== null)
    ? Number(opts.balancePart) : 0;
  if (credit > 0 && balance > 0) return `৳${balance} আপনার ওয়ালেটে এবং ৳${credit} ওই সেবার ক্রেডিটে ফেরত দেওয়া হয়েছে।`;
  if (credit > 0) return `৳${credit} ওই সেবার ক্রেডিটে ফেরত দেওয়া হয়েছে।`;
  if (balance > 0) return `৳${balance} আপনার ওয়ালেটে ফেরত দেওয়া হয়েছে।`;
  return '';
}

async function notifyOrderFailed(db, order, opts) {
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
    // Auto-refund (2026-11-03): failing an order refunds it at once
    // (same transaction). The notice itself names the refund — the
    // old "refund separately, contact support" line is no longer
    // true and must never appear again.
    const refundLine = refundLineForNotice(opts);
    const msg =
      `${greetingFor(user)}\n` +
      `দুঃখিত — আপনার ${serviceName} সেবাটি (অর্ডার নম্বর: ${short}) সম্পন্ন করা যায়নি।` +
      (refundLine ? `\n${refundLine}` : '');
    return dispatch(db, 'order_failed', user, {
      text: msg,
      params: [greetingFor(user), serviceName, short],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyOrderFailed failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

async function notifyOrderCancelled(db, order, opts) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'order_cancelled'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [order.user_id]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const short = String(order.id || '').slice(0, 8);
    // Auto-refund (2026-11-03): cancelling an order refunds it at
    // once (same transaction). The notice itself names the refund
    // — the old "refund separately" line is no longer true.
    // P2 (2026-11-03): the explicit cancel reason travels here as
    // opts.cancelReason — never the internal admin_note.
    const refundLine = refundLineForNotice(opts);
    const reason = opts && opts.cancelReason ? String(opts.cancelReason).trim() : '';
    const msg =
      `${greetingFor(user)}\n` +
      `আপনার অর্ডার (নম্বর: ${short}) বাতিল করা হয়েছে।` +
      (reason ? `\nকারণ: ${reason}` : '') +
      (refundLine ? `\n${refundLine}` : '');
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


// Recharge request amount-mismatch: the SMS amount and the claimed
// amount disagree. More informative than the generic rejected message.
// `held` (audit #26): the request is HELD for admin review, not
// cancelled — the parser may have misread the amount. Default
// false keeps the submit-refusal wording used by routes/user.js
// (no request exists there to hold).
async function notifyRechargeMismatch(db, tx, smsAmount, held = false) {
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
      (held
        ? `আপনার রিচার্জের অনুরোধে ৳${Number(tx.amount)} লেখা ছিল, কিন্তু প্রাপ্ত SMS অনুযায়ী এসেছে ৳${Number(smsAmount)} — পরিমাণে অমিল থাকায় অনুরোধটি আটকে আছে, এডমিন যাচাই করছেন। টাকা এখনো যোগ হয়নি।`
        : `আপনার রিচার্জের অনুরোধে ৳${Number(tx.amount)} লেখা ছিল, কিন্তু প্রাপ্ত SMS অনুযায়ী এসেছে ৳${Number(smsAmount)} — পরিমাণে অমিল থাকায় অনুরোধটি বাতিল হয়েছে, টাকা যোগ হয়নি।\nসঠিক পরিমাণ লিখে আবার চেষ্টা করুন।`);
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
async function notifyServiceCompleted(db, userId, serviceLabel, opts) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'service_completed'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [userId]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const label = String(serviceLabel || 'সেবা');
    // Admin-order fix (2026-11-03): manual completed without a delivery
    // file must not promise one. opts.hasDeliveryFile === false drops
    // the file sentence; unset opts keep the old text (engine callers).
    let text =
      `${greetingFor(user)} 🎉\n` +
      `আপনার ${label} সফলভাবে সম্পন্ন হয়েছে ✅\n`;
    if (!(opts && opts.hasDeliveryFile === false)) {
      text += 'ফাইলটি আপনার অ্যাকাউন্টের ইতিহাস (History) থেকে যেকোনো সময় আবার ডাউনলোড করতে পারবেন।\n';
    }
    text += 'Abc Authentic-এর সঙ্গে থাকার জন্য আন্তরিক ধন্যবাদ।';
    return dispatch(db, 'service_completed', user, {
      text,
      params: [greetingFor(user), label],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyServiceCompleted failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

// P2 (2026-11-03): a manual submission REJECTED by the admin.
// Same pattern as notifyServiceCompleted: template first via
// dispatch (no Meta template is mapped for 'service_rejected' yet,
// so dispatch falls back to free text — the in-window path), push
// is sent by the caller alongside.
async function notifyServiceRejected(db, userId, serviceLabel) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'service_rejected'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [userId]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const label = String(serviceLabel || 'ম্যানুয়াল সেবা');
    const text =
      `${greetingFor(user)}\n` +
      `দুঃখিত — আপনার ${label} অনুরোধটি সম্পন্ন করা যায়নি ❌\n` +
      'সহায়তার জন্য সাপোর্টে যোগাযোগ করুন।';
    return dispatch(db, 'service_rejected', user, {
      text,
      params: [greetingFor(user), label],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyServiceRejected failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

// P2 (2026-11-03): a file added to an ALREADY-delivered order.
// Deliberately its own message — reusing the delivered message
// here would tell the customer the order was "delivered" a second
// time. The caller (delivery-docs endpoint) fires this only when
// the order is already delivered, so it can never double with the
// first-delivery notice.
async function notifyDeliveryFileAdded(db, order, opts) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'delivery_file_added'))) return { ok: false, error: 'NOTIFY_OFF' };
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
    const text =
      `${greetingFor(user)}\n` +
      `আপনার ${serviceName} অর্ডারে (নম্বর: ${short}) একটি নতুন ডেলিভারি ফাইল যোগ করা হয়েছে 📎\n` +
      'ফাইলটি আপনার অ্যাকাউন্টের ইতিহাস (History) থেকে ডাউনলোড করতে পারবেন।';
    return dispatch(db, 'delivery_file_added', user, {
      text,
      params: [greetingFor(user), serviceName, short],
    });
  } catch (e) {
    safeLog('[whatsapp] notifyDeliveryFileAdded failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

// Mirror of notifyServiceCompleted for a FAILED engine service
// (e.g. a QR + photo verification that did not match). The
// customer is told it failed, why, and — most importantly —
// that no money was taken. Template: abc_verify_failed (the first attempt, abc_service_failed, was rejected by Meta's automated review on 2026-10-22 with no reason shown; this name + a verification-framed body replaced it).
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

// Welcome message for a brand-new customer (registration).
// A new registrant has never messaged the business, so there is
// no 24h window — this only ever reaches them via the template
// ('abc_welcome'); the free-text fallback covers the rare case
// where a window happens to be open already.
async function notifyWelcome(db, userId) {
  try {
    if (!(await canSend(db))) return { ok: false, error: 'DISABLED' };
    if (!(await isNotifyEnabled(db, 'welcome'))) return { ok: false, error: 'NOTIFY_OFF' };
    const u = await db.query(
      'SELECT name, whatsapp, religion FROM users WHERE id = $1', [userId]
    );
    const user = u.rows[0];
    if (!user || !user.whatsapp) return { ok: false, error: 'NO_WHATSAPP' };
    const text =
      `${greetingFor(user)}\n` +
      'Abc Authentic-এ স্বাগতম! 🎉\n' +
      'আপনার অ্যাকাউন্ট তৈরি হয়েছে। ওয়ালেটে রিচার্জ করে যেকোনো সেবা নিতে পারবেন।\n' +
      'সহায়তা লাগলে এই নম্বরেই মেসেজ করুন।';
    const sent = await dispatch(db, 'welcome', user, {
      text, params: [greetingFor(user)],
    });
    if (!sent.ok) safeLog('[whatsapp] welcome notify not sent:', sent.error);
    return sent;
  } catch (e) {
    safeLog('[whatsapp] notifyWelcome failed:', e.message);
    return { ok: false, error: e.message };
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
    const sent = await dispatch(db, 'cashback_received', user, {
      text, params: [greetingFor(user), amt, coupon],
    });
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
  notifyOrderDelivered,
  notifyOrderRefunded,
  notifyOrderFailed,
  notifyOrderCancelled,
  notifyRechargeApproved,
  notifyRechargeMismatch,
  notifyRechargeRejected,
  notifyServiceCompleted,
  notifyServiceFailed,
  notifyServiceRejected,
  notifyDeliveryFileAdded,
  notifyCashbackReceived,
  notifyWelcome,
  notifyDuplicateTrxid,
};
// M-22 (2026-10-15): removed never-used exports (canSend, graphPost,
// DEFAULT_TEMPLATES, getTemplates) — dead API surface. sendTemplateMessage
// and getMetaTemplates returned 2026-10-21: template delivery is now the
// primary notification path (see dispatch above).
