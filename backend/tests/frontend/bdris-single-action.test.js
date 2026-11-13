const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('one deliberate application button click invokes its action exactly once', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../../frontend/bdris-apply.html'), 'utf8');
  const start = html.indexOf('function setBtns(list) {');
  const end = html.indexOf('\nfunction clearBtns()', start);
  const buttons = [];
  const row = { innerHTML: '', style: {}, appendChild: b => buttons.push(b) };
  const document = { createElement: () => ({
    listeners: [], addEventListener(event, callback) { this.listeners.push(callback); },
    click() { this.listeners.forEach(f => f()); if (this.onclick) this.onclick(); }
  }) };
  const context = { document, $: () => row };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  let calls = 0;
  context.setBtns([{ html: 'Submit', fn: () => { calls++; } }]);
  buttons[0].click();
  expect(calls).toBe(1);
});