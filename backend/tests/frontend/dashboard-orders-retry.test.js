const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../frontend/dashboard.html'), 'utf8');
const start = html.indexOf('async function loadRecentOrders()');
const end = html.indexOf('// Audit #82 — the engine cards', start);
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