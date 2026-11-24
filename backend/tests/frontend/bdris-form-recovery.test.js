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

test('starting a new filing clears the old draft and its charge reference', () => {
  const c = {
    S: { draftId: 'old-draft', _submitKey: 'old-charge', _submitTok: 'old-receipt', d: { s1: { firstNameBn: 'পুরোনো' } } },
    setDraftId(id) { c.S.draftId = id; },
    sessionStorage: { removeItem: jest.fn() },
    resetSent: jest.fn(),
    goStep: jest.fn(),
  };
  vm.createContext(c);
  vm.runInContext(extract('freshData', 'function goStep(n)'), c);
  c.startManual();
  expect(c.S).toMatchObject({ draftId: null, _submitKey: null, _submitTok: null, otpStage: 'review' });
  expect(c.S.d.s1.firstNameBn).toBeUndefined();
  expect(c.goStep).toHaveBeenCalledWith(1);
});

test('a draft save that finishes after switching forms cannot attach its id to the new form', async () => {
  let finish;
  const c = {
    S: { mode: 'manual', d: { s1: {} } },
    curAccessToken: () => 'fixture',
    docsMetaOf: () => [],
    socket: { connected: true },
    fetch: jest.fn(),
    setDraftId: jest.fn(),
    updDraftsCnt: jest.fn(),
  };
  vm.createContext(c);
  vm.runInContext(extract('draftPayload', '/* খসড়ায় ছবিসহ'), c);
  vm.runInContext(extract('saveDraft', '/* FINAL-SOLUTION'), c);
  c.emitDraftOp = (_event, draft, cb) => { finish = () => cb({ ok: true, draftId: draft.draftId }); };
  const result = c.saveDraft(2);
  await Promise.resolve();
  c.S.d = { s1: { firstNameBn: 'নতুন' } };
  finish();
  await result;
  expect(c.setDraftId).not.toHaveBeenCalled();
  expect(c.fetch).not.toHaveBeenCalled();
});

test('returning to the address step validates edits before re-sending it', () => {
  const c = {
    S: { d: { uiStep: 5, s2b: { permCopy: true, presCopy: false, pres: { division: 'ঢাকা' } } } },
    collectStep4: jest.fn(),
    $: () => null,
    showFail: jest.fn(),
    hideFail: jest.fn(),
    note: jest.fn(),
    stepChanged: () => true,
    payloadFor: jest.fn(),
    resendFrom: jest.fn(),
    goStep: jest.fn(),
  };
  vm.createContext(c);
  const start = html.indexOf('function submitStep4()');
  vm.runInContext(html.slice(start, html.indexOf('\n}', start) + 2), c);
  c.submitStep4();
  expect(c.showFail).toHaveBeenCalled();
  expect(c.resendFrom).not.toHaveBeenCalled();
  expect(c.goStep).not.toHaveBeenCalled();
});
