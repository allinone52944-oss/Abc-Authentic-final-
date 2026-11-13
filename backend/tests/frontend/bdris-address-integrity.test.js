const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../frontend/bdris-apply.html'), 'utf8');
function fn(name) { const i = html.indexOf('function ' + name + '('); return html.slice(i, html.indexOf('\n}\n', i) + 3); }
function sel(opts, value) {
  const options = opts.map(([v, t]) => ({ value: v, text: t }));
  const n = { tagName: 'SELECT', options, value: value || '' };
  Object.defineProperty(n, 'selectedOptions', { get: () => options.filter(o => o.value === n.value) });
  return n;
}
test('changing district removes the old ward ID', async () => {
  const nodes = { g_dist: sel([['', '--'], ['d2', 'গাজীপুর']], 'd2'), g_ward: sel([['', '--']]) };
  const c = { $: id => nodes[id], GEO_LEVELS: [{ k: 'district', ui: 'g_dist' }, { k: 'ward', ui: 'g_ward' }],
    S: { d: {} }, setGeoState() {}, getGeoState: () => 'loaded', note() {}, noteOff() {}, geoLoad: async () => {}, geoMirror: async () => {} };
  c.levelOf = (k, Ls) => Ls.find(L => L.k === k);
  vm.createContext(c); vm.runInContext('async ' + fn('geoChanged'), c);
  const data = { district: 'ঢাকা', districtId: 'd1', ward: 'ওয়ার্ড - ১', wardId: 'w-old' };
  await c.geoChanged('district', c.GEO_LEVELS, data);
  expect(data.districtId).toBe('d2');
  expect(data.wardId).toBeUndefined();
  expect(data.ward).toBe('');
});
test('an ambiguous partial name is not guessed', () => {
  const n = sel([['', '--'], ['dncc', 'ঢাকা উত্তর সিটি কর্পোরেশন'], ['dscc', 'ঢাকা দক্ষিণ সিটি কর্পোরেশন']]);
  const c = { $: () => n }; vm.createContext(c); vm.runInContext(fn('setSelByText'), c);
  expect(c.setSelByText('x', 'ঢাকা')).toBe(false);
  expect(n.value).toBe('');
});
test('an exact name still selects its option', () => {
  const n = sel([['', '--'], ['dncc', 'ঢাকা উত্তর সিটি কর্পোরেশন'], ['dscc', 'ঢাকা দক্ষিণ সিটি কর্পোরেশন']]);
  const c = { $: () => n }; vm.createContext(c); vm.runInContext(fn('setSelByText'), c);
  expect(c.setSelByText('x', 'ঢাকা দক্ষিণ সিটি কর্পোরেশন')).toBe(true);
  expect(n.value).toBe('dscc');
});
test('birthplace ward is required even while its list has not loaded', () => {
  expect(html).toContain("if (!s1.ward) bad.push('ওয়ার্ড');");
  expect(html).not.toContain("wd.options.length > 1 && !wd.value");
});
