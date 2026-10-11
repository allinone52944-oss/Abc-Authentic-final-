// ============================================================
// All In One (Abc Authentic) - Auth routes (Phase 2)
// POST /api/auth/register | /login | /refresh | /logout
// GET  /api/auth/me | PUT /api/auth/me | POST /api/auth/change-password
// Security: bcrypt(12), JWT 15m + rotating refresh, login attempt
// limiting with admin unblock, parameterized queries only.
// ============================================================
const express = require('express');
const db = require('../db');
const {
  hashPassword,
  verifyPassword,
  signAccess,
  mintRefreshToken,
  hashRefreshToken,
  requireAuth,
} = require('../auth');
const { safeLog } = require('../security');

const router = express.Router();

// ---- helpers -------------------------------------------------
async function getSetting(key) {
  const r = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].value : null;
}

function validBDPhone(v) {
  return typeof v === 'string' && /^01[3-9]\d{8}$/.test(v.trim());
}
function validEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}
function validReligion(v) {
  return ['islam', 'hindu', 'buddhist', 'christian', 'other'].includes(v);
}

function publicUser(u) {
  const { password_hash, failed_attempts, locked_until, ...rest } = u;
  return rest;
}

async function issueTokens(userId, role) {
  const access_token = signAccess({ id: userId, role });
  const { token, hash, expiresAt } = mintRefreshToken();
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hash, expiresAt]
  );
  return { access_token, refresh_token: token };
}

// ---- POST /api/auth/register ---------------------------------
router.post('/register', async (req, res) => {
  try {
    const reg = await getSetting('registration_enabled');
    if (!reg || reg.enabled === false) {
      return res.status(403).json({ error: 'REGISTRATION_DISABLED' });
    }

    const { name, phone, whatsapp, email, password, religion } = req.body || {};

    // Validation (all fields mandatory per spec; whatsapp MANDATORY)
    if (!name || String(name).trim().length < 2 || String(name).trim().length > 120) {
      return res.status(400).json({ error: 'INVALID_NAME' });
    }
    if (!validBDPhone(phone)) {
      return res.status(400).json({ error: 'INVALID_PHONE' });
    }
    if (!validBDPhone(whatsapp)) {
      return res.status(400).json({ error: 'INVALID_WHATSAPP' });
    }
    if (!validEmail(email)) {
      return res.status(400).json({ error: 'INVALID_EMAIL' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'WEAK_PASSWORD' });
    }
    const rel = religion || 'other';
    if (!validReligion(rel)) {
      return res.status(400).json({ error: 'INVALID_RELIGION' });
    }

    const phoneN = phone.trim();
    const emailN = email.trim().toLowerCase();

    const dup = await db.query(
      'SELECT id FROM users WHERE phone = $1 OR email = $2 LIMIT 1',
      [phoneN, emailN]
    );
    if (dup.rows.length) {
      return res.status(409).json({ error: 'ALREADY_REGISTERED' });
    }

    const password_hash = await hashPassword(String(password));
    const ins = await db.query(
      `INSERT INTO users (name, phone, whatsapp, email, password_hash, religion, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [name.trim(), phoneN, whatsapp.trim(), emailN, password_hash, rel]
    );
    const user = ins.rows[0];

    // Welcome bonus (admin-controlled)
    try {
      const wb = await getSetting('welcome_bonus');
      if (wb && wb.enabled && Number(wb.amount) > 0) {
        await db.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
          user.id, Number(wb.amount), 'bonus', 'welcome-' + user.id,
        ]);
      }
    } catch (e) { safeLog('[auth] welcome bonus skipped:', e.message); }

    const tokens = await issueTokens(user.id, user.role);
    const fresh = await db.query('SELECT * FROM users WHERE id = $1', [user.id]);
    return res.status(201).json({ user: publicUser(fresh.rows[0]), ...tokens });
  } catch (e) {
    safeLog('[auth] register error:', e.message);
    return res.status(500).json({ error: 'REGISTER_FAILED' });
  }
});

// ---- POST /api/auth/login ------------------------------------
router.post('/login', async (req, res) => {
  try {
    const { login, password } = req.body || {};
    if (!login || !password) {
      return res.status(400).json({ error: 'MISSING_CREDENTIALS' });
    }
    const loginN = String(login).trim().toLowerCase();

    const r = await db.query(
      'SELECT * FROM users WHERE LOWER(phone) = $1 OR LOWER(email) = $1 LIMIT 1',
      [loginN]
    );
    const user = r.rows[0];

    // Uniform timing-safe failure (do not reveal which field was wrong)
    const fail = async (code, status) => {
      if (user) {
        const sec = await getSetting('login_security');
        const maxAttempts = Number((sec && sec.max_attempts) || 5);
        const lockMinutes = Number((sec && sec.lock_minutes) || 30);
        const attempts = (user.failed_attempts || 0) + 1;
        if (attempts >= maxAttempts) {
          await db.query(
            `UPDATE users SET failed_attempts = $1,
             locked_until = NOW() + ($2 || ' minutes')::interval WHERE id = $3`,
            [attempts, String(lockMinutes), user.id]
          );
          return res.status(423).json({ error: 'ACCOUNT_LOCKED', retry_minutes: lockMinutes });
        }
        await db.query('UPDATE users SET failed_attempts = $1 WHERE id = $2', [attempts, user.id]);
      }
      return res.status(status).json({ error: code });
    };

    if (!user) return fail('INVALID_CREDENTIALS', 401);
    if (user.status === 'blocked' || user.status === 'disabled' || user.login_enabled === false) {
      return res.status(403).json({ error: 'ACCOUNT_DISABLED' });
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'ACCOUNT_LOCKED' });
    }

    const ok = await verifyPassword(String(password), user.password_hash);
    if (!ok) return fail('INVALID_CREDENTIALS', 401);

    await db.query(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1',
      [user.id]
    );
    const tokens = await issueTokens(user.id, user.role);
    const fresh = await db.query('SELECT * FROM users WHERE id = $1', [user.id]);
    return res.json({ user: publicUser(fresh.rows[0]), ...tokens });
  } catch (e) {
    safeLog('[auth] login error:', e.message);
    return res.status(500).json({ error: 'LOGIN_FAILED' });
  }
});

// ---- POST /api/auth/refresh (rotate) --------------------------
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).json({ error: 'MISSING_TOKEN' });

    const hash = hashRefreshToken(String(refresh_token));
    const r = await db.query(
      `SELECT rt.*, u.role, u.status FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.revoked = FALSE AND rt.expires_at > NOW()
       LIMIT 1`,
      [hash]
    );
    const row = r.rows[0];
    if (!row) return res.status(401).json({ error: 'INVALID_REFRESH' });
    if (row.status === 'blocked' || row.status === 'disabled') {
      return res.status(403).json({ error: 'ACCOUNT_DISABLED' });
    }

    // Rotate: revoke old, mint new (single transaction)
    const tokens = await db.withTransaction(async (client) => {
      await client.query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1', [row.id]);
      const access_token = signAccess({ id: row.user_id, role: row.role });
      const minted = mintRefreshToken();
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [row.user_id, minted.hash, minted.expiresAt]
      );
      return { access_token, refresh_token: minted.token };
    });
    return res.json(tokens);
  } catch (e) {
    safeLog('[auth] refresh error:', e.message);
    return res.status(500).json({ error: 'REFRESH_FAILED' });
  }
});

// ---- POST /api/auth/logout ------------------------------------
router.post('/logout', async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (refresh_token) {
      const hash = hashRefreshToken(String(refresh_token));
      await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1', [hash]);
    }
    return res.json({ ok: true });
  } catch (e) {
    safeLog('[auth] logout error:', e.message);
    return res.status(500).json({ error: 'LOGOUT_FAILED' });
  }
});

// ---- GET /api/auth/me -----------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.json({ user: publicUser(r.rows[0]) });
  } catch (e) {
    safeLog('[auth] me error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

// ---- PUT /api/auth/me (profile update) -------------------------
router.put('/me', requireAuth, async (req, res) => {
  try {
    const { name, whatsapp, email, religion, gender } = req.body || {};
    const sets = [];
    const params = [];
    let i = 1;

    if (name !== undefined) {
      if (String(name).trim().length < 2 || String(name).trim().length > 120) {
        return res.status(400).json({ error: 'INVALID_NAME' });
      }
      sets.push(`name = $${i++}`); params.push(String(name).trim());
    }
    if (whatsapp !== undefined) {
      if (!validBDPhone(whatsapp)) return res.status(400).json({ error: 'INVALID_WHATSAPP' });
      sets.push(`whatsapp = $${i++}`); params.push(String(whatsapp).trim());
    }
    if (email !== undefined) {
      if (!validEmail(email)) return res.status(400).json({ error: 'INVALID_EMAIL' });
      const dup = await db.query(
        'SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1',
        [String(email).trim().toLowerCase(), req.user.id]
      );
      if (dup.rows.length) return res.status(409).json({ error: 'EMAIL_TAKEN' });
      sets.push(`email = $${i++}`); params.push(String(email).trim().toLowerCase());
    }
    if (religion !== undefined) {
      if (!validReligion(religion)) return res.status(400).json({ error: 'INVALID_RELIGION' });
      sets.push(`religion = $${i++}`); params.push(religion);
    }
    if (gender !== undefined) {
      if (!['male', 'female', 'child', 'other'].includes(gender)) {
        return res.status(400).json({ error: 'INVALID_GENDER' });
      }
      sets.push(`gender = $${i++}`); params.push(gender);
    }
    if (!sets.length) return res.status(400).json({ error: 'NOTHING_TO_UPDATE' });

    params.push(req.user.id);
    const r = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    return res.json({ user: publicUser(r.rows[0]) });
  } catch (e) {
    safeLog('[auth] update me error:', e.message);
    return res.status(500).json({ error: 'UPDATE_FAILED' });
  }
});

// ---- POST /api/auth/change-password (inside profile) -----------
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password || String(new_password).length < 6) {
      return res.status(400).json({ error: 'WEAK_PASSWORD' });
    }
    const r = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: 'NOT_FOUND' });

    const ok = await verifyPassword(String(current_password), user.password_hash);
    if (!ok) return res.status(401).json({ error: 'WRONG_CURRENT_PASSWORD' });

    const hash = await hashPassword(String(new_password));
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    // Invalidate all refresh tokens (logout everywhere) on password change
    await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [user.id]);
    return res.json({ ok: true });
  } catch (e) {
    safeLog('[auth] change-password error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

module.exports = router;
