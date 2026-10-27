/**
 * OTP-SEND-NET (2026-10-28) — the site can fail an OTP send SILENTLY:
 * click ok, no toast, no countdown, button still visible (5× live
 * 2026-10-28). The S4_PREP send is therefore wrapped in a one-shot
 * network tap. These tests pin the tap + the failure-reason mapping:
 * only path + status are ever recorded (the query carries the phone
 * number and must never be logged), non-otp responses are ignored,
 * detach stops recording, and the user-facing reason names a non-2xx
 * send status or the total absence of a send request.
 * No live contact, no browser, no personal data. Fixture values only.
 * Run: node --test engines/bdris-apply/v2/tests/otp-send-net.test.js
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

const fakeRes = (url, status) => ({ url: () => url, status: () => status });
const handler = (page) => new StepHandler({ page });

describe('OTP-SEND-NET tap', () => {
  it('records an otp response as path + status, query stripped', () => {
    const page = fakePage();
    const h = handler(page);
    const net = h._tapOtpSendNet();
    page.emit('response', fakeRes('https://bdris.gov.bd/api/otp/sent?phone=01000000000&officeId=0', 200));
    assert.deepEqual(net.seen, [{ path: '/api/otp/sent', status: 200 }]);
    assert.ok(!JSON.stringify(net.seen).includes('01000000000'), 'phone number must never be recorded');
    net.detach();
  });

  it('ignores non-otp responses', () => {
    const page = fakePage();
    const h = handler(page);
    const net = h._tapOtpSendNet();
    page.emit('response', fakeRes('https://bdris.gov.bd/api/geo/divisions', 200));
    page.emit('response', fakeRes('https://bdris.gov.bd/br/application', 200));
    assert.deepEqual(net.seen, []);
    net.detach();
  });

  it('ignores responses whose URL cannot be parsed', () => {
    const page = fakePage();
    const h = handler(page);
    const net = h._tapOtpSendNet();
    page.emit('response', { url: () => { throw new Error('bad url'); }, status: () => 500 });
    assert.deepEqual(net.seen, []);
    net.detach();
  });

  it('detach stops recording', () => {
    const page = fakePage();
    const h = handler(page);
    const net = h._tapOtpSendNet();
    page.emit('response', fakeRes('https://bdris.gov.bd/api/otp/sent', 200));
    net.detach();
    page.emit('response', fakeRes('https://bdris.gov.bd/api/otp/sent', 400));
    assert.deepEqual(net.seen, [{ path: '/api/otp/sent', status: 200 }]);
  });

  it('is a no-op on pages without on/off', () => {
    const h = handler({});
    const net = h._tapOtpSendNet();
    assert.deepEqual(net.seen, []);
    assert.doesNotThrow(() => net.detach());
  });
});

describe('OTP-SEND-NET failure reason', () => {
  const ev = 'সাইট কোড পাঠানোর নিশ্চিত প্রমাণ দেয়নি — নম্বর দেখে আবার চেষ্টা করুন';
  it('names a non-2xx send status', () => {
    const h = handler(fakePage());
    const reason = h._otpSendFailReason([{ path: '/api/otp/sent', status: 400 }], ev);
    assert.ok(reason.includes('400'), 'status must be named');
    assert.ok(reason.includes(ev), 'evidence reason must be kept');
  });

  it('says plainly when no send request was seen', () => {
    const h = handler(fakePage());
    const reason = h._otpSendFailReason([], ev);
    assert.ok(reason.includes('কোনো সেন্ড-রিকোয়েস্টই পাঠায়নি'), 'absence must be named');
    assert.ok(reason.includes(ev), 'evidence reason must be kept');
  });

  it('keeps the evidence reason when the send looked fine', () => {
    const h = handler(fakePage());
    assert.equal(h._otpSendFailReason([{ path: '/api/otp/sent', status: 200 }], ev), ev);
  });
});
