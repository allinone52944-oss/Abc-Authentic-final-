const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.resolve(__dirname, '../../../frontend/bdris-apply.html'), 'utf8');
const match = html.match(/const form = (uiId\.startsWith[^;]+);/);
function route(uiId) {
  if (!match) throw new Error('Address routing missing');
  return vm.runInNewContext(match[1], { uiId });
}
test('birthplace zone uses birth form', () => expect(route('g_pu')).toBe('birth'));
test('permanent address zone uses permanent form', () => expect(route('sp_paurasavaUnion')).toBe('perm'));
test('current address zone uses current form', () => expect(route('rp_paurasavaUnion')).toBe('prsnt'));
test('current address ward uses current form', () => expect(route('rp_ward')).toBe('prsnt'));
