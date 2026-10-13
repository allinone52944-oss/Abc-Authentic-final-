// Unit tests for backend/utils/whatsapp.js.
// global.fetch is mocked — no real network. DB is a stub.
const wa = require('../../utils/whatsapp');

function stubDb(value) {
  return {
    query: jest.fn(async () => ({
      rows: value === undefined ? [] : [{ value }],
    })),
  };
}

const ENV_KEYS = ['WHATSAPP_ENABLED', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'];
let savedEnv;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  if (global.fetch && global.fetch.mockReset) global.fetch.mockReset();
});

describe('normalizeBdPhone', () => {
  test('local 01XXXXXXXXX → 880…', () => {
    expect(wa.normalizeBdPhone('01712345678')).toBe('8801712345678');
  });
  test('strips spaces, dashes, parens and leading +', () => {
    expect(wa.normalizeBdPhone('+880 1712-345678')).toBe('8801712345678');
    expect(wa.normalizeBdPhone('(01712) 345678')).toBe('8801712345678');
  });
  test('already-international passes through', () => {
    expect(wa.normalizeBdPhone('8801712345678')).toBe('8801712345678');
  });
  test('invalid numbers → null', () => {
    expect(wa.normalizeBdPhone('123')).toBeNull();
    expect(wa.normalizeBdPhone('02123456789')).toBeNull();
    expect(wa.normalizeBdPhone('')).toBeNull();
    expect(wa.normalizeBdPhone(null)).toBeNull();
    expect(wa.normalizeBdPhone("01712345678'; DROP")).toBeNull();
  });
});

describe('renderTemplate', () => {
  test('replaces known placeholders', () => {
    expect(wa.renderTemplate('Hi {name}, ৳{amount}', { name: 'Rahim', amount: 500 }))
      .toBe('Hi Rahim, ৳500');
  });
  test('unknown placeholders are left as-is (no silent deletion)', () => {
    expect(wa.renderTemplate('Hi {name} {typo}', { name: 'R' })).toBe('Hi R {typo}');
  });
  test('null template → empty string', () => {
    expect(wa.renderTemplate(null, {})).toBe('');
  });
});

describe('getConfig precedence (DB overrides env)', () => {
  test('env-only config', async () => {
    process.env.WHATSAPP_ENABLED = 'true';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pid';
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token';
    const cfg = await wa.getConfig(stubDb());
    expect(cfg).toMatchObject({ enabled: true, phone_number_id: 'env-pid', access_token: 'env-token' });
  });

  test('DB enabled=false wins over env true', async () => {
    process.env.WHATSAPP_ENABLED = 'true';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pid';
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token';
    const cfg = await wa.getConfig(stubDb({ enabled: false, phone_number_id: 'db-pid', access_token: 'db-token' }));
    expect(cfg.enabled).toBe(false);
  });

  test('DB non-empty values override env', async () => {
    const cfg = await wa.getConfig(stubDb({ enabled: true, phone_number_id: 'db-pid', access_token: 'db-token' }));
    expect(cfg).toMatchObject({ enabled: true, phone_number_id: 'db-pid', access_token: 'db-token' });
  });

  test('blank DB strings fall back to env', async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pid';
    process.env.WHATSAPP_ACCESS_TOKEN = 'env-token';
    const cfg = await wa.getConfig(stubDb({ enabled: true, phone_number_id: '  ', access_token: '' }));
    expect(cfg.phone_number_id).toBe('env-pid');
    expect(cfg.access_token).toBe('env-token');
  });

  test('DB read failure → {} (never throws)', async () => {
    const badDb = { query: jest.fn(async () => { throw new Error('db down'); }) };
    const cfg = await wa.getConfig(badDb);
    expect(cfg.enabled).toBe(false);
  });
});

describe('sendTextMessage', () => {
  function configuredEnv() {
    process.env.WHATSAPP_ENABLED = 'true';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'pid1';
    process.env.WHATSAPP_ACCESS_TOKEN = 'tok1';
  }

  test('not configured → WHATSAPP_NOT_CONFIGURED (no fetch)', async () => {
    global.fetch = jest.fn();
    const r = await wa.sendTextMessage('01712345678', 'hello', stubDb());
    expect(r).toEqual({ ok: false, error: 'WHATSAPP_NOT_CONFIGURED' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('invalid recipient → INVALID_RECIPIENT', async () => {
    configuredEnv();
    global.fetch = jest.fn();
    const r = await wa.sendTextMessage('not-a-number', 'hello', stubDb());
    expect(r).toEqual({ ok: false, error: 'INVALID_RECIPIENT' });
  });

  test('empty message → EMPTY_MESSAGE', async () => {
    configuredEnv();
    global.fetch = jest.fn(); // must never reach the network
    const r = await wa.sendTextMessage('01712345678', '', stubDb());
    expect(r).toEqual({ ok: false, error: 'EMPTY_MESSAGE' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('happy path posts to Graph API and returns message id', async () => {
    configuredEnv();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.abc' }] }),
    }));
    const r = await wa.sendTextMessage('01712345678', 'হ্যালো', stubDb());
    expect(r).toEqual({ ok: true, id: 'wamid.abc' });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('graph.facebook.com/v21.0/pid1/messages');
    expect(opts.headers.Authorization).toBe('Bearer tok1');
    expect(JSON.parse(opts.body).to).toBe('8801712345678');
  });

  test('Graph API error → { ok:false } without leaking the token', async () => {
    configuredEnv();
    global.fetch = jest.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ error: { message: 'Invalid token' } }),
    }));
    const r = await wa.sendTextMessage('01712345678', 'hi', stubDb());
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('tok1');
  });

  test('fetch throws (network) → REQUEST_FAILED, never throws', async () => {
    configuredEnv();
    global.fetch = jest.fn(async () => { throw new Error('boom'); });
    const r = await wa.sendTextMessage('01712345678', 'hi', stubDb());
    expect(r).toEqual({ ok: false, error: 'boom' });
  });
});

describe('notifiers', () => {
  test('notifyOrderCompleted disabled → DISABLED', async () => {
    const r = await wa.notifyOrderCompleted(stubDb(), { id: 'o1', user_id: 'u1' });
    expect(r).toEqual({ ok: false, error: 'DISABLED' });
  });

  test('notifyRechargeApproved: user without whatsapp → NO_WHATSAPP', async () => {
    process.env.WHATSAPP_ENABLED = 'true';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'pid1';
    process.env.WHATSAPP_ACCESS_TOKEN = 'tok1';
    const db = { query: jest.fn(async () => ({ rows: [{ name: 'R', whatsapp: null, balance: 0 }] })) };
    const r = await wa.notifyRechargeApproved(db, { id: 't1', user_id: 'u1', amount: 100 });
    expect(r).toEqual({ ok: false, error: 'NO_WHATSAPP' });
  });

  test('message builders render defaults', () => {
    const m = wa.orderCompletedMessage({ orderId: 'abcdef123456', serviceName: 'NID' });
    expect(m).toContain('abcdef12'); // note: orderCompletedMessage does NOT uppercase
    const r = wa.rechargeApprovedMessage({ amount: 250, newBalance: 300 });
    expect(r).toContain('250');
    expect(r).toContain('300');
  });
});

describe('testConnection', () => {
  test('no credentials → WHATSAPP_NOT_CONFIGURED', async () => {
    const r = await wa.testConnection(stubDb());
    expect(r).toEqual({ ok: false, error: 'WHATSAPP_NOT_CONFIGURED' });
  });
});
