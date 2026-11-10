jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
const express = require('express');
const request = require('supertest');
const fs = require('fs');
const db = require('../../db');
const auth = require('../../auth');
const admin = require('../../routes/admin');
const app = () => { const a = express(); a.use(express.json()); a.use('/api/admin', admin); return a; };
const post = () => request(app()).post('/api/admin/orders/o1/delivery-docs')
  .set('Authorization', 'Bearer ' + auth.signAccess({ id: 'a1', role: 'admin' }))
  .field('doc_type', 'delivery').attach('file', Buffer.from('%PDF-1.4 x'), { filename: 'd.pdf', contentType: 'application/pdf' });
beforeEach(() => db.__reset());
test('delivery upload appends to documents on the order row locked FOR UPDATE', async () => {
  db.__routeQuery([['FOR UPDATE', { rows: [{ id: 'o1', user_id: 'u1', status: 'processing', documents: [] }] }]]);
  await post().expect(200);
  const sql = db.__client.query.mock.calls.map((c) => c[0]);
  expect(sql.some((t) => /FROM orders WHERE id=\$1 FOR UPDATE/.test(t))).toBe(true);
  expect(sql.some((t) => t.startsWith('UPDATE orders SET documents'))).toBe(true);
});
test('delivery upload is refused on a cancelled order (checked on the locked row)', async () => {
  db.__routeQuery([['FOR UPDATE', { rows: [{ id: 'o1', user_id: 'u1', status: 'cancelled', documents: [] }] }]]);
  const r = await post().expect(400);
  expect(r.body.error).toBe('INVALID_STATUS');
  expect(db.__client.query.mock.calls.some((c) => c[0].startsWith('UPDATE orders SET documents'))).toBe(false);
});
