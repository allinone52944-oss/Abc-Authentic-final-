// Passport engine form-first flow — frontend only (text-reading + vm).
//
// Bug (user-reported 2026-11-13, corrected same day): the page opened
// straight into the editor, and the first fix showed the form INSIDE the
// editor's Engine tab (MRZ lines visible, editor chrome around it).
// Correct flow: landing "Passport তৈরি করুন" → a SEPARATE form screen
// (1st page = form, only what the user fills up — no MRZ auto fields, no
// document preview, no editor chrome) → Create → DIRECT download, then
// the editor for photo/signature fine-tuning. Automation (name auto-split,
// MRZ auto-generation, dates) still runs behind the scenes through the
// engine inputs — it is computed, not displayed. The output itself (MRZ
// TD3, dotted strip, name split, dates, photo/signature slots) is
// untouched — the change is the FLOW only, driven through the exposed
// editor APIs (window.passportEngine / window.documentEditor).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../../../frontend');
const PAGE = fs.readFileSync(path.join(FRONTEND, 'passport.html'), 'utf8');

function inlineScripts(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}
const SCRIPTS = inlineScripts(PAGE);
const FLOW = SCRIPTS[SCRIPTS.length - 1]; // the flow layer is the last script
const MAIN = SCRIPTS[SCRIPTS.length - 2]; // the editor IIFE

// All engine fields the form must expose (FORM_KEYS in the flow script).
const FORM_KEYS = [
  'passportNo', 'docType', 'countryCode', 'fullName', 'surname', 'givenName',
  'fatherName', 'motherName', 'spouseName', 'dob', 'sex', 'issueDate',
  'expiryDate', 'birthPlace', 'nationality', 'nationalityCode', 'personalNo',
  'previousPassport', 'authority', 'address1', 'address2', 'emergency1',
  'emergency2', 'emergencyName', 'phone', 'relationship', 'mrz1', 'mrz2',
];
// What the separate form screen actually SHOWS: only the fields the user
// fills up. surname/givenName (auto-split) and mrz1/mrz2 (auto-generated)
// stay in the DOM as automation targets but are hidden in form state.
const FILLABLE_KEYS = [
  'passportNo', 'docType', 'countryCode', 'fullName',
  'fatherName', 'motherName', 'spouseName', 'dob', 'sex', 'issueDate',
  'expiryDate', 'birthPlace', 'nationality', 'nationalityCode', 'personalNo',
  'previousPassport', 'authority', 'address1', 'address2', 'emergency1',
  'emergency2', 'emergencyName', 'phone', 'relationship',
];

function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toString: () => [...set].join(' '),
  };
}
function makeEl(id, type) {
  const listeners = {};
  const el = {
    id,
    type: type || 'text',
    value: '',
    checked: false,
    textContent: '',
    focused: false,
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    click: () => { (listeners.click || []).forEach((fn) => fn()); },
    fire: (ev, arg) => { (listeners[ev] || []).forEach((fn) => fn(arg || { target: el })); },
    focus: function () { el.focused = true; },
  };
  return el;
}

// Runs ONLY the flow script against a stub DOM + stub editor APIs.
// Returns the stubs so tests can click buttons and inspect state.
function runFlow(opts) {
  const o = opts || {};
  const els = {};
  FORM_KEYS.forEach((k) => { els['eng-' + k] = makeEl('eng-' + k, k === 'sex' ? 'select-one' : 'text'); });
  els['eng-dotStripAuto'] = makeEl('eng-dotStripAuto', 'checkbox');
  els['eng-sameEmergency'] = makeEl('eng-sameEmergency', 'checkbox');
  els['start-passport-button'] = makeEl('start-passport-button', 'button');
  els['create-passport-button'] = makeEl('create-passport-button', 'button');
  els['create-message'] = makeEl('create-message', 'p');
  // Form-screen photo/signature upload controls.
  ['photo', 'signature'].forEach((type) => {
    const input = makeEl('form-' + type + '-upload', 'file');
    input.files = [];
    els['form-' + type + '-upload'] = input;
    els['form-upload-' + type + '-button'] = makeEl('form-upload-' + type + '-button', 'button');
    const status = makeEl('form-' + type + '-status', 'p');
    status.hidden = true;
    els['form-' + type + '-status'] = status;
    const thumb = makeEl('form-' + type + '-thumb', 'img');
    thumb.src = '';
    els['form-' + type + '-thumb'] = thumb;
    els['form-' + type + '-name'] = makeEl('form-' + type + '-name', 'span');
    els['form-remove-' + type] = makeEl('form-remove-' + type, 'button');
  });
  // Template values, as the live page ships them — the form must blank them.
  els['eng-passportNo'].value = 'EJ0762655';
  els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
  els['eng-dob'].value = '1979-12-17';
  els['eng-nationality'].value = 'BANGLADESHI';
  els['eng-dotStripAuto'].checked = true;
  els['eng-sameEmergency'].checked = true;
  const body = {
    classList: makeClassList(o.bodyClasses || ['flow-landing']),
    appendChild: () => {},
  };
  const calls = { applyAll: 0, regenerateMRZ: 0, resetImage: [], exportHTML: 0, setImage: [] };
  const state = { exportedPromise: null, imagePromise: null };
  const downloads = [];
  const anchor = {
    href: '',
    download: '',
    click: function () { downloads.push({ href: anchor.href, name: anchor.download }); },
    remove: function () {},
  };
  const documentStub = {
    body,
    getElementById: (id) => els[id] || null,
    createElement: (tag) => (tag === 'a' ? anchor : {}),
  };
  const sandbox = {
    document: documentStub,
    window: {},
    Blob: function (parts) { this.parts = parts; },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    setTimeout: () => 0,
  };
  if (o.withApi !== false) {
    sandbox.window.passportEngine = {
      applyAll: () => { calls.applyAll += 1; },
      regenerateMRZ: () => { calls.regenerateMRZ += 1; },
    };
  }
  if (o.withEditor !== false) {
    sandbox.window.documentEditor = {
      resetImage: (type) => { calls.resetImage.push(type); },
      setImage: (type, input) => {
        calls.setImage.push({ type, file: input });
        state.imagePromise = o.setImageFails
          ? Promise.reject(new Error('Use PNG, JPEG, or WebP images.'))
          : Promise.resolve({ type });
        return state.imagePromise;
      },
      exportHTML: () => {
        calls.exportHTML += 1;
        state.exportedPromise = Promise.resolve('<html>passport</html>');
        return state.exportedPromise;
      },
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(FLOW, sandbox);
  return { els, body, calls, downloads, state };
}

describe('landing (form-first entry)', () => {
  test('body starts in the landing state', () => {
    expect(PAGE).toContain('<body class="flow-landing">');
  });

  test('landing section with the Passport তৈরি করুন button, before the document area', () => {
    expect(PAGE).toContain('id="passport-landing"');
    expect(PAGE).toContain('id="start-passport-button"');
    expect(PAGE).toContain('Passport তৈরি করুন');
    const landingAt = PAGE.indexOf('id="passport-landing"');
    const docAt = PAGE.indexOf('class="document-area"');
    expect(landingAt).toBeGreaterThan(-1);
    expect(docAt).toBeGreaterThan(landingAt);
  });

  test('landing is hidden by default and shown only in the landing state', () => {
    expect(PAGE).toContain('#passport-landing{display:none}');
    expect(PAGE).toContain('body.flow-landing #passport-landing{display:block}');
  });

  test('landing state hides the toolbar, document, editor and footer', () => {
    expect(PAGE).toContain('body.flow-landing .toolbar,body.flow-landing .document-area,body.flow-landing aside,body.flow-landing .footer-note{display:none}');
  });
});

describe('form (separate form screen)', () => {
  test.each(FORM_KEYS)('engine input eng-%s still exists in the DOM (automation target)', (key) => {
    expect(PAGE).toContain('id="eng-' + key + '"');
  });

  test.each(FILLABLE_KEYS)('form shows fillable field eng-%s', (key) => {
    expect(PAGE).toContain('id="eng-' + key + '"');
    // Every fillable field sits before the MRZ group — none of them is
    // inside a container the form screen hides.
    expect(PAGE.indexOf('id="eng-' + key + '"')).toBeLessThan(PAGE.indexOf('id="eng-mrz-group"'));
  });

  test('form screen has its own heading, shown only in form state', () => {
    expect(PAGE).toContain('id="passport-form-head"');
    expect(PAGE).toContain('.form-head{display:none}');
    expect(PAGE).toContain("body.flow-form .form-head{display:block;margin:0 0 6px}");
    const headAt = PAGE.indexOf('id="passport-form-head"');
    const panelAt = PAGE.indexOf('id="panel-engine"');
    expect(headAt).toBeGreaterThan(panelAt);
    expect(PAGE.slice(headAt, headAt + 400)).toContain('Passport তৈরি করুন');
  });

  test('form screen hides the editor chrome (panel head, tabs) and the helper', () => {
    expect(PAGE).toContain('body.flow-form .panel-head,body.flow-form .tabs{display:none}');
    expect(PAGE).toContain('body.flow-form #panel-engine>.helper{display:none}');
    expect(PAGE).toContain('body.flow-form [data-tab]:not([data-tab="engine"]){display:none}');
    expect(PAGE).toContain('body.flow-form .toolbar,body.flow-form .document-area,body.flow-form .footer-note{display:none}');
  });

  test('form screen hides the MRZ group — the MRZ fields are not shown', () => {
    expect(PAGE).toContain('body.flow-form #eng-mrz-group{display:none}');
    const groupAt = PAGE.indexOf('id="eng-mrz-group"');
    const mrz1At = PAGE.indexOf('id="eng-mrz1"');
    const mrz2At = PAGE.indexOf('id="eng-mrz2"');
    const createAt = PAGE.indexOf('id="create-passport-button"');
    expect(groupAt).toBeLessThan(mrz1At);
    expect(mrz1At).toBeLessThan(mrz2At);
    expect(mrz2At).toBeLessThan(createAt);
  });

  test('form screen hides the auto name-split fields', () => {
    expect(PAGE).toContain('body.flow-form #eng-name-auto-row{display:none}');
    const rowAt = PAGE.indexOf('id="eng-name-auto-row"');
    const surnameAt = PAGE.indexOf('id="eng-surname"');
    const givenAt = PAGE.indexOf('id="eng-givenName"');
    const fatherAt = PAGE.indexOf('id="eng-fatherName"');
    expect(rowAt).toBeLessThan(surnameAt);
    expect(surnameAt).toBeLessThan(givenAt);
    expect(givenAt).toBeLessThan(fatherAt);
  });

  test('form screen hides preview, hints and auto-only controls', () => {
    expect(PAGE).toContain('body.flow-form #eng-passportPreview,body.flow-form #eng-dotmx-note{display:none}');
    expect(PAGE).toContain('body.flow-form #panel-engine .engine-hint:not(#create-message){display:none}');
    expect(PAGE).toContain('body.flow-form .auto-tag{display:none}');
    expect(PAGE).toContain('body.flow-form #eng-dotstrip-row{display:none}');
  });

  test('form state collapses the editor grid to a single column', () => {
    expect(PAGE).toContain('body.flow-form main{grid-template-columns:minmax(0,1fr);max-width:760px}');
  });
});

describe('form photo/signature upload', () => {
  test('form has a photo upload group with file input, button and confirmation state', () => {
    expect(PAGE).toContain('id="eng-photo-group"');
    expect(PAGE).toContain('id="form-photo-upload"');
    expect(PAGE).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(PAGE).toContain('id="form-upload-photo-button"');
    expect(PAGE).toContain('ছবি যোগ করুন');
    expect(PAGE).toContain('id="form-photo-status"');
    expect(PAGE).toContain('id="form-photo-thumb"');
    expect(PAGE).toContain('id="form-photo-name"');
    expect(PAGE).toContain('id="form-remove-photo"');
  });

  test('form has a signature upload group with file input, button and confirmation state', () => {
    expect(PAGE).toContain('id="form-signature-upload"');
    expect(PAGE).toContain('id="form-upload-signature-button"');
    expect(PAGE).toContain('স্বাক্ষর যোগ করুন');
    expect(PAGE).toContain('id="form-signature-status"');
    expect(PAGE).toContain('id="form-signature-thumb"');
    expect(PAGE).toContain('id="form-signature-name"');
    expect(PAGE).toContain('id="form-remove-signature"');
  });

  test('upload group sits inside the Engine panel, after the MRZ group and before Create', () => {
    const groupAt = PAGE.indexOf('id="eng-photo-group"');
    const mrzAt = PAGE.indexOf('id="eng-mrz-group"');
    const createAt = PAGE.indexOf('id="create-passport-button"');
    const panelTextAt = PAGE.indexOf('id="panel-text"');
    expect(groupAt).toBeGreaterThan(mrzAt);
    expect(groupAt).toBeLessThan(createAt);
    expect(createAt).toBeLessThan(panelTextAt);
  });

  test('form state does not hide the upload group — the confirmation stays hidden until a file is chosen', () => {
    expect(PAGE).not.toContain('eng-photo-group{display:none}');
    expect(PAGE).toContain('.form-upload-status[hidden]{display:none}');
    expect(PAGE).toContain('id="form-photo-status" hidden=""');
    expect(PAGE).toContain('id="form-signature-status" hidden=""');
  });

  test('flow script drives the upload through the exposed editor setImage/resetImage APIs', () => {
    expect(FLOW).toContain('editor.setImage(type, file)');
    expect(FLOW).toContain('editor.resetImage(type)');
    expect(FLOW).toContain('URL.createObjectURL(file)');
    expect(FLOW).toContain('form-photo-upload');
    expect(FLOW).toContain('form-signature-upload');
  });

  test('landing and form notes tell the user to add photo/signature in the form', () => {
    expect(PAGE).toContain('ছবি ও স্বাক্ষর ফর্মেই যোগ করুন');
  });
});

describe('Create → download', () => {
  test('Create button + status message sit at the end of the Engine panel, outside the MRZ group', () => {
    expect(PAGE).toContain('id="create-passport-button"');
    expect(PAGE).toContain('Create — ডাউনলোড করুন');
    expect(PAGE).toContain('id="create-message"');
    const createAt = PAGE.indexOf('id="create-passport-button"');
    const remrzAt = PAGE.indexOf('id="eng-remrz"');
    expect(createAt).toBeGreaterThan(remrzAt);
    const panelTextAt = PAGE.indexOf('id="panel-text"');
    expect(createAt).toBeLessThan(panelTextAt);
    // The MRZ group closes before the Create block opens — Create is a
    // sibling of the group, so hiding the group never hides Create.
    expect(PAGE).toContain('</div>\n    <div class="create-actions">');
    const createBlockAt = PAGE.indexOf('<div class="create-actions">');
    expect(createBlockAt).toBeLessThan(createAt);
    expect(createBlockAt).toBeGreaterThan(remrzAt);
  });

  test('flow script drives the download through the exposed editor API', () => {
    expect(FLOW).toContain('form-first flow');
    expect(FLOW).toContain('editor.exportHTML().then(function(html){');
    expect(FLOW).toContain('URL.createObjectURL');
    expect(FLOW).toContain('a.download = name');
    expect(FLOW).toContain("'Passport-'");
  });

  test('Create requires passport no, full name, DOB and nationality before downloading', () => {
    expect(FLOW).toContain("['passportNo','Passport No.']");
    expect(FLOW).toContain("['fullName','Full name']");
    expect(FLOW).toContain("['dob','Date of birth']");
    expect(FLOW).toContain("['nationality','Nationality']");
  });
});

describe('flow layer does not touch the editor', () => {
  test('the editor IIFE still exposes the same frozen APIs', () => {
    expect(MAIN).toContain('window.passportEngine=Object.freeze');
    expect(MAIN).toContain('window.documentEditor=Object.freeze');
    expect(MAIN).toContain('applyAll:applyAllEngine');
    expect(MAIN).toContain('regenerateMRZ,');
    expect(MAIN).toContain('validate:validateEngine,');
    expect(MAIN).toContain('buildMrz1,buildMrz2,');
  });

  test('flow script guards on missing APIs / no landing state instead of crashing', () => {
    expect(FLOW).toContain("if (!body || !body.classList.contains('flow-landing') || !api || !editor) return;");
    expect(FLOW).toContain("if (!startBtn || !createBtn) { body.classList.remove('flow-landing'); return; }");
  });

  test('a downloaded copy opens in the editor, not the landing (snapshotHTML resets the body class)', () => {
    expect(MAIN).toContain("root.querySelector('body').className=''");
  });

  test('every inline script parses', () => {
    expect(SCRIPTS.length).toBe(2);
    for (const s of SCRIPTS) expect(() => new vm.Script(s)).not.toThrow();
  });
});

describe('flow behavior (vm, stub DOM)', () => {
  test('landing: no form action until the entry button is clicked', () => {
    const r = runFlow({});
    expect(r.body.classList.contains('flow-landing')).toBe(true);
    expect(r.calls.applyAll).toBe(0);
    expect(r.calls.exportHTML).toBe(0);
    expect(r.downloads).toHaveLength(0);
  });

  test('clicking Passport তৈরি করুন shows the form, blanks it and focuses Passport No.', () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    expect(r.body.classList.contains('flow-landing')).toBe(false);
    expect(r.body.classList.contains('flow-form')).toBe(true);
    expect(r.els['eng-passportNo'].value).toBe('');
    expect(r.els['eng-fullName'].value).toBe('');
    expect(r.els['eng-dob'].value).toBe('');
    expect(r.els['eng-nationality'].value).toBe('');
    expect(r.els['eng-dotStripAuto'].checked).toBe(true);
    expect(r.els['eng-sameEmergency'].checked).toBe(false);
    expect(r.calls.applyAll).toBeGreaterThan(0);
    expect(r.calls.regenerateMRZ).toBeGreaterThan(0);
    expect(r.els['eng-passportNo'].focused).toBe(true);
  });

  test('filling + Create downloads the output named after the passport number and shows the editor', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    r.els['eng-dob'].value = '1979-12-17';
    r.els['eng-nationality'].value = 'BANGLADESHI';
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.calls.exportHTML).toBe(1);
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].name).toBe('Passport-EJ0762655.html');
    expect(r.body.classList.contains('flow-form')).toBe(false);
    expect(r.body.classList.contains('flow-landing')).toBe(false);
    expect(r.els['create-message'].textContent).toContain('Passport তৈরি হয়েছে');
  });

  test('Create with a missing required field downloads nothing and points at the field', () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    // dob left blank
    r.els['eng-nationality'].value = 'BANGLADESHI';
    r.els['create-passport-button'].click();
    expect(r.calls.exportHTML).toBe(0);
    expect(r.downloads).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('Date of birth');
    expect(r.els['eng-dob'].focused).toBe(true);
    expect(r.body.classList.contains('flow-form')).toBe(true);
  });

  test('missing editor APIs: the flow does nothing instead of crashing', () => {
    const r = runFlow({ withApi: false, withEditor: false });
    expect(r.body.classList.contains('flow-landing')).toBe(true);
    // No listeners were attached: clicking is a no-op, not a throw.
    expect(() => r.els['start-passport-button'].click()).not.toThrow();
    expect(r.body.classList.contains('flow-landing')).toBe(true);
  });

  test('no landing state (downloaded copy): the flow does nothing', () => {
    const r = runFlow({ bodyClasses: [] });
    expect(() => r.els['start-passport-button'].click()).not.toThrow();
    expect(r.body.classList.contains('flow-form')).toBe(false);
    expect(r.calls.applyAll).toBe(0);
  });
});

describe('form upload behavior (vm, stub DOM)', () => {
  async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  test('upload buttons open the hidden file input', () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    let photoClicked = false;
    let sigClicked = false;
    r.els['form-photo-upload'].addEventListener('click', () => { photoClicked = true; });
    r.els['form-signature-upload'].addEventListener('click', () => { sigClicked = true; });
    r.els['form-upload-photo-button'].click();
    r.els['form-upload-signature-button'].click();
    expect(photoClicked).toBe(true);
    expect(sigClicked).toBe(true);
  });

  test('choosing a photo calls editor.setImage and shows the confirmation', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    expect(r.els['form-photo-status'].hidden).toBe(true);
    r.els['form-photo-upload'].files = [{ name: 'photo.png' }];
    r.els['form-photo-upload'].fire('change');
    await r.state.imagePromise;
    await flush();
    expect(r.calls.setImage).toHaveLength(1);
    expect(r.calls.setImage[0].type).toBe('photo');
    expect(r.calls.setImage[0].file.name).toBe('photo.png');
    expect(r.els['form-photo-thumb'].src).toBe('blob:test');
    expect(r.els['form-photo-name'].textContent).toBe('photo.png');
    expect(r.els['form-photo-status'].hidden).toBe(false);
    expect(r.els['form-upload-photo-button'].textContent).toBe('ছবি বদলান');
    expect(r.els['form-upload-photo-button'].disabled).toBe(false);
    expect(r.els['create-message'].textContent).toContain('ছবি যোগ হয়েছে');
  });

  test('choosing a signature calls editor.setImage and shows the confirmation', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['form-signature-upload'].files = [{ name: 'sig.png' }];
    r.els['form-signature-upload'].fire('change');
    await r.state.imagePromise;
    await flush();
    expect(r.calls.setImage).toHaveLength(1);
    expect(r.calls.setImage[0].type).toBe('signature');
    expect(r.els['form-signature-thumb'].src).toBe('blob:test');
    expect(r.els['form-signature-name'].textContent).toBe('sig.png');
    expect(r.els['form-signature-status'].hidden).toBe(false);
    expect(r.els['form-upload-signature-button'].textContent).toBe('স্বাক্ষর বদলান');
    expect(r.els['create-message'].textContent).toContain('স্বাক্ষর যোগ হয়েছে');
  });

  test('remove clears the slot and hides the confirmation', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['form-photo-upload'].files = [{ name: 'photo.png' }];
    r.els['form-photo-upload'].fire('change');
    await r.state.imagePromise;
    await flush();
    expect(r.els['form-photo-status'].hidden).toBe(false);
    const resetsBefore = r.calls.resetImage.length;
    r.els['form-remove-photo'].click();
    expect(r.calls.resetImage.slice(resetsBefore)).toEqual(['photo']);
    expect(r.els['form-photo-status'].hidden).toBe(true);
    expect(r.els['form-photo-thumb'].src).toBe('');
    expect(r.els['form-photo-name'].textContent).toBe('');
    expect(r.els['form-upload-photo-button'].textContent).toBe('ছবি যোগ করুন');
    expect(r.els['create-message'].textContent).toContain('ছবি সরানো হয়েছে');
  });

  test('Create after uploads downloads, with the slots populated first', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['form-photo-upload'].files = [{ name: 'photo.png' }];
    r.els['form-photo-upload'].fire('change');
    r.els['form-signature-upload'].files = [{ name: 'sig.png' }];
    r.els['form-signature-upload'].fire('change');
    await r.state.imagePromise;
    await flush();
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    r.els['eng-dob'].value = '1979-12-17';
    r.els['eng-nationality'].value = 'BANGLADESHI';
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await flush();
    // The uploads populated the editor's photo/signature slots BEFORE
    // exportHTML ran, so the snapshot carries them. (The stub editor
    // cannot prove the image bytes land in the export — the live editor's
    // snapshotHTML serializes model.images, which setImage fills.)
    expect(r.calls.setImage.map((c) => c.type)).toEqual(['photo', 'signature']);
    expect(r.calls.exportHTML).toBe(1);
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].name).toBe('Passport-EJ0762655.html');
  });

  test('entering the form clears any previous photo/signature and hides the confirmations', () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    expect(r.calls.resetImage).toEqual(['photo', 'signature']);
    expect(r.els['form-photo-status'].hidden).toBe(true);
    expect(r.els['form-signature-status'].hidden).toBe(true);
  });

  test('upload failure shows the error and leaves the confirmation hidden', async () => {
    const r = runFlow({ setImageFails: true });
    r.els['start-passport-button'].click();
    r.els['form-photo-upload'].files = [{ name: 'photo.txt' }];
    r.els['form-photo-upload'].fire('change');
    try { await r.state.imagePromise; } catch (e) { /* expected rejection */ }
    await flush();
    expect(r.calls.setImage).toHaveLength(1);
    expect(r.els['form-photo-status'].hidden).toBe(true);
    expect(r.els['form-photo-thumb'].src).toBe('');
    expect(r.els['create-message'].textContent).toContain('যোগ হয়নি');
    expect(r.els['form-upload-photo-button'].disabled).toBe(false);
  });
});
