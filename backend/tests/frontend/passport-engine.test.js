'use strict';
// Passport engine core regression tests — ported from the user's own zip
// (Passport-Engine/photo-bg-fixed, regression-tests.cjs), run against the
// LIVE frontend/passport.html. UI and image checks are additionally run in
// a real browser. Jest suite (test/expect globals);
// node:assert is kept for the ported assertions.
// PRIVACY: two zip tests tied to the sample's real passport number are NOT
// ported here — the dot-geometry test uses a fake number ('ZZ 0000001')
// with locked expectations from the glyph tables, and the measured
// scan-centres test stays in the user's zip only. No sample identifiers
// (passport numbers, names, DOBs, personal numbers) appear in this file.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '../../../frontend/passport.html'), 'utf8');
const stateMatch = html.match(/<script\b(?=[^>]*\bid="document-state")[^>]*>([\s\S]*?)<\/script>/);
assert.ok(stateMatch, 'embedded model exists');
const original = JSON.parse(stateMatch[1]);
const script = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].find(m => m[2].includes(' const engBusy='))[2];
// The editor IIFE is the script containing the engine core — not the
// first non-JSON script (the head now holds the login-gate script).
const engine = script.slice(script.indexOf(' const engBusy='), script.indexOf(' createFields();createImages();'));
const setTextCode = script.slice(script.indexOf(' function setText('), script.indexOf(' function resetRegion('));
const resetCode = script.slice(script.indexOf(' function resetRegion('), script.indexOf(' function createFields('));

function createHarness() {
  const model = { fields: original.fields.map(f => ({ id:f.id, text:f.text, original:f.original, group:f.group, style:{} })), engine:structuredClone(original.engine || {}) };
  const fields = new Map(model.fields.map(f => [f.id, f]));
  const elements = new Map();
  for (const match of html.slice(0, stateMatch.index).matchAll(/<(input|textarea|select|button|div|p)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tag, attrs, id] = match;
    const listeners = {};
    elements.set(id, { id, type:attrs.match(/\btype="([^"]+)"/)?.[1] || (tag === 'select' ? 'select-one' : 'text'), tagName:tag.toUpperCase(), value:'', checked:false, hidden:false, textContent:'', dataset:{ engine:attrs.match(/\bdata-engine="([^"]+)"/)?.[1] }, validityMessage:'', addEventListener(event, callback) { listeners[event] = callback; }, setCustomValidity(message) { this.validityMessage = message; }, fire(event, arg) { listeners[event]?.(arg); } });
  }
  const document = { getElementById:id => elements.get(id), querySelectorAll:selector => selector === '[data-engine]' ? [...elements.values()].filter(e => e.dataset.engine) : [], activeElement:null };
  const context = vm.createContext({ model, fields, document, window:{}, nodes:new Map(), selected:null, normalize:value => String(value).replace(/[\r\n\t]+/g, ' ').replace(/\u00a0/g, ' '), renderField() {}, baseStyle:() => ({}), selectField() {}, clone:structuredClone, marks:0, notify() {}, $:id => elements.get(id) });
  vm.runInContext('function mark(){marks++;}\n' + setTextCode + resetCode + engine + '\ninitEngine();', context);
  const api = context.window.passportEngine;
  return { api, context, fields, elements,
    field:id => fields.get(id).text,
    input(key, value) { const e = elements.get('eng-' + key); assert.ok(e, key); if(e.type === 'checkbox')e.checked = value; else e.value = value; e.fire(e.type === 'checkbox' || e.tagName === 'SELECT' ? 'change' : 'input'); },
    edit(id, value) { context.setText(id, value); },
    reset(id) { context.resetRegion(id); }
  };
}
function checkDigit(value) {
  return String([...value].reduce((sum, c, i) => sum + (c === '<' ? 0 : parseInt(c, 36)) * [7,3,1][i % 3], 0) % 10);
}
// dotStrip() returns an object built inside the vm context; under Jest a
// direct deepStrictEqual against a literal fails on prototype (cross-realm),
// even though the values match. Compare field by field instead.
function assertDotStrip(h, active, text) {
  const s = h.api.dotStrip();
  assert.equal(s.active, active);
  assert.equal(s.text, text);
}
function checkLine(line) {
  assert.match(line, /^[A-Z0-9<]{44}$/);
  assert.equal(line[9], checkDigit(line.slice(0,9)));
  assert.equal(line[19], checkDigit(line.slice(13,19)));
  assert.equal(line[27], checkDigit(line.slice(21,27)));
  assert.equal(line[42], checkDigit(line.slice(28,42)));
  assert.equal(line[43], checkDigit(line.slice(0,10) + line.slice(13,20) + line.slice(21,43)));
}

// NOTE (2026-11-14): the editor is gone — the selection harness,
// the text-input harness and their five tests were removed with it.
// The form writes through the model (setText / window.passportEngine);
// there is no in-page selection, no panel text input, no caret work.
test('image slots carry no keyboard-focus styling (no editor interaction)', () => {
  assert.ok(!html.includes('.image-slot:focus-visible'), 'no focus outline rule for image slots');
  assert.ok(!html.includes('body:not(.preview)'), 'no preview-state CSS remains');
});
test('entire executable script parses', () => { new vm.Script(script); });
test('paste handler exists ONLY on the form date inputs (copy-paste dates), never on document text', () => {
  assert.ok(script.includes("addEventListener('paste'"), 'date inputs have a paste listener');
  // The paste wiring is a loop over exactly the three date keys.
  const pasteAt = script.indexOf("addEventListener('paste'");
  const around = script.slice(Math.max(0, pasteAt - 400), pasteAt + 400);
  assert.ok(around.includes("['dob','issueDate','expiryDate']"), 'paste loop covers only the three date inputs');
  assert.ok(!around.includes('personal-name'), 'no paste wiring on document fields');
  assert.ok(!script.includes('.contentEditable'), 'slots are never made editable');
  // The export still strips any stray contenteditable from the shell.
  assert.ok(script.includes("shell.querySelectorAll('[contenteditable]')"));
});
test('pasted date strings normalize to ISO (copy-paste dates, 2026-11-15)', () => {
  const h = createHarness();
  const p = h.api.parsePastedDate;
  assert.equal(p('17/12/1979'), '1979-12-17');
  assert.equal(p('17-12-1979'), '1979-12-17');
  assert.equal(p('17.12.1979'), '1979-12-17');
  assert.equal(p('1979-12-17'), '1979-12-17');
  assert.equal(p('17 DEC 1979'), '1979-12-17');
  assert.equal(p('17 dec 1979'), '1979-12-17');
  assert.equal(p('17 December 1979'), '1979-12-17');
  assert.equal(p(' 17/12/1979 '), '1979-12-17');
  assert.equal(p('29/02/2020'), '2020-02-29'); // leap day is real
  assert.equal(p('31/02/1979'), ''); // impossible date
  assert.equal(p('29/02/2019'), ''); // not a leap year
  assert.equal(p('32/13/1979'), '');
  assert.equal(p('hello'), '');
  assert.equal(p(''), '');
});
test('pasting a date into a date input sets it and rebuilds the MRZ', () => {
  const h = createHarness();
  const dob = h.elements.get('eng-dob');
  assert.ok(dob, 'eng-dob exists');
  let prevented = false;
  dob.fire('paste', { clipboardData: { getData: () => '17/12/1979' }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(dob.value, '1979-12-17');
  assert.equal(h.api.state().dob, '1979-12-17');
  assert.equal(h.field('mrz-2').slice(13, 19), '791217');
  checkLine(h.field('mrz-2'));
  // Unparseable paste is left alone — validation still catches it.
  const issue = h.elements.get('eng-issueDate');
  const before = issue.value;
  issue.fire('paste', { clipboardData: { getData: () => 'not a date' }, preventDefault: () => { prevented = true; } });
  assert.equal(issue.value, before);
});
test('no unsaved indicator exists (editor status UI removed)', () => {
  assert.ok(!script.includes('function updateStatus('), 'updateStatus is gone');
  assert.ok(!script.includes('unsaved'), 'no unsaved state in the engine script');
  const h = createHarness();
  h.edit('personal-name', 'TEST SAMPLE PERSON');
  assert.equal(h.field('surname'), 'PERSON');
});
test('signature render defaults are remove-white + trim with no panel controls', () => {
  assert.ok(!script.includes('function updateSignatureOptions('), 'updateSignatureOptions is gone');
  assert.ok(!html.includes('id="signature-remove-white"'), 'no signature panel control');
  assert.ok(!html.includes('id="signature-trim"'), 'no signature trim control');
  assert.equal(original.images.signature.removeWhite, true);
  assert.equal(original.images.signature.trim, true);
  assert.equal(original.images.signature.fit, 'contain');
});
test('no print path exists in the flow (the PDF is the output)', () => {
  assert.ok(!script.includes('function printDocument('), 'printDocument is gone');
  assert.ok(!html.includes('id="print-button"'), 'no print button');
  assert.ok(!script.includes('window.print'), 'no window.print call');
});
test('startup preserves all source text without dirtying', () => { const h=createHarness(); for(const f of original.fields) assert.equal(h.field(f.id),f.text); assert.equal(h.context.marks,0); });
test('ordinary vertical print is not mapped as dotted scan artwork', () => { const h=createHarness(); const mapping=h.api.map().passportNo; assert.ok(mapping.some(([id,transform])=>id==='vertical-passport'&&transform==='printedVertical')); assert.ok(!mapping.some(([,transform])=>/dot/i.test(transform))); });
test('passport preview reads actual printed-region text rather than synthesizing it', () => { const h=createHarness(); h.edit('vertical-passport','ZZ  0000007'); const preview=h.elements.get('eng-passportPreview').textContent; assert.ok(preview.includes('ছাপা     ZZ  0000007')); assert.ok(preview.includes('ডট       ZZ 0000007')); });
test('passport changes disclose the dotted strip auto-edit state', () => { const h=createHarness(); const note=h.elements.get('eng-dotmx-note'); assert.ok(note.textContent.includes('আসল স্ক্যান')); h.input('passportNo','ZZ0000008'); assert.ok(note.textContent.includes('নিজে থেকে বদলানো সক্রিয়')); h.reset('passport-no'); assert.ok(!note.textContent.includes('নিজে থেকে বদলানো সক্রিয়')); });
test('dotted strip stays original scan artwork at startup without dirtying', () => { const h=createHarness(); assertDotStrip(h,false,''); assert.ok(h.elements.get('eng-passportPreview').textContent.includes('ডট       (মূল স্ক্যান)')); assert.equal(h.context.marks,0); });
test('passport change auto-renders the dotted strip', () => { const h=createHarness(); h.input('passportNo','ZZ0000001'); assertDotStrip(h,true,'ZZ 0000001'); assert.ok(h.elements.get('eng-passportPreview').textContent.includes('ডট       ZZ 0000001')); });
test('dotted strip follows direct page edits and restore', () => { const h=createHarness(); h.edit('vertical-passport','ZZ 0000003'); assert.equal(h.api.dotStrip().text,'ZZ 0000003'); h.edit('passport-no','ZZ0000009'); assert.equal(h.api.dotStrip().text,'ZZ 0000009'); h.reset('passport-no'); assert.equal(h.api.dotStrip().active,false); });
test('dotted strip auto-edit toggle preserves original artwork', () => { const h=createHarness(); h.input('passportNo','ZZ0000001'); h.input('dotStripAuto',false); assert.equal(h.api.dotStrip().active,false); assert.equal(h.api.state().dotStripAuto,false); h.input('dotStripAuto',true); assert.equal(h.api.dotStrip().active,true); });
test('cleared passport blanks the dotted strip while auto-edit is on', () => { const h=createHarness(); h.input('passportNo',''); assertDotStrip(h,true,''); assert.ok(h.elements.get('eng-passportPreview').textContent.includes('ডট       (খালি)')); });
test('reapply keeps the dotted strip synchronized', () => { const h=createHarness(); h.input('passportNo','ZZ0000002'); h.api.applyAll(); assertDotStrip(h,true,'ZZ 0000002'); });
test('dot layout reproduces the glyph geometry for a sample number', () => { const h=createHarness(); const L=h.api.dotLayout('ZZ 0000001'); assert.equal(L.dots.length,126); assert.equal(L.dots[0][0],4.5); assert.equal(L.dots[0][1],4.5); assert.ok(Math.abs(L.w-761.2)<1.5); assert.ok(L.dots.some(([u,v])=>Math.abs(u-82.7)<0.01&&v===4.5)); assert.equal(h.api.dotLayout('').dots.length,0); });
test('empty passport fields remain explicit in actual-region preview', () => { const h=createHarness(); h.input('passportNo',''); const preview=h.elements.get('eng-passportPreview').textContent; assert.ok(preview.includes('বাক্স     (খালি)')); assert.ok(preview.includes('ছাপা     (খালি)')); });
test('passport input updates all linked fields', () => { const h=createHarness(); h.input('passportNo','ZZ0000001'); assert.equal(h.field('passport-no'),'ZZ0000001'); assert.equal(h.field('vertical-passport'),'ZZ 0000001'); assert.ok(h.field('mrz-2').startsWith('ZZ0000001')); checkLine(h.field('mrz-2')); });
test('direct passport edit updates form, printed vertical number and MRZ', () => { const h=createHarness(); h.edit('passport-no','ZZ0000002'); assert.equal(h.api.state().passportNo,'ZZ0000002'); assert.equal(h.field('vertical-passport'),'ZZ 0000002'); assert.ok(h.field('mrz-2').startsWith('ZZ0000002')); });
test('direct printed-vertical edit updates the passport source', () => { const h=createHarness(); h.edit('vertical-passport','ZZ 0000003'); assert.equal(h.field('passport-no'),'ZZ0000003'); checkLine(h.field('mrz-2')); });
test('restore region reverse-syncs all dependents', () => { const h=createHarness(); h.input('passportNo','ZZ0000004'); h.reset('passport-no'); assert.equal(h.api.state().passportNo,h.field('passport-no')); assert.equal(h.field('mrz-2').slice(0,9),h.field('passport-no')); });
test('document type is mapped in both directions', () => { const h=createHarness(); h.input('docType','X'); assert.equal(h.field('type'),'X'); assert.equal(h.field('mrz-1')[0],'X'); h.edit('type','P'); assert.equal(h.api.state().docType,'P'); assert.equal(h.field('mrz-1')[0],'P'); });
test('defaults P/BGD flow into the MRZ like typed values (2026-11-15)', () => { const h=createHarness(); h.input('docType','D'); h.input('countryCode','USA'); assert.equal(h.api.buildMrz1().slice(0,5),'D<USA'); h.input('docType','P'); h.input('countryCode','BGD'); assert.equal(h.field('type'),'P'); assert.equal(h.field('country-code'),'BGD'); assert.equal(h.api.buildMrz1().slice(0,5),'P<BGD'); assert.match(h.api.buildMrz1(),/^[A-Z0-9<]{44}$/); });
test('invalid document type is caught by validation', () => { const h=createHarness(); h.input('docType','PP'); assert.ok(h.api.validate().some(x=>x.includes('ধরন একটি লাতিন অক্ষর হতে হবে।'))); h.input('docType','P'); assert.ok(!h.api.validate().some(x=>x.includes('ধরন'))); });
test('first and last name feed surname/given name directly — no splitting (2026-11-15)', () => { const h=createHarness(); h.input('surname','KEEP'); h.input('givenName','NEW EXAMPLE'); assert.equal(h.api.state().surname,'KEEP'); assert.equal(h.api.state().givenName,'NEW EXAMPLE'); assert.equal(h.field('personal-name'),'NEW EXAMPLE KEEP'); assert.equal(h.field('surname'),'KEEP'); assert.equal(h.field('given-name'),'NEW EXAMPLE'); assert.ok(h.field('mrz-1').includes('KEEP<<NEW<EXAMPLE')); assert.match(h.field('mrz-1'),/^[A-Z0-9<]{44}$/); });
test('two-word name feeds document and MRZ directly', () => { const h=createHarness(); h.input('givenName','KARIM UDDIN'); h.input('surname','AHMED'); assert.equal(h.field('personal-name'),'KARIM UDDIN AHMED'); assert.equal(h.field('surname'),'AHMED'); assert.equal(h.field('given-name'),'KARIM UDDIN'); assert.ok(h.field('mrz-1').startsWith('P<BGDAHMED<<KARIM<UDDIN')); assert.match(h.field('mrz-1'),/^[A-Z0-9<]{44}$/); });
test('multi-word given name stays whole — its last word is NOT moved to surname', () => { const h=createHarness(); h.input('givenName','A B C'); h.input('surname','D'); assert.equal(h.api.state().givenName,'A B C'); assert.equal(h.api.state().surname,'D'); assert.equal(h.field('personal-name'),'A B C D'); assert.ok(h.field('mrz-1').includes('D<<A<B<C')); assert.match(h.field('mrz-1'),/^[A-Z0-9<]{44}$/); });
test('single-name applicant: empty surname stays empty, no doubling, MRZ correct', () => { const h=createHarness(); h.input('givenName','RAHIM'); h.input('surname',''); assert.equal(h.api.state().givenName,'RAHIM'); assert.equal(h.api.state().surname,''); assert.equal(h.field('personal-name'),'RAHIM'); assert.equal(h.field('surname'),''); assert.equal(h.field('given-name'),'RAHIM'); assert.ok(h.field('mrz-1').startsWith('P<BGD<<<RAHIM')); assert.match(h.field('mrz-1'),/^[A-Z0-9<]{44}$/); assert.ok(!h.api.validate().some(x=>x.includes('পদবি'))); assert.ok(!h.api.validate().some(x=>x.includes('প্রদত্ত নাম'))); });
test('name section sits after photo-signature and before passport, first name before last name (2026-11-15)', () => { const photoAt=html.indexOf('id="eng-photo-group"'); const nameAt=html.indexOf('নাম <span class="auto-tag">'); const givenAt=html.indexOf('id="eng-givenName"'); const surnameAt=html.indexOf('id="eng-surname"'); const passportAt=html.indexOf('<p class="engine-legend">পাসপোর্ট</p>'); const passportNoAt=html.indexOf('id="eng-passportNo"'); assert.ok(photoAt>-1&&nameAt>photoAt,'name section after photo-signature'); assert.ok(givenAt>nameAt&&surnameAt>givenAt,'first name before last name'); assert.ok(passportAt>surnameAt&&passportNoAt>passportAt,'passport section after name'); assert.ok(!html.includes('id="eng-fullName"'),'no single full-name field'); assert.ok(!html.includes('id="eng-name-auto-row"'),'no hidden auto-split row'); });
test('direct full-name edit derives every name region', () => { const h=createHarness(); h.edit('personal-name','TEST SAMPLE PERSON'); assert.equal(h.field('surname'),'PERSON'); assert.equal(h.field('given-name'),'TEST SAMPLE'); assert.ok(h.field('mrz-1').includes('PERSON<<TEST<SAMPLE')); });
test('public apply feeds a single name field directly', () => { const h=createHarness(); h.elements.get('eng-givenName').value='API TEST'; h.api.apply('givenName'); assert.equal(h.field('given-name'),'API TEST'); assert.equal(h.field('personal-name'),'API TEST MD'); assert.equal(h.field('surname'),'MD'); });
test('reapply preserves manual name and MRZ overrides', () => { const h=createHarness(); h.input('surname','CUSTOM'); h.input('mrz1','P<BGDCUSTOM<<TEST'.padEnd(44,'<')); const line=h.field('mrz-1'); h.api.applyAll(); assert.equal(h.field('surname'),'CUSTOM'); assert.equal(h.field('mrz-1'),line); });
test('new source data clears stale MRZ overrides', () => { const h=createHarness(); h.input('mrz2','<'.repeat(44)); h.input('passportNo','ZZ0000005'); assert.notEqual(h.field('mrz-2'),'<'.repeat(44)); checkLine(h.field('mrz-2')); });
test('same-address edits synchronize document, form and model', () => { const h=createHarness(); h.input('sameEmergency',true); h.input('address1','TEST ADDRESS'); h.input('address2','TEST DISTRICT'); assert.equal(h.field('emergency-address'),'TEST ADDRESS'); assert.equal(h.api.state().emergency1,'TEST ADDRESS'); assert.equal(h.api.state().emergency2,'TEST DISTRICT'); });
test('reapply never restores a stale emergency address', () => { const h=createHarness(); h.input('sameEmergency',true); h.input('address1','NEW ADDRESS'); h.input('address2','NEW DISTRICT'); h.api.applyAll(); assert.equal(h.field('emergency-address'),'NEW ADDRESS'); assert.equal(h.field('emergency-city'),'NEW DISTRICT'); });
test('unchecking same-address retains latest mirrored values', () => { const h=createHarness(); h.input('sameEmergency',true); h.input('address1','LATEST'); h.input('sameEmergency',false); assert.equal(h.elements.get('eng-emergency1').value,'LATEST'); });
test('direct emergency override explicitly unlinks addresses', () => { const h=createHarness(); h.input('sameEmergency',true); h.edit('emergency-address','DIFFERENT'); assert.equal(h.api.state().sameEmergency,false); assert.equal(h.api.state().emergency1,'DIFFERENT'); assert.equal(h.elements.get('eng-emergency-box').hidden,false); });
test('independent emergency address survives parent edits', () => { const h=createHarness(); h.input('sameEmergency',false); h.input('emergency1','INDEPENDENT'); h.input('address1','PERMANENT'); assert.equal(h.field('emergency-address'),'INDEPENDENT'); });
test('checkbox-only state changes are dirty', () => { const h=createHarness(); h.input('sameEmergency',true); const marks=h.context.marks; h.input('sameEmergency',false); assert.ok(h.context.marks>marks); });
test('valid leap day reverse-syncs', () => { const h=createHarness(); h.edit('birth-date','29 FEB 2024'); assert.equal(h.api.state().dob,'2024-02-29'); assert.equal(h.field('mrz-2').slice(13,19),'240229'); });
test('invalid dates clear stale derived dates and warn', () => { const h=createHarness(); h.edit('birth-date','31 FEB 2024'); assert.equal(h.api.state().dob,''); assert.equal(h.field('mrz-2').slice(13,19),'<<<<<<'); assert.ok(h.api.validate().some(x=>x.includes('জন্মতারিখ'))); });
test('clearing a page date clears form and MRZ date', () => { const h=createHarness(); h.edit('birth-date',''); assert.equal(h.api.state().dob,''); assert.equal(h.field('mrz-2').slice(13,19),'<<<<<<'); });
test('century leap-year rules are respected', () => { const h=createHarness(); h.edit('birth-date','29 FEB 1900'); assert.equal(h.api.state().dob,''); h.edit('birth-date','29 FEB 2000'); assert.equal(h.api.state().dob,'2000-02-29'); h.edit('birth-date','29 FEB 2100'); assert.equal(h.api.state().dob,''); });
test('ISO dates in text region parse without loss', () => { const h=createHarness(); h.edit('birth-date','2001-12-03'); assert.equal(h.api.state().dob,'2001-12-03'); });
test('date chronology problems are visible', () => { const h=createHarness(); h.input('issueDate','2030-01-01'); h.input('expiryDate','2029-01-01'); assert.ok(h.api.validate().some(x=>x.includes('মেয়াদের তারিখ'))); });
test('partial country code does not shift MRZ positions', () => { const h=createHarness(); h.input('countryCode','B'); assert.equal(h.api.buildMrz1().length,44); assert.equal(h.api.buildMrz1().slice(2,5),'B<<'); checkLine(h.api.buildMrz2()); assert.ok(h.api.validate().some(x=>x.includes('ইস্যুকারী দেশ'))); });
test('issuing country and nationality are independent', () => { const h=createHarness(); h.input('nationality','GBR'); h.input('countryCode','BGD'); assert.equal(h.field('mrz-1').slice(2,5),'BGD'); assert.equal(h.field('mrz-2').slice(10,13),'GBR'); });
test('Bangladeshi nationality maps to BGD', () => { const h=createHarness(); h.input('nationality','Bangladeshi'); assert.equal(h.api.state().nationalityCode,'BGD'); assert.equal(h.field('mrz-2').slice(10,13),'BGD'); });
test('unknown nationality clears stale code until explicit correction', () => { const h=createHarness(); h.input('nationalityCode','USA'); h.input('nationality','Example nationality'); assert.equal(h.api.state().nationalityCode,''); assert.equal(h.field('mrz-2').slice(10,13),'<<<'); h.input('nationalityCode','GBR'); h.api.applyAll(); assert.equal(h.api.state().nationalityCode,'GBR'); });
test('MRZ name characters are constrained and unsupported text warned', () => { const h=createHarness(); h.input('surname',"D’ÁR-CY"); h.input('givenName','TEST'); assert.match(h.api.buildMrz1(), /^[A-Z0-9<]{44}$/); assert.ok(h.api.buildMrz1().includes('DAR<CY')); h.input('surname','পরীক্ষা'); assert.ok(h.api.validate().some(x=>x.includes('লাতিন অক্ষরের পদবি'))); });
test('overlength passport number produces a visible warning', () => { const h=createHarness(); h.input('passportNo','ZZ1234567890'); assert.ok(h.api.validate().some(x=>x.includes('সর্বোচ্চ ৯টি'))); checkLine(h.field('mrz-2')); });
test('manual MRZ override validates length and normalizes line breaks', () => { const h=createHarness(); h.input('mrz1','TEST\nLINE'); assert.equal(h.api.state().mrz1,'TESTLINE'); assert.equal(h.field('mrz-1'),'TESTLINE'); assert.ok(h.api.validate().some(x=>x.includes('MRZ লাইন ১'))); });
test('published checksum example matches known digits', () => { const h=createHarness(); h.input('passportNo','L898902C3'); h.input('dob','1974-08-12'); h.input('expiryDate','2012-04-15'); const line=h.api.buildMrz2(); assert.equal(line[9],'6'); assert.equal(line[19],'2'); assert.equal(line[27],'9'); checkLine(line); });
test('MRZ regeneration restores valid checksums', () => { const h=createHarness(); h.input('mrz2','<'.repeat(44)); h.api.regenerateMRZ(); checkLine(h.field('mrz-2')); });
test('unspecified sex uses the MRZ filler', () => { const h=createHarness(); h.input('sex','<'); assert.equal(h.field('sex'),'<'); assert.equal(h.field('mrz-2')[20],'<'); checkLine(h.field('mrz-2')); });
test('multiple generated synthetic records retain fixed positions and checksums', () => { const h=createHarness(); for(let i=0;i<100;i++){ h.input('passportNo','ZZ'+String(i).padStart(7,'0')); h.input('dob',`${1980+i%30}-${String(i%12+1).padStart(2,'0')}-${String(i%28+1).padStart(2,'0')}`); h.input('expiryDate','2035-12-31'); h.input('nationalityCode',i%2?'BGD':'GBR'); h.input('sex',i%3===0?'<':i%2?'F':'M'); checkLine(h.field('mrz-2')); assert.equal(h.field('mrz-2').slice(10,13),i%2?'BGD':'GBR'); } });

test('scan glyphs J and 7 keep their measured extra dots', () => { const h=createHarness(); assert.equal(h.api.dotLayout('J').dots.length,10); const seven=h.api.dotLayout('7').dots; assert.ok(seven.some(([u,v])=>Math.abs(u-41.1)<0.01&&Math.abs(v-28.9)<0.01)); assert.ok(seven.some(([u,v])=>Math.abs(u-28.9)<0.01&&Math.abs(v-41.1)<0.01)); });

// --- Photo background preservation (scan backdrop plate + offline person cutout) ---
const cutoutCode = script.slice(script.indexOf(' function cutoutMask('), script.indexOf(' async function processPhotoCutout('));
const renderImageCode = script.slice(script.indexOf(' function renderImage('), script.indexOf(' function loadImage('));
const resetImageCode = script.slice(script.indexOf(' function resetImage('), script.indexOf(' function escapeHtml('));
const setImageCode = script.slice(script.indexOf(' async function setImage('), script.indexOf(' function resetImage('));
function syntheticPixels(w, h, paint) { const p = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = paint(x, y); const j = (y * w + x) * 4; p[j] = r; p[j+1] = g; p[j+2] = b; p[j+3] = 255; } return p; }
function runCutoutMask(p, w, h) { const ctx = vm.createContext({}); vm.runInContext(cutoutCode, ctx); return ctx.cutoutMask(p, w, h); }

// Minimal 8-bit RGB PNG reader (node:zlib only) — the photo backdrop plate
// is stored as PNG so its tone can be regression-checked without an image
// library in the test environment.
function decodePngRgb(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') { idat.push(data); }
    else if (type === 'IEND') { break; }
    pos += 12 + len;
  }
  assert.equal(bitDepth, 8, 'plate is 8-bit');
  assert.equal(colorType, 2, 'plate is RGB');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 3, stride = width * bpp;
  const out = Buffer.alloc(width * height * bpp);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[src++];
    const row = raw.subarray(src, src + stride); src += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const dst = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? dst[x - bpp] : 0, b = prev ? prev[x] : 0, c = (x >= bpp && prev) ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
      dst[x] = v;
    }
  }
  return { width, height, data: out };
}

test('embedded model ships the scan photo-window backdrop and cutout default on', () => {
  assert.ok(original.assets.photoBackground.startsWith('data:image/png;base64,'));
  assert.ok(original.assets.photoBackground.length > 5000);
  assert.equal(original.images.photo.cutout, true);
  assert.equal(original.images.photo.cutoutRendered, '');
});
test('photo backdrop plate is tonally even — no dark band behind the cut-out person (2026-11-16)', () => {
  const png = decodePngRgb(Buffer.from(original.assets.photoBackground.split(',')[1], 'base64'));
  assert.equal(png.width, 385);
  assert.equal(png.height, 532);
  const rowMean = (y) => { let s = 0, n = 0; for (let x = 0; x < png.width; x += 4) { const i = (y * png.width + x) * 3; s += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3; n++; } return s / n; };
  const mid = (rowMean(200) + rowMean(300) + rowMean(350)) / 3;
  const bottom = (rowMean(450) + rowMean(480) + rowMean(510)) / 3;
  // Before the fix the bottom rows averaged ~147 against ~184 mid-frame —
  // a grey smudge at the bottom-right of the photo frame behind the new
  // person. The plate's bottom gradient is now levelled to the mid tone.
  assert.ok(Math.abs(bottom - mid) < 12, `photo plate bottom ${bottom.toFixed(1)} vs mid ${mid.toFixed(1)}`);
});
test('hologram overlay is a separate asset from the template seal (2026-11-16)', () => {
  // The lotus emblem was genuinely missing from the template, so it was
  // extracted from the user-provided artwork file; the round government
  // seal was ALREADY in the template as stampOverlay and is untouched.
  assert.ok(original.assets.hologramOverlay.startsWith('data:image/webp;base64,'));
  assert.ok(original.assets.hologramOverlay.length > 5000);
  assert.notEqual(original.assets.hologramOverlay, original.assets.stampOverlay);
  assert.ok(original.assets.stampOverlay.startsWith('data:image/webp;base64,'));
  assert.ok(script.includes("holo.className='hologram-overlay'"));
  assert.ok(script.includes('holo.src=model.assets.hologramOverlay'));
});
test('photo slot backing shows the scan plate in edit and print css (no preview state)', () => {
  assert.ok(html.includes('.image-slot.photo.changed .slot-patch{display:block}'));
  assert.ok(!html.includes('body.preview'), 'no preview state remains');
  const printBlock = html.slice(html.indexOf('@media print{'), html.indexOf('</style>'));
  assert.ok(printBlock.includes('.image-slot.photo.changed .slot-patch{display:block!important}'));
  assert.ok(!/\.image-slot\.photo\.changed\{background:#eef0ea/.test(html), 'flat backing colour must not replace the scan plate');
  assert.ok(script.includes("if(type==='photo')patch.src=model.assets.photoBackground;"));
});
test('cutoutMask separates a flat backdrop from a textured person touching the bottom', () => {
  const w = 64, h = 96;
  const p = syntheticPixels(w, h, (x, y) => (x >= 16 && x < 48 && y >= 30) ? [60 + (x * 7 + y * 13) % 40, 70 + (x * 5 + y * 11) % 35, 80 + (x * 3 + y * 17) % 30] : [240, 240, 240]);
  const mask = runCutoutMask(p, w, h);
  assert.equal(mask.ok, true);
  assert.equal(mask.alpha[2 * w + 2], 0);
  assert.equal(mask.alpha[60 * w + 32], 255);
  assert.ok([...mask.alpha].some(a => a === 180 || a === 235), 'feathered edge alphas exist');
  assert.deepEqual(JSON.parse(JSON.stringify(mask.bg.map(Math.round))), [240, 240, 240]);
});
test('cutoutMask falls back when the background is too textured to flood', () => {
  const w = 64, h = 96;
  const p = syntheticPixels(w, h, (x, y) => { const v = (x * 31 + y * 17 + (x * y) % 7 * 13) % 256; return [v, (v + 40) % 256, (v + 90) % 256]; });
  assert.equal(runCutoutMask(p, w, h).ok, false);
});
test('cutoutMask falls back when the person does not reach the bottom edge', () => {
  const w = 64, h = 96;
  const p = syntheticPixels(w, h, (x, y) => (x >= 16 && x < 48 && y >= 20 && y < 60) ? [60 + (x * 7 + y * 13) % 40, 70 + (x * 5 + y * 11) % 35, 80 + (x * 3 + y * 17) % 30] : [240, 240, 240]);
  assert.equal(runCutoutMask(p, w, h).ok, false);
});
test('renderImage prefers the cutout render and falls back to the uploaded photo (no panel sync)', () => {
  const slotImg = { style:{}, src:'', removeAttribute(){ this.src = ''; } };
  const ctx = vm.createContext({ model:{ images:{ photo:{ data:'DATA', cutout:true, cutoutRendered:'CUT', preserveStamp:true, fit:'cover', x:50, y:50, zoom:1 } }, assets:{ photoOriginal:'ORIG' } }, imageNodes:new Map([['photo', { el:{ classList:{ toggle(){} } }, img:slotImg }]]), syncBusy(){} });
  vm.runInContext(renderImageCode, ctx);
  ctx.renderImage('photo'); assert.equal(slotImg.src, 'CUT'); assert.equal(slotImg.style.objectFit, 'cover'); assert.equal(slotImg.style.objectPosition, '50% 50%');
  ctx.model.images.photo.cutout = false; ctx.renderImage('photo'); assert.equal(slotImg.src, 'DATA');
  ctx.model.images.photo.cutout = true; ctx.model.images.photo.cutoutRendered = ''; ctx.renderImage('photo'); assert.equal(slotImg.src, 'DATA');
  ctx.model.images.photo.data = ''; ctx.renderImage('photo'); assert.equal(slotImg.src, '');
});
test('resetImage restores the photo cutout default and clears the render', () => {
  const ctx = vm.createContext({ model:{ images:{ photo:{ data:'X', cutoutRendered:'Y', cutout:false, fit:'contain', x:1, y:2, zoom:3, preserveStamp:false } } }, imageRevision:{ photo:0 }, renderImage(){}, mark(){} });
  vm.runInContext(resetImageCode, ctx); ctx.resetImage('photo');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.model.images.photo)), { data:'', cutoutRendered:'', cutout:true, fit:'cover', x:50, y:50, zoom:1, preserveStamp:true });
});
test('setImage computes the cutout for photos only while the option is on', async () => {
  let calls = 0;
  const ctx = vm.createContext({ File:class File {}, model:{ slots:{ photo:{}, signature:{} }, images:{ photo:{ data:'', cutout:true, cutoutRendered:'' }, signature:{ data:'', rendered:'', removeWhite:true, trim:true } } }, imageRevision:{ photo:0, signature:0 }, loadImage:async () => ({ naturalWidth:10, naturalHeight:10 }), processPhotoCutout:async () => { calls++; return 'CUT'; }, processSignature:async () => 'SIG', renderImage(){}, mark(){}, clone:structuredClone });
  vm.runInContext(setImageCode, ctx);
  const r = await ctx.setImage('photo', 'data:image/png;base64,QUJD');
  assert.equal(r.type, 'photo'); assert.equal(ctx.model.images.photo.cutoutRendered, 'CUT'); assert.equal(calls, 1);
  ctx.model.images.photo.cutout = false;
  await ctx.setImage('photo', 'data:image/png;base64,QUJD');
  assert.equal(calls, 1);
});
test('photo cutout default stays on in the model (no panel toggle)', () => {
  assert.ok(!script.includes('function updatePhotoOptions('), 'updatePhotoOptions is gone');
  assert.ok(!html.includes('id="photo-cutout"'), 'no photo cutout control');
  assert.equal(original.images.photo.cutout, true);
  assert.equal(original.images.photo.fit, 'cover');
});
test('the photo panel is gone (no cutout control, no panel wiring)', () => {
  assert.ok(!html.includes('id="photo-cutout"'), 'no cutout checkbox in the page');
  assert.ok(!html.includes('id="panel-photo"'), 'no photo panel');
  assert.ok(!script.includes("'photo-cutout'"), 'no cutout wiring in the engine script');
});
