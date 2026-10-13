// FIX-13 + FIX-14 regression: filter/date param validation.
// NOTE on real behavior (verified in source, commit 88175f3): invalid
// values are IGNORED (never reach the SQL) — the endpoints do NOT return
// 400 for them. These tests lock in that real behavior: allowlisted values
// are applied as params, anything else is dropped.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const adminRouter = require('../../routes/admin');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', adminRouter);
  return a;
}
const adminToken = () => auth.signAccess({ id: 'admin1', role: 'admin' });
const withAdmin = (req) => req.set('Authorization', 'Bearer ' + adminToken());

beforeEach(() => { db.__reset(); });

function txHandlers() {
  return [
    ['SELECT COUNT(*) FROM transactions', { rows: [{ count: '0' }] }],
    ['FROM transactions t JOIN', { rows: [] }],
  ];
}
function ordersReportHandlers() {
  return [['SELECT o.id, o.status', { rows: [] }]];
}
const allParams = () => db.query.mock.calls.flatMap((c) => c[1] || []);
const allSql = () => db.query.mock.calls.map((c) => c[0]).join('\n');

describe('FIX-13 admin transactions filter allowlist', () => {
  test('valid status+type are applied as query params', async () => {
    db.__routeQuery(txHandlers());
    await withAdmin(request(app())
      .get('/api/admin/transactions?status=pending&type=debit')).expect(200);
    const countCall = db.query.mock.calls.find((c) => /SELECT COUNT\(\*\) FROM transactions/.test(c[0]));
    expect(countCall[1]).toEqual(expect.arrayContaining(['pending', 'debit']));
    expect(allSql()).toMatch(/t\.status = \$1/);
    expect(allSql()).toMatch(/t\.type = \$2/);
  });

  test('invalid status/type are IGNORED — never reach the SQL (no 400)', async () => {
    db.__routeQuery(txHandlers());
    const r = await withAdmin(request(app())
      .get('/api/admin/transactions?status=bogus&type=evil')).expect(200);
    expect(r.body.transactions).toEqual([]);
    expect(allParams()).not.toContain('bogus');
    expect(allParams()).not.toContain('evil');
    expect(allSql()).not.toMatch(/t\.status =/);
    expect(allSql()).not.toMatch(/t\.type =/);
  });

  test("injection-shaped filter is dropped, not interpolated", async () => {
    db.__routeQuery(txHandlers());
    await withAdmin(request(app())
      .get("/api/admin/transactions?status=pending' OR '1'='1")).expect(200);
    expect(allParams()).not.toContain("pending' OR '1'='1");
    expect(allSql()).not.toContain("OR '1'='1");
  });

  test('mixed: valid type kept, invalid status dropped', async () => {
    db.__routeQuery(txHandlers());
    await withAdmin(request(app())
      .get('/api/admin/transactions?status=nope&type=recharge')).expect(200);
    expect(allParams()).toContain('recharge');
    expect(allParams()).not.toContain('nope');
  });
});

describe('FIX-14 /reports/orders date params validated by regex', () => {
  test('valid YYYY-MM-DD from/to are applied', async () => {
    db.__routeQuery(ordersReportHandlers());
    await withAdmin(request(app())
      .get('/api/admin/reports/orders?from=2026-10-01&to=2026-10-31'))
      .expect(200)
      .expect('Content-Type', /pdf/);
    expect(allParams()).toEqual(expect.arrayContaining(['2026-10-01', '2026-10-31']));
  });

  test('malformed dates are IGNORED — never reach the SQL (no 400)', async () => {
    db.__routeQuery(ordersReportHandlers());
    await withAdmin(request(app())
      .get("/api/admin/reports/orders?from=not-a-date&to=2026-10-01' OR '1'='1"))
      .expect(200);
    expect(allParams()).not.toContain('not-a-date');
    expect(allParams()).not.toContain("2026-10-01' OR '1'='1");
    expect(allSql()).not.toContain('not-a-date');
    // the invalid `from` adds no date condition at all
    expect(allSql()).not.toMatch(/o\.created_at >=/);
  });

  test('regex is format-only: 2026-13-99 passes the shape check (documents real behavior)', async () => {
    // The guard is /^\d{4}-\d{2}-\d{2}$/ — format only, not calendar-valid.
    // Postgres will reject/ignore it; the point is no injection is possible.
    db.__routeQuery(ordersReportHandlers());
    await withAdmin(request(app())
      .get('/api/admin/reports/orders?from=2026-13-99')).expect(200);
    expect(allParams()).toContain('2026-13-99');
    expect(allSql()).not.toMatch(/[';]/); // no quote/semicolon smuggling possible
  });
});
