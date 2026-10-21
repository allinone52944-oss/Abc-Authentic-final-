// ============================================================
// All In One (Abc Authentic) - Admin routes (Phase 2)
// Mounted at /api/admin with requireAuth + requireAdmin.
// Self-protection: admin CANNOT delete self, CANNOT change own
// role. All sensitive actions logged to activity_log.
// ============================================================
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const db = require('../db');
const { requireAuth, requireAdmin, hashPassword, verifyPassword } = require('../auth');
const { safeLog, orderDocUpload, safeJsonArray } = require('../security');
const wa = require('../utils/whatsapp');
const push = require('../utils/push');

// Delivery document uploads: settings-driven via orderDocUpload(db, 'delivery') (H-12).
// Filenames stay random (C-2: never embed req.params.id).

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

// GET /api/admin/users/:id (admin fetches single user)
router.get('/users/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const r = await db.query(
      `SELECT id, name, phone, whatsapp, email, religion, gender, role,
              balance, status, login_enabled, email_verified, failed_attempts,
              locked_until, created_at, updated_at
       FROM users WHERE id = $1`, [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ user: r.rows[0] });
  } catch (e) {
    safeLog('[admin] user get error:', e.message);
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
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    if (cleanEmail) {
      const er = await db.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [cleanEmail]);
      if (er.rows.length) return res.status(409).json({ error: 'EMAIL_TAKEN' });
    }

    const password_hash = await hashPassword(String(password));
    const ins = await db.query(
      `INSERT INTO users (name, phone, whatsapp, email, password_hash, religion, role, status, email_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',TRUE)
       RETURNING id, name, phone, whatsapp, email, religion, role, balance, status, created_at`,
      [String(name).trim(), String(phone).trim(), String(whatsapp).trim(),
       cleanEmail,
       password_hash, religion || 'other', role === 'admin' ? 'admin' : 'user']
    );
    await logActivity(req.user.id, 'user.create', { user_id: ins.rows[0].id, phone });
    res.status(201).json({ user: ins.rows[0] });
  } catch (e) {
    safeLog('[admin] user create error:', e.message);
    // Password strength failure from hashPassword
    if (e.message === 'WEAK_PASSWORD') {
      return res.status(400).json({ error: 'WEAK_PASSWORD' });
    }
    // Return specific error for unique violations
    if (e.code === '23505') {
      if (e.constraint && e.constraint.includes('phone')) return res.status(409).json({ error: 'PHONE_TAKEN' });
      if (e.constraint && e.constraint.includes('email')) return res.status(409).json({ error: 'EMAIL_TAKEN' });
      return res.status(409).json({ error: 'DUPLICATE' });
    }
    res.status(500).json({ error: 'CREATE_FAILED' });
  }
});

// PUT /api/admin/users/:id
router.put('/users/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { name, phone, email, religion, role, status, login_enabled, balance_adjust, admin_note, balance_note } = req.body || {};
    const noteToLog = admin_note || balance_note || '';

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
    // H-9 fix (2026-10-15): last-admin guard — অন্য admin-কে demote/disable/delete
    // করলে যদি কোনো সক্রিয় admin না থাকে, action block হবে।
    if (!isSelf && target.role === 'admin') {
      const removesAdmin = (role === 'user') ||
        (status === 'disabled' || status === 'blocked') || (login_enabled === false);
      if (removesAdmin) {
        const c = await db.query(
          `SELECT COUNT(*) AS c FROM users
           WHERE role = 'admin' AND status = 'active' AND login_enabled IS NOT FALSE AND id != $1`,
          [id]
        );
        if (!parseInt(c.rows[0].c, 10)) {
          return res.status(403).json({ error: 'LAST_ADMIN' });
        }
      }
    }

    const sets = [];
    const params = [];
    let i = 1;
    const changes = {};

    if (name !== undefined) { sets.push(`name = $${i++}`); params.push(String(name).trim()); changes.name = name; }
    // L-14 fix (2026-10-15): admin can change a user's phone (login ID),
    // with BD format + uniqueness checks.
    if (phone !== undefined) {
      const ph = String(phone).trim();
      if (!/^01[0-9]{9}$/.test(ph)) return res.status(400).json({ error: 'INVALID_PHONE' });
      const ex = await db.query('SELECT id FROM users WHERE phone = $1 AND id != $2', [ph, id]);
      if (ex.rows.length) return res.status(400).json({ error: 'PHONE_EXISTS' });
      sets.push(`phone = $${i++}`); params.push(ph); changes.phone = ph;
    }
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
        // L-15 fix (2026-10-15): custom_price must be null or >= 0
        let cp = null;
        if (ov.custom_price !== null && ov.custom_price !== undefined) {
          cp = Number(ov.custom_price);
          if (!Number.isFinite(cp) || cp < 0) {
            return res.status(400).json({ error: 'INVALID_CUSTOM_PRICE' });
          }
        }
        await db.query(
          `INSERT INTO user_services (user_id, service_id, custom_price, access_enabled)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, service_id)
           DO UPDATE SET custom_price = EXCLUDED.custom_price,
                         access_enabled = EXCLUDED.access_enabled`,
          [id, serviceId, cp, ov.access_enabled !== false]
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

    // M-7 fix (2026-10-15): role change → bump token_version + revoke all
    // refresh tokens, so the old role can't be used via refresh anymore
    // (access tokens only live 15 min).
    if (changes.role && changes.role !== target.role) {
      await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [id]);
      await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [id]);
    }

    await logActivity(req.user.id, 'user.update', { user_id: id, changes, note: noteToLog || undefined });
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

// POST /api/admin/users/:id/verify-email — admin manually marks email as verified
// (for customers registered by phone where email verification is impractical).
router.post('/users/:id/verify-email', async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE users SET email_verified = TRUE, updated_at = NOW()
       WHERE id = $1 RETURNING id, email_verified`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    await logActivity(req.user.id, 'user.verify_email', { user_id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    safeLog('[admin] verify-email error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/admin/users/:id/service-overrides — per-service pricing + access
router.get('/users/:id/service-overrides', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT service_id, custom_price, access_enabled FROM user_services WHERE user_id = $1',
      [req.params.id]
    );
    const overrides = {};
    r.rows.forEach(x => { overrides[x.service_id] = x; });
    res.json({ overrides });
  } catch (e) {
    safeLog('[admin] service-overrides error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// PUT /api/admin/users/:id/service-access { service_id, enabled }
router.put('/users/:id/service-access', async (req, res) => {
  try {
    const { service_id, enabled } = req.body || {};
    if (!service_id) return res.status(400).json({ error: 'MISSING_SERVICE' });
    await db.query(
      `INSERT INTO user_services (user_id, service_id, access_enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, service_id)
       DO UPDATE SET access_enabled = EXCLUDED.access_enabled`,
      [req.params.id, service_id, enabled !== false]
    );
    await logActivity(req.user.id, 'user.service_access', { user_id: req.params.id, service_id, enabled });
    res.json({ ok: true });
  } catch (e) {
    safeLog('[admin] service-access error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// PUT /api/admin/users/:id/service-pricing { service_id, custom_price }
router.put('/users/:id/service-pricing', async (req, res) => {
  try {
    const { service_id, custom_price } = req.body || {};
    if (!service_id) return res.status(400).json({ error: 'MISSING_SERVICE' });
    const cp = custom_price === null || custom_price === '' ? null : Number(custom_price);
    if (cp !== null && (isNaN(cp) || cp < 0)) return res.status(400).json({ error: 'INVALID_PRICE' });
    await db.query(
      `INSERT INTO user_services (user_id, service_id, custom_price)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, service_id)
       DO UPDATE SET custom_price = EXCLUDED.custom_price`,
      [req.params.id, service_id, cp]
    );
    await logActivity(req.user.id, 'user.service_pricing', { user_id: req.params.id, service_id, custom_price: cp });
    res.json({ ok: true });
  } catch (e) {
    safeLog('[admin] service-pricing error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// POST /api/admin/users/:id/reset-password — generates new random password
router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const crypto = require('crypto');
    const newPw = crypto.randomBytes(4).toString('hex');
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(newPw, 12);
    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, req.params.id]);
    await logActivity(req.user.id, 'user.reset_password', { user_id: req.params.id });
    res.json({ ok: true, new_password: newPw });
  } catch (e) {
    safeLog('[admin] reset-password error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/admin/users/:id/data — user stats summary
router.get('/users/:id/data', async (req, res) => {
  try {
    const id = req.params.id;
    const [u, o, t] = await Promise.all([
      db.query('SELECT balance FROM users WHERE id = $1', [id]),
      db.query('SELECT COUNT(*) AS c FROM orders WHERE user_id = $1', [id]),
      db.query('SELECT COUNT(*) AS c FROM transactions WHERE user_id = $1', [id]),
    ]);
    res.json({
      balance: u.rows[0] ? Number(u.rows[0].balance) : 0,
      orders: Number(o.rows[0].c), transactions: Number(t.rows[0].c),
    });
  } catch (e) {
    safeLog('[admin] user-data error:', e.message);
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
    const cur = await db.query('SELECT id, phone, name, role FROM users WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });

    // H-9 fix (2026-10-15): last-admin guard — শেষ সক্রিয় admin-কে delete করা যাবে না।
    if (cur.rows[0].role === 'admin') {
      const c = await db.query(
        `SELECT COUNT(*) AS c FROM users
         WHERE role = 'admin' AND status = 'active' AND login_enabled IS NOT FALSE AND id != $1`,
        [id]
      );
      if (!parseInt(c.rows[0].c, 10)) {
        return res.status(403).json({ error: 'LAST_ADMIN' });
      }
    }

    // Count what will be deleted (for the log)
    const counts = await db.query(
      `SELECT (SELECT COUNT(*) FROM orders WHERE user_id = $1) AS orders,
              (SELECT COUNT(*) FROM transactions WHERE user_id = $1) AS transactions,
              (SELECT COUNT(*) FROM coupons WHERE user_id = $1) AS coupons,
              (SELECT COUNT(*) FROM notices WHERE user_id = $1) AS notices,
              (SELECT COUNT(*) FROM chat_messages WHERE user_id = $1) AS chat`,
      [id]
    );

    // M-13 fix (2026-10-15): collect uploaded document files BEFORE the DB
    // cascade deletes the rows — then remove them from disk too.
    let docFiles = [];
    try {
      const dr = await db.query('SELECT documents FROM orders WHERE user_id = $1', [id]);
      for (const row of dr.rows) {
        const docs = safeJsonArray(row.documents);
        for (const d of docs) {
          if (d && (d.path || d.filename)) docFiles.push(d.path || d.filename);
        }
      }
    } catch (e) { safeLog('[admin] doc list skipped:', e.message); }

    // ON DELETE CASCADE handles: user_services, orders, transactions,
    // coupons(user_id), notices(user_id), chat_messages, refresh_tokens.
    // Explicitly clear anything else first.
    await db.query('DELETE FROM users WHERE id = $1', [id]);

    // Delete the collected files from disk (uploads dir only — safety).
    let filesDeleted = 0;
    try {
      const path = require('path');
      const UP = '/opt/all-in-one-abc-authentic/uploads/orders';
      for (const f of docFiles) {
        const abs = path.resolve(UP, path.basename(String(f)));
        if (abs.startsWith(UP + path.sep) && fs.existsSync(abs)) {
          fs.unlinkSync(abs);
          filesDeleted++;
        }
      }
    } catch (e) { safeLog('[admin] doc file cleanup skipped:', e.message); }

    await logActivity(req.user.id, 'user.delete', {
      user_id: id, phone: cur.rows[0].phone, name: cur.rows[0].name,
      deleted: counts.rows[0], files_deleted: filesDeleted,
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
      conds.push(`(u.name ILIKE $${i} OR u.phone ILIKE $${i} OR s.name ILIKE $${i} OR s.name_bn ILIKE $${i})`);
      params.push('%' + req.query.q.trim() + '%'); i++;
    }
    if (req.query.type) {
      if (req.query.type === 'manual') {
        conds.push(`(s.type = 'manual' OR (o.data::text LIKE '%_manual_form%'))`);
      } else if (req.query.type === 'auto') {
        conds.push(`(s.type != 'manual' AND NOT (o.data::text LIKE '%_manual_form%'))`);
      }
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = await db.query(
      `SELECT COUNT(*) FROM orders o JOIN users u ON u.id = o.user_id
       JOIN services s ON s.id = o.service_id ${where}`, params);
    const rows = await db.query(
      `SELECT o.*, u.name AS user_name, u.phone AS user_phone,
              s.name AS service_name, s.name_bn AS service_name_bn,
              s.type AS service_type, s.engine_id AS service_engine
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
// H-1 fix (2026-10-15): allowed status transitions — any→any no longer permitted.
// Terminal states: cancelled, refunded. failed → pending allows retry.
const ORDER_TRANSITIONS = {
  new: ['pending', 'processing', 'cancelled'],
  pending: ['processing', 'cancelled', 'failed'],
  processing: ['completed', 'failed', 'cancelled'],
  completed: ['delivered', 'refunded'],
  delivered: ['refunded'],
  failed: ['pending'],
  cancelled: [],
  refunded: [],
};
router.put('/orders/:id/status', async (req, res) => {
  try {
    const { status, admin_note } = req.body || {};
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'INVALID_STATUS' });
    }
    const cur = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const from = cur.rows[0].status;
    // Same status: idempotent no-op (no history spam)
    if (from !== status && !(ORDER_TRANSITIONS[from] || []).includes(status)) {
      return res.status(400).json({ error: 'INVALID_TRANSITION', from, allowed: ORDER_TRANSITIONS[from] || [] });
    }
    const r = await db.query(
      `UPDATE orders SET status = $1, admin_note = COALESCE($2, admin_note), updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [status, admin_note || null, req.params.id]
    );

    // Refund: credit the order price back to wallet (idempotent via wallet_apply)
    if (status === 'refunded' && from !== 'refunded') {
      try {
        await db.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
          r.rows[0].user_id, Number(r.rows[0].price), 'refund', 'refund-' + r.rows[0].id,
        ]);
      } catch (e) { safeLog('[admin] refund credit skipped:', e.message); }
    }

    // Status history (H-1)
    if (from !== status) {
      try {
        await db.query(
          `INSERT INTO order_status_history (order_id, from_status, to_status, admin_id, note)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.params.id, from, status, req.user.id, admin_note || null]
        );
      } catch (e) { safeLog('[admin] status history skipped:', e.message); }
    }

    await logActivity(req.user.id, 'order.status', {
      order_id: req.params.id, from, status, admin_note: admin_note || null,
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

// ---- BDRIS applications (auto service) ---------------------------
// Submitted birth-registration applications from ALL customers
// (recorded by POST /api/bdris-apply/applications). The owner asked
// that everything a customer does — auto or manual — reaches the
// admin, and that the admin can delete it.
router.get('/bdris-applications', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT a.id, a.ack_no, a.applicant_name, a.created_at,
              u.name AS user_name, u.phone AS user_phone
         FROM bdris_applications a
         JOIN users u ON u.id = a.user_id
        ORDER BY a.created_at DESC LIMIT 200`);
    res.json({ ok: true, applications: r.rows });
  } catch (e) { safeLog('[admin] bdris applications error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

router.delete('/bdris-applications/:id', async (req, res) => {
  try {
    const r = await db.query('DELETE FROM bdris_applications WHERE id = $1 RETURNING ack_no', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    await logActivity(req.user.id, 'bdris_application.delete', { ack_no: r.rows[0].ack_no });
    res.json({ ok: true });
  } catch (e) { safeLog('[admin] bdris application delete error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// DELETE /api/admin/orders/:id?refund=yes|no — permanently delete order (with optional refund)
router.delete('/orders/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const cur = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const order = cur.rows[0];

    const refundRequested = req.query.refund === 'yes';
    let refunded = false;

    // Refund: credit order price back to user wallet if requested and not already refunded
    if (refundRequested && Number(order.price) > 0 && order.status !== 'refunded') {
      try {
        await db.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
          order.user_id, Number(order.price), 'refund', 'refund-del-' + order.id,
        ]);
        refunded = true;
      } catch (e) {
        safeLog('[admin] order delete refund failed:', e.message);
      }
    }

    // Collect uploaded documents before deleting order row
    let docFiles = [];
    try {
      let docs = [];
      if (typeof order.documents === 'string') {
        docs = JSON.parse(order.documents || '[]');
      } else if (Array.isArray(order.documents)) {
        docs = order.documents;
      }
      for (const d of docs) {
        if (d && (d.filename || d.path)) docFiles.push(d.filename || d.path);
      }
    } catch (_) {
      safeLog('[admin] corrupt documents JSON during order delete');
    }

    // Delete order row (cascades order_status_history, chat_messages, support_messages)
    await db.query('DELETE FROM orders WHERE id = $1', [id]);

    // Clean up physical uploaded files from disk safely
    try {
      const path = require('path');
      const UP = '/opt/all-in-one-abc-authentic/uploads/orders';
      for (const f of docFiles) {
        const full = path.resolve(UP, path.basename(f));
        if (full.startsWith(UP) && fs.existsSync(full)) {
          fs.unlinkSync(full);
        }
      }
    } catch (e) {
      safeLog('[admin] order file delete skipped:', e.message);
    }

    await logActivity(req.user.id, 'order.delete', {
      order_id: id,
      user_id: order.user_id,
      price: order.price,
      status: order.status,
      refunded,
    });

    res.json({ ok: true, deleted_id: id, refunded });
  } catch (e) {
    safeLog('[admin] order delete error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/admin/orders/:id/history — status transition timeline (H-1)
router.get('/orders/:id/history', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT h.*, u.name AS admin_name FROM order_status_history h
       LEFT JOIN users u ON u.id = h.admin_id
       WHERE h.order_id = $1 ORDER BY h.created_at ASC`,
      [req.params.id]
    );
    res.json({ history: r.rows });
  } catch (e) {
    safeLog('[admin] order history error:', e.message);
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

// GET /api/admin/storage/:filename/download - Download uploaded file
router.get('/storage/:filename/download', async (req, res) => {
  try {
    const fn = path.basename(req.params.filename);
    const fp = path.join('/opt/all-in-one-abc-authentic/uploads/orders', fn);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'NOT_FOUND' });
    res.download(fp, fn);
  } catch (e) { safeLog('[admin] storage download error:', e.message); res.status(500).json({ error: 'FAILED' }); }
});

// DELETE /api/admin/storage - Delete ALL uploaded files
router.delete('/storage', async (req, res) => {
  try {
    const dir = '/opt/all-in-one-abc-authentic/uploads/orders';
    if (!fs.existsSync(dir)) return res.json({ ok: true, deleted: 0 });
    const files = fs.readdirSync(dir);
    let count = 0;
    files.forEach(f => {
      try { fs.unlinkSync(path.join(dir, f)); count++; } catch (e) {}
    });
    await logActivity(req.user.id, 'storage.delete_all', { count });
    res.json({ ok: true, deleted: count });
  } catch (e) { safeLog('[admin] storage delete-all error:', e.message); res.status(500).json({ error: 'FAILED' }); }
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
router.post('/orders/:id/delivery-docs', orderDocUpload(db, 'delivery'), async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!req.file) return res.status(400).json({ error: 'NO_FILE' });
    const ord = await db.query('SELECT * FROM orders WHERE id=$1', [orderId]);
    if (!ord.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const order = ord.rows[0];
    const docs = safeJsonArray(order.documents);
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

// GET /api/admin/orders/:id/documents/:filename — admin download (no owner check)
router.get('/orders/:id/documents/:filename', async (req, res) => {
  try {
    const orderId = req.params.id;
    const fn = require('path').basename(req.params.filename);
    const ord = await db.query('SELECT documents FROM orders WHERE id=$1', [orderId]);
    if (!ord.rows.length) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
    const docs = safeJsonArray(ord.rows[0].documents);
    const doc = docs.find(d => d && require('path').basename(d.filename) === fn);
    if (!doc) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });
    const fp = require('path').join('/opt/all-in-one-abc-authentic/uploads/orders', fn);
    const fs = require('fs');
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'FILE_MISSING' });
    res.download(fp, doc.originalname || fn);
  } catch (e) {
    safeLog('[admin] order document download error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/admin/sms/secret — get SMS webhook secret (admin only)
// L-1 fix (2026-10-15): masked by default (last 4 chars). Full reveal needs
// POST with the admin's current password. Rotation via SMS_WEBHOOK_SECRET env.
router.get('/sms/secret', async (req, res) => {
  try {
    const secret = process.env.SMS_WEBHOOK_SECRET || '';
    const masked = secret.length > 4 ? '••••' + secret.slice(-4) : (secret ? '••••' : '');
    res.json({ ok: true, secret: masked, configured: !!secret });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/sms/secret/reveal', async (req, res) => {
  try {
    const pw = req.body && req.body.admin_password;
    if (!pw) return res.status(403).json({ error: 'WRONG_PASSWORD' });
    const ur = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!ur.rows.length || !(await verifyPassword(String(pw), ur.rows[0].password_hash))) {
      return res.status(403).json({ error: 'WRONG_PASSWORD' });
    }
    await logActivity(req.user.id, 'sms.secret_reveal', {});
    res.json({ ok: true, secret: process.env.SMS_WEBHOOK_SECRET || '' });
  } catch (e) {
    safeLog('[admin] sms secret reveal error:', e.message);
    res.status(500).json({ error: 'FAILED' });
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
    try {
      const uq = await db.query('SELECT user_id FROM orders WHERE id = $1', [req.params.id]);
      if (uq.rows.length && uq.rows[0].user_id) {
        push.notifyUser(db, uq.rows[0].user_id, '💬 সাপোর্ট থেকে নতুন মেসেজ!', msg, '/orders.html').catch(() => {});
      }
    } catch (e) { /* fire-and-forget safe */ }
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
    const { name, name_bn, type, price, documents_required, fields_required, schedule, rules_text, engine_id, category_id, manual_instructions, manual_sample, manual_doc_count } = req.body || {};
    if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'INVALID_NAME' });
    if (!['manual', 'automated'].includes(type)) return res.status(400).json({ error: 'INVALID_TYPE' });
    const catId = await resolveCategoryId(category_id);
    if (catId === false) return res.status(400).json({ error: 'INVALID_CATEGORY' });
    const docCount = Math.min(6, Math.max(1, Number(manual_doc_count) || 1));
    const maxSerial = await db.query('SELECT COALESCE(MAX(serial), -1) + 1 AS s FROM services');
    const r = await db.query(
      `INSERT INTO services (name, name_bn, category_id, type, price, serial, documents_required,
                             fields_required, schedule, rules_text, engine_id,
                             manual_instructions, manual_sample, manual_doc_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [String(name).trim(), name_bn || null, catId, type, Number(price) || 0,
       Number(maxSerial.rows[0].s),
       JSON.stringify(documents_required || []),
       JSON.stringify(fields_required || []),
       JSON.stringify(schedule || {}),
       rules_text || null, engine_id || null,
       manual_instructions || null, manual_sample || null, docCount]
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
    const { name, name_bn, type, price, status, documents_required, fields_required, schedule, rules_text, engine_id, category_id, manual_instructions, manual_sample, manual_doc_count } = req.body || {};
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
    if (manual_instructions !== undefined) put('manual_instructions', manual_instructions || null);
    if (manual_sample !== undefined) put('manual_sample', manual_sample || null);
    if (manual_doc_count !== undefined) put('manual_doc_count', Math.min(6, Math.max(1, Number(manual_doc_count) || 1)));
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

// POST /api/admin/services/:id/duplicate — clone an existing service
router.post('/services/:id/duplicate', async (req, res) => {
  try {
    const sRes = await db.query('SELECT * FROM services WHERE id = $1', [req.params.id]);
    if (!sRes.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    const orig = sRes.rows[0];
    const maxSerial = await db.query('SELECT COALESCE(MAX(serial), -1) + 1 AS s FROM services');
    const newName = (orig.name || '') + ' (Copy)';
    const newNameBn = (orig.name_bn || orig.name) + ' (কপি)';
    const r = await db.query(
      `INSERT INTO services (name, name_bn, category_id, type, price, serial, documents_required,
                             fields_required, schedule, rules_text, engine_id,
                             manual_instructions, manual_sample, manual_doc_count, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'disabled') RETURNING *`,
      [newName, newNameBn, orig.category_id, orig.type, Number(orig.price) || 0,
       Number(maxSerial.rows[0].s),
       typeof orig.documents_required === 'string' ? orig.documents_required : JSON.stringify(orig.documents_required || []),
       typeof orig.fields_required === 'string' ? orig.fields_required : JSON.stringify(orig.fields_required || []),
       typeof orig.schedule === 'string' ? orig.schedule : JSON.stringify(orig.schedule || {}),
       orig.rules_text || null, orig.engine_id || null,
       orig.manual_instructions || null, orig.manual_sample || null,
       Math.min(6, Math.max(1, Number(orig.manual_doc_count) || 1))]
    );
    await logActivity(req.user.id, 'service.duplicate', { original_id: orig.id, service_id: r.rows[0].id });
    res.status(201).json({ service: r.rows[0] });
  } catch (e) {
    safeLog('[admin] service duplicate error:', e.message);
    res.status(500).json({ error: 'DUPLICATE_FAILED' });
  }
});

router.delete('/services/:id', async (req, res) => {
  try {
    if (req.query.confirm !== 'yes') return res.status(400).json({ error: 'CONFIRM_REQUIRED' });
    // M-12 fix (2026-10-15): block with a clear message when orders reference
    // the service (was: 500 DELETE_FAILED from the FK violation).
    const used = await db.query('SELECT COUNT(*) AS c FROM orders WHERE service_id = $1', [req.params.id]);
    if (parseInt(used.rows[0].c, 10) > 0) {
      return res.status(400).json({
        error: 'SERVICE_IN_USE',
        orders: parseInt(used.rows[0].c, 10),
        message: 'এই সার্ভিসে অর্ডার আছে — আগে সার্ভিসটি নিষ্ক্রিয় (inactive) করুন',
      });
    }
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

// GET /api/admin/recharge/pending — latest pending recharges with user names
// (used by the admin dashboard TTS notifier; 2026-10-15: was calling a
// non-existent endpoint, so the customer-name announcement silently failed)
router.get('/recharge/pending', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT t.id, t.amount, t.trxid, t.created_at, u.name AS user_name, u.phone AS user_phone
       FROM transactions t JOIN users u ON u.id = t.user_id
       WHERE t.status = 'pending' AND t.type = 'recharge'
       ORDER BY t.created_at DESC LIMIT 10`
    );
    res.json({ list: r.rows });
  } catch (e) {
    safeLog('[admin] recharge pending error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/admin/reports/summary — server-side aggregates for the Reports tab.
// Client-side summing of capped (100-row) pages silently undercounts revenue.
router.get('/reports/summary', async (req, res) => {
  try {
    const [rev, rch, byStatus, users] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(price),0) AS revenue FROM orders WHERE status IN ('completed','delivered')`),
      db.query(`SELECT COALESCE(SUM(amount),0) AS recharge FROM transactions WHERE type = 'recharge' AND status = 'approved'`),
      db.query(`SELECT status, COUNT(*) AS c FROM orders GROUP BY status`),
      db.query(`SELECT COUNT(*) AS c FROM users`),
    ]);
    res.json({
      revenue: Number(rev.rows[0].revenue),
      recharge: Number(rch.rows[0].recharge),
      byStatus: Object.fromEntries(byStatus.rows.map(r => [r.status, Number(r.c)])),
      users: Number(users.rows[0].c),
    });
  } catch (e) {
    safeLog('[admin] reports summary error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

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

    // Recharge fraud guard: an SMS with the same TrxID but a different
    // amount must never be approved — reject it instead.
    if (tx.type === 'recharge' && tx.trxid) {
      const sms = await db.query(
        `SELECT amount FROM incoming_sms
         WHERE trxid IS NOT NULL AND UPPER(trxid) = UPPER($1) AND amount IS NOT NULL
           AND matched_recharge_id IS DISTINCT FROM $2
         ORDER BY created_at DESC LIMIT 1`,
        [String(tx.trxid).trim(), tx.id]
      );
      if (sms.rows.length) {
        const smsAmt = Number(sms.rows[0].amount);
        if (Math.abs(smsAmt - Number(tx.amount)) >= 0.005) {
          return res.status(400).json({
            error: 'AMOUNT_MISMATCH',
            sms_amount: smsAmt,
            requested_amount: Number(tx.amount),
          });
        }
      }
    }

    await db.withTransaction(async (client) => {
      // C-4 fix (2026-10-15): existing pending row reuse করা হয় — ডবল ledger row নয়।
      // Idempotent atomic credit; raises DUPLICATE_TRANSACTION if already applied
      await client.query('SELECT * FROM wallet_apply($1, $2, $3, $4, $5)', [
        tx.user_id, Number(tx.amount), tx.type, tx.trxid || ('tx-' + tx.id), tx.id,
      ]);
      await client.query(
        `UPDATE transactions SET admin_id = $1 WHERE id = $2`,
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
    const { type, title, design_id, content, active, animation_type, animation_speed } = req.body || {};
    if (!['banner', 'ad', 'popup'].includes(type) || !title) {
      return res.status(400).json({ error: 'INVALID_INPUT' });
    }
    const animType = ['slide', 'fade', 'ticker', 'bounce', 'none'].includes(animation_type) ? animation_type : 'slide';
    const animSpeed = Math.min(120, Math.max(5, Number(animation_speed) || 30));
    const r = await db.query(
      `INSERT INTO banners (type, title, design_id, content, active, animation_type, animation_speed)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [type, String(title).trim(), Math.min(50, Math.max(1, Number(design_id) || 1)),
       JSON.stringify(content || {}), active !== false, animType, animSpeed]
    );
    await logActivity(req.user.id, 'banner.create', { banner_id: r.rows[0].id });
    res.status(201).json({ banner: r.rows[0] });
  } catch (e) { safeLog('[admin] banner create error:', e.message); res.status(500).json({ error: 'CREATE_FAILED' }); }
});

router.put('/banners/:id', async (req, res) => {
  try {
    const { type, title, design_id, content, active, animation_type, animation_speed } = req.body || {};
    const sets = []; const params = []; let i = 1;
    if (type !== undefined && ['banner', 'ad', 'popup'].includes(type)) {
      sets.push(`type = $${i++}`); params.push(type);
    }
    if (title !== undefined) { sets.push(`title = $${i++}`); params.push(String(title).trim()); }
    if (design_id !== undefined) { sets.push(`design_id = $${i++}`); params.push(Math.min(50, Math.max(1, Number(design_id) || 1))); }
    if (content !== undefined) { sets.push(`content = $${i++}`); params.push(JSON.stringify(content)); }
    if (active !== undefined) { sets.push(`active = $${i++}`); params.push(!!active); }
    if (animation_type !== undefined && ['slide', 'fade', 'ticker', 'bounce', 'none'].includes(animation_type)) {
      sets.push(`animation_type = $${i++}`); params.push(animation_type);
    }
    if (animation_speed !== undefined) {
      sets.push(`animation_speed = $${i++}`); params.push(Math.min(120, Math.max(5, Number(animation_speed) || 30)));
    }
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
        -- L-13 (2026-10-15): today's counts (Asia/Dhaka)
        (SELECT COUNT(*) FROM orders
          WHERE created_at >= (CURRENT_DATE AT TIME ZONE 'Asia/Dhaka')::timestamptz
            AND created_at < ((CURRENT_DATE + 1) AT TIME ZONE 'Asia/Dhaka')::timestamptz) AS orders_today,
        (SELECT COUNT(*) FROM users
          WHERE role = 'user'
            AND created_at >= (CURRENT_DATE AT TIME ZONE 'Asia/Dhaka')::timestamptz
            AND created_at < ((CURRENT_DATE + 1) AT TIME ZONE 'Asia/Dhaka')::timestamptz) AS users_today,
        (SELECT COUNT(*) FROM transactions WHERE status = 'pending' AND type = 'recharge') AS pending_recharge,
        (SELECT COALESCE(SUM(amount),0) FROM transactions
          WHERE type = 'recharge' AND status = 'approved'
            AND created_at >= CURRENT_DATE) AS revenue_today,
        (SELECT COUNT(*) FROM services WHERE status = 'active') AS services_active
    `);
    // Manual submissions count (defensive: table may not exist on old DBs)
    let manualNew = 0;
    try {
      const m = await db.query("SELECT COUNT(*) AS c FROM manual_submissions WHERE status = 'new'");
      manualNew = Number(m.rows[0].c) || 0;
    } catch (e) { /* ignore */ }
    const out = r.rows[0] || {};
    out.manual_new = manualNew;
    res.json(out);
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

// ---- Database backup (H-7 fix, 2026-10-15) ----------------------
// POST triggers pg_dump in background; GET shows last-backup status + files.
// For automatic daily backups add the cron line from backend/scripts/backup.js
// on the server.
const BACKUP_DIR = process.env.BACKUP_DIR || '/opt/all-in-one-abc-authentic/backups';
router.post('/backup', async (req, res) => {
  try {
    const { spawn } = require('child_process');
    const script = require('path').join(__dirname, '..', 'scripts', 'backup.js');
    const p = spawn(process.execPath, [script], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    p.unref();
    await logActivity(req.user.id, 'backup.trigger', {});
    res.json({ ok: true, started: true });
  } catch (e) {
    safeLog('[admin] backup trigger error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});
router.get('/backup', async (req, res) => {
  try {
    const r = await db.query("SELECT value FROM settings WHERE key = 'backup.last' LIMIT 1");
    const v = r.rows[0] && r.rows[0].value;
    const last = v ? (typeof v === 'string' ? JSON.parse(v) : v) : null;
    let files = [];
    try {
      const path = require('path');
      files = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.endsWith('.dump'))
        .map((f) => {
          const st = fs.statSync(path.join(BACKUP_DIR, f));
          return { name: f, bytes: st.size, at: st.mtime.toISOString() };
        })
        .sort((a, b) => (a.at < b.at ? 1 : -1));
    } catch (e) { /* dir may not exist yet */ }
    res.json({ last, files });
  } catch (e) {
    safeLog('[admin] backup status error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

router.put('/settings', async (req, res) => {  try {
    const allowed = ['registration_enabled', 'maintenance_mode', 'file_upload',
                     'login_security', 'cashback', 'welcome_bonus', 'voice_greeting',
                     'whatsapp', 'bdris_apply.pdf_price', 'recharge_numbers',
                     'ip_blocklist', 'session_timeout', 'manual_template'];
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

// GET /api/admin/monitor - System monitoring (user spec 2026-10-16)
router.get('/monitor', async (req, res) => {
  try {
    const [dbOk, ordC, usrC, txC] = await Promise.all([
      db.query('SELECT 1').then(() => true).catch(() => false),
      db.query("SELECT COUNT(*) AS c FROM orders WHERE created_at > NOW() - INTERVAL '24 hours'"),
      db.query("SELECT COUNT(*) AS c FROM users WHERE created_at > NOW() - INTERVAL '24 hours'"),
      db.query("SELECT COUNT(*) AS c FROM transactions WHERE created_at > NOW() - INTERVAL '24 hours'"),
    ]);
    const act = await db.query(
      'SELECT action, created_at FROM activity_log ORDER BY created_at DESC LIMIT 10'
    );
    res.json({
      ok: true,
      db: dbOk ? 'up' : 'down',
      last24h: {
        orders: Number(ordC.rows[0].c),
        users: Number(usrC.rows[0].c),
        transactions: Number(txC.rows[0].c),
      },
      recent_activity: act.rows,
      time: new Date().toISOString(),
    });
  } catch (e) {
    safeLog('[admin] monitor error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

module.exports = router;
