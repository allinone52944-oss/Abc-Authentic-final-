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
const secureHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
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
const clientIpKey = (req) => {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip;
};

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

// ---- XSS: strip <script> and event handlers from strings ------
function sanitizeValue(v) {
  if (typeof v !== 'string') return v;
  return v
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
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

module.exports = {
  secureHeaders,
  authLimiter,
  apiLimiter,
  xssClean,
  sameOrigin,
  uploadMiddleware,
  safeLog,
  DEFAULT_MAX_MB,
  DEFAULT_ALLOWED,
};
