const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../frontend/bdris-apply.html'), 'utf8');
const start = html.indexOf('function submitAuto(');
const src = html.slice(start, html.indexOf('\nfunction autoPrep()', start));
function ctx() {
  const queued = []; const chains = []; const notes = [];
  const c = { S: { pvMode: true }, console: { log() {} }, validateAuto: () => [], hideFail() {}, parentBrnWarnings: () => [],
    note: m => notes.push(m), showFail() {}, el: () => null, OPS: ['x'],
    ensureReady: cb => queued.push(cb), saveDraft: (s, cb) => cb(), runChain: () => chains.push(1), autoPrep() {},
    setTimeout: () => 1, clearTimeout() {} };
  vm.createContext(c); vm.runInContext(src, c);
  return { c, queued, chains, notes };
}
test('two quick submit clicks start only one preparation', () => {
  const t = ctx();
  t.c.submitAuto(); t.c.submitAuto();
  expect(t.queued.length).toBe(1);
  t.queued.forEach(cb => cb());
  expect(t.chains.length).toBe(1);
});
test('submit can start again after the first preparation has begun', () => {
  const t = ctx();
  t.c.submitAuto(); t.queued[0]();
  t.c.submitAuto();
  expect(t.queued.length).toBe(2);
});
test('failed validation does not lock the submit button', () => {
  const t = ctx();
  t.c.validateAuto = () => ['ওয়ার্ড'];
  t.c.submitAuto();
  t.c.validateAuto = () => [];
  t.c.submitAuto();
  expect(t.queued.length).toBe(1);
});
