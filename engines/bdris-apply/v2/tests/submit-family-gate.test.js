/**
 * Family/180-days retry gate (2026-10-30 principled fix) — chain level.
 * The old family branch retried on ANY error carrying a code plus the
 * [family: 180-days] tag, and the tag itself came from a bare /180/
 * scan of the whole response body — so a 200 shell that merely
 * contained "180" anywhere could trigger a second POST on an
 * outcome-unknown response (a double-file hazard). The fix gates
 * the retry on BOTH: isFallbackSafe('submit', e) (a definitive
 * rejection only — a 200 non-JSON shell never qualifies) AND the
 * tag, which is now set only from the server's explicit error
 * wording. These tests drive the real runHttpChain with a fake
 * client (no browser, no network, no real submit).
 * Run: node --test engines/bdris-apply/v2/tests/submit-family-gate.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

const { runHttpChain } = require('../services/HttpPathRunner');
const { DIRECT_FAMILY_NOTE } = require('../http/client');

function validChargeToken(userId, secret, ref) {
  const head = `v1.${userId}.submit.${ref}.${Date.now()}`;
  const mac = nodeCrypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

function runnerData(ref) {
  return {
    person: { dob: '2020-01-15', brn: '' },
    birthPlace: { wardId: '7193', paurasavaUnionId: '1988' },
    permAddr: { paurasavaUnionId: '1988' },
    relation: 'SELF', applicantName: 'Test', phone: '01000000000',
    officeAddressType: 'PERMANENT',
    documents: [
      { attachmentType: 40, attachmentTypeId: 40, url: '/admin/doc/40', id: 40 },
      { attachmentType: 41, attachmentTypeId: 41, url: '/admin/doc/41', id: 41 },
    ],
    otp: '123456',
    _chargeToken: validChargeToken('user-1', 'test-secret', ref),
  };
}

function baseClient(submitApplication) {
  return {
    bootstrapped: true,
    otpSend: async () => ({ code: 'MESSAGE_SENT', success: true, payload: null }),
    verifyOtp: async () => ({ isVerified: true }),
    submitApplication,
  };
}

describe('family retry gate (isFallbackSafe + strict tag)', () => {
  it('does NOT retry a shell response even when the tag is present (outcome-unknown, single POST)', async () => {
    let calls = 0;
    const shellErr = new Error('Submit response contains neither success:true JSON nor the verified success phrase. [family: 180-days]');
    shellErr.code = 'SUBMIT_NOT_SUCCESS';
    // The live shell shape: 200, non-JSON, no explicit JSON failure.
    shellErr.responseSummary = { status: 200, json: false, jsonSuccess: false, jsonExplicitFailure: false, textLen: 118673, formFields: true, successPhrase: false };
    const out = await runHttpChain({
      data: runnerData('ref-fgate-1'), userId: 'user-1', secret: 'test-secret',
      client: baseClient(async () => { calls += 1; throw shellErr; }),
      log: () => {},
    });
    assert.strictEqual(calls, 1, 'a shell must never be retried, tag or not');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'SUBMIT_OUTCOME_UNKNOWN');
  });

  it('does NOT retry a shell response whose summary lacks jsonExplicitFailure (the exact live shape)', async () => {
    let calls = 0;
    const shellErr = new Error('Submit response contains neither success:true JSON nor the verified success phrase. [family: 180-days]');
    shellErr.code = 'SUBMIT_NOT_SUCCESS';
    shellErr.responseSummary = { status: 200, textLen: 118673 };
    const out = await runHttpChain({
      data: runnerData('ref-fgate-2'), userId: 'user-1', secret: 'test-secret',
      client: baseClient(async () => { calls += 1; throw shellErr; }),
      log: () => {},
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(out.error, 'SUBMIT_OUTCOME_UNKNOWN');
  });

  it('retries ONCE names-only on a definitive rejection carrying the family tag', async () => {
    const seen = [];
    const familyErr = new Error('Submit returned status 400: [family: 180-days].');
    familyErr.code = 'SUBMIT_BAD_RESPONSE';
    familyErr.responseSummary = { status: 400 };
    const out = await runHttpChain({
      data: runnerData('ref-fgate-3'), userId: 'user-1', secret: 'test-secret',
      client: baseClient(async (input) => {
        seen.push(input);
        if (seen.length === 1) throw familyErr;
        return { hasPrintLink: false };
      }),
      log: () => {},
    });
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[1]._familyNamesOnly, true);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.familyNamesOnly, true);
    assert.strictEqual(out.familyNote, DIRECT_FAMILY_NOTE);
  });

  it('retries on a 200 JSON explicit failure carrying the family tag', async () => {
    const seen = [];
    const familyErr = new Error('Submit JSON failure: [family: 180-days].');
    familyErr.code = 'SUBMIT_NOT_SUCCESS';
    familyErr.responseSummary = { status: 200, jsonExplicitFailure: true };
    const out = await runHttpChain({
      data: runnerData('ref-fgate-4'), userId: 'user-1', secret: 'test-secret',
      client: baseClient(async (input) => {
        seen.push(input);
        if (seen.length === 1) throw familyErr;
        return { hasPrintLink: false };
      }),
      log: () => {},
    });
    assert.strictEqual(seen.length, 2, 'an explicit JSON failure is a definitive rejection, so the family retry applies');
    assert.strictEqual(out.ok, true);
  });

  it('does NOT retry a definitive rejection without the family tag', async () => {
    let calls = 0;
    const out = await runHttpChain({
      data: runnerData('ref-fgate-5'), userId: 'user-1', secret: 'test-secret',
      client: baseClient(async () => {
        calls += 1;
        const e = new Error('Submit returned status 400: something else.');
        e.code = 'SUBMIT_BAD_RESPONSE';
        e.responseSummary = { status: 400 };
        throw e;
      }),
      log: () => {},
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(out.ok, false);
  });

  it('does NOT retry a codeless failure even with the tag in the message', async () => {
    let calls = 0;
    const out = await runHttpChain({
      data: runnerData('ref-fgate-6'), userId: 'user-1', secret: 'test-secret',
      client: baseClient(async () => {
        calls += 1;
        throw new Error('socket timeout [family: 180-days]');
      }),
      log: () => {},
    });
    assert.strictEqual(calls, 1, 'a codeless failure is never a definitive rejection');
    assert.strictEqual(out.ok, false);
  });
});
