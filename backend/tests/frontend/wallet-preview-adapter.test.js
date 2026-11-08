const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../../frontend/js/wallet-preview-adapter.js'), 'utf8');
function setup(invalid = false) {
  let click;
  let release;
  const button = { disabled: false, textContent: '', addEventListener: (_, fn) => { click = fn; } };
  const context = {
    document: { querySelector: () => button, querySelectorAll: () => [], getElementById: id => id === 'gwErr' ? { textContent: invalid ? 'invalid sender' : '' } : null },
    MutationObserver: class { observe() {} },
    gw: null,
  };
  context.gwStartSession = jest.fn(() => { if (!invalid) context.gw = { submitted: false, done: false }; });
  context.gwAutoMatch = jest.fn(() => new Promise(resolve => { release = () => { context.gw.submitted = true; resolve(); }; }));
  vm.runInNewContext(source, context);
  return { context, button, click: () => click({ preventDefault() {}, stopImmediatePropagation() {} }), release: () => release() };
}
describe('preview wallet delegates one-action auto to original pipeline', () => {
  test('one click uses original validation and original matcher once', async () => {
    const t = setup(); const first = t.click();
    expect(t.context.gwStartSession).toHaveBeenCalledTimes(1);
    expect(t.context.gwAutoMatch).toHaveBeenCalledTimes(1);
    await t.click();
    expect(t.context.gwAutoMatch).toHaveBeenCalledTimes(1);
    t.release(); await first;
    expect(t.button.disabled).toBe(true);
    await t.click();
    expect(t.context.gwAutoMatch).toHaveBeenCalledTimes(1);
  });
  test('invalid sender or amount never reaches the matcher', async () => {
    const t = setup(true); await t.click();
    expect(t.context.gwStartSession).toHaveBeenCalledTimes(1);
    expect(t.context.gwAutoMatch).not.toHaveBeenCalled();
    expect(t.button.disabled).toBe(false);
  });
});
