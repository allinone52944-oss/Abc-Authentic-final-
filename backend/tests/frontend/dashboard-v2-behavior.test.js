const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '../../../frontend');
const script = fs.readFileSync(path.join(root, 'js/dashboard-v2.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');

async function history(items) {
  const targets = { dv2HistD: { innerHTML: '' }, dv2HistM: { innerHTML: '' } };
  const context = {
    document: { readyState: 'complete', body: { classList: { add() {} } },
      querySelector: () => null, getElementById: id => targets[id] || null },
    ABC: { api: async () => ({ ok: true, json: async () => ({ items }) }) },
    Date, String, window: {},
  };
  context.window.ABC = context.ABC;
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  return targets.dv2HistD.innerHTML;
}

function ordered(services, query) {
  const start = html.indexOf('function dashboardServices()');
  const end = html.indexOf('\nasync function loadServices()', start);
  const context = { _allServices: services, escapeHtml: String, autoIcon: () => '', bnNum: String,
    document: { getElementById: () => ({ set innerHTML(value) { context.result = value; } }) }, result: '' };
  vm.runInNewContext(html.slice(start, end), context);
  if (query !== undefined) vm.runInNewContext(`onSvcFilter(${JSON.stringify(query)}, 'popularServices')`, context);
  else vm.runInNewContext('result = dashboardServices().map(s => s.id)', context);
  return context.result;
}

test('instant history excludes completed manual/order entries before selecting the last three', async () => {
  const result = await history([
    { kind: 'order', title: 'MANUAL_ORDER', created_at: new Date().toISOString(), documents: [] },
    { kind: 'manual', title: 'MANUAL_SUBMISSION', created_at: new Date().toISOString(), documents: [] },
    ...[1, 2, 3].map(i => ({ kind: 'engine', title: 'ENGINE_' + i, created_at: new Date().toISOString(), documents: [{ url: '/engine-jobs/' + i + '/file' }] })),
  ]);
  expect(result).not.toContain('MANUAL_');
  expect(result).toContain('ENGINE_3');
});

test('submitted automatic registration stays in instant history', async () => {
  const result = await history([{ kind: 'bdris', title: 'REGISTRATION', created_at: new Date().toISOString(), documents: [{ url: '/bdris-apply/file' }] }]);
  expect(result).toContain('REGISTRATION');
});

test('an unsuccessful history entry with no date reports the file status', async () => {
  const result = await history([{ kind: 'engine', title: 'নমুনা — ব্যর্থ', documents: [], created_at: '' }]);
  expect(result).toContain('ফাইল তৈরি হয়নি');
  expect(result).not.toContain('NaN');
  expect(result).not.toContain('চার্জ কাটা হয়নি');
});

test('special service cards use the visible account catalog and its zero price and closure', () => {
  const start = html.indexOf('const ENGINE_CARDS =');
  const end = html.indexOf('function renderServiceGrid', start);
  const targets = { engineGridDesk: { innerHTML: '' }, engineGridMob: { innerHTML: '' } };
  const context = {
    _allServices: [
      { id: 'free', engine_id: 'birth-final', open: true, price: 0 },
      { id: 'closed', engine_id: 'nid-replica', open: false, price: 35 },
      { id: 'hidden', engine_id: 'nid-smart-card', open: true, price: 70, show_on_dashboard: false },
    ],
    document: { getElementById: id => targets[id] },
    window: {}, escapeHtml: String, bnNum: value => Number(value).toLocaleString('bn-BD'),
  };
  vm.runInNewContext(html.slice(start, end) + '\nrenderEngineCards();', context);
  for (const target of Object.values(targets)) {
    expect(target.innerHTML).toContain('৳০');
    expect(target.innerHTML).toContain('সাময়িক বন্ধ');
    expect(target.innerHTML).toContain('/service-detail.html?id=closed');
    expect(target.innerHTML).not.toContain('/nid-smart-card.html');
    expect(target.innerHTML).not.toContain('/nid-server-copy.html');
  }
});

test('highlight does not move a service ahead of the admin serial order', () => {
  const result = ordered([{ id: 'first', serial: 1 }, { id: 'highlight', serial: 2, featured: true }, { id: 'hidden', serial: 0, show_on_dashboard: false }]);
  expect(Array.from(result)).toEqual(['first', 'highlight']);
});

test('dashboard search does not reveal services hidden by admin', () => {
  const result = ordered([{ id: 'hidden', name_bn: 'Secret', show_on_dashboard: false, price: 20 }], 'Secret');
  expect(result).not.toContain('id=hidden');
});
