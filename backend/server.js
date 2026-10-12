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
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

// Load modular engines (NID, BDRIS, ... added later)
const engines = loadEngines();
app.set('engines', engines);

// ---- Health -------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'abc-authentic', engines: Object.keys(engines) });
});

// ---- Public settings (registration on/off, maintenance) ----
app.get('/api/public/settings', apiLimiter, async (req, res) => {
  try {
    const r = await db.query('SELECT key, value FROM settings');
    const out = {};
    for (const row of r.rows) out[row.key] = row.value;
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
// adapter (engines/death-verify/index.js) captures its request handler
// WITHOUT binding port 3001 and exposes it as middleware, so the
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

app.listen(PORT, () => {
  safeLog(`[abc-authentic] listening on port ${PORT}`);
});
