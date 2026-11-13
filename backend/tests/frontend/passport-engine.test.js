'use strict';
// Passport engine core regression tests — ported from the user's own zip
// (Passport-Engine/photo-bg-fixed, regression-tests.cjs), run against the
// LIVE frontend/passport.html. UI, image, save/reopen and print checks are
// additionally run in a real browser. Jest suite (test/expect globals);
// node:assert is kept for the ported assertions.
// PRIVACY: two zip tests tied to the sample's real passport number are NOT
// ported here — the dot-geometry test uses a fake number ('ZZ 0000001')
// with locked expectations from the glyph tables, and the measured
// scan-centres test stays in the user's zip only. No sample identifiers
// (passport numbers, names, DOBs, personal numbers) appear in this file.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '../../../frontend/passport.html'), 'utf8');
const stateMatch = html.match(/<script\b(?=[^>]*\bid="document-state")[^>]*>([\s\S]*?)<\/script>/);
assert.ok(stateMatch, 'embedded model exists');
const original = JSON.parse(stateMatch[1]);
const script = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].find(m => !m[1].includes('application/json'))[2];
const engine = script.slice(script.indexOf(' const engBusy='), script.indexOf(' createFields();createImages();'));
const setTextCode = script.slice(script.indexOf(' function setText('), script.indexOf(' function setStyle('));
const resetCode = script.slice(script.indexOf(' function resetRegion('), script.indexOf(' function createFields('));

function createHarness() {
  const model = { fields: original.fields.map(f => ({ id:f.id, text:f.text, original:f.original, group:f.group, style:{} })), engine:structuredClone(original.engine || {}) };
  const fields = new Map(model.fields.map(f => [f.id, f]));
  const elements = new Map();
  for (const match of html.slice(0, stateMatch.index).matchAll(/<(input|textarea|select|button|div|p)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tag, attrs, id] = match;
    const listeners = {};
    elements.set(id, { id, type:attrs.match(/\btype="([^"]+)"/)?.[1] || (tag === 'select' ? 'select-one' : 'text'), tagName:tag.toUpperCase(), value:'', checked:false, hidden:false, textContent:'', dataset:{ engine:attrs.match(/\bdata-engine="([^"]+)"/)?.[1] }, validityMessage:'', addEventListener(event, callback) { listeners[event] = callback; }, setCustomValidity(message) { this.validityMessage = message; }, fire(event) { listeners[event]?.(); } });
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

function createSelectionHarness() {
  const elements = new Map(['field-picker','field-value','style-controls','restore-field','field-info'].map(id => [id,{value:'father',disabled:false,textContent:'Old selection'}]));
  const classList = () => { const classes=new Set(['active']); return {add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k)}; };
  const nodes = new Map([['father',{el:{classList:classList()}}]]), imageNodes = new Map([['photo',{el:{classList:classList()}}]]);
  const context=vm.createContext({elements,nodes,imageNodes,selected:'father',fields:new Map([['father',{text:'TEST FIELD',group:'Test'}]]),document:{querySelectorAll:()=>[]},$:id=>elements.get(id),changed:()=>true,tab() {}});
  vm.runInContext(script.slice(script.indexOf(' function clearSelection('),script.indexOf(' function selectImage(')),context);
  return {context,elements,nodes,imageNodes};
}
function createTextInputHarness(value,start=value.length,end=start,direction='none') {
  const h=createHarness(),input=h.elements.get('field-value');
  Object.assign(input,{value,selectionStart:start,selectionEnd:end,selectionDirection:direction,setSelectionRange(s,e,d){this.selectionStart=s;this.selectionEnd=e;this.selectionDirection=d;}});
  h.context.selected='father';h.context.document.activeElement=input;
  return {...h,input};
}

test('empty picker clears selection and disables text editing and restore', () => {
  const h=createSelectionHarness();h.context.selectField('');
  assert.equal(h.context.selected,null);assert.equal(h.elements.get('field-picker').value,'');
  assert.equal(h.elements.get('field-value').value,'');
  for(const id of ['field-value','style-controls','restore-field'])assert.equal(h.elements.get(id).disabled,true,id);
  assert.equal(h.nodes.get('father').el.classList.contains('active'),false);
  assert.equal(h.imageNodes.get('photo').el.classList.contains('active'),false);
});
test('choosing a valid region after deselection re-enables its editor', () => {
  const h=createSelectionHarness();h.context.selectField('');h.context.selectField('father');
  assert.equal(h.context.selected,'father');assert.equal(h.elements.get('field-value').value,'TEST FIELD');
  assert.equal(h.elements.get('field-value').disabled,false);assert.equal(h.elements.get('style-controls').disabled,false);
  assert.equal(h.nodes.get('father').el.classList.contains('active'),true);
});
test('textarea input normalizes pasted lines in both control and model', () => {
  const h=createTextInputHarness('AUDIT বাংলা\n\tSECOND\u00a0LINE');h.context.editFieldValue();
  assert.equal(h.input.value,'AUDIT বাংলা SECOND LINE');assert.equal(h.field('father'),h.input.value);
  assert.equal(h.api.state().fatherName,h.input.value);
  assert.ok(script.includes("$('field-value').addEventListener('input',editFieldValue)"));
});
test('textarea normalization preserves caret selection and direction', () => {
  const h=createTextInputHarness('AB\n\tCD',4,5,'backward');h.context.editFieldValue();
  assert.equal(h.input.value,'AB CD');assert.equal(h.input.selectionStart,3);assert.equal(h.input.selectionEnd,4);assert.equal(h.input.selectionDirection,'backward');
  h.input.value='AB CD';h.input.setSelectionRange(2,2,'none');h.context.editFieldValue();
  assert.equal(h.input.selectionStart,2);assert.equal(h.input.selectionEnd,2);
});
test('textarea input with no selected region cannot alter the old field', () => {
  const h=createTextInputHarness('SHOULD NOT APPLY'),before=h.field('father');h.context.selected=null;
  h.context.editFieldValue();assert.equal(h.field('father'),before);assert.equal(h.context.marks,0);
});
test('keyboard focus styling covers image slots outside preview', () => {
  assert.ok(/body:not\(\.preview\) \.image-slot:focus-visible\s*\{[^}]*outline:4px solid var\(--focus\)/.test(html),'image slots need a visible keyboard focus outline');
});
test('entire executable script parses', () => { new vm.Script(script); });
test('cross-region paste cannot delete adjacent document regions', () => {
  const body=script.match(/text\.addEventListener\('paste',e=>\{([\s\S]*?)\}\);/)[1];
  let deleted=false, updated='';
  const text={textContent:'ORIGINAL',contains:node=>node==='inside'};
  const context=vm.createContext({text,f:{id:'personal-name'},normalize:String,e:{preventDefault(){},clipboardData:{getData:()=> 'PASTE TEST'}},getSelection:()=>({rangeCount:1,anchorNode:'inside',focusNode:'outside',getRangeAt:()=>({deleteContents(){deleted=true;throw new Error('Cross-region deletion');}})}),setText:(id,value)=>{updated=value;}});
  vm.runInContext(body,context);
  assert.equal(deleted,false);assert.equal(updated,'PASTE TEST');
});
test('settings-only edits display an Unsaved indicator', () => {
  const status={textContent:''}; const code=script.slice(script.indexOf(' function updateStatus('),script.indexOf(' function mark('));
  const ctx=vm.createContext({counts:()=>({text:0,images:0}),$:()=>status,model:{fields:new Array(59)},unsaved:true});
  vm.runInContext(code+'\nupdateStatus();',ctx);assert.ok(status.textContent.endsWith('Unsaved'));
});
test('signature options are dirty before an image is uploaded', async () => {
  const code=script.slice(script.indexOf(' async function updateSignatureOptions('),script.indexOf(' function download('));
  let marks=0;const model={images:{signature:{data:'',rendered:'',removeWhite:true,trim:true}}};
  const ctx=vm.createContext({model,imageRevision:{signature:0},$:id=>({checked:id==='signature-trim'}),renderImage(){},mark(){marks++;},notify(){}});
  vm.runInContext(code,ctx);await ctx.updateSignatureOptions();assert.equal(marks,1);assert.equal(model.images.signature.removeWhite,false);await ctx.updateSignatureOptions();assert.equal(marks,1);
});
test('print waits for pending work, fonts and image decoding', async () => {
  const code=script.slice(script.indexOf(' async function printDocument('),script.indexOf(' async function exportHTML('));
  const order=[];const ctx=vm.createContext({drainImages:async()=>order.push('jobs'),document:{fonts:{get ready(){order.push('fonts');return Promise.resolve();}},querySelectorAll:()=>[{decode:async()=>order.push('image')}],activeElement:{blur(){order.push('blur');}}},model:{fields:[{}]},renderField:()=>order.push('render'),window:{print:()=>order.push('print')},notify:message=>{throw new Error(message);}});
  vm.runInContext(code,ctx);await ctx.printDocument();assert.deepEqual(order,['jobs','fonts','image','blur','render','print']);
});
test('startup preserves all source text without dirtying', () => { const h=createHarness(); for(const f of original.fields) assert.equal(h.field(f.id),f.text); assert.equal(h.context.marks,0); });
test('ordinary vertical print is not mapped as dotted scan artwork', () => { const h=createHarness(); const mapping=h.api.map().passportNo; assert.ok(mapping.some(([id,transform])=>id==='vertical-passport'&&transform==='printedVertical')); assert.ok(!mapping.some(([,transform])=>/dot/i.test(transform))); });
test('passport preview reads actual printed-region text rather than synthesizing it', () => { const h=createHarness(); h.edit('vertical-passport','ZZ  0000007'); const preview=h.elements.get('eng-passportPreview').textContent; assert.ok(preview.includes('PRINTED  ZZ  0000007')); assert.ok(preview.includes('DOT-MX   ZZ 0000007')); });
test('passport changes disclose the dotted strip auto-edit state', () => { const h=createHarness(); const note=h.elements.get('eng-dotmx-note'); assert.ok(note.textContent.includes('scan artwork')); h.input('passportNo','ZZ0000008'); assert.ok(note.textContent.includes('auto-edit সক্রিয়')); h.reset('passport-no'); assert.ok(!note.textContent.includes('auto-edit সক্রিয়')); });
test('dotted strip stays original scan artwork at startup without dirtying', () => { const h=createHarness(); assertDotStrip(h,false,''); assert.ok(h.elements.get('eng-passportPreview').textContent.includes('DOT-MX   (original scan)')); assert.equal(h.context.marks,0); });
test('passport change auto-renders the dotted strip', () => { const h=createHarness(); h.input('passportNo','ZZ0000001'); assertDotStrip(h,true,'ZZ 0000001'); assert.ok(h.elements.get('eng-passportPreview').textContent.includes('DOT-MX   ZZ 0000001')); });
test('dotted strip follows direct page edits and restore', () => { const h=createHarness(); h.edit('vertical-passport','ZZ 0000003'); assert.equal(h.api.dotStrip().text,'ZZ 0000003'); h.edit('passport-no','ZZ0000009'); assert.equal(h.api.dotStrip().text,'ZZ 0000009'); h.reset('passport-no'); assert.equal(h.api.dotStrip().active,false); });
test('dotted strip auto-edit toggle preserves original artwork', () => { const h=createHarness(); h.input('passportNo','ZZ0000001'); h.input('dotStripAuto',false); assert.equal(h.api.dotStrip().active,false); assert.equal(h.api.state().dotStripAuto,false); h.input('dotStripAuto',true); assert.equal(h.api.dotStrip().active,true); });
test('cleared passport blanks the dotted strip while auto-edit is on', () => { const h=createHarness(); h.input('passportNo',''); assertDotStrip(h,true,''); assert.ok(h.elements.get('eng-passportPreview').textContent.includes('DOT-MX   (blank)')); });
test('reapply keeps the dotted strip synchronized', () => { const h=createHarness(); h.input('passportNo','ZZ0000002'); h.api.applyAll(); assertDotStrip(h,true,'ZZ 0000002'); });
test('dot layout reproduces the glyph geometry for a sample number', () => { const h=createHarness(); const L=h.api.dotLayout('ZZ 0000001'); assert.equal(L.dots.length,126); assert.equal(L.dots[0][0],4.5); assert.equal(L.dots[0][1],4.5); assert.ok(Math.abs(L.w-761.2)<1.5); assert.ok(L.dots.some(([u,v])=>Math.abs(u-82.7)<0.01&&v===4.5)); assert.equal(h.api.dotLayout('').dots.length,0); });
test('empty passport fields remain explicit in actual-region preview', () => { const h=createHarness(); h.input('passportNo',''); const preview=h.elements.get('eng-passportPreview').textContent; assert.ok(preview.includes('BOX      (empty)')); assert.ok(preview.includes('PRINTED  (empty)')); });
test('passport input updates all linked fields', () => { const h=createHarness(); h.input('passportNo','ZZ0000001'); assert.equal(h.field('passport-no'),'ZZ0000001'); assert.equal(h.field('vertical-passport'),'ZZ 0000001'); assert.ok(h.field('mrz-2').startsWith('ZZ0000001')); checkLine(h.field('mrz-2')); });
test('direct passport edit updates form, printed vertical number and MRZ', () => { const h=createHarness(); h.edit('passport-no','ZZ0000002'); assert.equal(h.api.state().passportNo,'ZZ0000002'); assert.equal(h.field('vertical-passport'),'ZZ 0000002'); assert.ok(h.field('mrz-2').startsWith('ZZ0000002')); });
test('direct printed-vertical edit updates the passport source', () => { const h=createHarness(); h.edit('vertical-passport','ZZ 0000003'); assert.equal(h.field('passport-no'),'ZZ0000003'); checkLine(h.field('mrz-2')); });
test('restore region reverse-syncs all dependents', () => { const h=createHarness(); h.input('passportNo','ZZ0000004'); h.reset('passport-no'); assert.equal(h.api.state().passportNo,h.field('passport-no')); assert.equal(h.field('mrz-2').slice(0,9),h.field('passport-no')); });
test('document type is mapped in both directions', () => { const h=createHarness(); h.input('docType','X'); assert.equal(h.field('type'),'X'); assert.equal(h.field('mrz-1')[0],'X'); h.edit('type','P'); assert.equal(h.api.state().docType,'P'); assert.equal(h.field('mrz-1')[0],'P'); });
test('full name change clears manual surname and given name', () => { const h=createHarness(); h.input('surname','OVERRIDE'); h.input('givenName','OVERRIDE'); h.input('fullName','NEW EXAMPLE NAME'); assert.equal(h.api.state().surname,'NAME'); assert.equal(h.api.state().givenName,'NEW EXAMPLE'); });
test('direct full-name edit derives every name region', () => { const h=createHarness(); h.edit('personal-name','TEST SAMPLE PERSON'); assert.equal(h.field('surname'),'PERSON'); assert.equal(h.field('given-name'),'TEST SAMPLE'); assert.ok(h.field('mrz-1').includes('PERSON<<TEST<SAMPLE')); });
test('public apply uses the full-name derivation path', () => { const h=createHarness(); h.elements.get('eng-fullName').value='API TEST NAME'; h.api.apply('fullName'); assert.equal(h.field('surname'),'NAME'); assert.equal(h.field('given-name'),'API TEST'); });
test('reapply preserves manual name and MRZ overrides', () => { const h=createHarness(); h.input('surname','CUSTOM'); h.input('mrz1','P<BGDCUSTOM<<TEST'.padEnd(44,'<')); const line=h.field('mrz-1'); h.api.applyAll(); assert.equal(h.field('surname'),'CUSTOM'); assert.equal(h.field('mrz-1'),line); });
test('new source data clears stale MRZ overrides', () => { const h=createHarness(); h.input('mrz2','<'.repeat(44)); h.input('passportNo','ZZ0000005'); assert.notEqual(h.field('mrz-2'),'<'.repeat(44)); checkLine(h.field('mrz-2')); });
test('same-address edits synchronize document, form and model', () => { const h=createHarness(); h.input('sameEmergency',true); h.input('address1','TEST ADDRESS'); h.input('address2','TEST DISTRICT'); assert.equal(h.field('emergency-address'),'TEST ADDRESS'); assert.equal(h.api.state().emergency1,'TEST ADDRESS'); assert.equal(h.api.state().emergency2,'TEST DISTRICT'); });
test('reapply never restores a stale emergency address', () => { const h=createHarness(); h.input('sameEmergency',true); h.input('address1','NEW ADDRESS'); h.input('address2','NEW DISTRICT'); h.api.applyAll(); assert.equal(h.field('emergency-address'),'NEW ADDRESS'); assert.equal(h.field('emergency-city'),'NEW DISTRICT'); });
test('unchecking same-address retains latest mirrored values', () => { const h=createHarness(); h.input('sameEmergency',true); h.input('address1','LATEST'); h.input('sameEmergency',false); assert.equal(h.elements.get('eng-emergency1').value,'LATEST'); });
test('direct emergency override explicitly unlinks addresses', () => { const h=createHarness(); h.input('sameEmergency',true); h.edit('emergency-address','DIFFERENT'); assert.equal(h.api.state().sameEmergency,false); assert.equal(h.api.state().emergency1,'DIFFERENT'); assert.equal(h.elements.get('eng-emergency-box').hidden,false); });
test('independent emergency address survives parent edits', () => { const h=createHarness(); h.input('sameEmergency',false); h.input('emergency1','INDEPENDENT'); h.input('address1','PERMANENT'); assert.equal(h.field('emergency-address'),'INDEPENDENT'); });
test('checkbox-only state changes are dirty', () => { const h=createHarness(); h.input('sameEmergency',true); const marks=h.context.marks; h.input('sameEmergency',false); assert.ok(h.context.marks>marks); });
test('valid leap day reverse-syncs', () => { const h=createHarness(); h.edit('birth-date','29 FEB 2024'); assert.equal(h.api.state().dob,'2024-02-29'); assert.equal(h.field('mrz-2').slice(13,19),'240229'); });
test('invalid dates clear stale derived dates and warn', () => { const h=createHarness(); h.edit('birth-date','31 FEB 2024'); assert.equal(h.api.state().dob,''); assert.equal(h.field('mrz-2').slice(13,19),'<<<<<<'); assert.ok(h.api.validate().some(x=>x.includes('Birth date'))); });
test('clearing a page date clears form and MRZ date', () => { const h=createHarness(); h.edit('birth-date',''); assert.equal(h.api.state().dob,''); assert.equal(h.field('mrz-2').slice(13,19),'<<<<<<'); });
test('century leap-year rules are respected', () => { const h=createHarness(); h.edit('birth-date','29 FEB 1900'); assert.equal(h.api.state().dob,''); h.edit('birth-date','29 FEB 2000'); assert.equal(h.api.state().dob,'2000-02-29'); h.edit('birth-date','29 FEB 2100'); assert.equal(h.api.state().dob,''); });
test('ISO dates in text region parse without loss', () => { const h=createHarness(); h.edit('birth-date','2001-12-03'); assert.equal(h.api.state().dob,'2001-12-03'); });
test('date chronology problems are visible', () => { const h=createHarness(); h.input('issueDate','2030-01-01'); h.input('expiryDate','2029-01-01'); assert.ok(h.api.validate().some(x=>x.includes('Expiry date must not'))); });
test('partial country code does not shift MRZ positions', () => { const h=createHarness(); h.input('countryCode','B'); assert.equal(h.api.buildMrz1().length,44); assert.equal(h.api.buildMrz1().slice(2,5),'B<<'); checkLine(h.api.buildMrz2()); assert.ok(h.api.validate().some(x=>x.includes('Issuing country'))); });
test('issuing country and nationality are independent', () => { const h=createHarness(); h.input('nationality','GBR'); h.input('countryCode','BGD'); assert.equal(h.field('mrz-1').slice(2,5),'BGD'); assert.equal(h.field('mrz-2').slice(10,13),'GBR'); });
test('Bangladeshi nationality maps to BGD', () => { const h=createHarness(); h.input('nationality','Bangladeshi'); assert.equal(h.api.state().nationalityCode,'BGD'); assert.equal(h.field('mrz-2').slice(10,13),'BGD'); });
test('unknown nationality clears stale code until explicit correction', () => { const h=createHarness(); h.input('nationalityCode','USA'); h.input('nationality','Example nationality'); assert.equal(h.api.state().nationalityCode,''); assert.equal(h.field('mrz-2').slice(10,13),'<<<'); h.input('nationalityCode','GBR'); h.api.applyAll(); assert.equal(h.api.state().nationalityCode,'GBR'); });
test('MRZ name characters are constrained and unsupported text warned', () => { const h=createHarness(); h.input('surname',"D’ÁR-CY"); h.input('givenName','TEST'); assert.match(h.api.buildMrz1(), /^[A-Z0-9<]{44}$/); assert.ok(h.api.buildMrz1().includes('DAR<CY')); h.input('surname','পরীক্ষা'); assert.ok(h.api.validate().some(x=>x.includes('Latin-letter surname'))); });
test('overlength passport number produces a visible warning', () => { const h=createHarness(); h.input('passportNo','ZZ1234567890'); assert.ok(h.api.validate().some(x=>x.includes('at most 9'))); checkLine(h.field('mrz-2')); });
test('manual MRZ override validates length and normalizes line breaks', () => { const h=createHarness(); h.input('mrz1','TEST\nLINE'); assert.equal(h.api.state().mrz1,'TESTLINE'); assert.equal(h.field('mrz-1'),'TESTLINE'); assert.ok(h.api.validate().some(x=>x.includes('MRZ line 1'))); });
test('published checksum example matches known digits', () => { const h=createHarness(); h.input('passportNo','L898902C3'); h.input('dob','1974-08-12'); h.input('expiryDate','2012-04-15'); const line=h.api.buildMrz2(); assert.equal(line[9],'6'); assert.equal(line[19],'2'); assert.equal(line[27],'9'); checkLine(line); });
test('MRZ regeneration restores valid checksums', () => { const h=createHarness(); h.input('mrz2','<'.repeat(44)); h.api.regenerateMRZ(); checkLine(h.field('mrz-2')); });
test('unspecified sex uses the MRZ filler', () => { const h=createHarness(); h.input('sex','<'); assert.equal(h.field('sex'),'<'); assert.equal(h.field('mrz-2')[20],'<'); checkLine(h.field('mrz-2')); });
test('multiple generated synthetic records retain fixed positions and checksums', () => { const h=createHarness(); for(let i=0;i<100;i++){ h.input('passportNo','ZZ'+String(i).padStart(7,'0')); h.input('dob',`${1980+i%30}-${String(i%12+1).padStart(2,'0')}-${String(i%28+1).padStart(2,'0')}`); h.input('expiryDate','2035-12-31'); h.input('nationalityCode',i%2?'BGD':'GBR'); h.input('sex',i%3===0?'<':i%2?'F':'M'); checkLine(h.field('mrz-2')); assert.equal(h.field('mrz-2').slice(10,13),i%2?'BGD':'GBR'); } });

test('scan glyphs J and 7 keep their measured extra dots', () => { const h=createHarness(); assert.equal(h.api.dotLayout('J').dots.length,10); const seven=h.api.dotLayout('7').dots; assert.ok(seven.some(([u,v])=>Math.abs(u-41.1)<0.01&&Math.abs(v-28.9)<0.01)); assert.ok(seven.some(([u,v])=>Math.abs(u-28.9)<0.01&&Math.abs(v-41.1)<0.01)); });

// --- Photo background preservation (scan backdrop plate + offline person cutout) ---
const cutoutCode = script.slice(script.indexOf(' function cutoutMask('), script.indexOf(' async function processPhotoCutout('));
const renderImageCode = script.slice(script.indexOf(' function renderImage('), script.indexOf(' function loadImage('));
const resetImageCode = script.slice(script.indexOf(' function resetImage('), script.indexOf(' async function updateSignatureOptions('));
const setImageCode = script.slice(script.indexOf(' async function setImage('), script.indexOf(' function resetImage('));
const photoOptionsCode = script.slice(script.indexOf(' async function updatePhotoOptions('), script.indexOf(' function download('));
function syntheticPixels(w, h, paint) { const p = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = paint(x, y); const j = (y * w + x) * 4; p[j] = r; p[j+1] = g; p[j+2] = b; p[j+3] = 255; } return p; }
function runCutoutMask(p, w, h) { const ctx = vm.createContext({}); vm.runInContext(cutoutCode, ctx); return ctx.cutoutMask(p, w, h); }

test('embedded model ships the scan photo-window backdrop and cutout default on', () => {
  assert.ok(original.assets.photoBackground.startsWith('data:image/webp;base64,'));
  assert.ok(original.assets.photoBackground.length > 5000);
  assert.equal(original.images.photo.cutout, true);
  assert.equal(original.images.photo.cutoutRendered, '');
});
test('photo slot backing shows the scan plate in edit, preview and print css', () => {
  assert.ok(html.includes('.image-slot.photo.changed .slot-patch{display:block}'));
  assert.ok(html.includes('body.preview .image-slot.photo.changed .slot-patch{display:block!important}'));
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
test('renderImage prefers the cutout render and falls back to the uploaded photo', () => {
  const els = new Map(); const el = () => ({ src:'', value:'', checked:false, disabled:false, removeAttribute(){ this.src = ''; } });
  const slotImg = { style:{}, src:'', removeAttribute(){ this.src = ''; } };
  const ctx = vm.createContext({ model:{ images:{ photo:{ data:'DATA', cutout:true, cutoutRendered:'CUT', preserveStamp:true, fit:'cover', x:50, y:50, zoom:1 } }, assets:{ photoOriginal:'ORIG' } }, imageNodes:new Map([['photo', { el:{ classList:{ toggle(){} } }, img:slotImg }]]), $:id => { if (!els.has(id)) els.set(id, el()); return els.get(id); }, syncBusy(){}, updateStatus(){} });
  vm.runInContext(renderImageCode, ctx);
  ctx.renderImage('photo'); assert.equal(slotImg.src, 'CUT'); assert.equal(els.get('photo-cutout').checked, true); assert.equal(els.get('photo-cutout').disabled, false);
  ctx.model.images.photo.cutout = false; ctx.renderImage('photo'); assert.equal(slotImg.src, 'DATA');
  ctx.model.images.photo.cutout = true; ctx.model.images.photo.cutoutRendered = ''; ctx.renderImage('photo'); assert.equal(slotImg.src, 'DATA');
  ctx.model.images.photo.data = ''; ctx.renderImage('photo'); assert.equal(slotImg.src, ''); assert.equal(els.get('photo-cutout').disabled, true); assert.equal(els.get('photo-preview').src, 'ORIG');
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
test('photo cutout toggle recomputes the render and dirties only on option change', async () => {
  let marks = 0; const checkbox = { checked:false };
  const ctx = vm.createContext({ model:{ images:{ photo:{ data:'D', cutout:true, cutoutRendered:'OLD' } } }, imageRevision:{ photo:0 }, $:id => id === 'photo-cutout' ? checkbox : {}, processPhotoCutout:async () => 'CUT', renderImage(){}, mark(){ marks++; }, notify:message => { throw new Error(message); } });
  vm.runInContext(photoOptionsCode, ctx);
  await ctx.updatePhotoOptions(); assert.equal(ctx.model.images.photo.cutout, false); assert.equal(ctx.model.images.photo.cutoutRendered, ''); assert.equal(marks, 1);
  await ctx.updatePhotoOptions(); assert.equal(marks, 1);
  checkbox.checked = true; await ctx.updatePhotoOptions(); assert.equal(ctx.model.images.photo.cutoutRendered, 'CUT'); assert.equal(marks, 2);
});
test('photo panel exposes the cutout control and keeps it busy-safe', () => {
  assert.ok(html.includes('id="photo-cutout"'));
  assert.ok(/for\(const id of \['photo-fit','photo-x','photo-y','photo-zoom','preserve-stamp','photo-cutout'\]\)/.test(script));
  assert.ok(/\$\('photo-cutout'\)\.addEventListener\('change',\(\)=>track\(updatePhotoOptions\(\)\)\)/.test(script));
});
