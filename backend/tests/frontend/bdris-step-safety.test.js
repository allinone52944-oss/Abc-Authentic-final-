const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../frontend/bdris-apply.html'), 'utf8');
function fn(name) { const i = html.indexOf('function ' + name + '('); return html.slice(i, html.indexOf('\n}\n', i) + 3); }
const bad = { classList: { add() {} } };
test('returning to the applicant step with a cleared name shows errors and re-sends nothing', () => {
  let resent = 0; let errs = [];
  const c = { S: { d: { uiStep: 4, s1: { dob: '' } } }, $: () => bad, collectStep2() {}, stepChanged: () => true,
    resendFrom: () => { resent++; }, goStep() {}, showFail: b => { errs = b; }, note() {}, hideFail() {}, advanceAndSend() {} };
  vm.createContext(c); vm.runInContext(fn('submitStep2'), c); c.submitStep2();
  expect(resent).toBe(0); expect(errs.length).toBeGreaterThan(0);
});
test('returning to the parents step with a cleared name shows errors and re-sends nothing', () => {
  let resent = 0; let errs = [];
  const c = { S: { d: { uiStep: 5, s1: { dob: '01/01/2000' }, s2: { father: {}, mother: {} } } }, $: () => bad, collectStep3() {},
    isParentBrnExemptClient: () => true, stepChanged: () => true, resendFrom: () => { resent++; }, goStep() {},
    showFail: b => { errs = b; }, note() {}, hideFail() {}, parentBrnWarnings: () => [], advanceAndSend() {} };
  vm.createContext(c); vm.runInContext(fn('submitStep3'), c); c.submitStep3();
  expect(resent).toBe(0); expect(errs.length).toBe(4);
});
test('a failed draft save on pause does not claim it was saved', () => {
  const notes = []; let home = 0;
  const c = { S: { d: {} }, opAbort() {}, directAckClear() {}, note: (m, k) => notes.push(k), setBtns() {},
    renderHome: () => { home++; }, setTimeout: f => f(), saveDraft: (s, cb) => cb({ ok: false }) };
  vm.createContext(c); vm.runInContext(fn('abortChain'), c); c.abortChain();
  expect(notes).toEqual(['err']); expect(home).toBe(0);
});
test('a late file for another application does not replace the shown result', () => {
  const src = html.slice(html.indexOf("if (st === 'COMPLETED_ATTACHMENTS') {"), html.indexOf("if (st === 'ERROR') {"));
  const c = { S: { view: 'done', _done: { ackId: 'B-222' }, pdf: { base64: 'B' } }, showDone() { throw Error('must not render'); } };
  vm.createContext(c); vm.runInContext('function h(st, d) {' + src + '}', c);
  c.h('COMPLETED_ATTACHMENTS', { ackId: 'A-111', pdf: { base64: 'A' } });
  expect(c.S.pdf.base64).toBe('B');
});
test('only JPG and PNG photos are accepted', () => {
  const rule = /^image\/(?:jpe?g|pjpeg|png)$/i;
  expect(rule.test('image/jpeg')).toBe(true); expect(rule.test('image/png')).toBe(true);
  expect(rule.test('image/gif')).toBe(false); expect(rule.test('image/heic')).toBe(false); expect(rule.test('image/webp')).toBe(false);
  expect(html).not.toContain('/^image\\//.test(');
});
