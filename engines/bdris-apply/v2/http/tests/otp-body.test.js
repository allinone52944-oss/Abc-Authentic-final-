'use strict';
// DIRECT OTP BODY (2026-10-29): the direct chain's OTP send used to
// report a rejection as status-only ('OTP send returned status
// 400.'), so a 400 never said whether it meant duplicate or payload.
// These tests prove otpSend now carries the site's own reason wording
// (response-body message else code, ≤200 chars) — and nothing else
// — and that the runner carries it verbatim into the fallback reason.
// Mock fetch only; never contacts a live host. All fixture values
// are invented; no real phone, name, or application data is used.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BdrisHttpClient } = require('../client');
const { runSubmitHttpChain } = require('../../services/HttpPathRunner');

// Fake fetch Response: request() reads headers (getSetCookie/get)
// and text(); json is parsed from text by request() itself.
function stubFetch(status, bodyText) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { getSetCookie: undefined, get: () => null },
    text: async () => bodyText,
  });
}

function seededClient(fetchImpl) {
  const c = new BdrisHttpClient({ base: 'http://mock', fetchImpl });
  c.seedFromBrowser({ cookies: [], csrfToken: 'mock-csrf' });
  return c;
}

const SEND_DATA = {
  phone: 'mock-phone', email: 'mock@example.com',
  person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim' },
  father: { nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid' },
  mother: { nameBn: 'ফাতেমা', nameEn: 'Fatema' },
};

describe('otpSend error wording (DIRECT OTP BODY)', () => {
  it('non-ok with JSON {message} → thrown message contains the wording', async () => {
    const c = seededClient(stubFetch(400, JSON.stringify({
      code: 'DUPLICATE', message: 'Duplicate information not accepted', success: false, payload: null,
    })));
    await assert.rejects(
      () => c.otpSend(SEND_DATA),
      (e) => {
        assert.strictEqual(e.code, 'OTP_SEND_FAILED');
        assert.match(e.message, /OTP send returned status 400/);
        assert.match(e.message, /Duplicate information not accepted/);
        return true;
      },
    );
  });

  it('wording longer than 200 chars is truncated to ≤200 chars', async () => {
    const long = 'W'.repeat(300);
    const c = seededClient(stubFetch(400, JSON.stringify({ code: 'X', message: long })));
    await assert.rejects(
      () => c.otpSend(SEND_DATA),
      (e) => {
        const after = e.message.split('status 400: ')[1] || '';
        const wording = after.replace(/\.$/, '');
        assert.ok(wording.length <= 200, `wording length ${wording.length}`);
        assert.strictEqual(wording, 'W'.repeat(200));
        return true;
      },
    );
  });

  it('non-ok with {code} only → code is used as the wording', async () => {
    const c = seededClient(stubFetch(400, JSON.stringify({ code: 'SOME_CODE', success: false })));
    await assert.rejects(
      () => c.otpSend(SEND_DATA),
      (e) => e.message === 'OTP send returned status 400: SOME_CODE.',
    );
  });

  it('non-ok with neither message nor code → exact previous status-only message', async () => {
    const c = seededClient(stubFetch(400, JSON.stringify({ success: false, payload: null })));
    await assert.rejects(
      () => c.otpSend(SEND_DATA),
      (e) => e.message === 'OTP send returned status 400.',
    );
  });

  it('non-ok with a non-JSON body → exact previous status-only message', async () => {
    const c = seededClient(stubFetch(400, '<html>Bad Request</html>'));
    await assert.rejects(
      () => c.otpSend(SEND_DATA),
      (e) => e.message === 'OTP send returned status 400.',
    );
  });

  it('thrown message contains NONE of the other body values (only message/code)', async () => {
    const c = seededClient(stubFetch(400, JSON.stringify({
      message: 'Duplicate information not accepted',
      phone: '01999999999', applicantName: 'Secret Name Value', secretField: 'do-not-leak',
    })));
    await assert.rejects(
      () => c.otpSend(SEND_DATA),
      (e) => {
        assert.match(e.message, /Duplicate information not accepted/);
        assert.doesNotMatch(e.message, /01999999999/);
        assert.doesNotMatch(e.message, /Secret Name Value/);
        assert.doesNotMatch(e.message, /do-not-leak/);
        return true;
      },
    );
  });

  it('2xx success is unchanged: returns the JSON, never an error', async () => {
    const c = seededClient(stubFetch(200, JSON.stringify({
      code: 'MESSAGE_SENT', message: 'Message has been sent', success: true, payload: null,
    })));
    const res = await c.otpSend(SEND_DATA);
    assert.strictEqual(res.code, 'MESSAGE_SENT');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.payload, null);
  });

  it('ok response without JSON keeps the exact previous status-only message', async () => {
    const c = seededClient(stubFetch(200, '<html>not json</html>'));
    await assert.rejects(
      () => c.otpSend(SEND_DATA),
      (e) => e.message === 'OTP send returned status 200.',
    );
  });
});

describe('runner carries the wording to the fallback reason + journal', () => {
  it('send-phase 400 wording appears verbatim in httpReason and the fallback log line', async () => {
    const logs = [];
    const throwingClient = {
      bootstrapped: true,
      otpSend: async () => {
        throw Object.assign(
          new Error('OTP send returned status 400: Duplicate information not accepted.'),
          { code: 'OTP_SEND_FAILED' },
        );
      },
    };
    const addr = () => ({ division: 'X', district: 'Y', upazila: 'Z', union: 'W', ward: 'V' });
    const draft = {
      s0: { addressType: 'PERMANENT' },
      s1: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2020-01-15' },
      s2: { father: { nameBn: 'A', nameEn: 'A' }, mother: { nameBn: 'B', nameEn: 'B' } },
      s2b: { permCopy: false, presCopy: false, perm: addr(), pres: addr() },
      s3: { relation: 'FATHER', docs: [] },
      s4prep: { email: 'mock@example.com', phone: 'mock-phone' },
      docs: [],
    };
    const result = await runSubmitHttpChain({
      data: draft, phase: 'send', client: throwingClient, playwrightRunner: null,
      env: { BDRIS_HTTP_PATH: 'on' },
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.strictEqual(result.fallback, true);
    assert.match(result.httpReason, /Duplicate information not accepted/);
    assert.ok(
      logs.some((l) => l.includes('HTTP_PATH_FALLBACK') && l.includes('Duplicate information not accepted')),
      `fallback log line missing wording; logs: ${logs.join(' | ')}`,
    );
  });
});
