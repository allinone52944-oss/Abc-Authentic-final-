// Route tests for backend/routes/nid.js (NID replica engine).
// The engine adapter is mocked — no Python, no real PDFs.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/nid-replica/adapter', () => ({
  extractFields: jest.fn(),
  buildCard: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const nidRouter = require('../../routes/nid');
const adapter = require('../../../engines/nid-replica/adapter');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/nid-engine', nidRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());
const PDF_BUF = Buffer.from('%PDF-1.4 fake-bytes');

beforeEach(() => {
  db.__reset();
  adapter.extractFields.mockReset();
  adapter.buildCard.mockReset();
});

describe('POST /api/nid-engine/extract', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/nid-engine/extract').expect(401);
  });

  test('no file → 400 NO_FILE', async () => {
    const r = await withUser(request(app()).post('/api/nid-engine/extract')).expect(400);
    expect(r.body.error).toBe('NO_FILE');
  });

  test('non-PDF extension → 400 NOT_A_PDF', async () => {
    const r = await withUser(request(app()).post('/api/nid-engine/extract'))
      .attach('pdf', PDF_BUF, 'evil.exe').expect(400);
    expect(r.body.error).toBe('NOT_A_PDF');
    expect(adapter.extractFields).not.toHaveBeenCalled();
  });

  test('spoofed MIME (pdf name, text/plain) → 400 NOT_A_PDF (MIME-map fix)', async () => {
    const r = await withUser(request(app()).post('/api/nid-engine/extract'))
      .attach('pdf', PDF_BUF, { filename: 'spoof.pdf', contentType: 'text/plain' })
      .expect(400);
    expect(r.body.error).toBe('NOT_A_PDF');
    expect(adapter.extractFields).not.toHaveBeenCalled();
  });

  test('valid PDF → 200 with jobId/fields/images', async () => {
    adapter.extractFields.mockResolvedValue({
      ok: true, jobId: 'job1', fields: { name: 'Rahim' }, images: ['img1'],
    });
    const r = await withUser(request(app()).post('/api/nid-engine/extract'))
      .attach('pdf', PDF_BUF, 'form.pdf').expect(200);
    expect(r.body).toMatchObject({ ok: true, jobId: 'job1', fields: { name: 'Rahim' } });
    expect(adapter.extractFields).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(adapter.extractFields.mock.calls[0][0])).toBe(true);
  });

  test('adapter failure → 422 with its error code', async () => {
    adapter.extractFields.mockResolvedValue({ ok: false, error: 'BAD_PDF' });
    const r = await withUser(request(app()).post('/api/nid-engine/extract'))
      .attach('pdf', PDF_BUF, 'form.pdf').expect(422);
    expect(r.body.error).toBe('BAD_PDF');
  });
});

describe('POST /api/nid-engine/build', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/nid-engine/build').send({}).expect(401);
  });

  test.each([
    ['missing jobId', { fields: {} }],
    ['missing fields', { jobId: 'j1' }],
    ['fields not object', { jobId: 'j1', fields: 'nope' }],
    ['empty body', {}],
  ])('%s → 400 INVALID_REQUEST', async (_l, body) => {
    const r = await withUser(request(app()).post('/api/nid-engine/build')).send(body).expect(400);
    expect(r.body.error).toBe('INVALID_REQUEST');
  });

  test('JOB_NOT_FOUND → 404', async () => {
    adapter.buildCard.mockResolvedValue({ ok: false, error: 'JOB_NOT_FOUND' });
    const r = await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j1', fields: {} }).expect(404);
    expect(r.body.error).toBe('JOB_NOT_FOUND');
  });

  test('other adapter error → 422', async () => {
    adapter.buildCard.mockResolvedValue({ ok: false, error: 'RENDER_FAILED' });
    const r = await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j1', fields: {} }).expect(422);
    expect(r.body.error).toBe('RENDER_FAILED');
  });

  test('happy path → 200 application/pdf download', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 card');
    adapter.buildCard.mockResolvedValue({ ok: true, pdfBuffer: pdfBytes });
    const r = await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j1', fields: { name: 'R' } }).expect(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('nid-card.pdf');
  });
});
