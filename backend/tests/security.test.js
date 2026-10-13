// Unit tests for backend/security.js.
const express = require('express');
const request = require('supertest');
const security = require('../security');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('xssClean', () => {
  function run(req) {
    const next = jest.fn();
    security.xssClean(req, {}, next);
    expect(next).toHaveBeenCalled();
    return req;
  }

  test('strips <script> blocks from body strings', () => {
    const req = run({ body: { name: 'hi<script>alert(1)</script>there' }, query: {} });
    expect(req.body.name).toBe('hithere');
  });

  test('strips event-handler attributes', () => {
    const req = run({ body: { x: '<div onclick="evil()">y</div>' }, query: {} });
    expect(req.body.x).toBe('<div>y</div>');
  });

  test('recurses into nested objects and arrays', () => {
    const req = run({
      body: { nested: { deep: '<script>x</script>ok' }, list: ['<script>a</script>b'] },
      query: {},
    });
    expect(req.body.nested.deep).toBe('ok');
    expect(req.body.list[0]).toBe('b');
  });

  test('also cleans query strings', () => {
    const req = run({ body: {}, query: { q: '<script>z</script>search' } });
    expect(req.query.q).toBe('search');
  });

  test('leaves non-string values untouched', () => {
    const req = run({ body: { n: 42, b: true, z: null }, query: {} });
    expect(req.body.n).toBe(42);
    expect(req.body.b).toBe(true);
    expect(req.body.z).toBe(null);
  });

  test('tolerates missing body/query', () => {
    expect(() => run({})).not.toThrow();
  });
});

describe('sameOrigin', () => {
  function run({ method = 'POST', origin, host = 'abc-authentic.store' } = {}) {
    const req = { method, headers: { host } };
    if (origin !== undefined) req.headers.origin = origin;
    const res = mockRes();
    const next = jest.fn();
    security.sameOrigin(req, res, next);
    return { res, next };
  }

  test('passes when no Origin header is present', () => {
    const { next } = run({ origin: undefined });
    expect(next).toHaveBeenCalled();
  });

  test('passes for GET requests even with an Origin header', () => {
    const { next } = run({ method: 'GET', origin: 'https://evil.com' });
    expect(next).toHaveBeenCalled();
  });

  test('passes when Origin host matches Host', () => {
    const { next } = run({ origin: 'https://abc-authentic.store' });
    expect(next).toHaveBeenCalled();
  });

  test('403 BAD_ORIGIN when Origin host differs', () => {
    const { res, next } = run({ origin: 'https://evil.com' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'BAD_ORIGIN' });
  });

  test('403 BAD_ORIGIN for a malformed Origin value', () => {
    const { res, next } = run({ origin: '::::not a url' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('uploadMiddleware (security fix: MIME-map check)', () => {
  function harness(getLimits) {
    const app = express();
    const upload = security.uploadMiddleware(getLimits);
    app.post('/u', upload.single('f'), (req, res) => res.json({ ok: true }));
    // map multer errors to JSON like the nid route does
    app.use((err, req, res, next) => {
      if (err && err.message === 'FILE_TYPE_NOT_ALLOWED') {
        return res.status(400).json({ error: 'FILE_TYPE_NOT_ALLOWED' });
      }
      return res.status(400).json({ error: err.code || 'UPLOAD_FAILED' });
    });
    return app;
  }

  const buf = Buffer.from('fake-bytes');

  test('accepts an allowed extension with matching MIME', async () => {
    const app = harness(() => ({ allowed: ['pdf'], max_mb: 20 }));
    await request(app).post('/u').attach('f', buf, 'doc.pdf').expect(200);
  });

  test('rejects a disallowed extension', async () => {
    const app = harness(() => ({ allowed: ['pdf'], max_mb: 20 }));
    const r = await request(app).post('/u').attach('f', buf, 'evil.exe').expect(400);
    expect(r.body.error).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  test('rejects when extension is allowed but MIME mismatches (spoofed pdf)', async () => {
    const app = harness(() => ({ allowed: ['pdf'], max_mb: 20 }));
    const r = await request(app)
      .post('/u')
      .attach('f', buf, { filename: 'spoof.pdf', contentType: 'text/plain' })
      .expect(400);
    expect(r.body.error).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  test('custom getLimits are honoured (jpg only)', async () => {
    const app = harness(() => ({ allowed: ['jpg'], max_mb: 1 }));
    await request(app)
      .post('/u')
      .attach('f', buf, { filename: 'pic.jpg', contentType: 'image/jpeg' })
      .expect(200);
    const r = await request(app).post('/u').attach('f', buf, 'doc.pdf').expect(400);
    expect(r.body.error).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  test('defaults: DEFAULT_MAX_MB=5, DEFAULT_ALLOWED pdf/jpg/jpeg/png', () => {
    expect(security.DEFAULT_MAX_MB).toBe(5);
    expect(security.DEFAULT_ALLOWED).toEqual(
      expect.arrayContaining(['pdf', 'jpg', 'jpeg', 'png'])
    );
  });
});

describe('safeLog', () => {
  let seen;
  let orig;
  beforeEach(() => {
    orig = console.log;
    seen = null;
    console.log = (...args) => { seen = args; };
  });
  afterEach(() => { console.log = orig; });

  test('redacts sensitive fields (case-insensitive, substring match)', () => {
    security.safeLog({ password: 'x', Password_Hash: 'y', otp: '1', token: 't', smtp_pass: 's', secret: 'z', name: 'rahim' });
    const logged = seen[0];
    expect(logged.password).toBe('[REDACTED]');
    expect(logged.Password_Hash).toBe('[REDACTED]');
    expect(logged.otp).toBe('[REDACTED]');
    expect(logged.token).toBe('[REDACTED]');
    expect(logged.smtp_pass).toBe('[REDACTED]');
    expect(logged.secret).toBe('[REDACTED]');
    expect(logged.name).toBe('rahim');
  });

  test('passes non-object args through unchanged', () => {
    security.safeLog('plain string', 42);
    expect(seen).toEqual(['plain string', 42]);
  });
});

describe('exported middleware bundle', () => {
  test('secureHeaders, authLimiter, apiLimiter are middleware functions', () => {
    expect(typeof security.secureHeaders).toBe('function');
    expect(typeof security.authLimiter).toBe('function');
    expect(typeof security.apiLimiter).toBe('function');
  });

  test('authLimiter keys buckets by CF-Connecting-IP (per-visitor, not global)', async () => {
    // Regression: without per-visitor keys, every visitor shared one bucket
    // (req.ip is 127.0.0.1 for all traffic behind the tunnel), so /auth/me
    // started 429-ing on innocent refreshes and the dashboard bounced to login.
    const app = express();
    app.use(security.authLimiter);
    app.get('/', (req, res) => res.json({ ok: true }));
    const agent = request(app);
    for (let i = 0; i < 60; i++) {
      await agent.get('/').set('CF-Connecting-IP', '1.2.3.4').expect(200);
    }
    await agent.get('/').set('CF-Connecting-IP', '1.2.3.4').expect(429);
    // A different visitor gets a fresh bucket
    await agent.get('/').set('CF-Connecting-IP', '5.6.7.8').expect(200);
  });
});
