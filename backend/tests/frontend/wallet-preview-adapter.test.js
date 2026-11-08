const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../../frontend/js/wallet-preview-adapter.js'), 'utf8');
function setup(invalid = false) {
  let click;
  let release;
  const observers = [];
  const card = { setAttribute: jest.fn() };
  const expired = { style: { display: 'none' } };
  const button = { disabled: false, textContent: '', addEventListener: (_, fn) => { click = fn; } };
  const context = {
    document: { querySelector: () => button, querySelectorAll: () => [], getElementById: id => id === 'gwErr' ? { textContent: invalid ? 'invalid sender' : '' } : id === 'gwCard' ? card : id === 'gwExpired' ? expired : null },
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    gw: null,
  };
  context.gwStartSession = jest.fn(() => { if (!invalid) context.gw = { submitted: false, done: false }; });
  context.gwAutoMatch = jest.fn(() => new Promise(resolve => { release = () => { context.gw.submitted = true; resolve(); }; }));
  vm.runInNewContext(source, context);
  return { context, button, card, expired, notify: () => observers.forEach(fn => fn()), click: () => click({ preventDefault() {}, stopImmediatePropagation() {} }), release: () => release() };
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
  test('expiry followed by legacy restart unlocks submission without another match', () => {
    const t = setup();
    t.context.gw = { submitted: true, done: false };
    t.notify();
    expect(t.button.disabled).toBe(true);
    t.expired.style.display = 'block';
    t.notify();
    expect(t.card.setAttribute).toHaveBeenLastCalledWith('data-wp-session', 'expired');
    t.context.gw = null;
    t.expired.style.display = 'none';
    t.notify();
    expect(t.button.disabled).toBe(false);
    expect(t.context.gwAutoMatch).not.toHaveBeenCalled();
  });
});
