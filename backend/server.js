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

// ---- User routes (authenticated users) --
const userRoutes = require('./routes/user');
app.use('/api', apiLimiter, userRoutes);

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
