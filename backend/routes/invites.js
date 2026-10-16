// ============================================================
// All In One (Abc Authentic) - Invite links
// Admin generates registration links that work EVEN WHEN public
// registration is OFF. A valid invite code bypasses the
// registration_enabled check in POST /api/auth/register.
//
// 1) Admin  /api/admin/invites/*   (requireAuth + requireAdmin)
// 2) Public /api/invite/:code/validate  (rate limited, no info leak)
// Security: URL-safe random codes, parameterized queries,
// admin activity logged, validate endpoint never reveals details.
// ============================================================
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { safeLog } = require('../security');

// ---- shared validation --------------------------------------------------
// Returns the invite row if usable, or null. Never reveals why.
async function validateInvite(code) {
  if (!code || typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  if (!/^INV-[A-Z0-9]{32}$/.test(c)) return null;
  const r = await db.query('SELECT * FROM invite_links WHERE code = $1 LIMIT 1', [c]);
  if (!r.rows.length) return null;
  const inv = r.rows[0];
  if (!inv.is_active) return null;
  if (inv.expires_at && new Date(inv.expires_at) <= new Date()) return null;
  if (inv.max_uses != null && Number(inv.used_count) >= Number(inv.max_uses)) return null;
  return inv;
}

// Consume one use (row-locked, atomic).
async function consumeInvite(code) {
  const r = await db.query(
    `UPDATE invite_links SET used_count = used_count + 1
     WHERE code = $1
       AND is_active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (max_uses IS NULL OR used_count < max_uses)`,
    [code.trim().toUpperCase()]
  );
  return r.rowCount > 0;
}

// ---- admin router -------------------------------------------------------
const adminInvites = express.Router();
adminInvites.use(requireAuth, requireAdmin);

function appBaseUrl() {
  const base = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return base || 'https://abc-authentic.store';
}

function genCode() {
  // 128-bit entropy (was 32-bit) — invite links bypass the registration gate
  return 'INV-' + crypto.randomBytes(16).toString('hex').toUpperCase();
}

async function logActivity(adminId, action, details) {
  try {
    await db.query(
      'INSERT INTO activity_log (admin_id, action, details) VALUES ($1, $2, $3)',
      [adminId, action, JSON.stringify(details || {})]
    );
  } catch (e) { safeLog('[invites] log failed:', e.message); }
}

// POST /api/admin/invites  { max_uses, expires_at, note } → { code, link }
adminInvites.post('/', async (req, res) => {
  try {
    const { max_uses, expires_at, note } = req.body || {};
    let maxUses = null;
    if (max_uses != null && max_uses !== '') {
      // Validate the ORIGINAL input as an integer — parseInt() would silently
      // truncate fractions ('2.5' → 2), so check with Number() first.
      const n = Number(max_uses);
      if (!Number.isInteger(n) || n < 1 || n > 100000) {
        return res.status(400).json({ error: 'INVALID_MAX_USES' });
      }
      maxUses = n;
    }
    let expAt = null;
    if (expires_at) {
      const d = new Date(expires_at);
      if (isNaN(d.getTime()) || d <= new Date()) {
        return res.status(400).json({ error: 'INVALID_EXPIRY' });
      }
      expAt = d.toISOString();
    }
    const noteStr = String(note || '').trim().slice(0, 255);

    // Retry on (astronomically unlikely) code collision
    let code = null;
    for (let i = 0; i < 5; i++) {
      const c = genCode();
      try {
        const ins = await db.query(
          `INSERT INTO invite_links (code, created_by, max_uses, expires_at, note)
           VALUES ($1, $2, $3, $4, $5) RETURNING code`,
          [c, req.user.id, maxUses, expAt, noteStr]
        );
        code = ins.rows[0].code;
        break;
      } catch (e) {
        if (e.code !== '23505') throw e; // only retry unique violations
      }
    }
    if (!code) return res.status(500).json({ error: 'GENERATE_FAILED' });

    await logActivity(req.user.id, 'invite.create', { code, max_uses: maxUses, expires_at: expAt, note: noteStr });
    const link = appBaseUrl() + '/login.html?invite=' + encodeURIComponent(code);
    return res.status(201).json({ ok: true, code, link });
  } catch (e) {
    safeLog('[invites] create error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/admin/invites → list newest first
adminInvites.get('/', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, code, max_uses, used_count, expires_at, is_active, note, created_at
       FROM invite_links ORDER BY created_at DESC LIMIT 200`
    );
    return res.json({ ok: true, invites: r.rows });
  } catch (e) {
    safeLog('[invites] list error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

// PUT /api/admin/invites/:id { is_active: true|false } → enable/disable
adminInvites.put('/:id', async (req, res) => {
  try {
    const active = req.body && req.body.is_active;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'INVALID_STATUS' });
    }
    const r = await db.query(
      'UPDATE invite_links SET is_active = $1 WHERE id = $2 RETURNING code',
      [active, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    await logActivity(req.user.id, 'invite.set_active', { code: r.rows[0].code, is_active: active });
    return res.json({ ok: true });
  } catch (e) {
    safeLog('[invites] update error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

// DELETE /api/admin/invites/:id
adminInvites.delete('/:id', async (req, res) => {
  try {
    const r = await db.query('DELETE FROM invite_links WHERE id = $1 RETURNING code', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    await logActivity(req.user.id, 'invite.delete', { code: r.rows[0].code });
    return res.json({ ok: true });
  } catch (e) {
    safeLog('[invites] delete error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

// ---- public router ------------------------------------------------------
// GET /api/invite/:code/validate → { valid } — generic, no detail leak
const publicInvites = express.Router();

publicInvites.get('/:code/validate', async (req, res) => {
  try {
    const inv = await validateInvite(req.params.code);
    return res.json({ valid: !!inv });
  } catch (e) {
    safeLog('[invites] validate error:', e.message);
    return res.json({ valid: false });
  }
});

module.exports = { adminInvites, publicInvites, validateInvite, consumeInvite };
