/**
 * Stage A probe safety (2026-10-27): the probe is READ-ONLY — it
 * must never bootstrap, upload, send/verify OTP, or submit, and it
 * must never build a bare client. Fake client / mock data only —
 * no live bdris.gov.bd contact, no browser, no personal data.
 * Run: node --test engines/bdris-apply/v2/tests/http-stagea-probe.test.js
 * (from engines/bdris-apply/)
 *
 * Why: the gate deploy put seeded-client wiring live, but no live
 * run has exercised the bootstrap skip, and office lookup params
 * are still unverified. The probe proves the front half without
 * the full chain's OTP/submit side effects, so its safety
 * properties need tests first: seeded completes, unseeded refuses
 * without touching HTTP, missing client refuses, a failed office
 * step preserves earlier results, and steps are independent.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runStageAProbe, HTTP_CANDIDATE_LABEL } = require('../services/HttpPathRunner');

function fakeClient({ seeded = true, officeThrows = false } = {}) {
  const calls = [];
  const fail = (what) => async () => {
    calls.push(what);
    throw new Error(`probe must never ${what}`);
  };
  return {
    calls,
    bootstrapped: seeded,
    async bootstrap() { calls.push('bootstrap'); throw new Error('probe must never bootstrap'); },
    async walkGeoChain() {
      calls.push('geo');
      return [{ step: { nameBn: 'চট্টগ্রাম', geoType: 1 }, chosen: { id: '10', nameBn: 'চট্টগ্রাম' }, targetGeoOrder: 2 }];
    },
    async findOfficeByGeoId() {
      calls.push('office');
      if (officeThrows) {
        const e = new Error('Office lookup failed');
        e.code = 'OFFICE_BAD_RESPONSE';
        throw e;
      }
      return { offices: [{ id: '1' }] };
    },
    async findOfficeGeoProjectionByGeoId() { calls.push('office-projection'); return { projection: [] }; },
    uploadDocument: fail('upload'),
    otpSend: fail('otp-send'),
    verifyOtp: fail('verify'),
    submitApplication: fail('submit'),
  };
}

const geoChain = { firstParentId: '1', firstGeoOrder: 1, steps: [{ geoType: 1, nameBn: 'চট্টগ্রাম' }] };
const officeParams = { geoId: '10' };
const officeProjectionParams = { geoId: '10' };

describe('Stage A probe (read-only front half)', () => {
  it('seeded client completes geo + office and never touches upload/OTP/submit', async () => {
    const client = fakeClient({ seeded: true });
    const out = await runStageAProbe({
      client, geoChain, officeParams, officeProjectionParams, log: () => {},
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.path, 'http-probe');
    assert.strictEqual(out.stage, 'A');
    assert.strictEqual(out.candidate, true);
    assert.strictEqual(out.candidateLabel, HTTP_CANDIDATE_LABEL);
    assert.strictEqual(out.stoppedBefore, 'upload');
    assert.deepStrictEqual(out.steps, ['bootstrap-skipped', 'geo', 'office', 'office-projection']);
    assert.strictEqual(out.results.geo.steps[0].chosenId, '10');
    assert.deepStrictEqual(out.results.office.response, { offices: [{ id: '1' }] });
    assert.ok(!client.calls.includes('bootstrap'), 'probe must skip bootstrap for a seeded client');
    for (const banned of ['upload', 'otp-send', 'verify', 'submit']) {
      assert.ok(!client.calls.includes(banned), `probe must never ${banned}`);
    }
  });

  it('unseeded client is refused without touching HTTP', async () => {
    const client = fakeClient({ seeded: false });
    const out = await runStageAProbe({ client, geoChain, officeParams, log: () => {} });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'NOT_SEEDED');
    assert.deepStrictEqual(client.calls, [], 'refused probe must call nothing');
  });

  it('missing client is refused without touching HTTP', async () => {
    const out = await runStageAProbe({ geoChain, log: () => {} });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'NO_SEEDED_CLIENT');
  });

  it('a failed office step preserves the geo result and reports ok:false', async () => {
    const client = fakeClient({ seeded: true, officeThrows: true });
    const out = await runStageAProbe({
      client, geoChain, officeParams, officeProjectionParams, log: () => {},
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.results.geo.ok, true);
    assert.strictEqual(out.results.office.ok, false);
    assert.strictEqual(out.results.office.error, 'OFFICE_BAD_RESPONSE');
    assert.strictEqual(out.results.officeProjection.ok, true, 'later steps still run after a failed step');
  });

  it('steps are independent: no geoChain still attempts office', async () => {
    const client = fakeClient({ seeded: true });
    const out = await runStageAProbe({ client, officeParams, log: () => {} });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.steps, ['bootstrap-skipped', 'office']);
    assert.strictEqual(out.results.geo.skipped, 'no geoChain spec supplied');
  });
});
