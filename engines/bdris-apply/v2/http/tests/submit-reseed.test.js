/**
 * Submit reseed (2026-10-30): session-freshness for the submit POST.
 * The 7th live submit proved headers + field set make zero
 * difference (byte-identical shell), so the remaining session-side
 * difference is freshness: the chain's seed carries the warm page's
 * navigation-time cookies, and the jar never dropped expired ones.
 * Proves, with fakes only (no browser, no OTP, no live run):
 *  - Set-Cookie from a verify-like response reaches the next request
 *  - expired cookies (Playwright expires / Max-Age=0 / past Expires)
 *    are never stored and never sent
 *  - refreshSeed keeps API-response cookies over stale page values,
 *    adds page-only cookies, and always adopts the page CSRF
 *  - the runner's pre-submit reseed runs (or logs its skip) without
 *    ever failing the submit on a missing warm page
 *  - alreadyVerified skips verifyOtp but keeps otp in the submit
 *    payload; a first attempt always verifies
 *  - a shell response under the new path still throws
 *    SUBMIT_NOT_SUCCESS, never a false success
 * Run: node --test engines/bdris-apply/v2/http/tests/submit-reseed.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

const { BdrisHttpClient, buildSubmitPayload } = require('../client');
const { runHttpChain, normalizeChainInput } = require('../../services/HttpPathRunner');

const NOW = Date.now();
const PAST_S = Math.floor((NOW - 60000) / 1000); // expired 1 min ago
const FUTURE_S = Math.floor((NOW + 3600000) / 1000); // live 1 hour

function headersStub(setCookie) {
  return {
    getSetCookie: () => (setCookie === undefined ? [] : (Array.isArray(setCookie) ? setCookie : [setCookie])),
    get: () => null,
  };
}

function okResponse({ setCookie, text = '{}' } = {}) {
  return { status: 200, ok: true, headers: headersStub(setCookie), text: async () => text };
}

describe('expiry-aware cookie jar', () => {
  it('drops Playwright cookies already expired at seed time, keeps session + live ones', () => {
    const client = new BdrisHttpClient({ base: 'http://mock' });
    client.seedFromBrowser({
      cookies: [
        { name: 'dead', value: 'old', expires: PAST_S },
        { name: 'live', value: 'v1', expires: FUTURE_S },
        { name: 'sess', value: 'v2', expires: -1 },
      ],
      csrfToken: 'tok',
    });
    const h = client.apiHeaders();
    assert.equal(h.Cookie.includes('dead='), false, 'expired cookie must never be sent');
    assert.equal(h.Cookie.includes('live=v1'), true);
    assert.equal(h.Cookie.includes('sess=v2'), true);
  });

  it('applies Set-Cookie from a response to the next request', async () => {
    const seen = [];
    const client = new BdrisHttpClient({
      base: 'http://mock',
      fetchImpl: async (url, opts) => {
        seen.push(opts.headers || {});
        if (url.includes('/api/otp/verify')) {
          return okResponse({ setCookie: 'verified-session=abc123; Path=/; HttpOnly', text: '{"isVerified":true}' });
        }
        return okResponse({ text: '{}' });
      },
    });
    client.seedFromBrowser({ cookies: [{ name: 'seed', value: 's1', expires: -1 }], csrfToken: 'tok' });
    await client.verifyOtp({ otp: '123456', phone: 'x', applicantName: 'y' });
    await client.request('/br/application', { method: 'GET', headers: client.apiHeaders() });
    const cookieHeader = seen[1].Cookie || '';
    assert.equal(cookieHeader.includes('verified-session=abc123'), true, 'verify rotation must ride the next request');
    assert.equal(cookieHeader.includes('seed=s1'), true, 'seed cookies are kept');
  });

  it('Max-Age=0 deletes, past Expires is never sent', async () => {
    const client = new BdrisHttpClient({ base: 'http://mock' });
    client.seedFromBrowser({ cookies: [{ name: 'gone', value: 'v', expires: -1 }], csrfToken: 'tok' });
    client.jar.updateFromSetCookie('gone=; Max-Age=0; Path=/');
    assert.equal(client.jar.get('gone'), undefined);
    client.jar.updateFromSetCookie('old=stale; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/');
    assert.equal((client.apiHeaders().Cookie || '').includes('old='), false);
  });

  it('a short-lived cookie set by a response expires before a later send', () => {
    const client = new BdrisHttpClient({ base: 'http://mock' });
    client.seedFromBrowser({ cookies: [], csrfToken: 'tok' });
    client.jar.updateFromSetCookie('short=lived; Max-Age=1; Path=/');
    assert.equal((client.apiHeaders().Cookie || '').includes('short=lived'), true);
    // Pretend time passed: rewrite the entry as expired and confirm it is dropped.
    client.jar.expiry.set('short', Date.now() - 1);
    assert.equal((client.apiHeaders().Cookie || '').includes('short='), false);
  });
});

describe('refreshSeed provenance', () => {
  it('keeps API-response cookies over stale page values, adds page-only cookies, adopts page CSRF', () => {
    const client = new BdrisHttpClient({ base: 'http://mock' });
    client.seedFromBrowser({ cookies: [{ name: 'page-only', value: 'p0', expires: -1 }], csrfToken: 'old-csrf' });
    client.jar.updateFromSetCookie('rotated=new-value; Path=/'); // API response: fresher
    const out = client.refreshSeed({
      cookies: [
        { name: 'rotated', value: 'stale-page-value', expires: -1 },
        { name: 'page-only', value: 'p1', expires: -1 },
        { name: 'dead-page', value: 'x', expires: PAST_S },
      ],
      csrfToken: 'fresh-csrf',
    });
    assert.equal(out.refreshed, true);
    assert.equal(client.jar.get('rotated'), 'new-value', 'API-response cookie must win over the page');
    assert.equal(client.jar.get('page-only'), 'p1', 'page cookie fills/refreshes a non-response name');
    assert.equal(client.jar.get('dead-page'), undefined, 'expired page cookie dropped');
    assert.equal(client.csrfToken, 'fresh-csrf', 'page CSRF always adopted');
  });

  it('refreshSeed without a token keeps the existing CSRF', () => {
    const client = new BdrisHttpClient({ base: 'http://mock' });
    client.seedFromBrowser({ cookies: [], csrfToken: 'keep-me' });
    client.refreshSeed({ cookies: [] });
    assert.equal(client.csrfToken, 'keep-me');
  });
});

function fullApplication(overrides = {}) {
  const addr = {
    country: 'বাংলাদেশ', division: 'ঢাকা', district: 'ঢাকা',
    cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', paurasavaUnion: 'অঞ্চল - ১',
    ward: 'ওয়ার্ড - ৬', postOfficeBn: 'ঢাকা', postOfficeEn: 'Dhaka',
    villageBn: 'মহল্লা', villageEn: 'Moholla', houseRoadBn: 'বাসা ১', houseRoadEn: 'House 1',
  };
  return {
    person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
    father: { id: '123', brn: '', dob: '1990-05-01', nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid', nationality: 'বাংলাদেশী' },
    mother: { id: '456', brn: '', dob: '1992-03-01', nameBn: 'ফাতেমা', nameEn: 'Fatema', nationality: 'বাংলাদেশী' },
    birthPlace: addr, permAddr: addr, prsntAddr: addr,
    relation: 'FATHER', declaration: true, email: 'mock@example.com', phone: 'mock-phone',
    otp: '123456',
    documents: [{ attachmentType: 40, id: 'doc-40' }, { attachmentType: 41, id: 'doc-41' }],
    ...overrides,
  };
}

function validChargeToken(userId, secret, ref) {
  const head = `v1.${userId}.submit.${ref}.${Date.now()}`;
  const mac = nodeCrypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

function fakeRunnerClient(calls) {
  return {
    bootstrapped: true,
    csrfToken: 'mock-csrf',
    jar: { headerValue: () => '' },
    refreshSeed: (input) => { calls.refreshed = input; return { cookies: 1, refreshed: true }; },
    otpSend: async () => { calls.send = (calls.send || 0) + 1; return { success: true, code: 'MESSAGE_SENT' }; },
    verifyOtp: async () => { calls.verify = (calls.verify || 0) + 1; return { isVerified: true }; },
    submitApplication: async (input) => {
      calls.submit = (calls.submit || 0) + 1;
      calls.submitInput = input;
      return { success: true, hasPrintLink: false };
    },
  };
}

function fakeWarmPage() {
  return {
    context: () => ({ cookies: async () => [{ name: 'warm', value: 'w1', expires: -1 }] }),
    evaluate: async () => ({ token: 'warm-csrf', headerName: 'X-CSRF-TOKEN' }),
  };
}

let tokenCounter = 0;

describe('runner: skip-verify retry + pre-submit reseed', () => {
  async function runSubmit(data, opts = {}) {
    const calls = {};
    const client = fakeRunnerClient(calls);
    const out = await runHttpChain({
      data: { ...fullApplication(), _chargeToken: validChargeToken('u1', 's3cret', `reseed${Date.now()}${tokenCounter++}`), ...data },
      userId: 'u1', secret: 's3cret', client, phase: 'submit',
      log: () => {}, emit: () => {},
      ...opts,
    });
    return { out, calls, client };
  }

  it('alreadyVerified skips verifyOtp but keeps otp in the submit payload', async () => {
    const { out, calls } = await runSubmit({ alreadyVerified: true });
    assert.equal(out.ok, true);
    assert.equal(calls.verify || 0, 0, 'a consumed code must never be re-verified');
    assert.equal(calls.submit, 1);
    assert.equal(calls.submitInput.otp, '123456', 'otp still rides in the submit payload');
    assert.ok(out.steps.includes('verify-skipped'));
  });

  it('a first attempt always verifies', async () => {
    const { out, calls } = await runSubmit({});
    assert.equal(out.ok, true);
    assert.equal(calls.verify, 1);
    assert.equal(calls.submit, 1);
    assert.ok(out.steps.includes('verify'));
  });

  it('normalizeChainInput carries alreadyVerified only when explicitly true', () => {
    assert.equal(normalizeChainInput({ alreadyVerified: true }).alreadyVerified, true);
    assert.equal(normalizeChainInput({}).alreadyVerified, false);
    assert.equal(normalizeChainInput({ alreadyVerified: 'yes' }).alreadyVerified, false);
  });

  it('reseed runs before submit from the live warm page without failing the chain', async () => {
    const { out, calls } = await runSubmit({}, { reseedPage: fakeWarmPage() });
    assert.equal(out.ok, true);
    assert.equal(calls.submit, 1);
    assert.equal(calls.refreshed.csrfToken, 'warm-csrf', 'reseed must refresh the client from the page');
  });

  it('a missing warm page only logs the skip — the submit still proceeds', async () => {
    const { out, calls } = await runSubmit({}, {});
    assert.equal(out.ok, true, 'never fail the submit on a missing warm page');
    assert.equal(calls.submit, 1);
    assert.equal(calls.refreshed, undefined);
  });
});

describe('shell safety under the new path', () => {
  it('a shell response still throws SUBMIT_NOT_SUCCESS, never a false success', async () => {
    const client = new BdrisHttpClient({ base: 'http://mock' });
    client.bootstrapped = true;
    client.csrfToken = 'mock-csrf';
    client.request = async () => ({
      status: 200, ok: true, json: null,
      text: '<html><form><input name="personInfoForBirth"></form></html>',
      headers: { get: () => null },
    });
    await assert.rejects(
      client.submitApplication(fullApplication()),
      (e) => e.code === 'SUBMIT_NOT_SUCCESS',
    );
  });

  it('buildSubmitPayload is untouched by the reseed work', () => {
    const p = buildSubmitPayload(fullApplication());
    assert.equal(typeof p, 'object');
    assert.ok(Object.keys(p).length > 90);
  });
});
