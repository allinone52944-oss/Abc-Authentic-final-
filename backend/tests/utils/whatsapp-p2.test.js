// P2 second sweep (2026-11-03): cancel reason, manual rejected and
// delivered-order new-file WhatsApp texts (template-first via
// dispatch, free-text fallback when the template is unapproved).
const wa = require('../../utils/whatsapp');

function stubDb() {
  return {
    query: jest.fn(async (text) => {
      if (text.includes("key = 'whatsapp'")) return { rows: [] };
      if (text.includes('FROM users WHERE id')) {
        return { rows: [{ name: 'Rahim', whatsapp: '01712345678', religion: 'islam' }] };
      }
      if (text.includes('FROM services WHERE id')) {
        return { rows: [{ name: 'Svc', name_bn: 'সেবা' }] };
      }
      return { rows: [] };
    }),
  };
}

const ENV_KEYS = ['WHATSAPP_ENABLED', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'];
let savedEnv;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'pid';
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok';
  // Template send fails (unapproved) → dispatch falls back to text,
  // whose body the tests below assert on.
  global.fetch = jest.fn(async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: 'template not approved' } }),
  }));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

function textBodies() {
  return global.fetch.mock.calls
    .map((c) => { try { return JSON.parse(c[1].body); } catch (_) { return {}; } })
    .filter((b) => b.type === 'text')
    .map((b) => b.text.body);
}

describe('P2 item 2: cancel reason in the WhatsApp text', () => {
  test('cancelReason line appears; absent reason → no কারণ line', async () => {
    await wa.notifyOrderCancelled(stubDb(), { id: 'order123456', user_id: 'u1' },
      { cancelReason: 'তথ্য ভুল ছিল', refunded: false });
    const bodies = textBodies();
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies[0]).toContain('বাতিল করা হয়েছে');
    expect(bodies[0]).toContain('কারণ: তথ্য ভুল ছিল');

    global.fetch.mockClear();
    await wa.notifyOrderCancelled(stubDb(), { id: 'order123456', user_id: 'u1' }, {});
    expect(textBodies()[0]).not.toContain('কারণ:');
  });
});

describe('P2 item 13: manual rejected WhatsApp text', () => {
  test('rejected text names the service and never claims success', async () => {
    await wa.notifyServiceRejected(stubDb(), 'u1', 'ম্যানুয়াল সেবা');
    const bodies = textBodies();
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies[0]).toContain('ম্যানুয়াল সেবা');
    expect(bodies[0]).toContain('সম্পন্ন করা যায়নি');
    expect(bodies[0]).not.toContain('সফলভাবে সম্পন্ন');
  });
});

describe('P2 item 6: new file on a delivered order', () => {
  test('file-added text is its own message, not a second delivered claim', async () => {
    await wa.notifyDeliveryFileAdded(stubDb(),
      { id: 'order123456', user_id: 'u1', service_id: 's1' });
    const bodies = textBodies();
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies[0]).toContain('নতুন ডেলিভারি ফাইল');
    expect(bodies[0]).toContain('ইতিহাস (History)');
    expect(bodies[0]).not.toContain('ডেলিভার্ড হয়েছে');
  });
});
