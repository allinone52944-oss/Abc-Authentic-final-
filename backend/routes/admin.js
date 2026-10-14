// ============================================================
// All In One (Abc Authentic) - Admin routes (Phase 2)
// Mounted at /api/admin with requireAuth + requireAdmin.
// Self-protection: admin CANNOT delete self, CANNOT change own
// role. All sensitive actions logged to activity_log.
// ============================================================
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const db = require('../db');
const { requireAuth, requireAdmin, hashPassword, verifyPassword } = require('../auth');
const { safeLog } = require('../security');
const wa = require('../utils/whatsapp');

const orderDocStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = '/opt/all-in-one-abc-authentic/uploads/orders';
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `delivery-${req.params.id}-${Date.now()}${ext}`);
  }
});
const orderDocUpload = multer({
  storage: orderDocStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (['pdf','jpg','jpeg','png'].includes(ext)) cb(null, true);
    else cb(new Error('FILE_TYPE_NOT_ALLOWED'));
  }
});

const router = express.Router();
router.use(requireAuth, requireAdmin);

// ---- activity log helper --------------------------------------
async function logActivity(adminId, action, details) {
  try {
    await db.query(
      'INSERT INTO activity_log (admin_id, action, details) VALUES ($1, $2, $3)',
      [adminId, action, JSON.stringify(details || {})]
    );
  } catch (e) { safeLog('[admin] log failed:', e.message); }
}

function pageParams(req) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

// ============================================================
// USERS
// ============================================================

// GET /api/admin/users?q=&status=&page=
router.get('/users', async (req, res) => {
  try {
    const { page, limit, offset } = pageParams(req);
    const q = (req.query.q || '').trim();
    const status = req.query.status;
    const conds = [];
    const params = [];
    let i = 1;
    if (q) {
      conds.push(`(name ILIKE $${i} OR phone ILIKE $${i} OR email ILIKE $${i})`);
      params.push('%' + q + '%'); i++;
    }
    if (status && ['active', 'disabled', 'blocked', 'pending'].includes(status)) {
      conds.push(`status = $${i++}`); params.push(status);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = await db.query(`SELECT COUNT(*) FROM users ${where}`, params);
    const rows = await db.query(
      `SELECT id, name, phone, whatsapp, email, religion, gender, role,
              balance, status, login_enabled, email_verified, created_at
       FROM users ${where} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]
    );
    res.json({ users: rows.rows, total: parseInt(total.rows[0].count, 10), page, limit });
  } catch (e) {
    safeLog('[admin] users list error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// POST /api/admin/users (admin creates user)
router.post('/users', async (req, res) => {
  try {
    const { name, phone, whatsapp, email, password, religion, role } = req.body || {};
    if (!name || !/^01[3-9]\d{8}$/.test(String(phone || '').trim())) {
      return res.status(400).json({ error: 'INVALID_INPUT' });
    }
    if (!/^01[3-9]\d{8}$/.test(String(whatsapp || '').trim())) {
      return res.status(400).json({ error: 'INVALID_WHATSAPP' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'WEAK_PASSWORD' });
    }
    const r = await db.query('SELECT id FROM users WHERE phone = $1 LIMIT 1', [String(phone).trim()]);
    if (r.rows.length) return res.status(409).json({ error: 'PHONE_TAKEN' });

    const password_hash = await hashPassword(String(password));
    const ins = await db.query(
      `INSERT INTO users (name, phone, whatsapp, email, password_hash, religion, role, status, email_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',TRUE)
       RETURNING id, name, phone, whatsapp, email, religion, role, balance, status, created_at`,
      [String(name).trim(), String(phone).trim(), String(whatsapp).trim(),
       email ? String(email).trim().toLowerCase() : null,
       password_hash, religion || 'other', role === 'admin' ? 'admin' : 'user']
    );
    await logActivity(req.user.id, 'user.create', { user_id: ins.rows[0].id, phone });
    res.status(201).json({ user: ins.rows[0] });
  } catch (e) {
    safeLog('[admin] user create error:', e.message);
    res.status(500).json({ error: 'CREATE_FAILED' });
  }
});

// PUT /api/admin/users/:id
router.put('/users/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { name, email, religion, role, status, login_enabled, balance_adjust, admin_note } = req.body || {};

    const cur = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const target = cur.rows[0];
    const isSelf = target.id === req.user.id;

    // Self-protection: cannot change own role
    if (isSelf && role && role !== target.role) {
      return res.status(403).json({ error: 'ERR_CANNOT_CHANGE_OWN_ROLE' });
    }
    // Self-protection: cannot disable own account
    if (isSelf && (status === 'disabled' || status === 'blocked' || login_enabled === false)) {
      return res.status(403).json({ error: 'ERR_CANNOT_DISABLE_SELF' });
    }

    const sets = [];
    const params = [];
    let i = 1;
    const changes = {};

    if (name !== undefined) { sets.push(`name = $${i++}`); params.push(String(name).trim()); changes.name = name; }
    if (email !== undefined) {
      const em = String(email).trim().toLowerCase();
      // Check email not used by another user
      if (em) {
        const ex = await db.query('SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2', [em, id]);
        if (ex.rows.length) return res.status(400).json({ error: 'EMAIL_EXISTS' });
      }
      sets.push(`email = $${i++}`); params.push(em || null); changes.email = em;
      // Reset verification when email changes
      sets.push(`email_verified = $${i++}`); params.push(false);
    }
    if (religion !== undefined) { sets.push(`religion = $${i++}`); params.push(religion); changes.religion = religion; }
    if (role !== undefined && ['admin', 'user'].includes(role)) {
      sets.push(`role = $${i++}`); params.push(role); changes.role = role;
    }
    if (status !== undefined && ['active', 'disabled', 'blocked', 'pending'].includes(status)) {
      sets.push(`status = $${i++}`); params.push(status); changes.status = status;
    }
    if (login_enabled !== undefined) {
      sets.push(`login_enabled = $${i++}`); params.push(!!login_enabled); changes.login_enabled = !!login_enabled;
    }

    // Balance adjustment (atomic, logged)
    if (balance_adjust !== undefined && Number(balance_adjust) !== 0) {
      const amt = Number(balance_adjust);
      const w = await db.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
        id, amt, amt > 0 ? 'bonus' : 'debit', 'admin-adjust-' + Date.now(),
      ]).catch((e) => ({ error: e }));
      if (w.error) {
        return res.status(400).json({ error: w.error.message || 'BALANCE_FAILED' });
      }
      changes.balance_adjust = amt;
    }

    // Per-service price / access overrides
    if (req.body.service_overrides && typeof req.body.service_overrides === 'object') {
      for (const [serviceId, ov] of Object.entries(req.body.service_overrides)) {
        await db.query(
          `INSERT INTO user_services (user_id, service_id, custom_price, access_enabled)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, service_id)
           DO UPDATE SET custom_price = EXCLUDED.custom_price,
                         access_enabled = EXCLUDED.access_enabled`,
          [id, serviceId,
           ov.custom_price === null || ov.custom_price === undefined ? null : Number(ov.custom_price),
           ov.access_enabled !== false]
        );
      }
      changes.service_overrides = Object.keys(req.body.service_overrides).length;
    }

    // Per-user notice
    if (req.body.notice) {
      await db.query('INSERT INTO notices (user_id, title, message) VALUES ($1, $2, $3)',
        [id, req.body.notice.title || 'নোটিশ', req.body.notice.message || '']);
      changes.notice = true;
    }

    if (sets.length) {
      params.push(id);
      await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`, params);
    }

    await logActivity(req.user.id, 'user.update', { user_id: id, changes });
    const fresh = await db.query(
      `SELECT id, name, phone, whatsapp, email, religion, role, balance, status,
              login_enabled, created_at FROM users WHERE id = $1`, [id]);
    res.json({ user: fresh.rows[0] });
  } catch (e) {
    safeLog('[admin] user update error:', e.message);
    res.status(500).json({ error: 'UPDATE_FAILED' });
  }
});

// POST /api/admin/users/:id/unblock (admin unblocks login-locked user)
router.post('/users/:id/unblock', async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1',
      [req.params.id]
    );
    await logActivity(req.user.id, 'user.unblock', { user_id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    safeLog('[admin] unblock error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// DELETE /api/admin/users/:id?confirm=yes — deletes user + ALL data
router.delete('/users/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (id === req.user.id) {
      return res.status(403).json({ error: 'ERR_CANNOT_DELETE_SELF' });
    }
    if (req.query.confirm !== 'yes') {
      return res.status(400).json({ error: 'CONFIRM_REQUIRED' });
    }
    const cur = await db.query('SELECT id, phone, name FROM users WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });

    // Count what will be deleted (for the log)
    const counts = await db.query(
      `SELECT (SELECT COUNT(*) FROM orders WHERE user_id = $1) AS orders,
              (SELECT COUNT(*) FROM transactions WHERE user_id = $1) AS transactions,
              (SELECT COUNT(*) FROM coupons WHERE user_id = $1) AS coupons,
              (SELECT COUNT(*) FROM notices WHERE user_id = $1) AS notices,
              (SELECT COUNT(*) FROM chat_messages WHERE user_id = $1) AS chat`,
      [id]
    );

    // ON DELETE CASCADE handles: user_services, orders, transactions,
    // coupons(user_id), notices(user_id), chat_messages, refresh_tokens.
    // Explicitly clear anything else first.
    await db.query('DELETE FROM users WHERE id = $1', [id]);

    await logActivity(req.user.id, 'user.delete', {
      user_id: id, phone: cur.rows[0].phone, name: cur.rows[0].name,
      deleted: counts.rows[0],
    });
    res.json({ ok: true, deleted: counts.rows[0] });
  } catch (e) {
    safeLog('[admin] user delete error:', e.message);
    res.status(500).json({ error: 'DELETE_FAILED' });
  }
});

// ============================================================
// ORDERS
// ============================================================

// GET /api/admin/orders?status=&q=&page=
router.get('/orders', async (req, res) => {
  try {
    const { page, limit, offset } = pageParams(req);
    const conds = [];
    const params = [];
    let i = 1;
    if (req.query.status) { conds.push(`o.status = $${i++}`); params.push(req.query.status); }
    if (req.query.q) {
      conds.push(`(u.name ILIKE $${i} OR u.phone ILIKE $${i} OR s.name ILIKE $${i})`);
      params.push('%' + req.query.q.trim() + '%'); i++;
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = await db.query(
      `SELECT COUNT(*) FROM orders o JOIN users u ON u.id = o.user_id
       JOIN services s ON s.id = o.service_id ${where}`, params);
    const rows = await db.query(
      `SELECT o.*, u.name AS user_name, u.phone AS user_phone,
              s.name AS service_name, s.name_bn AS service_name_bn
       FROM orders o JOIN users u ON u.id = o.user_id
       JOIN services s ON s.id = o.service_id
       ${where} ORDER BY o.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]);
    res.json({ orders: rows.rows, total: parseInt(total.rows[0].count, 10), page, limit });
  } catch (e) {
    safeLog('[admin] orders list error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// PUT /api/admin/orders/:id/status
const ORDER_STATUSES = ['new', 'pending', 'processing', 'completed', 'delivered', 'failed', 'cancelled', 'refunded'];
router.put('/orders/:id/status', async (req, res) => {
  try {
    const { status, admin_note } = req.body || {};
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'INVALID_STATUS' });
    }
    const r = await db.query(
      `UPDATE orders SET status = $1, admin_note = COALESCE($2, admin_note)
       WHERE id = $3 RETURNING *`,
      [status, admin_note || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });

    // Refund: credit the order price back to wallet (idempotent via wallet_apply)
    if (status === 'refunded') {
      try {
        await db.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
          r.rows[0].user_id, Number(r.rows[0].price), 'refund', 'refund-' + r.rows[0].id,
        ]);
      } catch (e) { safeLog('[admin] refund credit skipped:', e.message); }
    }

    await logActivity(req.user.id, 'order.status', {
      order_id: req.params.id, status, admin_note: admin_note || null,
    });

    // WhatsApp: order completed/delivered -> customer success message
    // (async, non-blocking, never breaks the response)
    if (status === 'completed' || status === 'delivered') {
      wa.notifyOrderCompleted(db, r.rows[0]).catch(() => {});
    }
    // WhatsApp: order failed -> customer failure message
    if (status === 'failed') {
      wa.notifyOrderFailed(db, r.rows[0]).catch(() => {});
    }
    // WhatsApp: order cancelled -> customer cancellation message
    if (status === 'cancelled') {
      wa.notifyOrderCancelled(db, r.rows[0]).catch(() => {});
    }

    res.json({ order: r.rows[0] });
  } catch (e) {
    safeLog('[admin] order status error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/admin/storage - List uploaded files by user
router.get('/storage', async (req, res) => {
  try {
    const dir = '/opt/all-in-one-abc-authentic/uploads/orders';
    if (!fs.existsSync(dir)) return res.json({ files: [] });
    const files = fs.readdirSync(dir);
    const out = [];
    for (const f of files) {
      const fp = path.join(dir, f);
      const st = fs.statSync(fp);
      // Parse orderId from filename: delivery-<orderId>-<timestamp>.<ext>
      const m = f.match(/^delivery-(.+?)-\d+\./);
      let userPhone = '', orderId = '';
      if (m) {
        orderId = m[1];
        const or = await db.query('SELECT user_id FROM orders WHERE id=$1', [orderId]).catch(() => ({ rows: [] }));
        if (or.rows.length) {
          const ur = await db.query('SELECT phone FROM users WHERE id=$1', [or.rows[0].user_id]).catch(() => ({ rows: [] }));
          if (ur.rows.length) userPhone = ur.rows[0].phone;
        }
      }
      out.push({ filename: f, size: st.size, size_kb: Math.round(st.size / 1024), mtime: st.mtime, user_phone: userPhone, order_id: orderId });
    }
    out.sort((a, b) => b.size - a.size);
    res.json({ files: out });
  } catch (e) { safeLog('[admin] storage list error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// DELETE /api/admin/storage/:filename - Delete uploaded file
router.delete('/storage/:filename', async (req, res) => {
  try {
    const fn = path.basename(req.params.filename);
    const fp = path.join('/opt/all-in-one-abc-authentic/uploads/orders', fn);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'NOT_FOUND' });
    fs.unlinkSync(fp);
    await logActivity(req.user.id, 'storage.delete', { filename: fn });
    res.json({ ok: true });
  } catch (e) { safeLog('[admin] storage delete error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// ---- Order support messages (Phase 3) --------------------------
// POST /api/admin/orders/:id/support-message { message, template_key? }
const SUPPORT_TEMPLATES = [
  { key: 'network',   emoji: '🌐', bn: 'নেটওয়ার্ক সমস্যার কারণে একটু দেরি হচ্ছে, অনুগ্রহ করে অপেক্ষা করুন' },
  { key: 'processing', emoji: '⏰', bn: 'আপনার অর্ডারটি প্রসেসিং-এ আছে, আরো ৩০ মিনিট সময় লাগতে পারে' },
  { key: 'verifying',  emoji: '📄', bn: 'ডকুমেন্ট যাচাই চলছে, শীঘ্রই আপডেট পাবেন' },
  { key: 'done',       emoji: '✅', bn: 'আপনার অর্ডার সম্পন্ন! ডাউনলোড করুন' },
  { key: 'failed',     emoji: '❌', bn: 'দুঃখিত, এই অর্ডারে সমস্যা হয়েছে। সাপোর্টে যোগাযোগ করুন' },
  { key: 'paid',       emoji: '💰', bn: 'পেমেন্ট পেয়েছি, অর্ডার প্রসেসিং শুরু হয়েছে' },
];

router.get('/support-templates', async (req, res) => {
  res.json({ templates: SUPPORT_TEMPLATES });
});

// Admin upload delivery document
router.post('/orders/:id/delivery-docs', orderDocUpload.single('file'), async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!req.file) return res.status(400).json({ error: 'NO_FILE' });
    const ord = await db.query('SELECT * FROM orders WHERE id=$1', [orderId]);
    if (!ord.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const order = ord.rows[0];
    let docs = [];
    try { docs = JSON.parse(order.documents || '[]'); } catch (_) {}
    docs.push({
      type: req.body.doc_type || 'delivery',
      filename: req.file.filename,
      originalname: req.file.originalname,
      path: req.file.path,
      uploaded_at: new Date().toISOString(),
      uploaded_by: 'admin'
    });
    await db.query('UPDATE orders SET documents=$1 WHERE id=$2', [JSON.stringify(docs), orderId]);
    res.json({ ok: true, filename: req.file.filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/sms/secret — get SMS webhook secret (admin only)
router.get('/sms/secret', async (req, res) => {
  try {
    const secret = process.env.SMS_WEBHOOK_SECRET || '';
    res.json({ ok: true, secret });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/orders/:id/support-message', async (req, res) => {
  try {
    const { message, template_key } = req.body || {};
    const msg = String(message || '').trim();
    if (!msg || msg.length > 500) {
      return res.status(400).json({ error: 'INVALID_MESSAGE' });
    }
    const o = await db.query('SELECT id FROM orders WHERE id = $1', [req.params.id]);
    if (!o.rows.length) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });

    const r = await db.query(
      `INSERT INTO order_support_messages (order_id, admin_id, template_key, message)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, req.user.id, template_key || null, msg]
    );
    await logActivity(req.user.id, 'order.support_message', {
      order_id: req.params.id, message: msg.slice(0, 100),
    });
    res.status(201).json({ message: r.rows[0] });
  } catch (e) {
    safeLog('[admin] support message error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

router.get('/orders/:id/support-messages', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT m.*, u.name AS admin_name FROM order_support_messages m
       LEFT JOIN users u ON u.id = m.admin_id
       WHERE m.order_id = $1 ORDER BY m.created_at DESC LIMIT 20`,
      [req.params.id]
    );
    res.json({ messages: rows.rows });
  } catch (e) {
    safeLog('[admin] support messages list error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

// ============================================================
// SERVICES
// ============================================================

router.get('/services', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT s.*, sc.name AS category_name, sc.name_bn AS category_name_bn, sc.icon AS category_icon
       FROM services s LEFT JOIN service_categories sc ON sc.id = s.category_id
       ORDER BY s.serial ASC, s.created_at ASC`);
    res.json({ services: rows.rows });
  } catch (e) {
    safeLog('[admin] services list error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

router.post('/services', async (req, res) => {
  try {
    const { name, name_bn, type, price, documents_required, fields_required, schedule, rules_text, engine_id, category_id } = req.body || {};
    if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'INVALID_NAME' });
    if (!['manual', 'automated'].includes(type)) return res.status(400).json({ error: 'INVALID_TYPE' });
    const catId = await resolveCategoryId(category_id);
    if (catId === false) return res.status(400).json({ error: 'INVALID_CATEGORY' });
    const maxSerial = await db.query('SELECT COALESCE(MAX(serial), -1) + 1 AS s FROM services');
    const r = await db.query(
      `INSERT INTO services (name, name_bn, category_id, type, price, serial, documents_required,
                             fields_required, schedule, rules_text, engine_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [String(name).trim(), name_bn || null, catId, type, Number(price) || 0,
       Number(maxSerial.rows[0].s),
       JSON.stringify(documents_required || []),
       JSON.stringify(fields_required || []),
       JSON.stringify(schedule || {}),
       rules_text || null, engine_id || null]
    );
    await logActivity(req.user.id, 'service.create', { service_id: r.rows[0].id, name });
    res.status(201).json({ service: r.rows[0] });
  } catch (e) {
    safeLog('[admin] service create error:', e.message);
    res.status(500).json({ error: 'CREATE_FAILED' });
  }
});

// PUT /api/admin/services/reorder { order: [id1, id2, ...] }
// NOTE: must be registered BEFORE '/services/:id', otherwise Express
// matches 'reorder' as :id and this handler becomes dead code.
router.put('/services/reorder', async (req, res) => {
  try {
    const { order } = req.body || {};
    if (!Array.isArray(order)) return res.status(400).json({ error: 'INVALID_ORDER' });
    await db.withTransaction(async (client) => {
      for (let idx = 0; idx < order.length; idx++) {
        await client.query('UPDATE services SET serial = $1 WHERE id = $2', [idx, order[idx]]);
      }
    });
    await logActivity(req.user.id, 'service.reorder', { count: order.length });
    res.json({ ok: true });
  } catch (e) {
    safeLog('[admin] reorder error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

router.put('/services/:id', async (req, res) => {
  try {
    const { name, name_bn, type, price, status, documents_required, fields_required, schedule, rules_text, engine_id, category_id } = req.body || {};
    const sets = []; const params = []; let i = 1;
    const put = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };
    if (name !== undefined) {
      if (String(name).trim().length < 2) return res.status(400).json({ error: 'INVALID_NAME' });
      put('name', String(name).trim());
    }
    if (name_bn !== undefined) put('name_bn', name_bn || null);
    if (type !== undefined && ['manual', 'automated'].includes(type)) put('type', type);
    if (price !== undefined) put('price', Number(price) || 0);
    if (status !== undefined && ['active', 'disabled'].includes(status)) put('status', status);
    if (documents_required !== undefined) put('documents_required', JSON.stringify(documents_required));
    if (fields_required !== undefined) put('fields_required', JSON.stringify(fields_required));
    if (schedule !== undefined) put('schedule', JSON.stringify(schedule));
    if (rules_text !== undefined) put('rules_text', rules_text || null);
    if (engine_id !== undefined) put('engine_id', engine_id || null);
    if (category_id !== undefined) {
      const catId = await resolveCategoryId(category_id);
      if (catId === false) return res.status(400).json({ error: 'INVALID_CATEGORY' });
      put('category_id', catId);
    }
    if (!sets.length) return res.status(400).json({ error: 'NOTHING_TO_UPDATE' });
    params.push(req.params.id);
    const r = await db.query(`UPDATE services SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    await logActivity(req.user.id, 'service.update', { service_id: req.params.id });
    res.json({ service: r.rows[0] });
  } catch (e) {
    safeLog('[admin] service update error:', e.message);
    res.status(500).json({ error: 'UPDATE_FAILED' });
  }
});

router.delete('/services/:id', async (req, res) => {
  try {
    if (req.query.confirm !== 'yes') return res.status(400).json({ error: 'CONFIRM_REQUIRED' });
    const r = await db.query('DELETE FROM services WHERE id = $1 RETURNING id, name', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    await logActivity(req.user.id, 'service.delete', { service_id: req.params.id, name: r.rows[0].name });
    res.json({ ok: true });
  } catch (e) {
    safeLog('[admin] service delete error:', e.message);
    res.status(500).json({ error: 'DELETE_FAILED' });
  }
});

// ============================================================
// SERVICE CATEGORIES
// ============================================================

// Returns category id if it exists, null for empty, false for invalid
async function resolveCategoryId(val) {
  if (val === undefined || val === null || String(val).trim() === '') return null;
  const r = await db.query('SELECT id FROM service_categories WHERE id = $1', [String(val).trim()]);
  return r.rows.length ? r.rows[0].id : false;
}

router.get('/service-categories', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT sc.*, (SELECT COUNT(*) FROM services s WHERE s.category_id = sc.id) AS service_count
       FROM service_categories sc ORDER BY serial ASC, created_at ASC`);
    res.json({ categories: rows.rows });
  } catch (e) {
    safeLog('[admin] service-categories list error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

router.post('/service-categories', async (req, res) => {
  try {
    const { name, name_bn, icon } = req.body || {};
    if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'INVALID_NAME' });
    const maxSerial = await db.query('SELECT COALESCE(MAX(serial), -1) + 1 AS s FROM service_categories');
    const r = await db.query(
      `INSERT INTO service_categories (name, name_bn, icon, serial)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [String(name).trim(), name_bn || null, String(icon || '📁').slice(0, 20),
       Number(maxSerial.rows[0].s)]
    );
    await logActivity(req.user.id, 'service_category.create', { category_id: r.rows[0].id, name });
    res.status(201).json({ category: r.rows[0] });
  } catch (e) {
    safeLog('[admin] service-category create error:', e.message);
    res.status(500).json({ error: 'CREATE_FAILED' });
  }
});

// NOTE: reorder BEFORE :id so "reorder" isn't captured as an id
router.put('/service-categories/reorder', async (req, res) => {
  try {
    const { order } = req.body || {};
    if (!Array.isArray(order)) return res.status(400).json({ error: 'INVALID_ORDER' });
    await db.withTransaction(async (client) => {
      for (let idx = 0; idx < order.length; idx++) {
        await client.query('UPDATE service_categories SET serial = $1 WHERE id = $2', [idx, order[idx]]);
      }
    });
    await logActivity(req.user.id, 'service_category.reorder', { count: order.length });
    res.json({ ok: true });
  } catch (e) {
    safeLog('[admin] category reorder error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

router.put('/service-categories/:id', async (req, res) => {
  try {
    const { name, name_bn, icon, status } = req.body || {};
    const sets = []; const params = []; let i = 1;
    const put = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };
    if (name !== undefined) {
      if (String(name).trim().length < 2) return res.status(400).json({ error: 'INVALID_NAME' });
      put('name', String(name).trim());
    }
    if (name_bn !== undefined) put('name_bn', name_bn || null);
    if (icon !== undefined) put('icon', String(icon || '📁').slice(0, 20));
    if (status !== undefined && ['active', 'disabled'].includes(status)) put('status', status);
    if (!sets.length) return res.status(400).json({ error: 'NOTHING_TO_UPDATE' });
    params.push(req.params.id);
    const r = await db.query(`UPDATE service_categories SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    await logActivity(req.user.id, 'service_category.update', { category_id: req.params.id });
    res.json({ category: r.rows[0] });
  } catch (e) {
    safeLog('[admin] service-category update error:', e.message);
    res.status(500).json({ error: 'UPDATE_FAILED' });
  }
});

router.delete('/service-categories/:id', async (req, res) => {
  try {
    if (req.query.confirm !== 'yes') return res.status(400).json({ error: 'CONFIRM_REQUIRED' });
    const r = await db.query('DELETE FROM service_categories WHERE id = $1 RETURNING id, name', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    await logActivity(req.user.id, 'service_category.delete', { category_id: req.params.id, name: r.rows[0].name });
    res.json({ ok: true });
  } catch (e) {
    safeLog('[admin] service-category delete error:', e.message);
    res.status(500).json({ error: 'DELETE_FAILED' });
  }
});

// ============================================================
// TRANSACTIONS (recharge requests: approve / reject)
// ============================================================

router.get('/transactions', async (req, res) => {
  try {
    const { page, limit, offset } = pageParams(req);
    const conds = [];
    const params = [];
    let i = 1;
    const VALID_TX_STATUS = ['pending','approved','rejected'];
    // Must match the transactions.type CHECK in database/schema.sql
    const VALID_TX_TYPE = ['recharge','cashback','promo','refund','debit','bonus'];
    if (req.query.status && VALID_TX_STATUS.includes(req.query.status)) { conds.push(`t.status = $${i++}`); params.push(req.query.status); }
    if (req.query.type && VALID_TX_TYPE.includes(req.query.type)) { conds.push(`t.type = $${i++}`); params.push(req.query.type); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = await db.query(`SELECT COUNT(*) FROM transactions t ${where}`, params);
    const rows = await db.query(
      `SELECT t.*, u.name AS user_name, u.phone AS user_phone
       FROM transactions t JOIN users u ON u.id = t.user_id
       ${where} ORDER BY t.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]);
    res.json({ transactions: rows.rows, total: parseInt(total.rows[0].count, 10), page, limit });
  } catch (e) {
    safeLog('[admin] transactions error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// PUT /api/admin/transactions/:id/approve — atomic wallet credit
router.put('/transactions/:id/approve', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
    const tx = r.rows[0];
    if (!tx) return res.status(404).json({ error: 'NOT_FOUND' });
    if (tx.status !== 'pending') return res.status(400).json({ error: 'ALREADY_PROCESSED' });

    await db.withTransaction(async (client) => {
      // Idempotent atomic credit; raises DUPLICATE_TRANSACTION if already applied
      await client.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
        tx.user_id, Number(tx.amount), tx.type, tx.trxid || ('tx-' + tx.id),
      ]);
      await client.query(
        `UPDATE transactions SET status = 'approved', admin_id = $1 WHERE id = $2`,
        [req.user.id, tx.id]
      );
    });
    await logActivity(req.user.id, 'transaction.approve', { tx_id: tx.id, amount: tx.amount });

    // WhatsApp: recharge approved -> customer success message
    // (async, non-blocking, never breaks the response)
    if (tx.type === 'recharge') {
      wa.notifyRechargeApproved(db, tx).catch(() => {});
    }

    res.json({ ok: true });
  } catch (e) {
    safeLog('[admin] approve error:', e.message);
    const msg = /DUPLICATE_TRANSACTION|INSUFFICIENT_BALANCE/.test(e.message) ? e.message : 'APPROVE_FAILED';
    res.status(400).json({ error: msg });
  }
});

router.put('/transactions/:id/reject', async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE transactions SET status = 'rejected', admin_id = $1
       WHERE id = $2 AND status = 'pending' RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'NOT_PENDING' });
    await logActivity(req.user.id, 'transaction.reject', { tx_id: req.params.id });
    // WhatsApp: recharge rejected -> customer failure message
    wa.notifyRechargeRejected(db, r.rows[0]).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    safeLog('[admin] reject error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// ============================================================
// COUPONS / BANNERS / NOTICES
// ============================================================

router.get('/coupons', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM coupons ORDER BY created_at DESC LIMIT 100');
    res.json({ coupons: rows.rows });
  } catch (e) { safeLog('[admin] coupons error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

router.post('/coupons', async (req, res) => {
  try {
    const { code, type, percent, amount, service_id, expires_at } = req.body || {};
    if (!code || !['cashback', 'promo'].includes(type)) {
      return res.status(400).json({ error: 'INVALID_INPUT' });
    }
    const r = await db.query(
      `INSERT INTO coupons (code, type, percent, amount, service_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [String(code).trim().toUpperCase(), type, Number(percent) || 0, Number(amount) || 0,
       service_id || null, expires_at || null]
    );
    await logActivity(req.user.id, 'coupon.create', { code });
    res.status(201).json({ coupon: r.rows[0] });
  } catch (e) {
    safeLog('[admin] coupon create error:', e.message);
    res.status(500).json({ error: e.code === '23505' ? 'CODE_TAKEN' : 'CREATE_FAILED' });
  }
});

router.put('/coupons/:id', async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['active', 'disabled', 'expired'].includes(status)) {
      return res.status(400).json({ error: 'INVALID_STATUS' });
    }
    await db.query('UPDATE coupons SET status = $1 WHERE id = $2', [status, req.params.id]);
    await logActivity(req.user.id, 'coupon.update', { coupon_id: req.params.id, status });
    res.json({ ok: true });
  } catch (e) { safeLog('[admin] coupon update error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

router.get('/banners', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM banners ORDER BY created_at DESC');
    res.json({ banners: rows.rows });
  } catch (e) { safeLog('[admin] banners error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

router.post('/banners', async (req, res) => {
  try {
    const { type, title, design_id, content, active } = req.body || {};
    if (!['banner', 'ad', 'popup'].includes(type) || !title) {
      return res.status(400).json({ error: 'INVALID_INPUT' });
    }
    const r = await db.query(
      `INSERT INTO banners (type, title, design_id, content, active)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [type, String(title).trim(), Math.min(30, Math.max(1, Number(design_id) || 1)),
       JSON.stringify(content || {}), active !== false]
    );
    await logActivity(req.user.id, 'banner.create', { banner_id: r.rows[0].id });
    res.status(201).json({ banner: r.rows[0] });
  } catch (e) { safeLog('[admin] banner create error:', e.message); res.status(500).json({ error: 'CREATE_FAILED' }); }
});

router.put('/banners/:id', async (req, res) => {
  try {
    const { title, design_id, content, active } = req.body || {};
    const sets = []; const params = []; let i = 1;
    if (title !== undefined) { sets.push(`title = $${i++}`); params.push(String(title).trim()); }
    if (design_id !== undefined) { sets.push(`design_id = $${i++}`); params.push(Math.min(30, Math.max(1, Number(design_id) || 1))); }
    if (content !== undefined) { sets.push(`content = $${i++}`); params.push(JSON.stringify(content)); }
    if (active !== undefined) { sets.push(`active = $${i++}`); params.push(!!active); }
    if (!sets.length) return res.status(400).json({ error: 'NOTHING_TO_UPDATE' });
    params.push(req.params.id);
    const r = await db.query(`UPDATE banners SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ banner: r.rows[0] });
  } catch (e) { safeLog('[admin] banner update error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

router.delete('/banners/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM banners WHERE id = $1', [req.params.id]);
    await logActivity(req.user.id, 'banner.delete', { banner_id: req.params.id });
    res.json({ ok: true });
  } catch (e) { safeLog('[admin] banner delete error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

router.get('/notices', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT n.*, u.name AS user_name FROM notices n
       LEFT JOIN users u ON u.id = n.user_id
       ORDER BY n.created_at DESC LIMIT 100`);
    res.json({ notices: rows.rows });
  } catch (e) { safeLog('[admin] notices error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

router.post('/notices', async (req, res) => {
  try {
    const { user_id, title, message } = req.body || {};
    if (!title || !message) return res.status(400).json({ error: 'INVALID_INPUT' });
    const r = await db.query(
      'INSERT INTO notices (user_id, title, message) VALUES ($1,$2,$3) RETURNING *',
      [user_id || null, String(title).trim(), String(message).trim()]
    );
    await logActivity(req.user.id, 'notice.create', { notice_id: r.rows[0].id, user_id: user_id || 'all' });
    res.status(201).json({ notice: r.rows[0] });
  } catch (e) { safeLog('[admin] notice create error:', e.message); res.status(500).json({ error: 'CREATE_FAILED' }); }
});

router.delete('/notices/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM notices WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { safeLog('[admin] notice delete error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// ============================================================
// ACTIVITY LOG + STATS + SETTINGS
// ============================================================

router.get('/activity-log', async (req, res) => {
  try {
    const { page, limit, offset } = pageParams(req);
    const total = await db.query('SELECT COUNT(*) FROM activity_log');
    const rows = await db.query(
      `SELECT a.*, u.name AS admin_name FROM activity_log a
       LEFT JOIN users u ON u.id = a.admin_id
       ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    res.json({ log: rows.rows, total: parseInt(total.rows[0].count, 10), page, limit });
  } catch (e) { safeLog('[admin] activity error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

router.get('/stats', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role = 'user') AS users,
        (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admins,
        (SELECT COUNT(*) FROM orders) AS orders_total,
        (SELECT COUNT(*) FROM orders WHERE status = 'new') AS orders_new,
        (SELECT COUNT(*) FROM orders WHERE status IN ('pending','processing')) AS orders_active,
        (SELECT COUNT(*) FROM orders WHERE status = 'completed') AS orders_completed,
        (SELECT COUNT(*) FROM transactions WHERE status = 'pending' AND type = 'recharge') AS pending_recharge,
        (SELECT COALESCE(SUM(amount),0) FROM transactions
          WHERE type = 'recharge' AND status = 'approved'
            AND created_at >= CURRENT_DATE) AS revenue_today,
        (SELECT COUNT(*) FROM services WHERE status = 'active') AS services_active
    `);
    res.json(r.rows[0]);
  } catch (e) { safeLog('[admin] stats error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// Unmatched SMS count — separate query so a missing 005 migration
// can never break the main stats endpoint.
router.get('/stats/sms', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT COUNT(*) FROM incoming_sms
       WHERE matched_recharge_id IS NULL AND parse_status = 'parsed'`
    );
    res.json({ unmatched_sms: parseInt(r.rows[0].count, 10) });
  } catch (e) {
    res.json({ unmatched_sms: 0 }); // table may not exist yet
  }
});

router.get('/settings', async (req, res) => {
  try {
    const r = await db.query('SELECT key, value FROM settings');
    const out = {};
    for (const row of r.rows) out[row.key] = row.value;
    // Security: never return the WhatsApp access token to the client.
    // Clients see only whether a token is stored.
    if (out.whatsapp && typeof out.whatsapp === 'object') {
      let waVal = out.whatsapp;
      if (typeof waVal === 'string') {
        try { waVal = JSON.parse(waVal); } catch (_) { waVal = {}; }
      }
      if (waVal && typeof waVal === 'object') {
        const masked = Object.assign({}, waVal);
        masked.access_token_set = !!masked.access_token || !!process.env.WHATSAPP_ACCESS_TOKEN;
        masked.access_token_env = !!process.env.WHATSAPP_ACCESS_TOKEN && !masked.access_token;
        delete masked.access_token;
        out.whatsapp = masked;
      }
    }
    res.json(out);
  } catch (e) { safeLog('[admin] settings error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// Merge an incoming settings.whatsapp object with the stored one.
// - The access_token is only replaced when a non-empty, non-masked value
//   is supplied AND the admin's current password (body.admin_password)
//   verifies against their password hash. Otherwise the stored token is
//   preserved (it can never be blanked or read via this endpoint).
// - The access_token_set flag is never persisted.
async function mergeWhatsappSetting(req, incoming) {
  const cur = await db.query("SELECT value FROM settings WHERE key = 'whatsapp'");
  let existing = {};
  if (cur.rows.length) {
    const v = cur.rows[0].value;
    try {
      existing = (typeof v === 'string') ? JSON.parse(v) : (v || {});
    } catch (_) { existing = {}; }
  }
  const out = Object.assign({}, incoming);
  delete out.access_token_set; // mask flag is client-only, never stored
  const incomingToken = typeof out.access_token === 'string' ? out.access_token.trim() : '';
  const isNewToken = incomingToken !== '' && !incomingToken.startsWith('••••');
  if (isNewToken) {
    const pw = req.body && req.body.admin_password;
    if (!pw) {
      const err = new Error('WRONG_PASSWORD');
      err.status = 403;
      throw err;
    }
    const ur = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const hash = ur.rows[0] && ur.rows[0].password_hash;
    const ok = hash ? await verifyPassword(String(pw), hash) : false;
    if (!ok) {
      const err = new Error('WRONG_PASSWORD');
      err.status = 403;
      throw err;
    }
    out.access_token = incomingToken;
  } else if (existing.access_token) {
    out.access_token = existing.access_token; // preserve stored token
  } else {
    delete out.access_token;
  }
  return out;
}

router.put('/settings', async (req, res) => {
  try {
    const allowed = ['registration_enabled', 'maintenance_mode', 'file_upload',
                     'login_security', 'cashback', 'welcome_bonus', 'voice_greeting',
                     'whatsapp', 'bdris_apply.pdf_price', 'recharge_numbers'];
    const updated = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        let val = req.body[key];
        if (key === 'whatsapp' && val && typeof val === 'object') {
          try {
            val = await mergeWhatsappSetting(req, val);
          } catch (e) {
            if (e.status === 403) return res.status(403).json({ error: 'WRONG_PASSWORD' });
            throw e;
          }
        }
        await db.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [key, JSON.stringify(val)]
        );
        updated.push(key);
      }
    }
    await logActivity(req.user.id, 'settings.update', { keys: updated });
    res.json({ ok: true, updated });
  } catch (e) { safeLog('[admin] settings update error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// Test WhatsApp Cloud API credentials (uses stored token, never returns it).
// No password confirmation needed: nothing sensitive is exposed.
router.post('/settings/whatsapp/test', async (req, res) => {
  try {
    const r = await wa.testConnection(db);
    res.json(r);
  } catch (e) {
    safeLog('[admin] whatsapp test error:', e.message);
    res.status(500).json({ ok: false, error: 'FAILED' });
  }
});

// ============================================================
// PDF REPORTS (Phase 3) — pdfkit, Coffee theme, Bengali font
// ============================================================
const PDFDocument = require('pdfkit');
const path = require('path');

function reportDoc(title) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const fontReg = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansBengali-Regular.ttf');
  const fontBold = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansBengali-Bold.ttf');
  try {
    doc.registerFont('bn', fontReg);
    doc.registerFont('bn-bold', fontBold);
  } catch (e) { /* fallback to Helvetica */ }
  // Header
  doc.fillColor('#2b1d14').fontSize(20);
  try { doc.font('bn-bold'); } catch (e) {}
  doc.text('☕ All In One (Abc Authentic)', { align: 'center' });
  doc.fillColor('#8a7a5f').fontSize(10);
  try { doc.font('bn'); } catch (e) {}
  doc.text('বিশ্বাস ও সেবার ঠিকানা', { align: 'center' });
  doc.moveDown(0.5);
  doc.fillColor('#d4af37').fontSize(14);
  try { doc.font('bn-bold'); } catch (e) {}
  doc.text(title, { align: 'center' });
  doc.fillColor('#333').fontSize(9);
  try { doc.font('bn'); } catch (e) {}
  doc.text('তারিখ: ' + new Date().toLocaleString('bn-BD'), { align: 'center' });
  doc.moveDown(1);
  return doc;
}

function reportTable(doc, headers, rows) {
  const startX = 40, colW = (doc.page.width - 80) / headers.length;
  let y = doc.y;
  doc.fillColor('#fff').rect(startX, y - 4, doc.page.width - 80, 20).fill('#2b1d14');
  doc.fillColor('#d4af37').fontSize(9);
  try { doc.font('bn-bold'); } catch (e) {}
  headers.forEach((h, i) => doc.text(h, startX + i * colW + 4, y, { width: colW - 8 }));
  y += 22;
  doc.fillColor('#222').fontSize(8);
  try { doc.font('bn'); } catch (e) {}
  for (const row of rows) {
    if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
    row.forEach((c, i) => doc.text(String(c), startX + i * colW + 4, y, { width: colW - 8 }));
    y += 16;
    doc.strokeColor('#e8dcc0').lineWidth(0.5).moveTo(startX, y - 4).lineTo(doc.page.width - 40, y - 4).stroke();
  }
  doc.moveDown(2);
  doc.fillColor('#8a7a5f').fontSize(8);
  doc.text('মোট: ' + rows.length.toLocaleString('bn-BD') + ' টি রেকর্ড', { align: 'right' });
}

// GET /api/admin/reports/orders?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/reports/orders', async (req, res) => {
  try {
    const { from, to } = req.query;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const conds = []; const params = []; let i = 1;
    if (from && DATE_RE.test(from)) { conds.push(`o.created_at >= $${i++}`); params.push(from); }
    if (to && DATE_RE.test(to)) { conds.push(`o.created_at <= $${i++}::date + INTERVAL '1 day'`); params.push(to); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = await db.query(
      `SELECT o.id, o.status, o.price, o.created_at, u.name AS user_name, u.phone AS user_phone,
              COALESCE(s.name_bn, s.name) AS service
       FROM orders o JOIN users u ON u.id = o.user_id
       LEFT JOIN services s ON s.id = o.service_id
       ${where} ORDER BY o.created_at DESC LIMIT 500`, params);

    const doc = reportDoc('অর্ডার রিপোর্ট');
    reportTable(doc,
      ['তারিখ', 'ইউজার', 'সেবা', 'দাম', 'স্ট্যাটাস'],
      rows.rows.map(r => [
        new Date(r.created_at).toLocaleDateString('bn-BD'),
        (r.user_name || '') + ' (' + (r.user_phone || '') + ')',
        r.service || '-', '৳' + Number(r.price).toLocaleString('bn-BD'), r.status,
      ]));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="orders-report.pdf"');
    doc.pipe(res); doc.end();
    await logActivity(req.user.id, 'report.orders', { from: from || null, to: to || null, count: rows.rows.length });
  } catch (e) {
    safeLog('[admin] report orders error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/admin/reports/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/reports/transactions', async (req, res) => {
  try {
    const { from, to } = req.query;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const conds = []; const params = []; let i = 1;
    if (from && DATE_RE.test(from)) { conds.push(`t.created_at >= $${i++}`); params.push(from); }
    if (to && DATE_RE.test(to)) { conds.push(`t.created_at <= $${i++}::date + INTERVAL '1 day'`); params.push(to); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = await db.query(
      `SELECT t.type, t.amount, t.method, t.status, t.created_at, u.name AS user_name, u.phone AS user_phone
       FROM transactions t JOIN users u ON u.id = t.user_id
       ${where} ORDER BY t.created_at DESC LIMIT 500`, params);

    const doc = reportDoc('লেনদেন রিপোর্ট');
    reportTable(doc,
      ['তারিখ', 'ইউজার', 'ধরন', 'টাকা', 'মাধ্যম', 'স্ট্যাটাস'],
      rows.rows.map(r => [
        new Date(r.created_at).toLocaleDateString('bn-BD'),
        (r.user_name || '') + ' (' + (r.user_phone || '') + ')',
        r.type, '৳' + Number(r.amount).toLocaleString('bn-BD'), r.method || '-', r.status,
      ]));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions-report.pdf"');
    doc.pipe(res); doc.end();
    await logActivity(req.user.id, 'report.transactions', { from: from || null, to: to || null, count: rows.rows.length });
  } catch (e) {
    safeLog('[admin] report transactions error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

module.exports = router;
