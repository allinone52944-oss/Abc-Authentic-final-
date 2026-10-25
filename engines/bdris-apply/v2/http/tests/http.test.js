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
  officeQueries: [],
};

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
    if (url.pathname === '/api/otp/sent') {
      state.otpQueries.push(url.search);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'MESSAGE_SENT', message: 'mock message', success: true, payload: null }));
      return;
    }
    if (url.pathname === '/api/office/find-by-geo-id') {
      state.officeQueries.push(url.search);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: url.search }));
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
  it('sends appType + the verified param names and returns MESSAGE_SENT with null payload', async () => {
    const c = await bootstrappedClient();
    state.otpQueries.length = 0;
    const res = await c.otpSend({ phone: 'mock-phone', applicantName: 'mock-name' });
    assert.strictEqual(res.code, 'MESSAGE_SENT');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.payload, null);
    const q = new URLSearchParams(state.otpQueries[0]);
    assert.strictEqual(q.get('appType'), 'BIRTH_REGISTRATION_APPLICATION');
    assert.strictEqual(q.get('phone'), 'mock-phone');
    assert.strictEqual(q.get('applicantName'), 'mock-name');
    assert.ok(q.has('officeId') && q.has('applicantDob') && q.has('officeAddressType'));
  });

  it('office helper calls the verified URL with caller-supplied params (shape unverified)', async () => {
    const c = await bootstrappedClient();
    const res = await c.findOfficeByGeoId({ geoId: '300' });
    assert.strictEqual(res.ok, true);
    assert.match(state.officeQueries.at(-1), /geoId=300/);
  });
});

describe('NOT_IMPLEMENTED stubs (honesty constraint)', () => {
  it('verifyOtp throws naming /api/otp/verify and the missing params', async () => {
    const c = await bootstrappedClient();
    await assert.rejects(() => c.verifyOtp(), (e) => e.code === 'NOT_IMPLEMENTED_VERIFY_PARAMS' && /\/api\/otp\/verify/.test(e.message));
  });

  it('submitApplication throws naming /api/br/application/register and the missing payload', async () => {
    const c = await bootstrappedClient();
    await assert.rejects(() => c.submitApplication(), (e) => e.code === 'NOT_IMPLEMENTED_SUBMIT_PAYLOAD' && /\/api\/br\/application\/register/.test(e.message));
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
