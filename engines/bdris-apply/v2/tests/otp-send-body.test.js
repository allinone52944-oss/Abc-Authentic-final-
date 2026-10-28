/**
 * OTP-SEND-BODY (2026-10-28) — live 2026-10-28 the site answered
 * /api/otp/sent with HTTP 400 four times, and the status alone could not
 * say WHY: the site's reason lives only in the response body. The tap
 * therefore keeps, for a non-2xx ONLY, the body's error wording: the
 * known send shape { code, message, success, payload } contributes
 * message (else code) as a plain string, truncated; the payload field
 * is never read, the request query (phone number) is never logged, and
 * the full body is never kept. 2xx responses are never body-read.
 * No live contact, no browser, no personal data. Fixture values only.
 * Run: node --test engines/bdris-apply/v2/tests/otp-send-body.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { StepHandler } = require('../services/StepHandler');

function fakePage() {
  const handlers = new Map();
  return {
    on: (ev, fn) => {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev).add(fn);
    },
    off: (ev, fn) => {
      if (handlers.has(ev)) handlers.get(ev).delete(fn);
    },
    emit: (ev, arg) => {
      for (const fn of (handlers.get(ev) || [])) fn(arg);
    },
  };
}

const handler = (page) => new StepHandler({ page });
const tick = () => new Promise((r) => setImmediate(r));
const fakeRes = (url, status, body) => ({
  url: () => url,
  status: () => status,
  text: async () => body,
});

describe('OTP-SEND-BODY extraction', () => {
  const h = handler(fakePage());

  it('takes message from a JSON send-error body', () => {
    assert.equal(
      h._otpSendBodyMsg(JSON.stringify({ code: 'BAD_REQUEST', message: 'Too many requests', success: false, payload: null })),
      'Too many requests');
  });

  it('falls back to code when message is absent', () => {
    assert.equal(
      h._otpSendBodyMsg(JSON.stringify({ code: 'VALIDATION_FAILED', success: false })),
      'VALIDATION_FAILED');
  });

  it('ignores a JSON body with neither message nor code (payload never read)', () => {
    assert.equal(
      h._otpSendBodyMsg(JSON.stringify({ success: false, payload: { secret: 'must-not-leak' } })),
      '');
    assert.ok(!h._otpSendBodyMsg(JSON.stringify({ success: false, payload: { secret: 'must-not-leak' } })).includes('must-not-leak'));
  });

  it('keeps plain-text bodies, whitespace-collapsed', () => {
    assert.equal(h._otpSendBodyMsg('  Bad\n  request  '), 'Bad request');
  });

  it('truncates long messages to 200 chars', () => {
    const msg = h._otpSendBodyMsg(JSON.stringify({ message: 'x'.repeat(500) }));
    assert.equal(msg.length, 200);
  });

  it('returns empty for empty, non-string, or non-object JSON input', () => {
    assert.equal(h._otpSendBodyMsg(''), '');
    assert.equal(h._otpSendBodyMsg(null), '');
    assert.equal(h._otpSendBodyMsg(JSON.stringify(42)), '');
  });
});

describe('OTP-SEND-BODY tap', () => {
  it('attaches msg to a non-2xx otp entry, query still stripped', async () => {
    const page = fakePage();
    const h = handler(page);
    const net = h._tapOtpSendNet();
    page.emit('response', fakeRes('https://bdris.gov.bd/api/otp/sent?phone=01000000000&officeId=0', 400,
      JSON.stringify({ code: 'BAD_REQUEST', message: 'Too many requests', success: false, payload: null })));
    await tick();
    assert.deepEqual(net.seen, [{ path: '/api/otp/sent', status: 400, msg: 'Too many requests' }]);
    assert.ok(!JSON.stringify(net.seen).includes('01000000000'), 'phone number must never be recorded');
    net.detach();
  });

  it('never reads the body for a 2xx response', async () => {
    const page = fakePage();
    const h = handler(page);
    const net = h._tapOtpSendNet();
    let calls = 0;
    page.emit('response', {
      url: () => 'https://bdris.gov.bd/api/otp/sent',
      status: () => 200,
      text: async () => { calls++; return 'should-not-be-read'; },
    });
    await tick();
    assert.equal(calls, 0);
    assert.deepEqual(net.seen, [{ path: '/api/otp/sent', status: 200 }]);
    net.detach();
  });

  it('a throwing body read leaves path + status intact', async () => {
    const page = fakePage();
    const h = handler(page);
    const net = h._tapOtpSendNet();
    page.emit('response', {
      url: () => 'https://bdris.gov.bd/api/otp/sent',
      status: () => 400,
      text: async () => { throw new Error('body gone'); },
    });
    await tick();
    assert.deepEqual(net.seen, [{ path: '/api/otp/sent', status: 400 }]);
    net.detach();
  });
});

describe('OTP-SEND-BODY failure reason', () => {
  const ev = 'সাইট কোড পাঠানোর নিশ্চিত প্রমাণ দেয়নি — নম্বর দেখে আবার চেষ্টা করুন';
  it('names the site message with the status when captured', () => {
    const h = handler(fakePage());
    const reason = h._otpSendFailReason([{ path: '/api/otp/sent', status: 400, msg: 'Too many requests' }], ev);
    assert.ok(reason.includes('400'), 'status must be named');
    assert.ok(reason.includes('Too many requests'), 'site message must be named');
  });

  it('keeps the old status + evidence-reason form when no message was captured', () => {
    const h = handler(fakePage());
    const reason = h._otpSendFailReason([{ path: '/api/otp/sent', status: 400 }], ev);
    assert.ok(reason.includes('400'), 'status must be named');
    assert.ok(reason.includes(ev), 'evidence reason must be kept');
  });
});
