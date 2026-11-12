// Passport engine form-first flow — frontend only (text-reading + vm).
//
// Bug (user-reported 2026-11-13): the page opened straight into the
// editor (Engine / Text / Photo / Signature tabs, Print / Save HTML).
// No "Passport তৈরি করুন" entry, no form-first step, no Create → download.
// Correct flow: landing "Passport তৈরি করুন" → form → Create → download,
// then the editor for fine-tuning. The output itself (MRZ TD3, dotted
// strip, name split, dates, photo/signature slots) is untouched — the
// change is the FLOW only, driven through the exposed editor APIs
// (window.passportEngine / window.documentEditor).
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
  const calls = { applyAll: 0, regenerateMRZ: 0, resetImage: [], exportHTML: 0 };
  const state = { exportedPromise: null };
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

describe('form (all output fields)', () => {
  test.each(FORM_KEYS)('form exposes engine field eng-%s', (key) => {
    expect(PAGE).toContain('id="eng-' + key + '"');
  });

  test('form state shows only the Engine tab', () => {
    expect(PAGE).toContain('body.flow-form [data-tab]:not([data-tab="engine"]){display:none}');
    expect(PAGE).toContain('body.flow-form .toolbar,body.flow-form .document-area,body.flow-form .footer-note{display:none}');
  });

  test('form state collapses the editor grid to a single column', () => {
    expect(PAGE).toContain('body.flow-form main{grid-template-columns:minmax(0,1fr);max-width:760px}');
  });
});

describe('Create → download', () => {
  test('Create button + status message sit at the end of the Engine panel', () => {
    expect(PAGE).toContain('id="create-passport-button"');
    expect(PAGE).toContain('Create — ডাউনলোড করুন');
    expect(PAGE).toContain('id="create-message"');
    const createAt = PAGE.indexOf('id="create-passport-button"');
    const remrzAt = PAGE.indexOf('id="eng-remrz"');
    expect(createAt).toBeGreaterThan(remrzAt);
    const panelTextAt = PAGE.indexOf('id="panel-text"');
    expect(createAt).toBeLessThan(panelTextAt);
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
