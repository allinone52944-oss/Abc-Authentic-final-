const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../frontend/bdris-apply.html'), 'utf8');
function extract(name, next) { return html.slice(html.indexOf('function ' + name + '('), html.indexOf('\n' + next, html.indexOf('function ' + name + '('))); }
test('a form collection exception never reaches application preparation', () => {
  let prepares = 0; let errors = [];
  const c = { S: { ready: true }, console: { log() {} }, collectAuto() { throw Error('missing field'); }, validateAuto: () => [], showFail: x => { errors = x; }, ensureReady: () => { prepares++; } };
  vm.createContext(c); vm.runInContext(extract('submitAuto', 'function autoPrep()'), c); c.submitAuto();
  expect(prepares).toBe(0); expect(errors.length).toBe(1);
});
test('a validation exception never reaches application preparation', () => {
  let prepares = 0; let errors = [];
  const c = { S: { ready: true, pvMode: true }, console: { log() {} }, validateAuto() { throw Error('invalid state'); }, showFail: x => { errors = x; }, ensureReady: () => { prepares++; } };
  vm.createContext(c); vm.runInContext(extract('submitAuto', 'function autoPrep()'), c); c.submitAuto();
  expect(prepares).toBe(0); expect(errors.length).toBe(1);
});
test('failed charge token stops progress and sends no official submission', async () => {
  const active = new Set(); let sends = 0;
  const c = { S: {}, window: { abcDirectSubmitToken: async () => null }, DIRECT_HTTP_SUBMIT_TIMEOUT_MS: 200000,
    busy() {}, hideFail() {}, hideBanner() {}, noteOff() {}, Date,
    setInterval: () => { active.add(1); return 1; }, clearInterval: id => active.delete(id),
    directHttpPost: () => { sends++; } };
  vm.createContext(c); vm.runInContext('async ' + extract('directSubmit', 'function directSubmitAck('), c);
  await c.directSubmit('fixture-code', false);
  expect(active.size).toBe(0); expect(c.S.otpStage).toBe('code'); expect(sends).toBe(0);
});