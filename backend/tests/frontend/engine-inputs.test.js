const fs = require('fs');
const path = require('path');
const vm = require('vm');
const script = fs.readFileSync(path.join(__dirname, '../../../frontend/js/engine-inputs.js'), 'utf8');
function setup() {
  let labels = [], observer;
  const make = () => {
    const input = { disabled: false, click: jest.fn() };
    const label = { dataset: {}, setAttribute: jest.fn(), querySelector: () => input, addEventListener: jest.fn((name, handler) => { label.key = handler; }) };
    labels.push(label); return { label, input };
  };
  const first = make();
  vm.runInNewContext(script, { document: { readyState: 'complete', body: {}, querySelectorAll: () => labels }, MutationObserver: class { constructor(fn) { observer = fn; } observe() {} } });
  return { ...first, make, observe: () => observer() };
}
test.each(['Enter', ' '])('%s opens the original file picker once', key => {
  const { label, input } = setup();
  label.key({ target: label, key, preventDefault: jest.fn() });
  expect(input.click).toHaveBeenCalledTimes(1);
});
test('disabled uploads and repeated keystrokes never open picker', () => {
  const { label, input } = setup(); input.disabled = true;
  label.key({ target: label, key: 'Enter', preventDefault() {} }); input.disabled = false;
  label.key({ target: label, key: 'Enter', repeat: true, preventDefault() {} });
  expect(input.click).not.toHaveBeenCalled();
});
test('dynamic photo uploads attach once without replacing change handlers', () => {
  const s = setup(); const dynamic = s.make(); s.observe(); s.observe();
  dynamic.label.key({ target: dynamic.label, key: 'Enter', preventDefault() {} });
  expect(dynamic.input.click).toHaveBeenCalledTimes(1);
  expect(dynamic.label.addEventListener).toHaveBeenCalledTimes(1);
});