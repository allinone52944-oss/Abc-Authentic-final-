/**
 * ORIGIN-EMPTY-PARTS (2026-10-30) — the last two untested differences
 * between the browser's native submit POST and the engine's POST
 * (everything else is live-killed: navigation headers, DOM field
 * alignment, cookie freshness, submit-time fields, register, client
 * header value "bris").
 *
 *  #1  Origin header: a browser sends `Origin: <page origin>` on
 *      every POST. The engine's submit navigation headers never
 *      did. navigationHeaders() (submit ONLY) now sends Origin =
 *      the client base origin; apiHeaders() (send/verify/geo/
 *      upload) gains NO Origin.
 *  #2  Empty file parts: a browser's native multipart POST always
 *      carries a part for every file input, even when empty
 *      (`filename=""`, `Content-Type: application/octet-stream`,
 *      empty body). The form's file inputs are `files` (recreated
 *      EMPTY after every async upload) and `personImage` (never
 *      set by the bot). The engine's submit body omitted both
 *      entirely — and undici FormData cannot emit `filename=""`
 *      at all (verified: it drops the attribute), so the wire
 *      body is built manually to match the browser byte-for-byte
 *      on these parts.
 *  #3  Nothing else changed: the navigation header set differs
 *      from the documented set by exactly +Origin; the wire
 *      part-name set differs from the builder field set by
 *      exactly +files +personImage (+_csrf, as before);
 *      attachments ids, field names, and field values are
 *      untouched; names stay verbatim.
 *
 * Run: node --test engines/bdris-apply/v2/http/tests/submit-origin-emptyparts.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const {
  BdrisHttpClient,
  buildSubmitPayload,
  buildSubmitMultipartBody,
} = require('../client');

function bootstrapped(base) {
  const client = new BdrisHttpClient({ base });
  client.bootstrapped = true;
  client.csrfToken = 'mock-csrf';
  return client;
}

function submitClient(capture, responseText) {
  const client = bootstrapped('http://mock');
  client.request = async (path, opts = {}) => {
    capture.path = path;
    capture.headers = opts.headers || {};
    capture.body = opts.body;
    return { status: 200, ok: true, json: null, text: responseText };
  };
  return client;
}

function fixtureApplication(overrides = {}) {
  const addr = {
    country: 'বাংলাদেশ', division: 'ঢাকা', district: 'ঢাকা',
    cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', paurasavaUnion: 'অঞ্চল - ১',
    ward: 'ওয়ার্ড - ৬', wardId: '7193',
    postOfficeBn: 'ঢাকা', postOfficeEn: 'Dhaka',
    villageBn: 'মহল্লা', villageEn: 'Moholla', houseRoadBn: 'বাসা ১', houseRoadEn: 'House 1',
    locationId: '700', en: 'House 1, Moholla, Dhaka', bn: 'বাসা ১, মহল্লা, ঢাকা',
  };
  return {
    person: { firstNameBn: 'আবুল', lastNameBn: '', firstNameEn: 'Abul', lastNameEn: '', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
    father: { id: '123', brn: '', dob: '1990-05-01', nameBn: 'আহাম্মদ আলী`', nameEn: 'Ahammad Ali`', nationality: 'বাংলাদেশী' },
    mother: { id: '456', brn: '', dob: '1992-03-01', nameBn: 'রোকিয়া খাতুন`', nameEn: 'Rokia Khathun`', nationality: 'বাংলাদেশী' },
    birthPlace: addr, permAddr: addr, prsntAddr: addr,
    relation: 'FATHER', declaration: true,
    email: 'mock@example.com', phone: 'mock-phone', otp: '123456',
    documents: [
      { attachmentType: 40, id: 'doc-40' },
      { attachmentType: 41, id: 'doc-41' },
    ],
    ...overrides,
  };
}

// Parse a raw multipart body into [{ name, filename, contentType, body }].
function parseMultipart(raw, boundary) {
  const parts = [];
  for (const chunk of raw.split(`--${boundary}`)) {
    const headEnd = chunk.indexOf('\r\n\r\n');
    if (headEnd === -1) continue;
    const head = chunk.slice(0, headEnd);
    const body = chunk.slice(headEnd + 4).replace(/\r\n$/, '');
    const name = /name="([^"]*)"/.exec(head)?.[1];
    if (name === undefined) continue;
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    const contentType = /Content-Type: ([^\r]*)/.exec(head)?.[1];
    parts.push({ name, filename, contentType, body });
  }
  return parts;
}

const SUCCESS_HTML = '<html>আবেদনপত্রটি সফল ভাবে সাবমিট করা হয়েছে'
  + '<a href="/admin/br/application/print">print</a></html>';

test('navigationHeaders sends Origin = base origin; apiHeaders gains no Origin', () => {
  const mock = bootstrapped('http://mock');
  assert.equal(mock.navigationHeaders().Origin, 'http://mock');
  const bdris = bootstrapped('https://bdris.gov.bd');
  assert.equal(bdris.navigationHeaders().Origin, 'https://bdris.gov.bd');
  const apiKeys = Object.keys(mock.apiHeaders()).map((k) => k.toLowerCase());
  assert.equal(apiKeys.includes('origin'), false, 'apiHeaders must not gain Origin');
  // The full navigation set is unchanged apart from +Origin
  // (fresh client: jar empty, so no Cookie key — as before).
  const navKeys = Object.keys(mock.navigationHeaders()).map((k) => k.toLowerCase()).sort();
  assert.deepStrictEqual(navKeys, [
    'accept', 'client', 'origin', 'referer',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
    'upgrade-insecure-requests', 'x-csrf-token',
  ].sort());
});

test('wire body carries empty files + personImage parts, browser-exact', async () => {
  const capture = {};
  const client = submitClient(capture, SUCCESS_HTML);
  const out = await client.submitApplication(fixtureApplication());
  assert.equal(out.success, true);
  assert.equal(capture.path, '/br/application');
  assert.equal(capture.headers.Origin, 'http://mock');
  assert.match(capture.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  const boundary = capture.headers['Content-Type'].split('boundary=')[1];
  const parts = parseMultipart(capture.body.toString('utf8'), boundary);
  const byName = {};
  for (const p of parts) (byName[p.name] ||= []).push(p);
  // Empty file parts: filename="" + octet-stream + empty body, exactly.
  for (const name of ['files', 'personImage']) {
    assert.equal(byName[name].length, 1, `${name} must appear exactly once`);
    assert.equal(byName[name][0].filename, '');
    assert.equal(byName[name][0].contentType, 'application/octet-stream');
    assert.equal(byName[name][0].body, '');
  }
  // Everything else rides along untouched.
  assert.deepStrictEqual(byName.attachments.map((p) => p.body), ['doc-40', 'doc-41']);
  assert.equal(byName._csrf[0].body, 'mock-csrf');
  assert.equal(byName.otp[0].body, '123456');
  assert.equal(byName['personInfoForBirth.personNameEn'][0].body, 'Abul');
  // Names verbatim: single-name never doubled, backticks preserved.
  assert.equal(byName['personInfoForBirth.father.personNameBn'][0].body, 'আহাম্মদ আলী`');
  assert.equal(byName['personInfoForBirth.mother.personNameEn'][0].body, 'Rokia Khathun`');
});

test('wire part-name set differs from the builder set by exactly +files +personImage', async () => {
  const capture = {};
  const client = submitClient(capture, SUCCESS_HTML);
  await client.submitApplication(fixtureApplication());
  const boundary = capture.headers['Content-Type'].split('boundary=')[1];
  const wireNames = new Set(parseMultipart(capture.body.toString('utf8'), boundary).map((p) => p.name));
  const builder = buildSubmitPayload(fixtureApplication());
  const expected = new Set(Object.keys(builder));
  expected.delete('attachments');
  for (const id of builder.attachments) expected.add('attachments');
  expected.add('_csrf');
  expected.add('files');
  expected.add('personImage');
  assert.deepStrictEqual([...wireNames].sort(), [...expected].sort());
});

test('guard: a payload entry for files/personImage suppresses its empty part', () => {
  const { body, contentType } = buildSubmitMultipartBody(
    { applicantName: 'Abul', files: 'already-there', attachments: [] }, 'csrf-1');
  const boundary = contentType.split('boundary=')[1];
  const parts = parseMultipart(body.toString('utf8'), boundary);
  const files = parts.filter((p) => p.name === 'files');
  assert.equal(files.length, 1, 'no duplicate files part');
  assert.equal(files[0].filename, undefined, 'payload value rides as a field, not an empty file part');
  assert.equal(files[0].body, 'already-there');
  // personImage untouched by the guard still gets its empty part.
  const personImage = parts.filter((p) => p.name === 'personImage');
  assert.equal(personImage.length, 1);
  assert.equal(personImage[0].filename, '');
  assert.equal(personImage[0].body, '');
});
