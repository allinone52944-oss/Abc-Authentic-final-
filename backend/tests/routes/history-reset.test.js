jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('fs', () => ({ ...jest.requireActual('fs'), readdirSync: jest.fn(() => []), unlinkSync: jest.fn(), statSync: jest.fn(() => ({ isFile: () => true })) }));
const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const admin = require('../../routes/admin');
const app = () => { const a = express(); a.use(express.json()); a.use('/api/admin', admin); return a; };
const go = (body) => request(app()).post('/api/admin/reset-history').set('Authorization', 'Bearer ' + auth.signAccess({ id: 'a1', role: 'admin' })).send(body);
let hash;
beforeAll(async () => { hash = await auth.hashPassword('secret123'); });
const base = (active = 0, at = new Date().toISOString()) => [
  ['SELECT password_hash', { rows: [{ password_hash: hash }] }],
  ["key = 'backup.last'", { rows: [{ value: JSON.stringify({ at }) }] }],
  ['FROM orders WHERE status IN', { rows: [{ n: active }] }],
  ['DELETE FROM', { rows: [], rowCount: 2 }],
];
const deletes = () => db.__client.query.mock.calls.filter((c) => c[0].startsWith('DELETE'));
beforeEach(() => db.__reset());
test('wrong password deletes nothing', async () => {
  db.__routeQuery(base());
  await go({ confirm_text: 'সব মুছুন', admin_password: 'bad' }).expect(403);
  expect(deletes()).toHaveLength(0);
});
test('requires backup within 24 hours', async () => {
  db.__routeQuery(base(0, new Date(Date.now() - 25 * 3600e3).toISOString()));
  const r = await go({ confirm_text: 'সব মুছুন', admin_password: 'secret123' }).expect(409);
  expect(r.body.error).toBe('BACKUP_REQUIRED'); expect(deletes()).toHaveLength(0);
});
test('refuses while orders are in progress', async () => {
  db.__routeQuery(base(3));
  const r = await go({ confirm_text: 'সব মুছুন', admin_password: 'secret123' }).expect(409);
  expect(r.body.active).toBe(3); expect(deletes()).toHaveLength(0);
});
test('wipes history and orders but never users, balances or payments', async () => {
  db.__routeQuery(base());
  await go({ confirm_text: 'সব মুছুন', admin_password: 'secret123' }).expect(200);
  const sql = deletes().map((c) => c[0]).join('\n');
  expect(sql).toMatch(/DELETE FROM orders/); expect(sql).toMatch(/DELETE FROM engine_jobs/);
  expect(sql).not.toMatch(/users|transactions|service_credits|settings/);
});
