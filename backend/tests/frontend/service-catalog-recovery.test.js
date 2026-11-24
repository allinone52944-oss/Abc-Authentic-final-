const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(process.env.CATALOG_HTML || path.join(__dirname, '../../../frontend/services.html'), 'utf8');
const start = html.indexOf('async function init()');
const end = html.indexOf('  ALL_SERVICES =', start);
const source = html.slice(start, end) + '\n}';

test.each(['http', 'network', 'bad account', 'bad catalog'])('catalog failure releases loading and exposes recovery after %s failure', async mode => {
  const cat = { innerHTML: 'loading', style: { display: 'none' } };
  const svc = { innerHTML: '', style: { display: '' } };
  const context = {
    ABC: { api: async url => {
      if (url === '/auth/me') return { ok: true, json: async () => mode === 'bad account' ? {} : ({ user: { name: 'Fixture', balance: 250 } }) };
      if (mode === 'network') throw new Error('offline');
      if (mode === 'bad catalog') return { ok: true, json: async () => ({ services: {} }) };
      return { ok: false };
    } },
    document: { getElementById: id => id === 'catView' ? cat : id === 'svcView' ? svc : {} },
    bnNum: String,
    window: {},
  };
  vm.runInNewContext(source, context);
  await context.init();
  expect(cat.innerHTML).not.toBe('loading');
  expect(cat.style.display).toBe('');
  expect(svc.style.display).toBe('none');
});
