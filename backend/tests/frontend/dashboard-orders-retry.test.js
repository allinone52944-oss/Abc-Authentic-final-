const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../frontend/dashboard.html'), 'utf8');
const start = html.indexOf('async function loadRecentOrders()');
const end = html.indexOf('\nconst ENGINE_CARDS', start);
const source = html.slice(start, end);

test.each(['http', 'network'])('both dashboard order panels can retry after %s failure', async mode => {
  const desk = { innerHTML: 'loading' }, mob = { innerHTML: 'loading' };
  const retry = jest.fn(() => 'retry-action');
  const context = {
    ABC: { api: async () => { if (mode === 'network') throw new Error('offline'); return { ok: false }; } },
    document: { getElementById: id => id === 'recentOrdersDesk' ? desk : mob },
    retryBox: retry,
  };
  vm.runInNewContext(source, context);
  await context.loadRecentOrders();
  expect(desk.innerHTML).toBe('retry-action');
  expect(mob.innerHTML).toBe('retry-action');
  expect(retry.mock.calls).toEqual([['loadRecentOrders'], ['loadRecentOrders']]);
});

test('mobile tracking prioritizes a newly placed order over the latest delivery', async () => {
  const mobile = { innerHTML: '' };
  const context = {
    ABC: { api: async () => ({
      ok: true,
      json: async () => ({ orders: [{ id: 'delivered', status: 'delivered' }, { id: 'new-order', status: 'new' }] }),
    }) },
    document: { getElementById: id => id === 'recentOrdersMob' ? mobile : null },
    escapeHtml: String, autoIcon: () => '', STBN: { new: 'নতুন' },
  };
  vm.runInNewContext(source, context);
  await context.loadRecentOrders();
  expect(mobile.innerHTML).toContain('href="/order-detail.html?id=new-order"');
  expect(mobile.innerHTML).toContain('নতুন');
});
