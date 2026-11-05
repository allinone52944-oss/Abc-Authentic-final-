// Sidebar-unified-orders: GET /api/admin/unified-services.
// Merges orders + engine_jobs instant-delivery records +
// bdris_applications application rows into one date-DESC list.
// Terminology: delivery/application rows are never called
// orders in code, comments, or labels below.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../utils/whatsapp', () => ({
  notifyServiceCompleted: jest.fn().mockResolvedValue({ ok: true }),
  notifyServiceRejected: jest.fn().mockResolvedValue({ ok: true }),
  notifyDeliveryFileAdded: jest.fn().mockResolvedValue({ ok: true }),
  notifyOrderRefunded: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../utils/push', () => ({
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
}));

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
const adminTok = () => auth.signAccess({ id: 'a1', role: 'admin' });
const asAdmin = (r) => r.set('Authorization', 'Bearer ' + adminTok());

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
});

const ORDER_ROW = {
  id: 'o1', created_at: '2026-11-03T10:00:00.000Z', price: 100, status: 'completed',
  user_name: 'Karim', user_phone: '01711111111',
  service_id: 's1', service_engine: 'passport', service_name: 'Passport', service_name_bn: 'পাসপোর্ট সেবা',
  service_type: 'manual', is_manual: true, refund_balance: 25, refund_at: '2026-11-03T11:00:00.000Z',
};
const DELIVERY_ROW = {
  id: 'j1', created_at: '2026-11-03T12:00:00.000Z', engine_id: 'death-final',
  user_name: 'Rahim', user_phone: '01822222222',
};
const APPLICATION_ROW = {
  id: 'a1', created_at: '2026-11-03T11:00:00.000Z', ack_no: 'ACK123', applicant_name: 'Karim',
  user_name: 'Karim', user_phone: '01711111111',
};

function setFixtures(overrides = {}) {
  const f = {
    orderCount: '1', deliveryCount: '1', applicationCount: '1',
    orderRows: [ORDER_ROW], deliveryRows: [DELIVERY_ROW], applicationRows: [APPLICATION_ROW],
    userResolve: [], userTotal: [],
    ...overrides,
  };
  db.__routeQuery([
    ['COUNT(*) FROM orders', { rows: [{ count: f.orderCount }] }],
    ['FROM orders o JOIN users', { rows: f.orderRows }],
    ['COUNT(*) FROM engine_jobs', { rows: [{ count: f.deliveryCount }] }],
    ['FROM engine_jobs j JOIN users', { rows: f.deliveryRows }],
    ['COUNT(*) FROM bdris_applications', { rows: [{ count: f.applicationCount }] }],
    ['FROM bdris_applications a JOIN users', { rows: f.applicationRows }],
    ['FROM users u WHERE', { rows: f.userResolve }],
    ['service_count', { rows: f.userTotal }],
  ]);
}

function callTexts() {
  return db.query.mock.calls.map((c) => c[0]);
}

describe('unified-services: kind merge', () => {
  test('all three kinds present, date DESC, total is the sum of per-source counts', async () => {
    setFixtures();
    const r = await asAdmin(request(app()).get('/api/admin/unified-services')).expect(200);
    expect(r.body.total).toBe(3);
    expect(r.body.page).toBe(1);
    expect(r.body.pages).toBe(1);
    expect(r.body.userTotal).toBeNull();
    expect(r.body.rows.map((x) => x.kind)).toEqual(['delivery', 'application', 'order']);
    expect(r.body.rows.map((x) => x.kind_label)).toEqual(['ডেলিভারি', 'আবেদন', 'অর্ডার']);
    const [delivery, application, order] = r.body.rows;
    expect(delivery).toMatchObject({ price: 0, status: null, service_label: 'মৃত্যু সনদ যাচাই' });
    expect(application).toMatchObject({ price: 0, status: null, service_label: 'জন্ম নিবন্ধন আবেদন' });
    expect(order).toMatchObject({ price: 100, status: 'completed', service_label: 'পাসপোর্ট সেবা' });
    // Order-only list-display fields (badge + refund line); never
    // present on delivery/application rows (see their assertions).
    expect(order).toMatchObject({ service_type: 'manual', is_manual: true, refund_balance: 25 });
    expect(order.refund_at).toBe('2026-11-03T11:00:00.000Z');
    expect(delivery.service_type).toBeUndefined();
    expect(application.refund_balance).toBeUndefined();
    expect(order.created_at).toBe('2026-11-03T10:00:00.000Z');
  });

  test('unknown engine_id falls back to the engine id as service_label', async () => {
    setFixtures({ deliveryRows: [{ ...DELIVERY_ROW, engine_id: 'some-engine' }] });
    const r = await asAdmin(request(app()).get('/api/admin/unified-services')).expect(200);
    expect(r.body.rows[0].service_label).toBe('some-engine');
  });

  test('requires admin auth', async () => {
    setFixtures();
    await request(app()).get('/api/admin/unified-services').expect(401);
  });
});

describe('unified-services: type filters', () => {
  test('type absent = all three sources, no type condition on orders', async () => {
    setFixtures();
    await asAdmin(request(app()).get('/api/admin/unified-services')).expect(200);
    const texts = callTexts();
    expect(texts.some((t) => t.includes('engine_jobs'))).toBe(true);
    expect(texts.some((t) => t.includes('bdris_applications'))).toBe(true);
    // The FILTER lives in the WHERE clause: the COUNT query carries
    // filters only, so it must not mention _manual_form. (The rows
    // SELECT legitimately carries an is_manual display column with
    // the same expression — that is a badge column, not a filter.)
    const countCall = db.query.mock.calls.find((c) => c[0].includes('COUNT(*) FROM orders'));
    expect(countCall[0]).not.toContain('_manual_form');
    expect(countCall[0]).not.toContain("s.type = 'manual'");
  });

  test('type=manual = orders only, with the existing manual rule', async () => {
    setFixtures();
    const r = await asAdmin(request(app()).get('/api/admin/unified-services?type=manual')).expect(200);
    expect(r.body.total).toBe(1);
    expect(r.body.rows.map((x) => x.kind)).toEqual(['order']);
    const texts = callTexts();
    expect(texts.some((t) => t.includes('engine_jobs'))).toBe(false);
    expect(texts.some((t) => t.includes('bdris_applications'))).toBe(false);
    expect(texts.some((t) => t.includes("s.type = 'manual'"))).toBe(true);
    expect(texts.some((t) => t.includes('_manual_form'))).toBe(true);
  });

  test('type=auto = orders with the existing auto rule + delivery + application rows', async () => {
    setFixtures();
    const r = await asAdmin(request(app()).get('/api/admin/unified-services?type=auto')).expect(200);
    expect(r.body.total).toBe(3);
    expect(r.body.rows.map((x) => x.kind)).toEqual(['delivery', 'application', 'order']);
    const texts = callTexts();
    expect(texts.some((t) => t.includes("s.type != 'manual'"))).toBe(true);
    expect(texts.some((t) => t.includes("NOT (o.data::text LIKE '%_manual_form%')"))).toBe(true);
    expect(texts.some((t) => t.includes('engine_jobs'))).toBe(true);
    expect(texts.some((t) => t.includes('bdris_applications'))).toBe(true);
  });

  test('unknown type behaves like absent (all sources)', async () => {
    setFixtures();
    const r = await asAdmin(request(app()).get('/api/admin/unified-services?type=bogus')).expect(200);
    expect(r.body.total).toBe(3);
  });
});

describe('unified-services: status filter is order-rows only', () => {
  test('status=failed filters orders SQL but delivery/application rows still show', async () => {
    setFixtures();
    const r = await asAdmin(request(app()).get('/api/admin/unified-services?status=failed')).expect(200);
    expect(r.body.rows.map((x) => x.kind)).toEqual(['delivery', 'application', 'order']);
    const orderCall = db.query.mock.calls.find((c) => c[0].includes('FROM orders o JOIN users') && !c[0].includes('COUNT'));
    expect(orderCall[0]).toContain('o.status = $');
    expect(orderCall[1]).toContain('failed');
    const deliveryCall = db.query.mock.calls.find((c) => c[0].includes('FROM engine_jobs j JOIN users') && !c[0].includes('COUNT'));
    expect(deliveryCall[0]).not.toContain('status');
    const appCall = db.query.mock.calls.find((c) => c[0].includes('FROM bdris_applications a JOIN users') && !c[0].includes('COUNT'));
    expect(appCall[0]).not.toContain('status');
  });
});

describe('unified-services: user search + userTotal', () => {
  test('q uses digit-only phone equivalence in the orders query params', async () => {
    setFixtures({
      userResolve: [{ id: 'u1', name: 'Karim', phone: '01711111111' }],
      userTotal: [{ service_count: '1', total_money: '100' }],
    });
    await asAdmin(request(app()).get('/api/admin/unified-services?q=0171%20111-1111')).expect(200);
    const orderCall = db.query.mock.calls.find((c) => c[0].includes('FROM orders o JOIN users') && !c[0].includes('COUNT'));
    expect(orderCall[1]).toContain('%01711111111%');
    expect(orderCall[1]).toContain('%0171 111-1111%');
    expect(orderCall[0]).toContain("regexp_replace(u.phone, '[^0-9]', '', 'g')");
  });

  test('userTotal = completed/delivered orders only, never double-counted with delivery rows', async () => {
    // Karim has TWO merged rows (one order + one delivery) but the
    // kept-money aggregate counts only his ONE completed order.
    setFixtures({
      orderRows: [ORDER_ROW],
      deliveryRows: [{ ...DELIVERY_ROW, user_name: 'Karim', user_phone: '01711111111' }],
      applicationRows: [],
      orderCount: '1', deliveryCount: '1', applicationCount: '0',
      userResolve: [{ id: 'u1', name: 'Karim', phone: '01711111111' }],
      userTotal: [{ service_count: '1', total_money: '100' }],
    });
    const r = await asAdmin(request(app()).get('/api/admin/unified-services?q=Karim')).expect(200);
    expect(r.body.rows.filter((x) => x.user_name === 'Karim')).toHaveLength(2);
    expect(r.body.userTotal).toEqual({
      user_name: 'Karim', user_phone: '01711111111', service_count: 1, total_money: 100,
    });
    const sumCall = db.query.mock.calls.find((c) => c[0].includes('service_count'));
    expect(sumCall[0]).toContain("o.status IN ('completed', 'delivered')");
    expect(sumCall[1]).toEqual(['u1']);
  });

  test('userTotal is null when q matches no user (service-name-only search)', async () => {
    setFixtures();
    const r = await asAdmin(request(app()).get('/api/admin/unified-services?q=পাসপোর্ট')).expect(200);
    expect(r.body.userTotal).toBeNull();
  });

  test('userTotal with no completed/delivered orders returns zeros, not null', async () => {
    setFixtures({
      userResolve: [{ id: 'u1', name: 'Karim', phone: '01711111111' }],
      userTotal: [],
    });
    const r = await asAdmin(request(app()).get('/api/admin/unified-services?q=Karim')).expect(200);
    expect(r.body.userTotal).toEqual({
      user_name: 'Karim', user_phone: '01711111111', service_count: 0, total_money: 0,
    });
  });
});

describe('unified-services: pagination', () => {
  test('page 1 and page 2 slice the merged date-DESC list; pages from total', async () => {
    setFixtures();
    const p1 = await asAdmin(request(app()).get('/api/admin/unified-services?limit=2&page=1')).expect(200);
    expect(p1.body).toMatchObject({ total: 3, page: 1, pages: 2 });
    expect(p1.body.rows.map((x) => x.kind)).toEqual(['delivery', 'application']);
    const p2 = await asAdmin(request(app()).get('/api/admin/unified-services?limit=2&page=2')).expect(200);
    expect(p2.body).toMatchObject({ total: 3, page: 2, pages: 2 });
    expect(p2.body.rows.map((x) => x.kind)).toEqual(['order']);
  });

  test('empty result: total 0, pages 0, rows []', async () => {
    setFixtures({ orderCount: '0', deliveryCount: '0', applicationCount: '0', orderRows: [], deliveryRows: [], applicationRows: [] });
    const r = await asAdmin(request(app()).get('/api/admin/unified-services')).expect(200);
    expect(r.body).toEqual({ rows: [], total: 0, page: 1, pages: 0, userTotal: null });
  });
});

describe('unified-services: audit #67 — each source capped at offset+limit', () => {
  test('all three source SELECTs carry a LIMIT, cap = offset+limit', async () => {
    setFixtures();
    await asAdmin(request(app()).get('/api/admin/unified-services?limit=2&page=1')).expect(200);
    const calls = db.query.mock.calls;
    const sourceCall = (key) => calls.find((c) => c[0].includes(key) && c[0].includes('ORDER BY'));
    // page 1, limit 2 -> offset 0, cap 2
    for (const key of ['FROM orders o JOIN users', 'FROM engine_jobs j JOIN users', 'FROM bdris_applications a JOIN users']) {
      const call = sourceCall(key);
      expect(call[0]).toMatch(/ORDER BY \w+\.created_at DESC LIMIT \$\d+/);
      expect(call[1][call[1].length - 1]).toBe(2);
    }
  });

  test('page 2 cap grows with the offset (offset+limit, not just limit)', async () => {
    setFixtures();
    await asAdmin(request(app()).get('/api/admin/unified-services?limit=50&page=2')).expect(200);
    const calls = db.query.mock.calls;
    const orderCall = calls.find((c) => c[0].includes('FROM orders o JOIN users') && c[0].includes('ORDER BY'));
    expect(orderCall[0]).toMatch(/LIMIT \$\d+/);
    // offset 50 + limit 50 = 100
    expect(orderCall[1][orderCall[1].length - 1]).toBe(100);
  });
});
