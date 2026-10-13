// ============================================================
// All In One (Abc Authentic) - Auth: bcrypt + JWT
// Security: passwords NEVER stored plain. Access tokens short-lived
// (15 min). Long-lived refresh tokens (30d) with rotation.
// ============================================================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('FATAL: JWT_SECRET env var is required - refusing to start with insecure default');
}
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TTL_DAYS = parseInt(process.env.JWT_REFRESH_DAYS || '30', 10);
const BCRYPT_ROUNDS = 12;

// ---- Password hashing (bcrypt, never plain text) ------------
async function hashPassword(plain) {
  if (!plain || plain.length < 6) throw new Error('WEAK_PASSWORD');
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

// ---- Access token (short-lived) ------------------------------
function signAccess(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: ACCESS_TTL });
}

// ---- Refresh token (opaque, stored hashed in DB) --------------
// We return { token, hash, expiresAt }. Store ONLY the hash.
function mintRefreshToken() {
  const token = crypto.randomBytes(48).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);
  return { token, hash, expiresAt };
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---- Middleware ----------------------------------------------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'NO_TOKEN' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'INVALID_TOKEN' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'ADMIN_ONLY' });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  signAccess,
  mintRefreshToken,
  hashRefreshToken,
  requireAuth,
  requireAdmin,
  // legacy alias (do not use for new code)
  sign: signAccess,
};
