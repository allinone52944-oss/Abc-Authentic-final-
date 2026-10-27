/**
 * Gate wiring fix (2026-10-27): a session-seeded HTTP client must
 * NOT be re-bootstrapped, and the charge gate must still run first.
 * Fake client / mock data only — no live bdris.gov.bd contact, no
 * browser, no personal data.
 * Run: node --test engines/bdris-apply/v2/tests/http-seeded-skip.test.js
 * (from engines/bdris-apply/)
 *
 * Why: the gate audit found two gaps. (1) SUBMIT_HTTP_CHAIN built
 * a bare client (no seeded client passed). (2) runHttpChain called
 * client.bootstrap() unconditionally, so even a seeded client got
 * a bare-fetch form GET — proven blocked with 403. Fix: skip the
 * bootstrap step when client.bootstrapped is true (seedFromBrowser
 * sets it), and pass a session-seeded client from the handler.
 * These tests pin the runner half: seeded skips bootstrap and
 * completes, unseeded still bootstraps, and a bad charge token
 * still blocks before any bootstrap attempt.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

const { runHttpChain } = require('../services/HttpPathRunner');

function validChargeToken(userId, secret, ref = 'ref-1') {
  const head = `v1.${userId}.submit.${ref}.${Date.now()}`;
  const mac = nodeCrypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

function fakeClient({ seeded = false, bootstrapThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    bootstrapped: seeded,
    async bootstrap() {
      calls.push('bootstrap');
      if (bootstrapThrows) throw new Error('bootstrap must not run for a seeded client');
    },
    async walkGeoChain() { calls.push('geo'); return [{ id: '1' }]; },
    async uploadDocument({ attachmentType }) {
      calls.push('upload');
      return { attachmentType, attachmentTypeId: attachmentType, url: 'http://x/doc', id: 'u' };
    },
    async otpSend() { calls.push('otp-send'); return {}; },
    async verifyOtp() { calls.push('verify'); return {}; },
    async submitApplication() { calls.push('submit'); return { hasPrintLink: true }; },
  };
}

function chainInput(overrides = {}) {
  const b64 = Buffer.from('fake-jpeg-bytes').toString('base64');
  return {
    _chargeToken: validChargeToken('user-1', 'test-secret'),
    docs: [
      { name: 'doc40.jpg', mimeType: 'image/jpeg', base64: b64, docType: '40' },
      { name: 'doc41.jpg', mimeType: 'image/jpeg', base64: b64, docType: '41' },
    ],
    geoChain: { firstParentId: '1', firstGeoOrder: 1, steps: [{ geoType: 1, nameBn: 'ঢাকা' }] },
    ...overrides,
  };
}

describe('Gate fix: seeded client skips bootstrap', () => {
  it('seeded client completes the chain without calling bootstrap', async () => {
    const logs = [];
    const client = fakeClient({ seeded: true, bootstrapThrows: true });
    const out = await runHttpChain({
      data: chainInput(),
      userId: 'user-1',
      secret: 'test-secret',
      client,
      playwrightRunner: async () => { throw new Error('fallback must not run on success'); },
      log: (m) => logs.push(String(m)),
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.path, 'http');
    assert.ok(!client.calls.includes('bootstrap'), 'bootstrap must not run for a seeded client');
    assert.deepStrictEqual(out.steps, ['geo', 'upload', 'otp-send', 'verify', 'submit']);
    assert.ok(logs.some((l) => l.includes('skipped — client already seeded')));
  });

  it('unseeded client still bootstraps (old behaviour preserved)', async () => {
    const client = fakeClient({ seeded: false });
    const out = await runHttpChain({
      data: chainInput(),
      userId: 'user-1',
      secret: 'test-secret',
      client,
      playwrightRunner: async () => { throw new Error('fallback must not run on success'); },
      log: () => {},
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(client.calls[0], 'bootstrap');
    assert.strictEqual(out.steps[0], 'bootstrap');
  });

  it('charge gate still blocks before any bootstrap attempt', async () => {
    const client = fakeClient({ seeded: true, bootstrapThrows: true });
    const out = await runHttpChain({
      data: chainInput({ _chargeToken: 'v1.user-1.submit.ref-1.1.deadbeef' }),
      userId: 'user-1',
      secret: 'test-secret',
      client,
      log: () => {},
    });
    assert.strictEqual(out.error, 'CHARGE_REQUIRED');
    assert.ok(!client.calls.includes('bootstrap'), 'gate must run before bootstrap');
  });
});
