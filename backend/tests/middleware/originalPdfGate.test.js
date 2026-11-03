/**
 * Original-PDF gate middleware (MONEY/PDF cycle 4, B10).
 * Original Form-1 PDFs were anonymous static files under predictable
 * names; the gate requires a charge token minted for exactly the
 * requested file, or an owned server record with the original
 * flagged available. No personal values.
 */

jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const crypto = require('crypto');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const { originalPdfGate, verifyPdfChargeToken } = require('../../middleware/originalPdfGate');

function app() {
  const a = express();
  a.use(originalPdfGate(db));
  a.use((req, res) => res.status(200).send('PDF-BYTES'));
  return a;
}

const token = () => auth.signAccess({ id: 'u1', role: 'user' });

// Mirror of backend mintChargeToken: v1.<uid>.<kind>.<ref>.<ts>.<mac>
function mintPdfToken(userId, fileKey) {
  const ref = 'bdris-apply-pdf-pdf-' + fileKey + '-' + userId;
  const body = ['v1', String(userId), 'pdf', ref, String(Date.now())].join('.');
  const mac = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('hex');
  return body + '.' + mac;
}

beforeEach(() => { db.__reset(); });

describe('originalPdfGate', () => {
  test('non-PDF paths pass through untouched', async () => {
    await request(app()).get('/bdris-apply.html').expect(200);
    await request(app()).get('/index.html').expect(200);
  });

  test('no token → 401', async () => {
    await request(app()).get('/bdris-original-1234567.pdf').expect(401);
  });

  test('invalid JWT → 401', async () => {
    await request(app()).get('/bdris-original-1234567.pdf')
      .set('Authorization', 'Bearer nope').expect(401);
  });

  test('valid JWT + charge token for THIS file → allowed', async () => {
    const ct = mintPdfToken('u1', '1234567');
    await request(app()).get('/bdris-original-1234567.pdf')
      .set('Authorization', 'Bearer ' + token())
      .set('X-Charge-Token', ct).expect(200, 'PDF-BYTES');
  });

  test('valid JWT + charge token for ANOTHER file → 403', async () => {
    db.__routeQuery([['FROM bdris_applications', { rows: [] }]]);
    const ct = mintPdfToken('u1', '7654321');
    await request(app()).get('/bdris-original-1234567.pdf')
      .set('Authorization', 'Bearer ' + token())
      .set('X-Charge-Token', ct).expect(403);
  });

  test('valid JWT + no token + no record → 403', async () => {
    db.__routeQuery([['FROM bdris_applications', { rows: [] }]]);
    await request(app()).get('/bdris-original-1234567.pdf')
      .set('Authorization', 'Bearer ' + token()).expect(403);
  });

  test('valid JWT + no token + owned entitled record → allowed (re-download)', async () => {
    db.__routeQuery([['FROM bdris_applications', { rows: [{ 1: 1 }] }]]);
    await request(app()).get('/bdris-original-1234567.pdf')
      .set('Authorization', 'Bearer ' + token()).expect(200, 'PDF-BYTES');
    const q = db.query.mock.calls.find((c) => /FROM bdris_applications/.test(c[0]));
    expect(q[1]).toEqual(['u1', '1234567']);
  });

  test('charge token for another user → 403', async () => {
    db.__routeQuery([['FROM bdris_applications', { rows: [] }]]);
    const ct = mintPdfToken('u2', '1234567');
    await request(app()).get('/bdris-original-1234567.pdf')
      .set('Authorization', 'Bearer ' + token())
      .set('X-Charge-Token', ct).expect(403);
  });
});

describe('verifyPdfChargeToken', () => {
  const secret = process.env.JWT_SECRET;
  test('accepts a token minted for the file, rejects anything else', () => {
    const good = mintPdfToken('u1', '1234567');
    expect(verifyPdfChargeToken(good, 'u1', '1234567', secret)).toBe(true);
    expect(verifyPdfChargeToken(good, 'u1', '7654321', secret)).toBe(false);
    expect(verifyPdfChargeToken(good, 'u2', '1234567', secret)).toBe(false);
    expect(verifyPdfChargeToken('garbage', 'u1', '1234567', secret)).toBe(false);
    expect(verifyPdfChargeToken(good, 'u1', '1234567', 'wrong-secret')).toBe(false);
  });
});
