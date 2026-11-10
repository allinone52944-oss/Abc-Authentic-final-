jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const router = require('../../routes/user');
const rows = [
  { id: 'manual-1', service_type: 'manual', engine_id: null, status: 'pending' },
  { id: 'nid-1', service_type: 'automated', engine_id: 'nid-replica', status: 'completed' },
  { id: 'birth-1', service_type: 'manual', engine_id: 'birth-final', status: 'completed' },
];
function app() { const a = express(); a.use('/api', router); return a; }
function get(path) { return request(app()).get('/api' + path).set('Authorization', 'Bearer ' + auth.signAccess({ id: 'u1', role: 'user' })); }
beforeEach(() => {
  db.__reset();
  db.query.mockImplementation(async (sql) => {
    // Model the WHERE predicate over the same mixed persisted records.
    const manualOnly = sql.includes("s.type = 'manual'") && sql.includes("NULLIF(BTRIM(s.engine_id), '') IS NULL");
    const selected = manualOnly ? rows.filter(r => r.service_type === 'manual' && !r.engine_id) : rows;
    if (sql.includes('AS active')) return { rows: [{ total: selected.length, done: selected.filter(r => r.status === 'completed').length, active: selected.filter(r => r.status === 'pending').length }] };
    if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: String(selected.length) }] };
    if (sql.includes('FROM orders o JOIN services')) return { rows: selected };
    return { rows: [] };
  });
});
test('customer orders include only manual work; exclude NID and birth engine entries before pagination', async () => {
  const r = await get('/orders?page=1&limit=10').expect(200);
  expect(r.body.orders.map(o => o.id)).toEqual(['manual-1']);
  expect(r.body.total).toBe(1);
});
test('customer order counters exclude instant engine completions', async () => {
  const r = await get('/order-counts').expect(200);
  expect(r.body).toEqual({ total: 1, done: 0, active: 1 });
});
test('NID output appears as engine history with its original stored download URL', async () => {
  db.__routeQuery([['FROM orders o LEFT JOIN services', { rows: [{ id: 'nid-1', service_type: 'automated', engine_id: 'nid-replica', service_name: 'NID', created_at: '2026-11-10', documents: [{ filename: 'nid-copy.pdf', originalname: 'nid.pdf', uploaded_by: 'admin' }] }] }]]);
  const r = await get('/history').expect(200);
  expect(r.body.items[0].kind).toBe('engine');
  expect(r.body.items[0].documents[0].url).toBe('/orders/nid-1/documents/nid-copy.pdf');
});
