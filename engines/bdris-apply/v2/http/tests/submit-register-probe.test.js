/**
 * REGISTER-PROBE (2026-10-30) — diagnostic probe for the silent
 * direct-submit wall (6× live: the SAME 118,673-char response every
 * time, fingerprinted as a static app shell — no form action, no
 * submit button, no person/parents step fields).
 *
 * Prime suspect: the page's real submit goes via the register XHR
 * (/api/br/application/register, present in the page script but
 * unused by the engine), while the direct POST to /br/application
 * hits a shell-serving route. This probe diagnoses that endpoint's
 * contract with a body that CANNOT file anything: an empty JSON
 * object with session cookies + CSRF header only — zero record
 * fields (no names, dates, addresses, documents, phone, OTP).
 *
 * The probe is NEVER wired into submitApplication, HttpPathRunner,
 * the server adapter, or any UI path — these tests prove that
 * statically and at runtime. It is a diagnostic entry point only;
 * a live run needs separate user authorization.
 *
 * All fixture values below are fake. Run:
 * node --test engines/bdris-apply/v2/http/tests/submit-register-probe.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  BdrisHttpClient,
  REGISTER_PATH,
  probeResponseWording,
} = require('../client');

// Record field names that must NEVER appear in the probe body.
// (Checked against the body string only — the path legitimately
// contains 'application'.)
const RECORD_FIELD_NAMES = [
  'personInfoForBirth', 'personFirstName', 'personLastName',
  'personName', 'personBirthDate', 'thChild', 'gender',
  'father', 'mother', 'ubrn', 'birthPlace', 'permAddr', 'prsntAddr',
  'Div', 'Dist', 'PostOfc', 'VilAreaTown', 'attachments',
  'phone', 'otp', 'email', 'relation', 'applicant', 'office',
  'geoLocation', 'declaration', '_csrf', 'nid', 'passport',
  'dob', 'country', 'village', 'union', 'ward', 'zone',
];

function capturingClient(response) {
  const client = new BdrisHttpClient({ base: 'http://mock' });
  const captured = {};
  client.apiHeaders = (extra = {}) => ({
    'X-CSRF-TOKEN': 'mock-csrf',
    Cookie: 'session=mock-session',
    'x-requested-with': 'XMLHttpRequest',
    ...extra,
  });
  client.request = async (p, opts) => {
    captured.path = p;
    captured.method = opts.method;
    captured.headers = opts.headers;
    captured.body = opts.body;
    return response;
  };
  return { client, captured };
}

function addr() {
  return {
    country: 'বাংলাদেশ', division: 'ঢাকা', district: 'ঢাকা',
    cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন',
    paurasavaUnion: 'অঞ্চল - ৮', ward: 'ওয়ার্ড - ৬৮',
    postOfficeBn: 'সারুলিয়া', postOfficeEn: 'Sarulia',
    villageBn: 'সারুলিয়া', villageEn: 'Sarulia',
  };
}

function validApplicationInput() {
  return {
    person: {
      firstNameBn: 'আবদুল', lastNameBn: '', firstNameEn: 'Abdul',
      lastNameEn: '', dob: '2020-01-15', thChild: '১ম', gender: 'পুরুষ',
    },
    father: { nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid' },
    mother: { nameBn: 'ফাতেমা', nameEn: 'Fatema' },
    birthPlace: addr(), permAddr: addr(), prsntAddr: addr(),
    relation: 'FATHER', phone: '01700000000', otp: '123456',
    documents: [
      { attachmentType: 40, attachmentTypeId: 40, id: 'doc-40' },
      { attachmentType: 41, attachmentTypeId: 41, id: 'doc-41' },
    ],
  };
}

test('probe posts an empty JSON object to the register path with session headers only', async () => {
  const { client, captured } = capturingClient({
    status: 400, ok: false,
    json: { message: 'Validation failed' },
    text: '{"message":"Validation failed"}',
  });
  const result = await client.probeRegisterEndpoint();
  assert.equal(REGISTER_PATH, '/api/br/application/register');
  assert.equal(captured.path, '/api/br/application/register');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.body, '{}');
  assert.deepEqual(JSON.parse(captured.body), {});
  // Session + CSRF carried via headers, nothing else invented.
  assert.equal(captured.headers['X-CSRF-TOKEN'], 'mock-csrf');
  assert.equal(captured.headers.Cookie, 'session=mock-session');
  assert.equal(captured.headers['Content-Type'], 'application/json');
  // Return value is status + shape + wording ONLY.
  assert.deepEqual(Object.keys(result).sort(), ['isJson', 'status', 'wording']);
  assert.deepEqual(result, { status: 400, isJson: true, wording: 'Validation failed' });
});

test('probe body contains zero record fields', async () => {
  const { client, captured } = capturingClient({
    status: 400, ok: false,
    json: { message: 'Bad request' }, text: '{"message":"Bad request"}',
  });
  await client.probeRegisterEndpoint();
  const body = String(captured.body);
  for (const name of RECORD_FIELD_NAMES) {
    assert.ok(!body.includes(name), `probe body must not contain record field ${name}`);
  }
  // Not a form body either: no fields at all, no CSRF field in-body.
  assert.ok(!body.includes('='), 'probe body carries no key=value fields');
});

test('probe is not referenced by submit, runner, server, adapter, or UI', () => {
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');
  // Exactly two mentions in client.js: the REGISTER_PATH comment and
  // the method definition itself. Anything else would be a wiring.
  const mentionLines = clientSrc.split('\n').filter((l) => l.includes('probeRegisterEndpoint'));
  assert.equal(mentionLines.length, 2, `expected 2 mentions, got ${mentionLines.length}: ${mentionLines.join(' | ')}`);
  for (const line of mentionLines) {
    assert.ok(
      line.includes('REGISTER-PROBE') || /async probeRegisterEndpoint\(\)/.test(line),
      `unexpected probe mention: ${line}`,
    );
  }
  // submitApplication's own body never touches the probe or the path.
  // (The probe method immediately follows submitApplication in the
  // class, so slice up to its definition line; its JSDoc mentions
  // neither the method name nor the REGISTER_PATH constant.)
  const submitStart = clientSrc.indexOf('  async submitApplication(');
  const probeStart = clientSrc.indexOf('  async probeRegisterEndpoint() {');
  assert.ok(submitStart > 0 && probeStart > submitStart, 'submitApplication/probe bounds found');
  const submitBody = clientSrc.slice(submitStart, probeStart);
  assert.ok(!submitBody.includes('probeRegisterEndpoint'), 'submitApplication must not call the probe');
  assert.ok(!submitBody.includes('REGISTER_PATH'), 'submitApplication must not use the register path');
  // No other layer references it at all.
  const elsewhere = [
    path.join(__dirname, '..', '..', 'services', 'HttpPathRunner.js'),
    path.join(__dirname, '..', '..', 'server.js'),
    path.join(__dirname, '..', '..', '..', 'index.js'),
    path.join(__dirname, '..', '..', '..', '..', '..', 'frontend', 'bdris-apply.html'),
  ];
  for (const file of elsewhere) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!src.includes('probeRegisterEndpoint'), `${file} must not reference the probe`);
    assert.ok(!src.includes('REGISTER_PATH'), `${file} must not reference the register path`);
  }
});

test('submitApplication at runtime never touches the register path', async () => {
  const client = new BdrisHttpClient({ base: 'http://mock' });
  client.csrfToken = 'mock-csrf';
  client.apiHeaders = () => ({});
  const calledPaths = [];
  client.request = async (p) => {
    calledPaths.push(p);
    return {
      status: 200, ok: true, json: null,
      text: '<html><body>static app shell, no success phrase</body></html>',
    };
  };
  let thrown = null;
  try {
    await client.submitApplication(validApplicationInput());
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'submit must throw on the shell response');
  assert.equal(thrown.code, 'SUBMIT_NOT_SUCCESS');
  assert.deepEqual(calledPaths, ['/br/application']);
  assert.ok(!calledPaths.includes('/api/br/application/register'), 'submit never POSTs to register');
});

test('probe wording strips digit runs and caps at 200 chars', () => {
  assert.equal(
    probeResponseWording({ json: { message: 'Field 12345 is required, code 98765' }, text: '' }),
    'Field is required, code',
  );
  assert.equal(
    probeResponseWording({ json: { code: 'ERR-400-123' }, text: '' }),
    'ERR--',
  );
  assert.equal(
    probeResponseWording({ json: { message: 'ভুল ১২৩৪৫ হয়েছে' }, text: '' }),
    'ভুল হয়েছে',
  );
  assert.equal(
    probeResponseWording({ json: null, text: '<div class="text-danger">এই ঘরটি পূরণ আবশ্যক ১২৩</div>' }),
    'এই ঘরটি পূরণ আবশ্যক',
  );
  const long = probeResponseWording({ json: { message: `x${'y'.repeat(300)}` }, text: '' });
  assert.ok(long.length <= 200, `wording capped, got ${long.length}`);
  assert.ok(!/[0-9০-৯]/.test(long), 'capped wording still digit-free');
  assert.equal(probeResponseWording(null), '');
  assert.equal(probeResponseWording({ json: null, text: '' }), '');
});

test('probe returns status/isJson/wording only and never throws on non-2xx', async () => {
  // Tempting leaks in non-wording fields must never surface.
  const { client } = capturingClient({
    status: 400, ok: false,
    json: { message: 'Bad request 123', token: 'secret-123', name: 'FakeName' },
    text: '{"message":"Bad request 123"}',
  });
  const bad = await client.probeRegisterEndpoint();
  assert.deepEqual(bad, { status: 400, isJson: true, wording: 'Bad request' });
  assert.ok(!JSON.stringify(bad).includes('secret'), 'token never in probe result');
  assert.ok(!JSON.stringify(bad).includes('FakeName'), 'name never in probe result');

  // 404 with a JSON body: status + wording, no throw.
  const nf = capturingClient({
    status: 404, ok: false,
    json: { message: 'Not found 404' }, text: '{"message":"Not found 404"}',
  });
  assert.deepEqual(await nf.client.probeRegisterEndpoint(), { status: 404, isJson: true, wording: 'Not found' });

  // 200 HTML shell with no error-class text: empty wording, no throw.
  const shell = capturingClient({
    status: 200, ok: true, json: null,
    text: '<html><body>static app shell</body></html>',
  });
  assert.deepEqual(await shell.client.probeRegisterEndpoint(), { status: 200, isJson: false, wording: '' });
});
