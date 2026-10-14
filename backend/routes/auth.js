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
const { validateInvite, consumeInvite } = require('./invites');
const push = require('../utils/push');

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

// ---- GET /api/auth/registration-status (public) -----------------
router.get('/registration-status', async (req, res) => {
  try {
    const reg = await getSetting('registration_enabled');
    res.json({ enabled: reg ? reg.enabled !== false : true });
  } catch (e) {
    res.json({ enabled: true });
  }
});

// ---- GET /api/auth/voice-greeting (public) -----------------
router.get('/voice-greeting', async (req, res) => {
  try {
    const vg = await getSetting('voice_greeting');
    if (!vg || vg.enabled === false) return res.json({ enabled: false });
    res.json({
      enabled: true,
      rotation: vg.rotation !== false,
      greetings: vg.greetings || {}
    });
  } catch (e) {
    res.json({ enabled: false });
  }
});

// ---- POST /api/auth/register ---------------------------------
router.post('/register', async (req, res) => {
  try {
    const { name, phone, whatsapp, email, password, religion, invite_code } = req.body || {};

    // Registration gate: ON → normal. OFF → only a valid invite code may proceed.
    const reg = await getSetting('registration_enabled');
    const regOn = reg && reg.enabled !== false;
    let invite = null;
    if (!regOn) {
      invite = await validateInvite(invite_code);
      if (!invite) {
        return res.status(403).json({ error: 'REGISTRATION_DISABLED' });
      }
    } else if (invite_code) {
      // Registration ON: an invite code is optional but still counts its use.
      invite = await validateInvite(invite_code);
    }

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
      `INSERT INTO users (name, phone, whatsapp, email, password_hash, religion, status, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', FALSE)
       RETURNING *`,
      [name.trim(), phoneN, whatsapp.trim(), emailN, password_hash, rel]
    );
    const user = ins.rows[0];

    // Consume the invite use (atomic; only if a valid invite was used).
    if (invite) {
      try {
        const consumed = await consumeInvite(invite.code);
        if (!consumed) safeLog('[auth] invite consume: max_uses reached for', invite.code);
      }
      catch (e) { safeLog('[auth] invite consume skipped:', e.message); }
    }

    // Welcome bonus (admin-controlled) — credited now, usable after verification
    try {
      const wb = await getSetting('welcome_bonus');
      if (wb && wb.enabled && Number(wb.amount) > 0) {
        await db.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
          user.id, Number(wb.amount), 'bonus', 'welcome-' + user.id,
        ]);
      }
    } catch (e) { safeLog('[auth] welcome bonus skipped:', e.message); }

    // Mandatory email verification: send link, do NOT issue session tokens yet.
    let emailSent = false;
    try {
      if (isConfigured()) {
        const token = await createVerificationToken(user.id, 24);
        const link = `${appBaseUrl()}/verify-email.html?token=${token}`;
        const sent = await sendVerificationEmail(emailN, link, name.trim());
        emailSent = !!sent.ok;
      }
    } catch (e) { safeLog('[auth] verification email skipped:', e.message); }

    // Web Push: notify admins of new user registration (async, non-blocking)
    push.notifyNewUser(db, user).catch(() => {});

    return res.status(201).json({
      ok: true,
      verify_email: true,
      email: emailN,
      email_sent: emailSent,
      message: 'VERIFY_EMAIL',
    });
  } catch (e) {
    safeLog('[auth] register error:', e.message);
    return res.status(500).json({ error: 'REGISTER_FAILED' });
  }
});

// ---- GET /api/auth/verify-email?token= -------------------------
// Clicked from the verification email. Single-use, 24h expiry.
router.get('/verify-email', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).json({ error: 'INVALID_TOKEN' });
    }
    const row = await findValidToken('email_verification_tokens', token);
    if (!row) return res.status(400).json({ error: 'INVALID_OR_EXPIRED' });

    await db.withTransaction(async (client) => {
      await client.query(
        'UPDATE email_verification_tokens SET used = TRUE WHERE id = $1',
        [row.id]
      );
      await client.query(
        `UPDATE users SET email_verified = TRUE,
         status = CASE WHEN status = 'pending' THEN 'active' ELSE status END
         WHERE id = $1`,
        [row.user_id]
      );
    });
    return res.json({ ok: true });
  } catch (e) {
    safeLog('[auth] verify-email error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

// ---- POST /api/auth/resend-verification { email } ---------------
// Rate-limited: max 3 per email per hour. Never reveals account existence
// beyond what registration already does (409 ALREADY_REGISTERED).
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'INVALID_EMAIL' });
    const em = email.trim().toLowerCase();

    const rl = await db.query(
      `SELECT COUNT(*) AS c FROM email_verification_tokens evt
       JOIN users u ON u.id = evt.user_id
       WHERE LOWER(u.email) = $1 AND evt.created_at > NOW() - INTERVAL '1 hour'`,
      [em]
    );
    if (parseInt(rl.rows[0].c, 10) >= 3) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
    }

    const u = await db.query(
      'SELECT id, name, email_verified FROM users WHERE LOWER(email) = $1 LIMIT 1',
      [em]
    );
    const user = u.rows[0];
    if (user && !user.email_verified && isConfigured()) {
      try {
        const token = await createVerificationToken(user.id, 24);
        const link = `${appBaseUrl()}/verify-email.html?token=${token}`;
        await sendVerificationEmail(em, link, user.name);
      } catch (e) { safeLog('[auth] resend verification skipped:', e.message); }
    }
    // Always OK: do not reveal whether the email exists / is verified.
    return res.json({ ok: true });
  } catch (e) {
    safeLog('[auth] resend-verification error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

// ---- POST /api/auth/forgot-password { email } -------------------
// Sends a 1-hour single-use reset link. Always returns OK (no enumeration).
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'INVALID_EMAIL' });
    const em = email.trim().toLowerCase();

    const rl = await db.query(
      `SELECT COUNT(*) AS c FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE LOWER(u.email) = $1 AND prt.created_at > NOW() - INTERVAL '1 hour'`,
      [em]
    );
    if (parseInt(rl.rows[0].c, 10) >= 3) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
    }

    const u = await db.query(
      'SELECT id, name FROM users WHERE LOWER(email) = $1 LIMIT 1',
      [em]
    );
    const user = u.rows[0];
    if (user && isConfigured()) {
      try {
        const token = await createPasswordResetToken(user.id);
        const link = `${appBaseUrl()}/reset-password.html?token=${token}`;
        await sendPasswordResetEmail(em, link, user.name);
      } catch (e) { safeLog('[auth] forgot-password email skipped:', e.message); }
    }
    return res.json({ ok: true });
  } catch (e) {
    safeLog('[auth] forgot-password error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

// ---- POST /api/auth/reset-password { token, new_password } ------
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body || {};
    if (!/^[a-f0-9]{64}$/.test(String(token || ''))) {
      return res.status(400).json({ error: 'INVALID_TOKEN' });
    }
    if (!new_password || String(new_password).length < 6) {
      return res.status(400).json({ error: 'WEAK_PASSWORD' });
    }
    const row = await findValidToken('password_reset_tokens', String(token));
    if (!row) return res.status(400).json({ error: 'INVALID_OR_EXPIRED' });

    const hash = await hashPassword(String(new_password));
    await db.withTransaction(async (client) => {
      await client.query(
        'UPDATE password_reset_tokens SET used = TRUE WHERE id = $1',
        [row.id]
      );
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, row.user_id]);
      // Logout everywhere: revoke all refresh tokens for this user.
      await client.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [row.user_id]);
    });
    return res.json({ ok: true });
  } catch (e) {
    safeLog('[auth] reset-password error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
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

    // Timing-safe: always do password verification work, even if user not found,
    // so response time doesn't reveal whether the account exists.
    // Use a dummy hash when user is missing.
    const DUMMY_HASH = '$2b$10$dummyhashdummyhashdummyhashdummyhashdummyhashdumm';
    const hashToVerify = user ? user.password_hash : DUMMY_HASH;
    const pwOk = await verifyPassword(String(password), hashToVerify);

    // Uniform failure helper (does not reveal which field was wrong)
    const fail = async (code, status) => {
      if (user) {
        const sec = await getSetting('login_security');
        const maxAttempts = Number((sec && sec.max_attempts) || 10);
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

    if (!pwOk) return fail('INVALID_CREDENTIALS', 401);

    // Mandatory email verification: password is correct, but email not verified.
    if (!user.email_verified) {
      return res.status(403).json({ error: 'EMAIL_NOT_VERIFIED', email: user.email });
    }

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
      // New email must be verified before next login.
      sets.push(`email_verified = $${i++}`); params.push(false);
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
    const updated = r.rows[0];
    // Email was changed: send a fresh verification link for the new address.
    // Current session stays valid; next login requires verification.
    let verifySent = false;
    if (email !== undefined && isConfigured()) {
      try {
        const token = await createVerificationToken(updated.id, 24);
        const link = `${appBaseUrl()}/verify-email.html?token=${token}`;
        const sent = await sendVerificationEmail(updated.email, link, updated.name);
        verifySent = !!sent.ok;
      } catch (e) { safeLog('[auth] re-verification email skipped:', e.message); }
    }
    const out = publicUser(updated);
    if (email !== undefined) out.verify_email_sent = verifySent;
    return res.json({ user: out });
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

// ---- OTP via email (Phase 3) ----------------------------------
const crypto = require('crypto');
const {
  sendOtpEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  isConfigured,
} = require('../utils/mailer');

function makeOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

// ---- Email link tokens (mandatory verification + password reset) ----
// Raw token goes to the user (in the email link); only SHA-256 hash is stored.
function makeLinkToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 hex chars
}
function hashLinkToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
// Timing-safe comparison of a presented token against stored hashes.
async function findValidToken(table, token) {
  const ALLOWED_TABLES = ['email_verification_tokens', 'password_reset_tokens'];
  if (!ALLOWED_TABLES.includes(table)) {
    throw new Error('Invalid token table');
  }
  const hash = hashLinkToken(token);
  const r = await db.query(
    `SELECT * FROM ${table}
     WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()
     LIMIT 1`,
    [hash]
  );
  const row = r.rows[0];
  if (!row) return null;
  const a = Buffer.from(row.token_hash, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return row;
}

function appBaseUrl() {
  const u = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return u || 'https://abc-authentic.store';
}

async function createVerificationToken(userId, hoursValid) {
  const token = makeLinkToken();
  const hash = hashLinkToken(token);
  await db.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)`,
    [userId, hash, String(hoursValid)]
  );
  return token;
}

async function createPasswordResetToken(userId) {
  const token = makeLinkToken();
  const hash = hashLinkToken(token);
  await db.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
    [userId, hash]
  );
  return token;
}

// POST /api/auth/send-otp { email } — 6-digit OTP, 5-min expiry, hashed in DB
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'INVALID_EMAIL' });
    if (!isConfigured()) return res.status(503).json({ error: 'OTP_UNAVAILABLE' });
    const em = email.trim().toLowerCase();

    // Rate limit: max 3 OTPs per email per 10 minutes
    const rl = await db.query(
      `SELECT COUNT(*) AS c FROM otp_codes WHERE email = $1 AND created_at > NOW() - INTERVAL '10 minutes'`,
      [em]
    );
    if (parseInt(rl.rows[0].c, 10) >= 3) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
    }

    const code = makeOtp();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    await db.query(
      `INSERT INTO otp_codes (email, code_hash, purpose, expires_at)
       VALUES ($1, $2, 'verify', NOW() + INTERVAL '5 minutes')`,
      [em, codeHash]
    );

    const u = await db.query('SELECT name FROM users WHERE LOWER(email) = $1 LIMIT 1', [em]);
    const sent = await sendOtpEmail(em, code, u.rows.length ? u.rows[0].name : null);
    if (!sent.ok) return res.status(502).json({ error: 'EMAIL_FAILED' });
    return res.json({ ok: true });
  } catch (e) {
    safeLog('[auth] send-otp error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

// POST /api/auth/verify-otp { email, code } — marks email verified
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!validEmail(email) || !/^\d{6}$/.test(String(code || ''))) {
      return res.status(400).json({ error: 'INVALID_INPUT' });
    }
    const em = email.trim().toLowerCase();
    const codeHash = crypto.createHash('sha256').update(String(code)).digest('hex');

    const r = await db.query(
      `SELECT id, attempts FROM otp_codes
       WHERE email = $1 AND code_hash = $2 AND consumed = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [em, codeHash]
    );
    if (!r.rows.length) {
      // Count a failed attempt against the latest unconsumed OTP
      await db.query(
        `UPDATE otp_codes SET attempts = attempts + 1
         WHERE id = (SELECT id FROM otp_codes WHERE email = $1 AND consumed = FALSE
                     ORDER BY created_at DESC LIMIT 1)`,
        [em]
      );
      return res.status(400).json({ error: 'INVALID_OR_EXPIRED' });
    }
    const otp = r.rows[0];
    if (otp.attempts >= 5) return res.status(400).json({ error: 'TOO_MANY_ATTEMPTS' });

    await db.query('UPDATE otp_codes SET consumed = TRUE WHERE id = $1', [otp.id]);
    await db.query(
      `UPDATE users SET email_verified = TRUE,
       status = CASE WHEN status = 'pending' THEN 'active' ELSE status END
       WHERE LOWER(email) = $1`,
      [em]
    );
    return res.json({ ok: true });
  } catch (e) {
    safeLog('[auth] verify-otp error:', e.message);
    return res.status(500).json({ error: 'FAILED' });
  }
});

module.exports = router;
