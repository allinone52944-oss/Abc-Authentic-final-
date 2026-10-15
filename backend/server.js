// ============================================================
// All In One (Abc Authentic) - API Server (Phase 1 foundation)
// Port 3001 | Fresh rebuild, no legacy code
// Security: helmet, rate limits, XSS clean, same-origin check.
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { loadEngines } = require('./engines-loader');
const {
  secureHeaders,
  authLimiter,
  apiLimiter,
  getClientIp,
  xssClean,
  sameOrigin,
  safeLog,
} = require('./security');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(secureHeaders);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(xssClean);
app.use(sameOrigin);

// Serve frontend + bundled assets (fonts local, no CDN dependency)
app.use(express.static(path.join(__dirname, '..', 'frontend'), {
  setHeaders: (res, filePath) => {
    // HTML: always revalidate (no stale ?v= references)
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    // Versioned assets (?v=): cache aggressively (version changes on update)
    else if (/\.(css|js)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

// Load modular engines (NID, BDRIS, ... added later)
const engines = loadEngines();
app.set('engines', engines);

// ---- Health -------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'abc-authentic', engines: Object.keys(engines) });
});

// ---- Public settings (registration on/off, maintenance) ----
// C-3 fix (2026-10-15): আগে সব settings key unmasked ফেরত যেত —
// whatsapp access_token-ও public ছিল। এখন শুধু নিরাপদ key-এর whitelist,
// আর object value-তে access_token/secret/password থাকলে সেটা ছেঁটে দেওয়া হয়।
const PUBLIC_SETTINGS_KEYS = ['registration_enabled', 'maintenance_mode', 'voice_greeting'];
function sanitizePublicSetting(val) {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (/token|secret|password|api[_-]?key/i.test(k)) continue;
      out[k] = v;
    }
    return out;
  }
  return val;
}
app.get('/api/public/settings', apiLimiter, async (req, res) => {
  try {
    const r = await db.query('SELECT key, value FROM settings WHERE key = ANY($1)', [PUBLIC_SETTINGS_KEYS]);
    const out = {};
    for (const row of r.rows) out[row.key] = sanitizePublicSetting(row.value);
    res.json(out);
  } catch (e) {
    safeLog('[api] settings error:', e.message);
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

// ---- Engine catalog (delegated to loaded engines) -----------
app.get('/api/engines', apiLimiter, (req, res) => {
  const list = Object.values(engines).map(({ manifest }) => ({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
  }));
  res.json(list);
});

// ---- IP blocklist (M-9 fix, 2026-10-15) ---------------------------
// Admin-managed via settings key `ip_blocklist` ({"ips": [...]}).
// Checked before everything else; /api/health stays open for monitoring.
let _blockCache = { at: 0, ips: new Set() };
async function ipBlocklist(req, res, next) {
  try {
    if (req.path === '/api/health') return next();
    if (Date.now() - _blockCache.at > 30000) {
      const r = await db.query("SELECT value FROM settings WHERE key = 'ip_blocklist' LIMIT 1");
      const v = r.rows[0] && r.rows[0].value;
      const val = typeof v === 'string' ? JSON.parse(v) : v;
      const ips = val && Array.isArray(val.ips) ? val.ips.map((x) => String(x).trim()) : [];
      _blockCache = { at: Date.now(), ips: new Set(ips) };
    }
    if (_blockCache.ips.size && _blockCache.ips.has(getClientIp(req))) {
      return res.status(403).json({ error: 'IP_BLOCKED' });
    }
  } catch (e) { /* fail open on DB error */ }
  next();
}
app.use(ipBlocklist);

// ---- Maintenance mode gate (H-5 fix, 2026-10-15) ----------------
// Server-side enforcement: when maintenance_mode.enabled, all /api calls
// get 503 except login/refresh/health/admin (admins must be able to log in
// and turn it off) and /api/public/settings (login page reads the message).
const MAINTENANCE_ALLOW = new Set([
  '/api/health', '/api/public/settings',
  '/api/auth/login', '/api/auth/refresh', '/api/auth/logout', '/api/auth/logout-all',
]);
let _maintCache = { at: 0, enabled: false, message: '' };
async function maintenanceGate(req, res, next) {
  try {
    if (req.path.startsWith('/api/admin/') || MAINTENANCE_ALLOW.has(req.path)) return next();
    if (Date.now() - _maintCache.at > 15000) {
      const r = await db.query("SELECT value FROM settings WHERE key = 'maintenance_mode' LIMIT 1");
      const v = r.rows[0] && r.rows[0].value;
      const val = typeof v === 'string' ? JSON.parse(v) : v;
      _maintCache = { at: Date.now(), enabled: !!(val && val.enabled), message: (val && val.message) || '' };
    }
    if (_maintCache.enabled) {
      return res.status(503).json({ error: 'MAINTENANCE', message: _maintCache.message || 'সাইট এখন মেনটেনেন্সে আছে' });
    }
  } catch (e) { /* fail open — don't brick the site on DB error */ }
  next();
}
app.use('/api/', maintenanceGate);

// ---- Auth routes (strict rate limit: brute-force protection) --
const authRoutes = require('./routes/auth');
app.use('/api/auth', authLimiter, authRoutes);

// ---- Admin routes (auth + admin role required) --
const adminRoutes = require('./routes/admin');
app.use('/api/admin', apiLimiter, adminRoutes);

// ---- SMS routes: webhook (token-guarded) + admin SMS (JWT admin) --
const { webhook: smsWebhook, adminSms } = require('./routes/sms');
app.use('/api/sms', smsWebhook); // webhook has its own strict rate limiter
app.use('/api/admin/sms', apiLimiter, adminSms);

// ---- Cashback routes (authenticated users) --
const cashbackRoutes = require('./routes/cashback');
app.use('/api/cashback', apiLimiter, cashbackRoutes);

// ---- Invite link routes (admin management + public validate) --
const { adminInvites, publicInvites } = require('./routes/invites');
app.use('/api/admin/invites', apiLimiter, adminInvites);
app.use('/api/invite', apiLimiter, publicInvites);

// ---- BDRIS certificate engine (as-is Studio app, auth + strict limit) --
// The engine folder is a byte-identical copy of BuilderEngine-fixed.zip.
// Its own Express app is mounted here so the existing engine API endpoints
// (/api/captcha, /api/verify, /api/preview, /generate-pdf, ...) are used
// as-is. Auth required: captcha/verify hit the live BDRIS portal.
const { rateLimit } = require('express-rate-limit');
const { requireAuth } = require('./auth');
const bdrisEngineLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED' },
});
try {
  // NOTE: require index.js explicitly — the engine's own package.json
  // points "main" at its Studio server.js; the adapter is index.js.
  const bdrisEngine = require('../engines/bdris-certificate/index.js');
  bdrisEngine.init({});
  app.use('/api/bdris-engine', requireAuth, bdrisEngineLimiter, bdrisEngine.getApp());
  safeLog('[engines] mounted bdris-certificate at /api/bdris-engine');
} catch (e) {
  safeLog('[engines] bdris-certificate not mounted:', e.message);
}

// ---- Death verify engine (as-is DRN tool, auth + strict limit) ------
// The engine folder is an as-is copy of Death-Verify-Engine.zip.
// death-verify-server.js is a raw Node http server (not Express); the
// adapter (engines/death-verify/index.js) spawns it as a subprocess on
// 127.0.0.1:3001 and reverse-proxies /api/death-engine/* to it, so the
// existing engine API endpoints are used as-is:
//   GET  /api/captcha → POST /api/solve-captcha → POST /api/verify
//   {sessionId, drn, dod DD/MM/YYYY, captcha} → POST /api/preview | /api/pdf
// Auth required: captcha/verify hit the live BDRIS portal.
// Python + opencv + ddddocr are optional (offline captcha solver);
// without them the engine still works with manual captcha entry.
const deathEngineLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED' },
});
try {
  const deathEngine = require('../engines/death-verify/index.js');
  deathEngine.init({});
  app.use('/api/death-engine', requireAuth, deathEngineLimiter, deathEngine.getApp());
  safeLog('[engines] mounted death-verify at /api/death-engine');
} catch (e) {
  safeLog('[engines] death-verify not mounted:', e.message);
}

// ---- NID replica engine (as-is kit, auth + strict limit) -------------
// The engine folder is an as-is copy of NID-Engine-Fixed.zip (Python kit:
// extract_input.py → extract_template.py → make_fields.py → build_output.py).
// The adapter (engines/nid-replica/adapter.js) runs the scripts with a
// per-job CWD (work/jobs/<uuid>/) so concurrent users are isolated.
// No engine Python logic is modified.
//   POST /api/nid-engine/extract (multipart pdf) → { jobId, fields, images }
//   POST /api/nid-engine/build   ({ jobId, fields }) → application/pdf
// Python deps (VM): pip3 install pymupdf Pillow pdf417gen
const nidEngineLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED' },
});
try {
  const nidAdapter = require('../engines/nid-replica/adapter.js');
  nidAdapter.init({});
  const nidRoutes = require('./routes/nid');
  app.use('/api/nid-engine', requireAuth, nidEngineLimiter, nidRoutes);
  safeLog('[engines] mounted nid-replica at /api/nid-engine');
} catch (e) {
  safeLog('[engines] nid-replica not mounted:', e.message);
}

// ---- BDRIS Apply engine (as-is bot, auth + strict limit) -------------
// The engine folder is an as-is copy of Bdris-apply-v2-CLEAN-v23.zip
// (BDRIS Auto-fill Bot v6: Express + Socket.IO + Playwright).
// The adapter (engines/bdris-apply/index.js) spawns it as a subprocess
// on 127.0.0.1:3102 and reverse-proxies /api/bdris-apply/* to it
// (HTTP + WebSocket for Socket.IO). No engine logic is modified.
// Wallet charging (both admin-configurable):
//   POST /api/bdris-apply/charge/submit → service price (services table)
//   POST /api/bdris-apply/charge/pdf    → settings 'bdris_apply.pdf_price'
// Engine deps (VM): cd engines/bdris-apply && npm install
//   (playwright downloads ~170MB browser on first run)
const bdrisApplyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED' },
});
let bdrisApplyAdapter = null;
try {
  bdrisApplyAdapter = require('../engines/bdris-apply/index.js');
  bdrisApplyAdapter.init();
  const bdrisApplyRoutes = require('./routes/bdris-apply');
  // Charge endpoints first (Express tries these before the proxy fallback).
  //   POST /api/bdris-apply/charge/submit, POST /api/bdris-apply/charge/pdf,
  //   GET  /api/bdris-apply/prices
  // Everything else falls through to the engine subprocess proxy.
  // Socket.IO auth is enforced by the engine itself (io.use handshake check in
  // engines/bdris-apply/server.js) — the client sends its JWT in handshake.auth.
  // MUST come before the authenticated routes (Express matches in order)
  app.use('/api/bdris-apply/socket.io', bdrisApplyAdapter.getApp());
  app.use('/api/bdris-apply', requireAuth, bdrisApplyLimiter, bdrisApplyRoutes);
  app.use('/api/bdris-apply', requireAuth, bdrisApplyLimiter, bdrisApplyAdapter.getApp());
  safeLog('[engines] mounted bdris-apply at /api/bdris-apply');
} catch (e) {
  safeLog('[engines] bdris-apply not mounted:', e.message);
}

// ---- User routes (authenticated users) --
const userRoutes = require('./routes/user');
app.use('/api', apiLimiter, userRoutes);

// ---- Web Push routes (subscriptions + VAPID public key) --
const pushRoutes = require('./routes/push');
app.use('/api/push', apiLimiter, pushRoutes);

// ---- Fallback: frontend handles routing ----------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ---- Error handler (never leak internals) --------------------
app.use((err, req, res, next) => {
  safeLog('[api] error:', err.message);
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

const _httpServer = app.listen(PORT, () => {
  safeLog(`[abc-authentic] listening on port ${PORT}`);
});
// WebSocket upgrade for bdris-apply engine (Socket.IO)
_httpServer.on('upgrade', (req, socket, head) => {
  try {
    if (bdrisApplyAdapter && bdrisApplyAdapter.handleUpgrade(req, socket, head)) return;
  } catch (e) { /* fall through */ }
  socket.destroy();
});
