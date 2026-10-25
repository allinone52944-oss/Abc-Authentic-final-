/**
 * Tests for the HTTP-first BDRIS client — local mock server only.
 * No live bdris.gov.bd contact. Mock data reproduces ONLY the verified
 * JSON shapes from the 2026-10-25 investigation (geo, upload, OTP send).
 * All tokens/cookies here are mock fixtures, not real values.
 *
 * Run: node --test engines/bdris-apply/v2/http/tests/http.test.js
 * (from ~/workspace/abc-authentic-fixes)
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  BdrisHttpClient,
  GeoCache,
  parseSuccessPage,
  buildSubmitPayload,
  buildVerifyPayload,
  SUCCESS_PHRASE,
  PRINT_PATH,
} = require('../client');

// ---- Mock server state (for assertions about what the client sent) ----
const state = {
  geoHits: 0,
  geoCookies: [], // Cookie header seen on each geo call
  geoHeaders: [], // full header snapshot of the last geo call
  geoQueries: [],
  uploadHits: 0,
  uploadBody: '',
  otpQueries: [],
  otpBodies: [],
  officeQueries: [],
  verifyHits: 0,
  verifyQueries: [],
  verifyBodies: [],
  submitHits: 0,
  submitBodies: [],
};

// A complete application in the builders' canonical input shape. All
// values are mock fixtures; field NAMES come from the StepHandler map.
function completeApplication(overrides = {}) {
  const addr = (division) => ({
    country: 'বাংলাদেশ', division, district: 'ঢাকা',
    cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', paurasavaUnion: 'অঞ্চল - ১',
    ward: 'ওয়ার্ড - ১', postOfficeBn: 'ঢাকা', postOfficeEn: 'Dhaka',
    villageBn: 'মহল্লা', villageEn: 'Moholla', houseRoadBn: 'বাসা ১', houseRoadEn: 'House 1',
    locationId: '700', en: 'House 1, Moholla, Dhaka', bn: 'বাসা ১, মহল্লা, ঢাকা',
  });
  return {
    person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
    father: { brn: '', dob: '1990-05-01', nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid', nationality: 'বাংলাদেশী' },
    mother: { brn: '', dob: '1992-03-01', nameBn: 'ফাতেমা', nameEn: 'Fatema', nationality: 'বাংলাদেশী' },
    birthPlace: addr('ঢাকা'),
    permAddr: addr('ঢাকা'),
    prsntAddr: addr('ঢাকা'),
    relation: 'FATHER',
    applicantName: 'Abdul Hamid',
    declaration: true,
    email: 'mock@example.com',
    phone: 'mock-phone',
    officeAddressType: 'BIRTH',
    officeId: 'mock-office',
    documents: [
      { attachmentType: 40, attachmentTypeId: 40, url: '/admin/doc/40', id: 40 },
      { attachmentType: 41, attachmentTypeId: 41, url: '/admin/doc/41', id: 41 },
    ],
    otp: '123456',
    ...overrides,
  };
}

function geoResponse(parent, order, type, ward) {
  // Canned chain: division -> district -> zone (jump!) -> ward.
  if (parent === '100' && order === 1 && type === 1) {
    return { geoGroup: 'birthPlace', geoOrder: 1, geoType: 1, targetGeoOrder: 2,
      geoObject: [{ id: 200, nameEn: 'DHAKA', nameBn: 'ঢাকা', geoLevelId: 2, geoCode: '3026', parentGeoId: 100 }] };
  }
  if (parent === '200' && order === 2 && type === 2) {
    return { geoGroup: 'birthPlace', geoOrder: 2, geoType: 2, targetGeoOrder: 3,
      geoObject: [{ id: 300, nameEn: 'DHAKA', nameBn: 'ঢাকা', geoLevelId: 3, geoCode: '3001', parentGeoId: 200 }] };
  }
  if (parent === '300' && order === 3 && type === 8 && !ward) {
    // City-corp branch: zones, and the order JUMPS 3 -> 5 (never order+1).
    return { geoGroup: 'birthPlace', geoOrder: 3, geoType: 8, targetGeoOrder: 5,
      geoObject: [{ id: 400, nameEn: 'ZONE-1', nameBn: 'অঞ্চল - ১', geoLevelId: 6, geoCode: '4001', parentGeoId: 300 }] };
  }
  if (parent === '400' && order === 5 && type === 6 && ward) {
    return { geoGroup: 'birthPlace', geoOrder: 5, geoType: 6, targetGeoOrder: 6,
      geoObject: [{ id: 500, nameEn: 'WARD-1', nameBn: 'ওয়ার্ড - ১', geoLevelId: 7, geoCode: '5001', parentGeoId: 400 }] };
  }
  if (parent === '400' && order === 5 && type === 6 && !ward) {
    // ward=true distinction: without it this is NOT the ward list.
    return { geoGroup: 'birthPlace', geoOrder: 5, geoType: 6, targetGeoOrder: 6, geoObject: [] };
  }
  return { geoGroup: 'birthPlace', geoOrder: order, geoType: type, targetGeoOrder: order + 1, geoObject: [] };
}

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const rot = `TS01=rotated-${state.geoHits + state.uploadHits + 1}; Path=/; Max-Age=30`;
    if (url.pathname === '/br/application' && req.method === 'POST') {
      // Final submit: the form's own POST (multipart). Success shape
      // only — phrase + print link; no application number invented.
      state.submitHits += 1;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        state.submitBodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body>${SUCCESS_PHRASE} <a href="${PRINT_PATH}">print</a></body></html>`);
      });
      return;
    }
    if (url.pathname === '/br/application') {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': 'TS01=mock-session-1; Path=/; Max-Age=30',
      });
      res.end('<html><head><meta name="_csrf" content="mock-csrf-token">'
        + '<meta name="_csrf_headerName" content="X-CSRF-TOKEN"></head></html>');
      return;
    }
    if (url.pathname === '/br/application-custom-header') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><meta name="_csrf" content="mock-csrf-2">'
        + '<meta name="_csrf_headerName" content="X-Custom-Token"></head></html>');
      return;
    }
    if (url.pathname === '/br/application-nometa') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head></head><body>no meta</body></html>');
      return;
    }
    if (url.pathname.startsWith('/v1/api/geo/parentGeoIdWithGeoGroupAndGeoOrder/')) {
      state.geoHits += 1;
      state.geoCookies.push(req.headers.cookie || '');
      state.geoHeaders.push({ ...req.headers });
      state.geoQueries.push(url.search);
      const parent = decodeURIComponent(url.pathname.split('/').pop());
      const order = Number(url.searchParams.get('geoOrder'));
      const type = Number(url.searchParams.get('geoType'));
      const ward = url.searchParams.get('ward') === 'true';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': rot });
      res.end(JSON.stringify(geoResponse(parent, order, type, ward)));
      return;
    }
    if (url.pathname === '/admin/doc/upload' && req.method === 'POST') {
      state.uploadHits += 1;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        state.uploadBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': rot });
        res.end(JSON.stringify({ files: [{ name: 'mock-type-display-name', size: null,
          url: '/admin/doc/123', thumbnailUrl: '/admin/doc/123', deleteUrl: '/admin/doc/123?_csrf=mock',
          deleteType: 'DELETE', id: 123, attachmentType: 'mock-type-display-name',
          attachmentTypeId: 40, attachmentSubTypeId: null }] }));
      });
      return;
    }
    if (url.pathname === '/api/otp/sent' && req.method === 'POST') {
      state.otpQueries.push(url.search);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        state.otpBodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'MESSAGE_SENT', message: 'mock message', success: true, payload: null }));
      });
      return;
    }
    if (url.pathname === '/api/office/find-by-geo-id') {
      state.officeQueries.push(url.search);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: url.search }));
      return;
    }
    if (url.pathname === '/api/otp/verify' && req.method === 'POST') {
      state.verifyHits += 1;
      state.verifyQueries.push(url.search);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        state.verifyBodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { isVerified: true } }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found in mock' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function bootstrappedClient() {
  const c = new BdrisHttpClient({ base });
  await c.bootstrap();
  return c;
}

describe('bootstrap + cookie jar', () => {
  it('parses meta _csrf and header name, keeps the session cookie', async () => {
    const c = new BdrisHttpClient({ base });
    const r = await c.bootstrap();
    assert.strictEqual(c.csrfToken, 'mock-csrf-token');
    assert.strictEqual(c.csrfHeaderName, 'X-CSRF-TOKEN');
    assert.strictEqual(r.cookies, 1);
    assert.strictEqual(c.jar.get('TS01'), 'mock-session-1');
  });

  it('honours a different meta header name', async () => {
    const c = new BdrisHttpClient({ base });
    await c.bootstrap('/br/application-custom-header');
    assert.strictEqual(c.csrfHeaderName, 'X-Custom-Token');
    assert.strictEqual(c.csrfToken, 'mock-csrf-2');
  });

  it('fails bootstrap when the form page has no _csrf meta', async () => {
    const c = new BdrisHttpClient({ base });
    await assert.rejects(() => c.bootstrap('/br/application-nometa'), (e) => e.code === 'BOOTSTRAP_NO_CSRF');
  });

  it('refuses API calls before bootstrap', async () => {
    const c = new BdrisHttpClient({ base });
    assert.throws(() => c.apiHeaders(), (e) => e.code === 'NOT_BOOTSTRAPPED');
  });
});

describe('required API headers + cookie rotation', () => {
  it('sends cookies, csrf, x-requested-with, referer, client: bris', async () => {
    const c = await bootstrappedClient();
    state.geoHeaders.length = 0;
    await c.getGeo('100', 1, 1);
    const h = state.geoHeaders.at(-1);
    assert.strictEqual(h.client, 'bris');
    assert.strictEqual(h['x-requested-with'], 'XMLHttpRequest');
    assert.strictEqual(h.referer, `${base}/br/application`);
    assert.strictEqual(h['x-csrf-token'], 'mock-csrf-token');
    assert.match(h.cookie || '', /TS01=/);
  });

  it('updates the jar from every Set-Cookie (rotation), and sends the new value', async () => {
    const c = await bootstrappedClient();
    state.geoCookies.length = 0;
    await c.getGeo('100', 1, 1); // mock rotates TS01 on this response
    const afterFirst = c.jar.get('TS01');
    assert.notStrictEqual(afterFirst, 'mock-session-1');
    await c.getGeo('200', 2, 2);
    // The second call must have carried the rotated cookie from the first.
    assert.ok(state.geoCookies[1].includes(`TS01=${afterFirst}`));
  });
});

describe('geo cascade', () => {
  it('walks division -> district -> zone -> ward following targetGeoOrder (3 -> 5 jump)', async () => {
    const c = await bootstrappedClient();
    const chain = await c.walkGeoChain({
      firstParentId: '100',
      firstGeoOrder: 1,
      steps: [
        { geoType: 1, nameBn: 'ঢাকা' },
        { geoType: 2, nameBn: 'ঢাকা' },
        { geoType: 8, nameBn: 'অঞ্চল - ১' },
        { geoType: 6, nameBn: 'ওয়ার্ড - ১', ward: true },
      ],
    });
    assert.strictEqual(chain.length, 4);
    assert.strictEqual(chain[2].targetGeoOrder, 5, 'zone step must jump to order 5, not 4');
    assert.strictEqual(chain[3].chosen.id, 500);
  });

  it('distinguishes ward=true from the same call without it', async () => {
    const c = await bootstrappedClient();
    const withWard = await c.getGeo('400', 5, 6, { ward: true });
    const withoutWard = await c.getGeo('400', 5, 6, { ward: false });
    assert.strictEqual(withWard.entries.length, 1);
    assert.strictEqual(withWard.entries[0].nameBn, 'ওয়ার্ড - ১');
    assert.strictEqual(withoutWard.entries.length, 0);
  });

  it('requires an explicit firstParentId and never guesses one', async () => {
    const c = await bootstrappedClient();
    await assert.rejects(
      () => c.walkGeoChain({ firstGeoOrder: 1, steps: [{ geoType: 1, nameBn: 'ঢাকা' }] }),
      (e) => e.code === 'FIRST_PARENT_REQUIRED',
    );
  });

  it('throws GEO_NOT_FOUND for an unmatched nameBn', async () => {
    const c = await bootstrappedClient();
    await assert.rejects(
      () => c.walkGeoChain({ firstParentId: '100', firstGeoOrder: 1, steps: [{ geoType: 1, nameBn: 'নেই' }] }),
      (e) => e.code === 'GEO_NOT_FOUND',
    );
  });
});

describe('geo cache (same rule as AddressService)', () => {
  it('caches a non-empty live result: second identical call hits no server', async () => {
    const c = await bootstrappedClient();
    const before = state.geoHits;
    await c.getGeo('100', 1, 1);
    await c.getGeo('100', 1, 1);
    assert.strictEqual(state.geoHits, before + 1);
  });

  it('never caches an empty result: every call re-fetches live', async () => {
    const c = await bootstrappedClient();
    const before = state.geoHits;
    await c.getGeo('999', 9, 9);
    await c.getGeo('999', 9, 9);
    assert.strictEqual(state.geoHits, before + 2);
  });

  it('GeoCache entries expire after their TTL', async () => {
    const cache = new GeoCache(10); // 10ms, test-only TTL
    cache.set('1', 1, 1, false, [{ id: 2, nameBn: 'ঢাকা' }]);
    assert.strictEqual(cache.get('1', 1, 1, false).length, 1);
    await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(cache.get('1', 1, 1, false), null);
  });
});

describe('document upload', () => {
  it('parses files[0] into url/id/attachmentTypeId and sends the verified fields', async () => {
    const c = await bootstrappedClient();
    const out = await c.uploadDocument({
      fileBuffer: Buffer.from('fake-jpeg-bytes'),
      filename: 'doc.jpg',
      mimeType: 'image/jpeg',
      attachmentType: 40,
    });
    assert.strictEqual(out.url, '/admin/doc/123');
    assert.strictEqual(out.id, 123);
    assert.strictEqual(out.attachmentTypeId, 40);
    assert.match(state.uploadBody, /name="attachmentType"/);
    assert.match(state.uploadBody, /name="attachmentSubType"/);
    assert.match(state.uploadBody, /name="_csrf"/);
    assert.match(state.uploadBody, /name="files"/);
  });

  it('rejects files over 2MB client-side without hitting the server', async () => {
    const c = await bootstrappedClient();
    const before = state.uploadHits;
    await assert.rejects(
      () => c.uploadDocument({ fileBuffer: Buffer.alloc(2 * 1024 * 1024 + 1), filename: 'big.jpg', mimeType: 'image/jpeg', attachmentType: 40 }),
      (e) => e.code === 'FILE_TOO_LARGE',
    );
    assert.strictEqual(state.uploadHits, before);
  });

  it('rejects attachment types other than 40/41', async () => {
    const c = await bootstrappedClient();
    await assert.rejects(
      () => c.uploadDocument({ fileBuffer: Buffer.from('x'), filename: 'x.jpg', mimeType: 'image/jpeg', attachmentType: 42 }),
      (e) => e.code === 'UPLOAD_BAD_TYPE',
    );
  });
});

describe('OTP send + office helpers', () => {
  it('POSTs appType + the verified param names in query and the six name fields in body, returns MESSAGE_SENT with null payload', async () => {
    const c = await bootstrappedClient();
    state.otpQueries.length = 0;
    state.otpBodies.length = 0;
    const res = await c.otpSend({
      phone: 'mock-phone', applicantName: 'mock-name',
      person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim' },
      father: { nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid' },
      mother: { nameBn: 'ফাতেমা', nameEn: 'Fatema' },
    });
    assert.strictEqual(res.code, 'MESSAGE_SENT');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.payload, null);
    const q = new URLSearchParams(state.otpQueries[0]);
    assert.strictEqual(q.get('appType'), 'BIRTH_REGISTRATION_APPLICATION');
    assert.strictEqual(q.get('phone'), 'mock-phone');
    assert.strictEqual(q.get('applicantName'), 'mock-name');
    assert.ok(q.has('officeId') && q.has('applicantDob') && q.has('officeAddressType'));
    const body = state.otpBodies[0] || '';
    assert.match(body, /personInfoForBirth\.personNameBn/);
    assert.match(body, /personInfoForBirth\.father\.personNameEn/);
    assert.match(body, /personInfoForBirth\.mother\.personNameBn/);
  });

  it('office helper calls the verified URL with caller-supplied params (shape unverified)', async () => {
    const c = await bootstrappedClient();
    const res = await c.findOfficeByGeoId({ geoId: '300' });
    assert.strictEqual(res.ok, true);
    assert.match(state.officeQueries.at(-1), /geoId=300/);
  });
});

describe('Form-submit payload builder (pasted form source field names)', () => {
  it('covers every field the form itself carries for a complete application', () => {
    const p = buildSubmitPayload(completeApplication());
    // Person (S1): split + joined names, DOB, child number, gender enum.
    assert.strictEqual(p['personInfoForBirth.personFirstNameBn'], 'আবদুল');
    assert.strictEqual(p['personInfoForBirth.personLastNameEn'], 'Karim');
    assert.strictEqual(p['personInfoForBirth.personNameBn'], 'আবদুল করিম');
    assert.strictEqual(p['personInfoForBirth.personNameEn'], 'Abdul Karim');
    assert.strictEqual(p['personInfoForBirth.personBirthDate'], '2020-01-15');
    assert.strictEqual(p['personInfoForBirth.thChild'], '১ম');
    assert.strictEqual(p['personInfoForBirth.gender'], 'MALE');
    assert.strictEqual(p.religion, 'NOT_APPLICABLE');
    // Parents (S2): BRN, DOB, names, numeric nationality.
    assert.strictEqual(p['personInfoForBirth.father.personNameBn'], 'আবদুল হামিদ');
    assert.strictEqual(p['personInfoForBirth.father.personBirthDate'], '1990-05-01');
    assert.strictEqual(p['personInfoForBirth.mother.personNameEn'], 'Fatema');
    assert.strictEqual(p['personInfoForBirth.mother.personNationality'], '1');
    // Addresses (S2B): all three sections, full suffix set incl. LocationId/En/Bn.
    assert.strictEqual(p.birthPlaceDiv, 'ঢাকা');
    assert.strictEqual(p.birthPlaceCityCorpCantOrUpazila, 'ঢাকা দক্ষিণ সিটি কর্পোরেশন');
    assert.strictEqual(p.birthPlacePaurasavaOrUnion, 'অঞ্চল - ১');
    assert.strictEqual(p.birthPlaceVilAreaTownBn, 'মহল্লা');
    assert.strictEqual(p.birthPlaceLocationId, '700');
    assert.strictEqual(p.birthPlaceEn, 'House 1, Moholla, Dhaka');
    assert.strictEqual(p.permAddrPostOfcEn, 'Dhaka');
    assert.strictEqual(p.prsntAddrHouseRoadBn, 'বাসা ১');
    // Basis/documents/contact/OTP: office type mapped, attachments = ids.
    assert.strictEqual(p.officeAddressType, 'BIRTHPLACE');
    assert.strictEqual(p.officeId, 'mock-office');
    assert.strictEqual(p.geoLocationId, '700');
    assert.strictEqual(p.relationWithApplicant, 'FATHER');
    assert.strictEqual(p.applicantName, 'Abdul Hamid');
    assert.strictEqual(p.declaration, true);
    assert.strictEqual(p.phone, 'mock-phone');
    assert.strictEqual(p.email, 'mock@example.com');
    assert.strictEqual(p.otp, '123456');
    assert.deepStrictEqual(p.attachments, [40, 41]);
  });

  it('joins a first-name-only applicant to the first name alone (1-name rule)', () => {
    const p = buildSubmitPayload(completeApplication({
      person: { firstNameBn: 'আবদুল', lastNameBn: '', firstNameEn: 'Abdul', lastNameEn: '', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
    }));
    assert.strictEqual(p['personInfoForBirth.personNameBn'], 'আবদুল');
    assert.strictEqual(p['personInfoForBirth.personNameEn'], 'Abdul');
    assert.ok(!p['personInfoForBirth.personNameBn'].includes('আবদুল আবদুল'));
  });

  it('fails loudly listing every missing required field, guessing nothing', () => {
    assert.throws(
      () => buildSubmitPayload(completeApplication({ person: { firstNameBn: '', dob: '' }, documents: [] })),
      (e) => e.code === 'MISSING_SUBMIT_FIELD'
        && /person\.firstNameBn/.test(e.message)
        && /documents\[40\]/.test(e.message)
        && /documents\[41\]/.test(e.message),
    );
  });

  it('submitApplication POSTs the form itself (multipart) and accepts only the verified success shape', async () => {
    const c = await bootstrappedClient();
    state.submitBodies.length = 0;
    const before = state.submitHits;
    const out = await c.submitApplication(completeApplication());
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.hasPrintLink, true);
    assert.strictEqual(state.submitHits, before + 1);
    const sent = state.submitBodies.at(-1);
    assert.match(sent, /personInfoForBirth\.personNameBn/);
    assert.match(sent, /relationWithApplicant/);
    assert.match(sent, /name="attachments"/);
    assert.match(sent, /name="_csrf"/);
  });

  it('submitApplication with a missing field never hits the server', async () => {
    const c = await bootstrappedClient();
    const before = state.submitHits;
    await assert.rejects(
      () => c.submitApplication(completeApplication({ documents: [] })),
      (e) => e.code === 'MISSING_SUBMIT_FIELD',
    );
    assert.strictEqual(state.submitHits, before);
  });
});

describe('OTP-verify query builder + request (source-proven shape)', () => {
  it('builds query params (otp + context + geoLocationId) with an empty body', () => {
    const p = buildVerifyPayload({
      phone: 'mock-phone', applicantName: 'mock-name', applicantDob: '2020-01-15',
      officeAddressType: 'BIRTH', birthPlaceLocationId: '700', otp: '123456',
    });
    assert.strictEqual(p.appType, 'BIRTH_REGISTRATION_APPLICATION');
    assert.strictEqual(p.phone, 'mock-phone');
    assert.strictEqual(p.applicantName, 'mock-name');
    assert.strictEqual(p.applicantDob, '2020-01-15');
    assert.strictEqual(p.officeAddressType, 'BIRTHPLACE');
    assert.strictEqual(p.geoLocationId, '700');
    assert.strictEqual(p.otp, '123456');
  });

  it('refuses to verify without a 6-digit OTP', async () => {
    const c = await bootstrappedClient();
    const before = state.verifyHits;
    await assert.rejects(() => c.verifyOtp({ phone: 'x' }), (e) => e.code === 'OTP_REQUIRED');
    await assert.rejects(() => c.verifyOtp({ otp: '123' }), (e) => e.code === 'OTP_BAD_FORMAT');
    assert.strictEqual(state.verifyHits, before);
  });

  it('verifyOtp POSTs query params to /api/otp/verify with an empty body and requires isVerified', async () => {
    const c = await bootstrappedClient();
    state.verifyBodies.length = 0;
    state.verifyQueries.length = 0;
    const res = await c.verifyOtp({ phone: 'mock-phone', otp: '123456' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.isVerified, true);
    assert.strictEqual(state.verifyBodies.at(-1), '');
    const q = new URLSearchParams(state.verifyQueries.at(-1));
    assert.strictEqual(q.get('otp'), '123456');
    assert.strictEqual(q.get('phone'), 'mock-phone');
    assert.strictEqual(q.get('appType'), 'BIRTH_REGISTRATION_APPLICATION');
  });
});

describe('success-page parsing (later step)', () => {
  it('detects the verified phrase and print link; rejects a non-success page', () => {
    const ok = parseSuccessPage(`<html>${SUCCESS_PHRASE} <a href="${PRINT_PATH}">print</a></html>`);
    assert.strictEqual(ok.success, true);
    assert.strictEqual(ok.hasPrintLink, true);
    const no = parseSuccessPage('<html>some other page</html>');
    assert.strictEqual(no.success, false);
    assert.strictEqual(no.hasPrintLink, false);
  });
});

// ---- HttpPathRunner integration (mock server only, no browser) ----
const nodeCrypto = require('node:crypto');
const { runHttpChain, runSubmitHttpChain, getHttpPathStatus, isHttpPathEnabled, HTTP_CANDIDATE_LABEL } = require('../../services/HttpPathRunner');

function mockGeoChain() {
  return {
    firstParentId: '100',
    firstGeoOrder: 1,
    steps: [
      { geoType: 1, nameBn: 'ঢাকা' },
      { geoType: 2, nameBn: 'ঢাকা' },
      { geoType: 8, nameBn: 'অঞ্চল - ১' },
      { geoType: 6, nameBn: 'ওয়ার্ড - ১', ward: true },
    ],
  };
}

function runnerInput(overrides = {}) {
  const b64 = Buffer.from('fake-jpeg-bytes').toString('base64');
  return completeApplication({
    docs: [
      { name: 'doc40.jpg', mimeType: 'image/jpeg', base64: b64, docType: '40' },
      { name: 'doc41.jpg', mimeType: 'image/jpeg', base64: b64, docType: '41' },
    ],
    geoChain: mockGeoChain(),
    ...overrides,
  });
}

function validChargeToken(userId, secret, ref = 'ref-1') {
  const head = `v1.${userId}.submit.${ref}.${Date.now()}`;
  const mac = nodeCrypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

describe('HttpPathRunner (HTTP primary, Playwright fallback)', () => {
  it('runs the full chain against mocks and returns candidate-labelled success', async () => {
    const logs = [];
    const client = new BdrisHttpClient({ base });
    const submitBefore = state.submitHits;
    const out = await runHttpChain({
      data: runnerInput({ _chargeToken: validChargeToken('user-1', 'test-secret') }),
      userId: 'user-1',
      secret: 'test-secret',
      client,
      playwrightRunner: async () => { throw new Error('fallback must not run on success'); },
      log: (m) => logs.push(String(m)),
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.path, 'http');
    assert.strictEqual(out.candidate, true);
    assert.strictEqual(out.candidateLabel, HTTP_CANDIDATE_LABEL);
    assert.strictEqual(out.hasPrintLink, true);
    assert.strictEqual(out.ackNumber, null, 'no application number is ever extracted (format unverified)');
    assert.deepStrictEqual(out.steps, ['bootstrap', 'geo', 'upload', 'otp-send', 'verify', 'submit']);
    assert.strictEqual(state.submitHits, submitBefore + 1);
    assert.ok(logs.length > 0 && logs.every((l) => l.includes('CANDIDATE')), 'every HTTP-path log line carries CANDIDATE');
    assert.ok(logs.some((l) => /submit/.test(l) && /CANDIDATE/.test(l)));
  });

  it('falls back to Playwright on a geo failure, naming the step and reason', async () => {
    const logs = [];
    let stubCalls = 0;
    const client = new BdrisHttpClient({ base });
    const badChain = mockGeoChain();
    badChain.steps = [{ geoType: 1, nameBn: 'নেই' }];
    const out = await runHttpChain({
      data: runnerInput({ geoChain: badChain, _chargeToken: validChargeToken('user-1', 'test-secret', 'ref-geo') }),
      userId: 'user-1',
      secret: 'test-secret',
      client,
      playwrightRunner: async () => { stubCalls += 1; return { ok: true, completed: true }; },
      log: (m) => logs.push(String(m)),
    });
    assert.strictEqual(stubCalls, 1, 'Playwright fallback must run on HTTP geo failure');
    assert.strictEqual(out.path, 'playwright');
    assert.strictEqual(out.httpFallback, true);
    assert.strictEqual(out.httpStep, 'geo');
    assert.match(out.httpReason, /GEO_NOT_FOUND|No geo entry/);
    assert.strictEqual(out.candidate, true);
    assert.ok(logs.some((l) => l.includes('HTTP_PATH_FALLBACK') && l.includes('step=geo')));
  });

  it('returns fallback:true (no browser launch) when no Playwright runner is provided', async () => {
    const client = new BdrisHttpClient({ base });
    const badChain = mockGeoChain();
    badChain.steps = [{ geoType: 1, nameBn: 'নেই' }];
    const out = await runHttpChain({ data: runnerInput({ geoChain: badChain, _chargeToken: validChargeToken('user-1', 'test-secret', 'ref-norunner') }), userId: 'user-1', secret: 'test-secret', client, log: () => {} });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.fallback, true);
    assert.strictEqual(out.httpStep, 'geo');
  });

  it('blocks on a bad charge token before any HTTP attempt and never falls back', async () => {
    const client = new BdrisHttpClient({ base });
    const submitBefore = state.submitHits;
    const verifyBefore = state.verifyHits;
    let stubCalls = 0;
    const out = await runHttpChain({
      data: runnerInput({ _chargeToken: 'v1.user-1.submit.ref-1.1.deadbeef' }),
      userId: 'user-1',
      secret: 'test-secret',
      client,
      playwrightRunner: async () => { stubCalls += 1; return { ok: true }; },
      log: () => {},
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.blocked, true);
    assert.strictEqual(out.error, 'CHARGE_REQUIRED');
    assert.strictEqual(stubCalls, 0, 'charge gate must never be bypassed via fallback');
    assert.strictEqual(state.submitHits, submitBefore);
    assert.strictEqual(state.verifyHits, verifyBefore);
  });

  it('suppresses Playwright fallback when the submit outcome is unknown (no server response)', async () => {
    let stubCalls = 0;
    const fakeClient = {
      bootstrap: async () => ({}),
      walkGeoChain: async () => [{ chosen: { id: 1 } }],
      uploadDocument: async () => ({ attachmentTypeId: 40, url: '/admin/doc/123', id: 123 }),
      otpSend: async () => ({ success: true, code: 'MESSAGE_SENT', payload: null }),
      verifyOtp: async () => ({ success: true }),
      submitApplication: async () => { throw new Error('socket hangup'); }, // no .code: outcome unknown
    };
    const out = await runHttpChain({
      data: completeApplication({ _chargeToken: validChargeToken('user-1', 'test-secret', 'ref-unknown') }),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient,
      playwrightRunner: async () => { stubCalls += 1; return { ok: true }; },
      log: () => {},
    });
    assert.strictEqual(stubCalls, 0, 'unknown submit outcome must never auto-retry via Playwright (double-submit risk)');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'SUBMIT_OUTCOME_UNKNOWN');
    assert.strictEqual(out.httpStep, 'submit');
  });

  it('HTTP_PATH_STATUS probe is state-free and disabled runSubmitHttpChain hits no HTTP and no Playwright', async () => {
    const status1 = getHttpPathStatus({ BDRIS_HTTP_PATH: 'off' });
    const status2 = getHttpPathStatus({ BDRIS_HTTP_PATH: 'off' });
    assert.deepStrictEqual(status1, status2);
    assert.strictEqual(status1.httpPath, 'disabled');
    assert.strictEqual(status1.ready, true);
    assert.strictEqual(status1.candidateLabel, HTTP_CANDIDATE_LABEL);
    let stubCalls = 0;
    const submitBefore = state.submitHits;
    const out = await runSubmitHttpChain({
      data: runnerInput(),
      env: { BDRIS_HTTP_PATH: 'off' },
      playwrightRunner: async () => { stubCalls += 1; return { ok: true }; },
    });
    assert.strictEqual(stubCalls, 0, 'disabled chain must not run Playwright');
    assert.strictEqual(state.submitHits, submitBefore, 'disabled chain must not hit the submit endpoint either');
    assert.strictEqual(out.httpPath, 'disabled');
    assert.strictEqual(out.error, 'HTTP_PATH_DISABLED');
  });

  it('enabled runSubmitHttpChain delegates to the full HTTP chain (mock server, no browser)', async () => {
    const client = new BdrisHttpClient({ base });
    const submitBefore = state.submitHits;
    const out = await runSubmitHttpChain({
      data: runnerInput({ _chargeToken: validChargeToken('user-1', 'test-secret') }),
      userId: 'user-1',
      secret: 'test-secret',
      env: { BDRIS_HTTP_PATH: 'on' },
      client,
      playwrightRunner: async () => { throw new Error('fallback must not run on success'); },
      log: () => {},
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.path, 'http');
    assert.strictEqual(out.candidate, true);
    assert.strictEqual(state.submitHits, submitBefore + 1);
  });

  it('isHttpPathEnabled defaults OFF (opt-in only) and honours on/off values', () => {
    const saved = process.env.BDRIS_HTTP_PATH;
    try {
      delete process.env.BDRIS_HTTP_PATH;
      assert.strictEqual(isHttpPathEnabled(), false, 'default behaviour is Playwright (HTTP opt-in only)');
      process.env.BDRIS_HTTP_PATH = '';
      assert.strictEqual(isHttpPathEnabled(), false, 'empty value must disable');
      for (const v of ['on', '1', 'true', 'yes', 'enabled', 'ON', ' True ']) {
        process.env.BDRIS_HTTP_PATH = v;
        assert.strictEqual(isHttpPathEnabled(), true, `BDRIS_HTTP_PATH=${v} must enable`);
      }
      for (const v of ['off', '0', 'false', 'no', 'disabled', 'banana']) {
        process.env.BDRIS_HTTP_PATH = v;
        assert.strictEqual(isHttpPathEnabled(), false, `BDRIS_HTTP_PATH=${v} must disable`);
      }
    } finally {
      if (saved === undefined) delete process.env.BDRIS_HTTP_PATH; else process.env.BDRIS_HTTP_PATH = saved;
    }
  });
});
