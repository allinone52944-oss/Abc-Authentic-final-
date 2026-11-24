// A submitted owner record is required. An original-ready flag or a
// matching receipt grants access to the stored Form-1 PDF.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const bdrisRouter = require('../../routes/bdris-apply');

const ORIGINALS = fs.mkdtempSync(path.join(os.tmpdir(), 'orig-charge-'));
process.env.BDRIS_ORIGINALS_DIR = ORIGINALS;

const KEY = '266392130';
const FN = 'bdris-original-' + KEY + '.pdf';
const PDF = '%PDF-1.4\n' + 'A'.repeat(8100);

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/bdris-apply', bdrisRouter);
  return a;
}
const withUser = (req) => req.set('Authorization', 'Bearer ' + auth.signAccess({ id: 'u1', role: 'user' }));

// Mirror of backend mintChargeToken: v1.<uid>.pdf.<ref>.<ts>.<mac>
function mintPdfToken(userId, fileKey) {
  const ref = 'bdris-apply-pdf-pdf-' + fileKey + '-' + userId;
  const body = ['v1', String(userId), 'pdf', ref, String(Date.now())].join('.');
  const mac = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('hex');
  return body + '.' + mac;
}

beforeEach(() => {
  db.__reset();
  fs.writeFileSync(path.join(ORIGINALS, FN), PDF);
});
afterEach(() => { try { fs.unlinkSync(path.join(ORIGINALS, FN)); } catch {} });

describe('original download requires an owned application', () => {
  const owned = ['FROM bdris_applications', { rows: [{ original_pdf_available: false }] }];

  test('owned server record + receipt for THIS file → the paid copy downloads', async () => {
    db.__routeQuery([owned]);
    const r = await withUser(request(app()).get('/api/bdris-apply/applications/' + KEY + '/original'))
      .set('X-Charge-Token', mintPdfToken('u1', KEY)).expect(200);
    expect(r.body.toString().startsWith('%PDF-')).toBe(true);
  });

  test('matching receipt with no server record → 404', async () => {
    await withUser(request(app()).get('/api/bdris-apply/applications/' + KEY + '/original'))
      .set('X-Charge-Token', mintPdfToken('u1', KEY)).expect(404);
  });

  test('no server record + no receipt → 404 NOT_FOUND, no file served', async () => {
    db.__routeQuery([['FROM bdris_applications', { rows: [] }]]);
    const r = await withUser(request(app()).get('/api/bdris-apply/applications/' + KEY + '/original')).expect(404);
    expect(r.body.error).toBe('NOT_FOUND');
  });

  test('receipt minted for ANOTHER ack → 404, this copy stays closed', async () => {
    db.__routeQuery([owned]);
    const r = await withUser(request(app()).get('/api/bdris-apply/applications/' + KEY + '/original'))
      .set('X-Charge-Token', mintPdfToken('u1', '999999999')).expect(404);
    expect(r.body.error).toBe('PDF_NOT_AVAILABLE');
  });

  test('receipt minted for ANOTHER user → 404', async () => {
    db.__routeQuery([owned]);
    await withUser(request(app()).get('/api/bdris-apply/applications/' + KEY + '/original'))
      .set('X-Charge-Token', mintPdfToken('u2', KEY)).expect(404);
  });

  test('expired receipt (over 30 min) → 404', async () => {
    db.__routeQuery([owned]);
    const ref = 'bdris-apply-pdf-pdf-' + KEY + '-u1';
    const body = ['v1', 'u1', 'pdf', ref, String(Date.now() - 31 * 60 * 1000)].join('.');
    const mac = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('hex');
    await withUser(request(app()).get('/api/bdris-apply/applications/' + KEY + '/original'))
      .set('X-Charge-Token', body + '.' + mac).expect(404);
  });

  test('flagged owner record still downloads with no receipt at all', async () => {
    db.__routeQuery([['FROM bdris_applications', { rows: [{ original_pdf_available: true }] }]]);
    const r = await withUser(request(app()).get('/api/bdris-apply/applications/' + KEY + '/original')).expect(200);
    expect(r.body.toString().startsWith('%PDF-')).toBe(true);
  });

  test('signed-out request → 401 before any file read', async () => {
    await request(app()).get('/api/bdris-apply/applications/' + KEY + '/original').expect(401);
  });
});
