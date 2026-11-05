// Route tests for backend/routes/nid-server-copy.js (NID Server
// Copy engine). The portal engine and the NID pipeline adapter are
// mocked — no real portal calls, no real money. Money rules under
// test (same discipline as the other engines):
//   - balance is checked BEFORE any portal login starts
//   - the wallet is charged ONLY after the card PDF has been built
//   - a failed login / failed build never charges
//   - a captcha retry returns a fresh captcha and charges nothing
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/nid-server-copy/index', () => {
  const profileMap = jest.requireActual('../../../engines/nid-server-copy/profile-map');
  return {
    init: jest.fn(() => ({ ok: true })),
    getInfo: jest.fn(() => ({ id: 'nid-server-copy' })),
    startSession: jest.fn(),
    submitCaptcha: jest.fn(),
    getJob: jest.fn(),
    renderFromProfile: jest.fn(),
    profileMap,
  };
});
jest.mock('../../../engines/nid-replica/adapter', () => ({
  extractFields: jest.fn(),
  buildCard: jest.fn(),
}));
jest.mock('../../utils/whatsapp', () => ({
  notifyServiceCompleted: jest.fn().mockResolvedValue({ ok: true }),
  notifyServiceFailed: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../utils/push', () => ({
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const router = require('../../routes/nid-server-copy');
const engine = require('../../../engines/nid-server-copy/index');
const profileMap = require('../../../engines/nid-server-copy/profile-map');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/nid-server-copy', router);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

function baseRoutes(balance = 500) {
  return [
    ['FROM services WHERE', { rows: [{ id: 41, price: 150 }] }],
    ['FROM user_services WHERE', { rows: [] }],
    ['FROM users WHERE', { rows: [{ balance }] }],
    ['FROM service_credits', { rows: [] }],
    ['FROM transactions WHERE', { rows: [] }],
    ['wallet_apply', { rows: [{ balance: balance - 150 }] }],
    ['INSERT INTO orders', { rows: [{ id: 'o1' }] }],
    ['SELECT id, documents FROM orders', { rows: [{ id: 'o1', documents: '[]' }] }],
    ['UPDATE orders SET documents', { rows: [] }],
  ];
}

const CORE_PAIRS = [
  { section: 'ব্যক্তিগত তথ্য', label: 'নাম', value: 'মোঃ পরীক্ষা রহমান' },
  { section: 'ব্যক্তিগত তথ্য', label: 'Name', value: 'MD PORIKKHA RAHMAN' },
  { section: 'ব্যক্তিগত তথ্য', label: 'National ID', value: '1234567890' },
  { section: 'ব্যক্তিগত তথ্য', label: 'Date of Birth', value: '12/03/1990' },
];

function walletCalls() {
  return db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
}

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
  db.__routeQuery(baseRoutes());
  // fs writes for the delivery copy go to the production uploads
  // path; in tests the dir creation may fail silently — the route
  // treats delivery-copy storage as best-effort, which is what we
  // assert against (the response PDF is what matters).
});

describe('profile-map (portal pairs -> card input data)', () => {
  test('maps Bengali + English labels and present-address section', () => {
    const data = profileMap.buildInputData([
      ...CORE_PAIRS,
      { section: 'বর্তমান ঠিকানা', label: 'গ্রাম', value: 'বাসাবো' },
      { section: 'বর্তমান ঠিকানা', label: 'জেলা', value: 'ঢাকা' },
    ]);
    expect(data['Name(Bangla)']).toBe('মোঃ পরীক্ষা রহমান');
    expect(data['Name(English)']).toBe('MD PORIKKHA RAHMAN');
    expect(data['National ID']).toBe('1234567890');
    expect(data['Present Address']).toMatchObject({ village: 'বাসাবো', district: 'ঢাকা' });
    expect(profileMap.hasCoreData(data)).toBe(true);
  });
  test('empty pairs -> no core data', () => {
    expect(profileMap.hasCoreData(profileMap.buildInputData([]))).toBe(false);
  });
});

describe('GET /api/nid-server-copy/price', () => {
  test('requires auth → 401', async () => {
    await request(app()).get('/api/nid-server-copy/price').expect(401);
  });
  test('price 150 + balance → 200', async () => {
    const r = await withUser(request(app()).get('/api/nid-server-copy/price')).expect(200);
    expect(r.body).toMatchObject({ ok: true, price: 150, balance: 500, serviceId: 41 });
  });
});

describe('POST /api/nid-server-copy/start', () => {
  test('missing credentials → 400, portal never touched', async () => {
    await withUser(request(app()).post('/api/nid-server-copy/start')).send({}).expect(400);
    expect(engine.startSession).not.toHaveBeenCalled();
  });
  test('insufficient balance → 402 BEFORE any portal login', async () => {
    db.__routeQuery(baseRoutes(50));
    const r = await withUser(request(app()).post('/api/nid-server-copy/start'))
      .send({ username: 'x', password: 'y' }).expect(402);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(engine.startSession).not.toHaveBeenCalled();
  });
  test('ok → session + captcha image', async () => {
    engine.startSession.mockResolvedValue({ ok: true, sessionId: 's1', captcha: 'data:image/png;base64,AAA' });
    const r = await withUser(request(app()).post('/api/nid-server-copy/start'))
      .send({ username: 'x', password: 'y' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, sessionId: 's1' });
    expect(r.body.captcha).toContain('data:image/png');
    expect(engine.startSession).toHaveBeenCalledWith('u1', 'x', 'y');
  });
});

describe('POST /api/nid-server-copy/captcha', () => {
  test('login failed with retry → 422 + fresh captcha, no charge', async () => {
    engine.submitCaptcha.mockResolvedValue({ ok: false, error: 'LOGIN_FAILED', retry: true, captcha: 'data:image/png;base64,BBB', message: '' });
    const r = await withUser(request(app()).post('/api/nid-server-copy/captcha'))
      .send({ sessionId: 's1', captcha: 'abc' }).expect(422);
    expect(r.body).toMatchObject({ error: 'LOGIN_FAILED', retry: true });
    expect(r.body.captcha).toContain('data:image/png');
    expect(walletCalls()).toHaveLength(0);
  });

  test('session expired → 410', async () => {
    engine.submitCaptcha.mockResolvedValue({ ok: false, error: 'SESSION_EXPIRED' });
    await withUser(request(app()).post('/api/nid-server-copy/captcha'))
      .send({ sessionId: 'gone', captcha: 'abc' }).expect(410);
  });

  test('login success → jobId + options, NO charge at login (owner flow)', async () => {
    engine.submitCaptcha.mockResolvedValue({ ok: true, jobId: 'j1', hasDownload: false, holderName: 'MD PORIKKHA RAHMAN' });
    const r = await withUser(request(app()).post('/api/nid-server-copy/captcha'))
      .send({ sessionId: 's1', captcha: 'abc' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, jobId: 'j1', hasDownload: false, holderName: 'MD PORIKKHA RAHMAN' });
    expect(walletCalls()).toHaveLength(0);
  });
});

describe('POST /api/nid-server-copy/profile (edit-form data, free)', () => {
  const JOB = { id: 'j1', ownerId: 'u1', pairs: CORE_PAIRS, photo: null, downloadPdf: null, createdAt: Date.now() };

  test('missing jobId → 400', async () => {
    await withUser(request(app()).post('/api/nid-server-copy/profile')).send({}).expect(400);
  });

  test('expired job → 410 JOB_EXPIRED', async () => {
    engine.getJob.mockReturnValue(null);
    const r = await withUser(request(app()).post('/api/nid-server-copy/profile'))
      .send({ jobId: 'gone' }).expect(410);
    expect(r.body.error).toBe('JOB_EXPIRED');
  });

  test('incomplete profile → 422 PROFILE_INCOMPLETE, no charge', async () => {
    engine.getJob.mockReturnValue({ ...JOB, pairs: [] });
    const r = await withUser(request(app()).post('/api/nid-server-copy/profile'))
      .send({ jobId: 'j1' }).expect(422);
    expect(r.body.error).toBe('PROFILE_INCOMPLETE');
    expect(walletCalls()).toHaveLength(0);
  });

  test('ok → mapped fields + photo data URL + hasDownload, no charge', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('fake-photo')]);
    engine.getJob.mockReturnValue({ ...JOB, photo: { buffer: jpeg }, downloadPdf: Buffer.from('%PDF-1.4 official') });
    const r = await withUser(request(app()).post('/api/nid-server-copy/profile'))
      .send({ jobId: 'j1' }).expect(200);
    expect(r.body.fields['Name(Bangla)']).toBe('মোঃ পরীক্ষা রহমান');
    expect(r.body.fields['National ID']).toBe('1234567890');
    expect(r.body.photo).toMatch(/^data:image\/jpeg;base64,/);
    expect(r.body.hasDownload).toBe(true);
    expect(walletCalls()).toHaveLength(0);
  });
});

describe('POST /api/nid-server-copy/deliver with edits', () => {
  const JOB = { id: 'j1', ownerId: 'u1', pairs: CORE_PAIRS, photo: null, downloadPdf: null, createdAt: Date.now() };

  test('card render uses edited values, unknown keys dropped', async () => {
    engine.getJob.mockReturnValue({ ...JOB });
    engine.renderFromProfile.mockResolvedValue({ ok: true, pdfBuffer: Buffer.from('%PDF-1.4 fake'), fields: {} });
    await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'card', edits: { 'Name(Bangla)': 'এডিট করা নাম', HACK: 'x' } }).expect(200);
    const input = engine.renderFromProfile.mock.calls[0][0];
    expect(input['Name(Bangla)']).toBe('এডিট করা নাম');
    expect(input.HACK).toBeUndefined();
    expect(walletCalls()).toHaveLength(1);
  });

  test('photo null → render called with no photo', async () => {
    engine.getJob.mockReturnValue({ ...JOB, photo: { buffer: Buffer.from('portal-photo') } });
    engine.renderFromProfile.mockResolvedValue({ ok: true, pdfBuffer: Buffer.from('%PDF-1.4 fake'), fields: {} });
    await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'card', photo: null }).expect(200);
    expect(engine.renderFromProfile.mock.calls[0][1]).toBeNull();
  });

  test('photo data URL → render called with decoded buffer', async () => {
    engine.getJob.mockReturnValue({ ...JOB });
    engine.renderFromProfile.mockResolvedValue({ ok: true, pdfBuffer: Buffer.from('%PDF-1.4 fake'), fields: {} });
    await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'card', photo: 'data:image/png;base64,' + Buffer.from('new-photo').toString('base64') }).expect(200);
    const buf = engine.renderFromProfile.mock.calls[0][1];
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe('new-photo');
  });

  test('invalid photo → 400 INVALID_PHOTO, renderer untouched, no charge', async () => {
    engine.getJob.mockReturnValue({ ...JOB });
    const r = await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'card', photo: 'data:text/plain;base64,xxx' }).expect(400);
    expect(r.body.error).toBe('INVALID_PHOTO');
    expect(engine.renderFromProfile).not.toHaveBeenCalled();
    expect(walletCalls()).toHaveLength(0);
  });

  test('card signature data URL → render called with decoded sign buffer', async () => {
    engine.getJob.mockReturnValue({ ...JOB });
    engine.renderFromProfile.mockResolvedValue({ ok: true, pdfBuffer: Buffer.from('%PDF-1.4 fake'), fields: {} });
    await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'card', signature: 'data:image/png;base64,' + Buffer.from('hand-sign').toString('base64') }).expect(200);
    const signBuf = engine.renderFromProfile.mock.calls[0][2];
    expect(Buffer.isBuffer(signBuf)).toBe(true);
    expect(signBuf.toString()).toBe('hand-sign');
  });

  test('invalid signature → 400 INVALID_SIGNATURE, renderer untouched, no charge', async () => {
    engine.getJob.mockReturnValue({ ...JOB });
    const r = await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'card', signature: 'not-a-data-url' }).expect(400);
    expect(r.body.error).toBe('INVALID_SIGNATURE');
    expect(engine.renderFromProfile).not.toHaveBeenCalled();
    expect(walletCalls()).toHaveLength(0);
  });

  test('server copy ignores signature (still builds, still charges once)', async () => {
    engine.getJob.mockReturnValue({ ...JOB });
    await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'server', signature: 'data:image/png;base64,' + Buffer.from('hand-sign').toString('base64') }).expect(200);
    expect(engine.renderFromProfile).not.toHaveBeenCalled();
    expect(walletCalls()).toHaveLength(1);
  });

  test('edits clearing core data → 422 PROFILE_INCOMPLETE, no charge', async () => {
    engine.getJob.mockReturnValue({ ...JOB });
    const r = await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'card', edits: { 'Name(Bangla)': '', 'Name(English)': '' } }).expect(422);
    expect(r.body.error).toBe('PROFILE_INCOMPLETE');
    expect(walletCalls()).toHaveLength(0);
  });
});

describe('POST /api/nid-server-copy/deliver', () => {
  const JOB = { id: 'j1', ownerId: 'u1', pairs: CORE_PAIRS, photo: null, downloadPdf: null, createdAt: Date.now() };

  test('bad kind → 400', async () => {
    await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'other' }).expect(400);
  });

  test('expired job → 410 JOB_EXPIRED', async () => {
    engine.getJob.mockReturnValue(null);
    const r = await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'gone', kind: 'card' }).expect(410);
    expect(r.body.error).toBe('JOB_EXPIRED');
  });

  test('card via profile render → PDF, charged once, order recorded', async () => {
    engine.getJob.mockReturnValue({ ...JOB });
    engine.renderFromProfile.mockResolvedValue({ ok: true, pdfBuffer: Buffer.from('%PDF-1.4 fake'), fields: { 'ID NO:': '1234567890' } });
    const r = await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'card' }).expect(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(walletCalls()).toHaveLength(1);
    const orderInserts = db.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO orders'));
    expect(orderInserts).toHaveLength(1);
    expect(orderInserts[0][1]).toContain('nidsc-j1-card');
  });

  test('card downloadable → official PDF DIRECTLY, renderer untouched (owner rule)', async () => {
    const official = Buffer.from('%PDF-1.4 official-portal-card');
    engine.getJob.mockReturnValue({ ...JOB, downloadPdf: official });
    const r = await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'card' }).expect(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(engine.renderFromProfile).not.toHaveBeenCalled();
    expect(walletCalls()).toHaveLength(1);
  });

  test('server copy → EC-layout PDF from profile data, charged, renderer not used', async () => {
    engine.getJob.mockReturnValue({ ...JOB });
    const r = await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'server' }).expect(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.body.length || (r.text ? r.text.length : 0)).toBeGreaterThan(0);
    expect(engine.renderFromProfile).not.toHaveBeenCalled();
    expect(walletCalls()).toHaveLength(1);
    const orderInserts = db.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO orders'));
    expect(orderInserts[0][1]).toContain('nidsc-j1-server');
  });

  test('card build failure → 422, wallet untouched', async () => {
    engine.getJob.mockReturnValue({ ...JOB });
    engine.renderFromProfile.mockResolvedValue({ ok: false, error: 'RENDER_FAILED' });
    const r = await withUser(request(app()).post('/api/nid-server-copy/deliver'))
      .send({ jobId: 'j1', kind: 'card' }).expect(422);
    expect(r.body.error).toBe('RENDER_FAILED');
    expect(walletCalls()).toHaveLength(0);
  });

  test('incomplete profile → 422 PROFILE_INCOMPLETE, no charge (both kinds)', async () => {
    engine.getJob.mockReturnValue({ ...JOB, pairs: [] });
    for (const kind of ['card', 'server']) {
      const r = await withUser(request(app()).post('/api/nid-server-copy/deliver'))
        .send({ jobId: 'j1', kind }).expect(422);
      expect(r.body.error).toBe('PROFILE_INCOMPLETE');
    }
    expect(engine.renderFromProfile).not.toHaveBeenCalled();
    expect(walletCalls()).toHaveLength(0);
  });
});
