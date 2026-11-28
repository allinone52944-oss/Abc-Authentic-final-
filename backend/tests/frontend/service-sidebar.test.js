const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '../../../frontend', file), 'utf8');

function element(tagName) {
  return {
    tagName,
    children: [],
    attributes: {},
    classList: { add() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}

test('category disclosures contain the service links in serial order and retain the active service', () => {
  const context = {
    URLSearchParams,
    location: { pathname: '/order-create.html', search: '?service=manual&category=nid' },
    window: {},
    document: { readyState: 'loading', addEventListener() {}, createElement: element },
  };
  for (const file of ['js/service-navigation.js', 'js/sidebar-nav.js']) {
    vm.runInNewContext(read(file), context);
  }
  const menu = element('ul');
  const nid = { category_id: 'nid', category_name_bn: 'NID সেবা', category_serial: 1, open: true };
  context.window.ServiceSidebar.renderCategories(menu, [
    { ...nid, id: 'manual', type: 'manual', name_bn: 'সংশোধন সহায়তা', serial: 2 },
    { id: 'tin', category_id: 'tax', category_name_bn: 'কর সেবা', category_serial: 2, engine_id: 'auto-tin' },
    { ...nid, id: 'auto', engine_id: 'nid-auto-server-copy', name_bn: 'অটো সার্ভার কপি', serial: 1 },
  ]);

  const [selectedCategory, otherCategory] = menu.children.map(item => item.children[0]);
  expect(selectedCategory).toMatchObject({ tagName: 'details', open: true });
  expect(otherCategory.open).toBe(false);
  expect(selectedCategory.children[0]).toMatchObject({ tagName: 'summary', textContent: 'NID সেবা' });
  const links = selectedCategory.children[1].children.map(item => item.children[0]);
  expect(links.map(link => link.href)).toEqual([
    '/nid-auto-server-copy.html?service=auto&flow=directory&category=nid',
    '/order-create.html?service=manual&flow=directory&category=nid',
  ]);
  expect(links[1].attributes['aria-current']).toBe('page');
});
