// R1 follow-up (2026-11-05, user decision): History shows ONLY the
// deliverable PDF per record. Receipt PDFs (success or failure) are
// still generated and stored (backend untouched) but get NO download
// link in History; records with no deliverable show status informing
// with no download link (no fake link).
// R1 follow-up #2 (2026-11-07, user decision): a completed record
// with no output STAYS in History as written text only — the
// documents-length skip is gone, so receipt-only completed orders
// and manual submissions appear with documents: [] instead of
// dropping out of History entirely.
// Route tests for GET /api/history (backend/routes/user.js).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const db = require('../../db');
const auth = require('../../auth');
const userRouter = require('../../routes/user');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api', userRouter);
  return a;
}
const asUser = (req) => req.set('Authorization', 'Bearer ' + auth.signAccess({ id: 'u1', role: 'user' }));

beforeEach(() => { db.__reset(); });

describe('GET /api/history — deliverable PDF only (R1 follow-up)', () => {
  test('(a) a record with only a failure receipt shows NO PDF download link', async () => {
    db.__routeQuery([
      ['FROM engine_jobs', { rows: [
        { id: 'jF', engine_id: 'birth-final', subject_name: 'Rahim', filename: 'engine-fail-x.pdf', originalname: 'verification-failed-receipt.pdf', created_at: '2026-10-22T09:00:00Z', outcome: 'failed' },
      ] }],
    ]);
    const r = await asUser(request(app()).get('/api/history')).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].kind).toBe('engine');
    // the record stays (status informing) but its failure receipt gets
    // no download link — only deliverables do
    expect(r.body.items[0].title).toContain('ব্যর্থ');
    expect(r.body.items[0].documents).toEqual([]);
  });

  test('(a2) a receipt-only completed QR-success order stays in History as status-only text, with NO download link', async () => {
    db.__routeQuery([
      ['FROM orders o LEFT JOIN services', { rows: [
        { id: 'oR', documents: JSON.stringify([
          { filename: 'delivery-qr-x.pdf', originalname: 'qr-verification-receipt.pdf', uploaded_by: 'admin', type: 'delivery' },
        ]), created_at: '2026-10-22T09:00:00Z', service_name: 'QR Verify', service_name_bn: 'কিউআর যাচাই' },
      ] }],
    ]);
    const r = await asUser(request(app()).get('/api/history')).expect(200);
    // R1 follow-up #2 (2026-11-07): a completed record with no output
    // stays as written text only — it is NOT dropped from History.
    // The receipt itself still gets no download link.
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ kind: 'order', id: 'oR' });
    expect(r.body.items[0].title).toContain('কিউআর যাচাই');
    expect(r.body.items[0].documents).toEqual([]);
    const allDocs = r.body.items.flatMap(i => i.documents || []);
    expect(allDocs.map(d => d.filename)).not.toContain('delivery-qr-x.pdf');
  });

  test('(a3) a receipt-only mouza-map-success order stays in History as status-only text', async () => {
    db.__routeQuery([
      ['FROM orders o LEFT JOIN services', { rows: [
        { id: 'oM', documents: JSON.stringify([
          { filename: 'delivery-land-mouza-map-x.pdf', originalname: 'land-mouza-map-receipt.pdf', uploaded_by: 'admin', type: 'delivery' },
        ]), created_at: '2026-10-22T09:00:00Z', service_name: 'Mouza Map', service_name_bn: 'মৌজা ম্যাপ' },
      ] }],
    ]);
    const r = await asUser(request(app()).get('/api/history')).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ kind: 'order', id: 'oM' });
    expect(r.body.items[0].title).toContain('মৌজা ম্যাপ');
    expect(r.body.items[0].documents).toEqual([]);
  });

  test('(a4) a receipt-only completed manual submission stays in History as status-only text', async () => {
    db.__routeQuery([
      ['FROM manual_submissions m LEFT JOIN services', { rows: [
        { id: 'mR', documents: JSON.stringify([
          { filename: 'delivery-manual-x.pdf', originalname: 'manual-receipt.pdf', uploaded_by: 'admin', type: 'delivery' },
        ]), created_at: '2026-10-22T09:00:00Z', service_name: 'Manual', service_name_bn: 'ম্যানুয়াল সেবা' },
      ] }],
    ]);
    const r = await asUser(request(app()).get('/api/history')).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ kind: 'manual', id: 'mR' });
    expect(r.body.items[0].documents).toEqual([]);
  });

  test('(b) a record with a deliverable shows exactly its deliverable PDF download', async () => {
    db.__routeQuery([
      ['FROM orders o LEFT JOIN services', { rows: [
        { id: 'o1', documents: JSON.stringify([
          { filename: 'delivery-land-khatian-abc.pdf', originalname: 'land-khatian-summary.pdf', uploaded_by: 'admin', type: 'delivery' },
        ]), created_at: '2026-10-22T09:00:00Z', service_name: 'Khatian', service_name_bn: 'খতিয়ান' },
      ] }],
      ['FROM engine_jobs', { rows: [
        { id: 'j1', engine_id: 'birth-final', subject_name: 'Rahim', filename: 'engine-a.pdf', originalname: 'Certificate_1.pdf', created_at: '2026-10-21T08:00:00Z', outcome: 'completed' },
      ] }],
    ]);
    const r = await asUser(request(app()).get('/api/history')).expect(200);
    const byId = Object.fromEntries(r.body.items.map(i => [i.id, i]));
    expect(byId.o1.documents).toHaveLength(1);
    expect(byId.o1.documents[0]).toMatchObject({ filename: 'delivery-land-khatian-abc.pdf', url: '/orders/o1/documents/delivery-land-khatian-abc.pdf' });
    expect(byId.j1.documents).toHaveLength(1);
    expect(byId.j1.documents[0].url).toBe('/engine-jobs/j1/file');
  });

  test('(c) a record with both shows only the deliverable download', async () => {
    db.__routeQuery([
      ['FROM orders o LEFT JOIN services', { rows: [
        { id: 'o1', documents: JSON.stringify([
          { filename: 'delivery-qr-x.pdf', originalname: 'qr-verification-receipt.pdf', uploaded_by: 'admin', type: 'delivery' },
          { filename: 'delivery-x.pdf', originalname: 'cert.pdf', uploaded_by: 'admin', type: 'delivery' },
          { filename: 'delivery-land-failed-y.pdf', originalname: 'land-not-found-receipt.pdf', uploaded_by: 'admin', type: 'delivery' },
        ]), created_at: '2026-10-22T09:00:00Z', service_name: 'Mixed', service_name_bn: 'মিশ্র' },
      ] }],
    ]);
    const r = await asUser(request(app()).get('/api/history')).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].documents).toHaveLength(1);
    expect(r.body.items[0].documents[0]).toMatchObject({ filename: 'delivery-x.pdf', url: '/orders/o1/documents/delivery-x.pdf' });
  });

  test('(d) a record with no PDF yet shows status informing and no download link', async () => {
    db.__routeQuery([
      ['FROM bdris_applications', { rows: [
        { id: 'b1', ack_no: '265530312', applicant_name: 'টেস্ট', created_at: '2026-10-21T10:00:00Z', original_pdf_available: false },
      ] }],
    ]);
    const r = await asUser(request(app()).get('/api/history')).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].kind).toBe('bdris');
    expect(r.body.items[0].title).toContain('265530312');
    expect(r.body.items[0].documents).toEqual([]);
    expect(r.body.items[0].link).toBe('/bdris-apply.html');
    expect(r.body.items[0].original_pdf_available).toBe(false);
  });

  // Past-applications list (2026-11-07): a filed BDRIS application
  // whose stored original is retrievable gets a real download link
  // in History; without the file on disk it stays text-only.
  test('(e) BDRIS filing with a stored original → documents carries the owner-only download link', async () => {
    const KEY = '265530312';
    const FP = path.join(__dirname, '..', '..', '..', 'frontend', 'bdris-original-' + KEY + '.pdf');
    fs.writeFileSync(FP, '%PDF-1.4\n' + 'A'.repeat(8100));
    try {
      db.__routeQuery([
        ['FROM bdris_applications', { rows: [
          { id: 'b1', ack_no: KEY, applicant_name: 'টেস্ট', created_at: '2026-10-21T10:00:00Z', original_pdf_available: true },
        ] }],
      ]);
      const r = await asUser(request(app()).get('/api/history')).expect(200);
      expect(r.body.items).toHaveLength(1);
      expect(r.body.items[0].kind).toBe('bdris');
      expect(r.body.items[0].documents).toHaveLength(1);
      expect(r.body.items[0].documents[0]).toMatchObject({
        filename: 'bdris-original-' + KEY + '.pdf',
        url: '/api/bdris-apply/applications/' + KEY + '/original',
      });
    } finally {
      try { fs.unlinkSync(FP); } catch {}
    }
  });

  test('(e2) BDRIS filing flagged ready but file missing on disk → no download link, row stays', async () => {
    db.__routeQuery([
      ['FROM bdris_applications', { rows: [
        { id: 'b1', ack_no: '265530312', applicant_name: 'টেস্ট', created_at: '2026-10-21T10:00:00Z', original_pdf_available: true },
      ] }],
    ]);
    const r = await asUser(request(app()).get('/api/history')).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].kind).toBe('bdris');
    expect(r.body.items[0].documents).toEqual([]);
    expect(r.body.items[0].link).toBe('/bdris-apply.html');
    expect(r.body.items[0].original_pdf_available).toBe(true);
  });
});
