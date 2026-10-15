// ============================================================
// All In One (Abc Authentic) - Security middleware bundle
// - helmet: secure HTTP headers
// - rate limiting: strict for auth, general for API
// - XSS: basic input sanitizer for JSON bodies
// - CSRF: Bearer-token APIs are not cookie-authed, so classic
//   CSRF does not apply; we still enforce same-origin on
//   state-changing requests when an Origin header is present.
// - upload: multer with type + size validation (admin-configurable)
// ============================================================
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

// ---- Secure headers ------------------------------------------
// M-10 fix (2026-10-15): script-src keeps 'unsafe-inline' because the app
// legitimately uses ~170 inline onclick handlers (admin.js + pages).
// script-src 'self' alone SILENTLY KILLED every admin-panel button.
// Primary XSS defense is output escaping (esc() in all renderers), which the
// audit verified — CSP remains as defense-in-depth for external scripts.
const secureHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // coffee theme uses inline styles
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // allow same-origin static assets
});

// ---- Rate limiters --------------------------------------------
// Behind Cloudflare Tunnel + nginx, Express sees the same peer IP
// (127.0.0.1) for every visitor unless trust proxy is configured, which
// would turn these per-IP limiters into one GLOBAL bucket shared by all
// users. Key the limiters on the real client IP, trying headers in order:
// 1. CF-Connecting-IP (Cloudflare, unspoofable)
// 2. X-Forwarded-For first entry (nginx proxy)
// 3. req.ip fallback (shared — last resort)
// H-6 fix (2026-10-15): those headers are trusted ONLY when the direct TCP
// peer is loopback/private (i.e. the request really came through the local
// proxy). A direct public peer + spoofed headers would otherwise get a
// fresh rate-limit bucket per request.
function _peerIsLocalProxy(peer) {
  if (!peer) return false;
  const p = String(peer);
  return p === '127.0.0.1' || p === '::1' || p === '::ffff:127.0.0.1' ||
    /^10\./.test(p) || /^::ffff:10\./.test(p) ||
    /^192\.168\./.test(p) || /^::ffff:192\.168\./.test(p) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(p) || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(p) ||
    /^fc00:/i.test(p) || /^fe80:/i.test(p);
}
const _ipRe = /^[0-9a-fA-F.:]{3,45}$/;
// Real client IP (proxy-aware, H-6 hardened). Exported for the IP blocklist (M-9).
const getClientIp = (req) => {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  if (_peerIsLocalProxy(peer)) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf && _ipRe.test(cf)) return cf;
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff && _ipRe.test(xff)) return xff;
  }
  return req.ip;
};
const clientIpKey = (req) => getClientIp(req);

// Strict: login / register / OTP endpoints (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: clientIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS' },
});

// General API limiter
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: clientIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED' },
});

// ---- XSS: strip dangerous markup from strings ------------------
// M-20 fix (2026-10-15): hardened — was script-blocks + quoted on*= only.
// Now also strips: unquoted event handlers, javascript:/data:/vbscript: URIs,
// and iframe/object/embed/form/base/meta tags. Defense-in-depth only — the
// primary XSS defense remains output escaping (esc()) in every renderer.
function sanitizeValue(v) {
  if (typeof v !== 'string') return v;
  return v
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\s*(iframe|object|embed|form|base|meta|link|style)[\s\S]*?>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')          // quoted handlers
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')               // unquoted handlers
    .replace(/(['"\s=])(javascript|data|vbscript)\s*:/gi, '$1blocked:');
}
function xssClean(req, res, next) {
  const clean = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') obj[k] = sanitizeValue(v);
      else if (typeof v === 'object') clean(v);
    }
  };
  clean(req.body);
  clean(req.query);
  next();
}

// ---- Same-origin check for state-changing requests ------------
function sameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
    const host = req.headers.host;
    try {
      const o = new URL(origin);
      if (o.host !== host) return res.status(403).json({ error: 'BAD_ORIGIN' });
    } catch (e) {
      return res.status(403).json({ error: 'BAD_ORIGIN' });
    }
  }
  next();
}

// ---- File upload validation -----------------------------------
// Limits come from settings (admin-configurable); defaults here
// are the fallback when settings are unavailable.
const DEFAULT_MAX_MB = 5;
const DEFAULT_ALLOWED = ['pdf', 'jpg', 'jpeg', 'png'];

function uploadMiddleware(getLimits) {
  const storage = multer.memoryStorage();
  const limits = getLimits ? getLimits() : {};
  const maxMb = Number(limits.max_mb) > 0 ? Number(limits.max_mb) : DEFAULT_MAX_MB;
  const allowed = limits.allowed || DEFAULT_ALLOWED;
  const MIME_MAP = {
    pdf: ['application/pdf'],
    jpg: ['image/jpeg'], jpeg: ['image/jpeg'],
    png: ['image/png'],
  };
  return multer({
    storage,
    limits: { fileSize: maxMb * 1024 * 1024, files: 5 },
    fileFilter: (req, file, cb) => {
      const ext = (file.originalname.split('.').pop() || '').toLowerCase();
      if (!allowed.includes(ext)) {
        return cb(new Error('FILE_TYPE_NOT_ALLOWED'));
      }
      const validMimes = MIME_MAP[ext];
      if (validMimes && !validMimes.includes(file.mimetype)) {
        return cb(new Error('FILE_TYPE_NOT_ALLOWED'));
      }
      cb(null, true);
    },
  });
}

// ---- Safe logger: never log sensitive fields ------------------
const SENSITIVE = ['password', 'password_hash', 'otp', 'token', 'smtp_pass', 'secret'];
function safeLog(...args) {
  const clean = args.map((a) => {
    if (a && typeof a === 'object') {
      const c = { ...a };
      for (const k of Object.keys(c)) {
        if (SENSITIVE.some((s) => k.toLowerCase().includes(s))) c[k] = '[REDACTED]';
      }
      return c;
    }
    return a;
  });
  console.log(...clean);
}

// ---- Order-document disk upload, settings-driven (H-12 fix, 2026-10-15) ----
// Replaces the hardcoded 10MB/ext-only configs: limits now come from the
// `file_upload` setting (admin-configurable), refreshed every 30s.
// Filenames stay random (C-2: never embed req.params.id).
const _orderUploadCfg = { at: 0, maxMb: 10, allowed: ['pdf', 'jpg', 'jpeg', 'png'] };
const _KNOWN_UP_EXTS = ['pdf', 'jpg', 'jpeg', 'png'];
async function _refreshOrderUploadCfg(db) {
  if (Date.now() - _orderUploadCfg.at < 30000) return _orderUploadCfg;
  try {
    const r = await db.query("SELECT value FROM settings WHERE key = 'file_upload' LIMIT 1");
    const v = r.rows[0] && r.rows[0].value;
    const val = typeof v === 'string' ? JSON.parse(v) : v;
    if (val && typeof val === 'object') {
      if (Number(val.max_mb) > 0) _orderUploadCfg.maxMb = Math.min(Number(val.max_mb), 50);
      if (Array.isArray(val.allowed)) {
        const a = val.allowed.map((x) => String(x).toLowerCase()).filter((x) => _KNOWN_UP_EXTS.includes(x));
        if (a.length) _orderUploadCfg.allowed = a;
      }
    }
  } catch (e) { /* keep last good / defaults */ }
  _orderUploadCfg.at = Date.now();
  return _orderUploadCfg;
}
// kind: 'order' | 'delivery' — filename prefix. Returns a single-file middleware.
function orderDocUpload(db, kind) {
  const path = require('path');
  const fs = require('fs');
  const crypto = require('crypto');
  // L-8: magic-byte sniffing — don't trust the client-supplied extension alone.
  // Checks the first bytes of the in-memory chunk via multer's fileFilter is
  // impossible (no data yet), so we verify after write in a wrapper.
  const MAGIC = {
    '.pdf': (b) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46, // %PDF
    '.jpg': (b) => b.length > 2 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
    '.jpeg': (b) => b.length > 2 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
    '.png': (b) => b.length > 7 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47,
  };
  return (req, res, next) => {
    _refreshOrderUploadCfg(db).then((cfg) => {
      const storage = multer.diskStorage({
        destination: (req2, file, cb) => {
          const dir = '/opt/all-in-one-abc-authentic/uploads/orders';
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (req2, file, cb) => {
          const rawExt = path.extname(file.originalname).toLowerCase();
          const ext = cfg.allowed.includes(rawExt.slice(1)) ? rawExt : '.bin';
          cb(null, `${kind}-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${ext}`);
        },
      });
      const up = multer({
        storage,
        limits: { fileSize: cfg.maxMb * 1024 * 1024, files: 5 },
        fileFilter: (req2, file, cb) => {
          const ext = (file.originalname.split('.').pop() || '').toLowerCase();
          if (!cfg.allowed.includes(ext)) return cb(new Error('FILE_TYPE_NOT_ALLOWED'));
          cb(null, true);
        },
      }).single('file');
      up(req, res, (err) => {
        if (err || !req.file) return next(err);
        // L-8: verify magic bytes match the extension; delete spoofed files.
        try {
          const ext = path.extname(req.file.filename).toLowerCase();
          const check = MAGIC[ext];
          if (check) {
            const fd = fs.openSync(req.file.path, 'r');
            const head = Buffer.alloc(8);
            fs.readSync(fd, head, 0, 8, 0);
            fs.closeSync(fd);
            if (!check(head)) {
              fs.unlinkSync(req.file.path);
              return next(new Error('FILE_TYPE_NOT_ALLOWED'));
            }
          }
        } catch (e) { return next(e); }
        next();
      });
    }).catch(next);
  };
}

module.exports = {
  secureHeaders,
  authLimiter,
  apiLimiter,
  getClientIp,
  xssClean,
  sameOrigin,
  uploadMiddleware,
  orderDocUpload,
  safeLog,
  DEFAULT_MAX_MB,
  DEFAULT_ALLOWED,
};
