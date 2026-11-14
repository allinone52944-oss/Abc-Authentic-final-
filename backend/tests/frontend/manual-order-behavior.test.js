const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../frontend/order-create.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>')).replace(/\ninit\(\);/, '\n');
function setup({ jsonFields = false, fail = false, engine = null, fallback = false, docs = [], sample = null } = {}) {
  const fields = [{ name: 'applicant_name', label: 'আবেদনকারীর নাম', required: true }];
  const elements = new Map();
  const element = () => ({ style: {}, value: '', textContent: '', innerHTML: '', disabled: false, dataset: {}, addEventListener() {}, scrollIntoView() {}, focus() {}, classList: { add() {}, remove() {} } });
  const input = element(); input.dataset.field = 'applicant_name'; input.closest = () => ({ textContent: 'আবেদনকারীর নাম *' });
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  const context = vm.createContext({ console: { error() {}, warn() {} }, URLSearchParams, ABCPromo: {mount() {}}, location: { search: '?service=test' }, sessionStorage: store, localStorage: store, crypto: { randomUUID: () => 'test-id' },
    document: { getElementById: get, querySelector: selector => selector === '.card' ? element() : null, querySelectorAll: selector => selector === '[data-field]' ? [input] : [] },
    ABC: { api: async url => { if (fail && url.startsWith('/services/')) throw new Error('offline'); return { ok: true, json: async () => url === '/auth/me' ? { user: { id: 'test-user', name: 'Test Applicant', balance: 500 } } : url.startsWith('/services/') ? { service: { engine_id: engine, price: 100, fields_required: fallback ? [] : (jsonFields ? JSON.stringify(fields) : fields), documents_required: docs, manual_sample: sample } } : { service_credits: [] } }; } }
  });
  context.window = context;
  vm.runInContext(script, context);
  return { context, input, get };
}
test('applicant profile fills an empty own-name field', async () => {
  const { context, input } = setup(); await vm.runInContext('init()', context); expect(input.value).toBe('Test Applicant');
});
test('JSON-encoded admin fields can be reviewed with fee 100 and remaining wallet 400', async () => {
  const { context, input, get } = setup({ jsonFields: true }); await vm.runInContext('init()', context); input.value = 'Applicant';
  expect(() => vm.runInContext('showReview()', context)).not.toThrow(); expect(get('reviewBox').style.display).toBe('block');
  expect(vm.runInContext('feeSplit(100).fromBalance', context)).toBe(100); expect(get('reviewConfirmBtn').disabled).toBe(false);
});
test('failed service load leaves review disabled', async () => {
  const { context, get } = setup({ fail: true }); await vm.runInContext('init()', context); expect(get('submitBtn').disabled).toBe(true);
});
test('saved draft wins over applicant profile', async () => {
  const { context, input } = setup(); context.ABC.Drafts = { get: () => ({ applicant_name: 'Saved applicant' }) }; await vm.runInContext('init()', context); expect(input.value).toBe('Saved applicant');
});
test('different signed-in accounts never restore the same service draft', async () => {
  const seen = [];
  for (const id of ['user-a', 'user-b']) {
    const { context } = setup(); const api = context.ABC.api;
    context.ABC.api = async url => { const response = await api(url); if (url === '/auth/me') return { ok: true, json: async () => ({ user: { id, name: 'Applicant', balance: 500 } }) }; return response; };
    context.ABC.Drafts = { get: key => { seen.push(key); return null; } }; await vm.runInContext('init()', context);
  }
  expect(seen).toEqual(['order_user-a_test', 'order_user-b_test']);
});

test('engine checkout redirects to service entry instead of a manual order', async () => { const {context,get}=setup({engine:'qr-photo-verify'}); await vm.runInContext('init()',context); expect(context.location.href).toBe('/service-detail.html?id=test'); expect(get('submitBtn').disabled).toBe(true); });

test('B1#4/B2#9 — fallback placeholder never asks for a mobile number', async () => {
  const { context, get } = setup({ fallback: true });
  await vm.runInContext('init()', context);
  const html = get('fieldsContainer').innerHTML;
  expect(html).toContain('manualDetailsInput');
  expect(html).not.toContain('মোবাইল');
  expect(html).toContain('এখানে আপনার প্রয়োজনীয় তথ্য লিখে পূরণ করুন');
});

test('B1#4/B2#9 — fallback with a sample still never asks for a mobile number', async () => {
  const { context, get } = setup({ fallback: true, sample: 'নাম:\nNID নম্বর:\nজন্ম তারিখ:' });
  await vm.runInContext('init()', context);
  const html = get('fieldsContainer').innerHTML;
  expect(html).toContain('নমুনা ফরম্যাট (শুধু দেখার জন্য)');
  expect(html).not.toContain('মোবাইল');
});

test('B1#4/B2#9 — optional doc renders (ঐচ্ছিক) without *, required keeps *', async () => {
  const { context, get } = setup({ fallback: true, docs: ['জাতীয় পরিচয়পত্র', { name: 'পাসপোর্ট কপি', required: false }] });
  await vm.runInContext('init()', context);
  const html = get('namedDocs').innerHTML;
  expect(html).toContain('জাতীয় পরিচয়পত্র');
  expect(html).toContain('পাসপোর্ট কপি');
  expect(html).toContain('(ঐচ্ছিক)');
  expect(html).toContain('data-doctype="পাসপোর্ট কপি"');
  expect(html).not.toContain('[object Object]');
  // The required doc carries the red *; the optional one must not get one.
  const reqIdx = html.indexOf('জাতীয় পরিচয়পত্র');
  expect(html.slice(reqIdx, reqIdx + 120)).toContain('color:#ef4444;">*</span>');
  const optIdx = html.indexOf('পাসপোর্ট কপি');
  expect(html.slice(optIdx, optIdx + 120)).not.toContain('color:#ef4444;">*</span>');
});
