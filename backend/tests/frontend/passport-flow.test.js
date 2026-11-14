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
  els['back-to-landing-button'] = makeEl('back-to-landing-button', 'button');
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
  // Sample-face warning (finding 7): visible when photo/signature missing.
  const warning = makeEl('form-sample-warning', 'p');
  warning.hidden = true;
  els['form-sample-warning'] = warning;
  // Price line (integrated service): the fee / free text, filled by
  // loadPrice() when the form opens.
  els['passport-price-line'] = makeEl('passport-price-line', 'p');
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
  const calls = { applyAll: 0, regenerateMRZ: 0, validate: 0, resetImage: [], exportHTML: 0, setImage: [] };
  const state = { exportedPromise: null, imagePromise: null };
  const downloads = [];
  const blobs = []; // every blob handed to URL.createObjectURL (PDF or HTML)
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
    Blob: function (parts, opts) { this.parts = parts; this.type = (opts && opts.type) || ''; },
    URL: { createObjectURL: (blob) => { blobs.push(blob); return 'blob:test'; }, revokeObjectURL: () => {} },
    setTimeout: () => 0,
  };
  // Stored delivery copy (engine-jobs, fix 2026-11-14): the flow
  // reports the PDF blob after a successful Create, via fetch +
  // FormData (birth-final pattern). These stubs record the report.
  const engineJobCalls = [];
  sandbox.FormData = function () {
    this.fields = {};
    this.append = (k, v, fn) => { this.fields[k] = fn ? { value: v, filename: fn } : v; };
  };
  sandbox.fetch = (url, opts) => {
    engineJobCalls.push({ url, opts });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  sandbox.sessionStorage = { getItem: () => 'test-token' };
  // Backend charge stub (integrated service): Create calls
  // ABC.api('/passport/create') before the download; the form also
  // loads the price on entry. Default: price 0, charge ok.
  // PDF stub (direct real-PDF download, 2026-11-14): Create then
  // calls ABC.api('/passport/pdf?...') with the document HTML and
  // gets PDF bytes back. Default: a fake %PDF- blob. Options:
  // o.pdfFailTimes (first N /pdf calls fail), o.pdfNonPdf (the
  // server answers 200 but with a non-PDF content-type).
  const chargeCalls = [];
  const pdfCalls = [];
  let pdfAttempt = 0;
  if (o.withAbc !== false) {
    sandbox.window.ABC = {
      api: (path, opts) => {
        chargeCalls.push({ path, opts });
        if (String(path).indexOf('/passport/pdf') === 0) {
          pdfCalls.push({ path, opts });
          pdfAttempt += 1;
          if (o.pdfFailTimes && pdfAttempt <= o.pdfFailTimes) {
            return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'PDF_FAILED', message: 'PDF তৈরি করা যায়নি — আবার চেষ্টা করুন।' }) });
          }
          if (o.pdfNonPdf) {
            return Promise.resolve({
              ok: true, status: 200,
              headers: { get: () => 'text/html' },
              blob: async () => new sandbox.Blob(['<html>not a pdf</html>'], { type: 'text/html' }),
              json: async () => ({}),
            });
          }
          const pdfBytes = '%PDF-1.4\n%fake passport pdf\n';
          return Promise.resolve({
            ok: true, status: 200,
            headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/pdf' : null) },
            blob: async () => new sandbox.Blob([pdfBytes], { type: 'application/pdf' }),
            json: async () => ({}),
          });
        }
        if (o.chargeFails) return Promise.reject(new Error('network down'));
        const res = o.chargeResponse || { ok: true, status: 200, body: { ok: true, charged: 0, orderId: 'o1', balance: 500 } };
        return Promise.resolve({ ok: res.ok, status: res.status, json: async () => res.body });
      },
    };
  }
  if (o.withApi !== false) {
    sandbox.window.passportEngine = {
      applyAll: () => { calls.applyAll += 1; },
      regenerateMRZ: () => { calls.regenerateMRZ += 1; },
      validate: () => { calls.validate += 1; return o.validateIssues || []; },
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
  return { els, body, calls, downloads, blobs, state, chargeCalls, pdfCalls, engineJobCalls };
}

describe('landing (form-first entry)', () => {
  test('body starts in the landing state, inside the site shell', () => {
    expect(PAGE).toContain('<body class="has-tabbar flagship-app service-workspace page-passport flow-landing">');
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

  test('form screen has a back button to the landing (finding 9)', () => {
    expect(PAGE).toContain('id="back-to-landing-button"');
    expect(PAGE).toContain('ফিরে যান');
    const headAt = PAGE.indexOf('id="passport-form-head"');
    const backAt = PAGE.indexOf('id="back-to-landing-button"');
    const h2At = PAGE.indexOf('<h2>Passport তৈরি করুন</h2>', headAt);
    expect(backAt).toBeGreaterThan(headAt);
    expect(backAt).toBeLessThan(h2At);
    expect(PAGE).toContain('.back-button{background:none;border:0;color:var(--muted);cursor:pointer;font-size:13px;padding:0;margin:0 0 8px;text-align:left}');
    expect(FLOW).toContain('back-to-landing-button');
    expect(FLOW).toContain('formEntered');
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

  test('form screen hides preview, hints and auto-only controls — except validation', () => {
    expect(PAGE).toContain('body.flow-form #eng-passportPreview,body.flow-form #eng-dotmx-note{display:none}');
    // Validation must stay VISIBLE on the form screen (findings 1–6): the
    // engine computes format/consistency issues, and Create now blocks on
    // them — hiding the line would make the block reason undiscoverable.
    // Only the other hints are hidden.
    expect(PAGE).toContain('body.flow-form #panel-engine .engine-hint:not(#create-message):not(#engine-validation):not(#eng-nationality-hint){display:none}');
    expect(PAGE).toContain('body.flow-form #engine-validation{color:#b3261e;font-weight:600}');
    expect(PAGE).toContain('body.flow-form .auto-tag{display:none}');
    expect(PAGE).toContain('body.flow-form #eng-dotstrip-row{display:none}');
  });

  test('passport-no input is limited to 9 characters (finding 5: MRZ truncates silently otherwise)', () => {
    const at = PAGE.indexOf('id="eng-passportNo"');
    expect(at).toBeGreaterThan(-1);
    expect(PAGE.slice(at, at + 200)).toContain('maxlength="9"');
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

  test('upload group is first in the form — right after the form head, before the Passport group and Create', () => {
    const groupAt = PAGE.indexOf('id="eng-photo-group"');
    const headAt = PAGE.indexOf('id="passport-form-head"');
    const passportAt = PAGE.indexOf('id="eng-passportNo"');
    const createAt = PAGE.indexOf('id="create-passport-button"');
    const panelTextAt = PAGE.indexOf('id="panel-text"');
    expect(groupAt).toBeGreaterThan(headAt);
    expect(groupAt).toBeLessThan(passportAt);
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

  test('form warns visibly when photo/signature is missing (finding 7: sample face otherwise)', () => {
    expect(PAGE).toContain('id="form-sample-warning"');
    expect(PAGE).toContain('নমুনার ছবি ও স্বাক্ষর দেখাবে');
    const at = PAGE.indexOf('id="form-sample-warning"');
    expect(at).toBeGreaterThan(PAGE.indexOf('id="eng-photo-group"'));
    expect(at).toBeLessThan(PAGE.indexOf('id="create-passport-button"'));
    expect(PAGE).toContain('.form-sample-warning{margin:10px 0 0;color:#b3261e;font-weight:600;line-height:1.7}');
    expect(PAGE).toContain('.form-sample-warning[hidden]{display:none}');
    expect(FLOW).toContain('updateSampleWarning');
    expect(FLOW).toContain('নমুনার');
    // It is a plain warning element, NOT an .engine-hint — the form CSS
    // hides engine hints, so a hint class would hide the warning too.
    expect(PAGE.slice(at, at + 120)).not.toContain('engine-hint');
  });

  test('copy says post-Create changes need a re-download (finding 8: the download is frozen at Create)', () => {
    expect(PAGE).toContain('পরে বদলালে আবার ডাউনলোড করতে হবে');
    expect(PAGE).toContain('পরে কিছু বদলালে আবার Create করে ডাউনলোড করতে হবে');
    expect(FLOW).toContain('কিছু বদলাতে চাইলে আবার Create করে ডাউনলোড করুন');
    expect(PAGE).not.toContain('Create-এর পর বদলানো যাবে');
    expect(PAGE).not.toContain('Create-এর পরও বদলানো যাবে');
    expect(PAGE).not.toContain('তারপরও ছবি ও স্বাক্ষর বদলাতে পারবেন');
    expect(FLOW).not.toContain('Photo / Signature ট্যাব থেকে বদলাতে পারবেন');
  });
});

describe('form declutter — status bar, Fidelity and Print texts removed; groups borderless', () => {
  test('editor status bar and Save HTML hint are gone from the page', () => {
    expect(PAGE).not.toContain('id="status"');
    expect(PAGE).not.toContain('class="status"');
    expect(PAGE).not.toContain('status-block');
    expect(PAGE).not.toContain('Use <strong>Save HTML</strong>');
  });

  test('Fidelity and Print & developer access blocks are gone from the page', () => {
    expect(PAGE).not.toContain('Fidelity');
    expect(PAGE).not.toContain('Print &amp; developer access');
    expect(PAGE).not.toContain('preserved artwork');
  });

  test('the Text panel typography details block is kept (only the two quoted blocks were removed)', () => {
    expect(PAGE).toContain('id="style-details"');
    expect(PAGE).toContain('অক্ষর ও অবস্থান');
  });

  test('updateStatus guards the missing status element; the document-only export never touches it', () => {
    expect(MAIN).toContain("const st=$('status');if(st)");
    // The document-only export (bug fix 2026-11-14) builds a fresh
    // document from #page-shell — it never references #status, so the
    // old export-reset guard is gone because it cannot crash on it.
    expect(MAIN).not.toContain("root.querySelector('#status')");
  });

  test('form-state groups have no divider borders — spacing only, simpler premium look', () => {
    expect(PAGE).toContain('body.flow-form .engine-group{border-top:0;margin-top:24px;padding-top:0}');
  });
});

describe('Create → download', () => {
  test('Create button + status message sit at the end of the Engine panel, outside the MRZ group', () => {
    expect(PAGE).toContain('id="create-passport-button"');
    expect(PAGE).toContain('Create — PDF ডাউনলোড করুন');
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

  test('flow script drives the PDF download through the exposed editor API', () => {
    expect(FLOW).toContain('form-first flow');
    expect(FLOW).toContain('editor.exportHTML()');
    expect(FLOW).toContain('/passport/pdf');
    expect(FLOW).toContain("'.pdf'");
    expect(FLOW).toContain('URL.createObjectURL');
    expect(FLOW).toContain('a.download = name');
  });

  test('Create requires passport no, type, country code, full name, DOB, sex, expiry and nationality before downloading', () => {
    expect(FLOW).toContain("['passportNo','Passport No.']");
    expect(FLOW).toContain("['docType','Type']");
    expect(FLOW).toContain("['countryCode','Country code']");
    expect(FLOW).toContain("['fullName','Full name']");
    expect(FLOW).toContain("['dob','Date of birth']");
    expect(FLOW).toContain("['sex','Sex']");
    expect(FLOW).toContain("['expiryDate','Date of expiry']");
    expect(FLOW).toContain("['nationality','Nationality']");
  });

  test('Create blocks on engine validation issues and names the problem', () => {
    expect(FLOW).toContain('api.validate()');
    expect(FLOW).toContain('Please fix this before creating the passport:');
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

  test('a downloaded copy is the document only, not the editor (bug fix 2026-11-14)', () => {
    // The old export cloned the whole document and reset the body class so
    // the copy reopened as the editor. The download is now only the
    // passport document — no whole-document clone, no model JSON, no
    // body-class reset.
    expect(MAIN).not.toContain('document.documentElement.cloneNode(true)');
    expect(MAIN).not.toContain("root.querySelector('#document-state')");
    expect(MAIN).not.toContain("root.querySelector('body').className=''");
    expect(MAIN).toContain("const shell=$('page-shell').cloneNode(true);");
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

  test('back to landing preserves the filled form, and re-entering restores it (finding 9)', () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    expect(r.els['eng-passportNo'].value).toBe('');
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    r.els['back-to-landing-button'].click();
    expect(r.body.classList.contains('flow-landing')).toBe(true);
    expect(r.body.classList.contains('flow-form')).toBe(false);
    expect(r.els['eng-passportNo'].value).toBe('EJ0762655');
    expect(r.els['eng-fullName'].value).toBe('GOLAM KIBRIYA MD');
    // Re-entering restores the in-progress form instead of blanking it.
    r.els['start-passport-button'].click();
    expect(r.body.classList.contains('flow-form')).toBe(true);
    expect(r.els['eng-passportNo'].value).toBe('EJ0762655');
    expect(r.els['eng-fullName'].value).toBe('GOLAM KIBRIYA MD');
  });

  test('filling + Create downloads the output named after the passport number and shows the editor', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-docType'].value = 'P';
    r.els['eng-countryCode'].value = 'BGD';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    r.els['eng-dob'].value = '1979-12-17';
    r.els['eng-sex'].value = 'M';
    r.els['eng-expiryDate'].value = '2035-01-01';
    r.els['eng-nationality'].value = 'BANGLADESHI';
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.calls.exportHTML).toBe(1);
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].name).toBe('Passport-EJ0762655.pdf');
    expect(r.body.classList.contains('flow-form')).toBe(false);
    expect(r.body.classList.contains('flow-landing')).toBe(false);
    expect(r.els['create-message'].textContent).toContain('Passport PDF তৈরি হয়েছে');
  });

  test('Create with a missing required field downloads nothing and points at the field', () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-docType'].value = 'P';
    r.els['eng-countryCode'].value = 'BGD';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    // dob left blank
    r.els['eng-sex'].value = 'M';
    r.els['eng-expiryDate'].value = '2035-01-01';
    r.els['eng-nationality'].value = 'BANGLADESHI';
    r.els['create-passport-button'].click();
    expect(r.calls.exportHTML).toBe(0);
    expect(r.downloads).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('Date of birth');
    expect(r.els['eng-dob'].focused).toBe(true);
    expect(r.body.classList.contains('flow-form')).toBe(true);
  });

  test('Create with expiry missing downloads nothing and points at expiry (finding 2)', () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-docType'].value = 'P';
    r.els['eng-countryCode'].value = 'BGD';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    r.els['eng-dob'].value = '1979-12-17';
    r.els['eng-sex'].value = 'M';
    // expiryDate left blank
    r.els['eng-nationality'].value = 'BANGLADESHI';
    r.els['create-passport-button'].click();
    expect(r.calls.exportHTML).toBe(0);
    expect(r.downloads).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('Date of expiry');
    expect(r.els['eng-expiryDate'].focused).toBe(true);
  });

  test('Create with sex untouched downloads nothing and points at sex (finding 4)', () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-docType'].value = 'P';
    r.els['eng-countryCode'].value = 'BGD';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    r.els['eng-dob'].value = '1979-12-17';
    // sex left blank (clearForm blanks the select)
    r.els['eng-expiryDate'].value = '2035-01-01';
    r.els['eng-nationality'].value = 'BANGLADESHI';
    r.els['create-passport-button'].click();
    expect(r.calls.exportHTML).toBe(0);
    expect(r.downloads).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('Sex');
    expect(r.els['eng-sex'].focused).toBe(true);
  });

  test('Create blocked by an engine validation issue downloads nothing and names it (findings 1, 5)', () => {
    const r = runFlow({ validateIssues: ['Enter the three-letter nationality code; it is not assumed from the issuing country.'] });
    r.els['start-passport-button'].click();
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-docType'].value = 'P';
    r.els['eng-countryCode'].value = 'BGD';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    r.els['eng-dob'].value = '1979-12-17';
    r.els['eng-sex'].value = 'M';
    r.els['eng-expiryDate'].value = '2035-01-01';
    r.els['eng-nationality'].value = 'INDIAN';
    r.els['create-passport-button'].click();
    expect(r.calls.validate).toBeGreaterThan(0);
    expect(r.calls.exportHTML).toBe(0);
    expect(r.downloads).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('three-letter nationality code');
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
    r.els['eng-docType'].value = 'P';
    r.els['eng-countryCode'].value = 'BGD';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    r.els['eng-dob'].value = '1979-12-17';
    r.els['eng-sex'].value = 'M';
    r.els['eng-expiryDate'].value = '2035-01-01';
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
    expect(r.downloads[0].name).toBe('Passport-EJ0762655.pdf');
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

describe('sample-face warning behavior (vm, stub DOM)', () => {
  async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  test('warning is visible on form entry, naming both missing photo and signature', () => {
    const r = runFlow({});
    expect(r.els['form-sample-warning'].hidden).toBe(true);
    r.els['start-passport-button'].click();
    expect(r.els['form-sample-warning'].hidden).toBe(false);
    expect(r.els['form-sample-warning'].textContent).toContain('ছবি ও স্বাক্ষর না দিলে');
    expect(r.els['form-sample-warning'].textContent).toContain('নমুনার ছবি ও স্বাক্ষর দেখাবে');
  });

  test('attaching only the photo leaves the warning naming the signature', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['form-photo-upload'].files = [{ name: 'photo.png' }];
    r.els['form-photo-upload'].fire('change');
    await r.state.imagePromise;
    await flush();
    expect(r.els['form-sample-warning'].hidden).toBe(false);
    expect(r.els['form-sample-warning'].textContent).toContain('স্বাক্ষর না দিলে');
    expect(r.els['form-sample-warning'].textContent).toContain('নমুনার স্বাক্ষর দেখাবে');
  });

  test('attaching both photo and signature hides the warning', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['form-photo-upload'].files = [{ name: 'photo.png' }];
    r.els['form-photo-upload'].fire('change');
    r.els['form-signature-upload'].files = [{ name: 'sig.png' }];
    r.els['form-signature-upload'].fire('change');
    await r.state.imagePromise;
    await flush();
    expect(r.els['form-sample-warning'].hidden).toBe(true);
    expect(r.els['form-sample-warning'].textContent).toBe('');
  });

  test('removing the photo after both were attached shows the warning again', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['form-photo-upload'].files = [{ name: 'photo.png' }];
    r.els['form-photo-upload'].fire('change');
    r.els['form-signature-upload'].files = [{ name: 'sig.png' }];
    r.els['form-signature-upload'].fire('change');
    await r.state.imagePromise;
    await flush();
    expect(r.els['form-sample-warning'].hidden).toBe(true);
    r.els['form-remove-photo'].click();
    expect(r.els['form-sample-warning'].hidden).toBe(false);
    expect(r.els['form-sample-warning'].textContent).toContain('ছবি না দিলে');
  });

  test('the warning does NOT block Create — it warns only (finding 7)', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    expect(r.els['form-sample-warning'].hidden).toBe(false);
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-docType'].value = 'P';
    r.els['eng-countryCode'].value = 'BGD';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    r.els['eng-dob'].value = '1979-12-17';
    r.els['eng-sex'].value = 'M';
    r.els['eng-expiryDate'].value = '2035-01-01';
    r.els['eng-nationality'].value = 'BANGLADESHI';
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await flush();
    expect(r.calls.exportHTML).toBe(1);
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].name).toBe('Passport-EJ0762655.pdf');
  });
});

describe('passport integration — login gate, charge, layout, Bengali chrome (2026-11-13)', () => {
  async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  function fillValid(r) {
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-docType'].value = 'P';
    r.els['eng-countryCode'].value = 'BGD';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    r.els['eng-dob'].value = '1979-12-17';
    r.els['eng-sex'].value = 'M';
    r.els['eng-expiryDate'].value = '2035-01-01';
    r.els['eng-nationality'].value = 'BANGLADESHI';
  }

  function gateScript() {
    const m = PAGE.match(/<script id="passport-login-gate">([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    return m[1];
  }

  test('login gate: no token → redirect to /login.html?next=/passport.html', () => {
    const sandbox = {
      sessionStorage: { getItem: () => null },
      localStorage: { getItem: () => null },
      location: { pathname: '/passport.html', href: '' },
    };
    vm.createContext(sandbox);
    vm.runInContext(gateScript(), sandbox);
    expect(sandbox.location.href).toBe('/login.html?next=%2Fpassport.html');
  });

  test('login gate: token present → no redirect', () => {
    const sandbox = {
      sessionStorage: { getItem: () => 'tok' },
      localStorage: { getItem: () => null },
      location: { pathname: '/passport.html', href: '' },
    };
    vm.createContext(sandbox);
    vm.runInContext(gateScript(), sandbox);
    expect(sandbox.location.href).toBe('');
  });

  test('login gate script parses', () => {
    expect(() => new vm.Script(gateScript())).not.toThrow();
  });

  test('CSP allows same-origin API calls and no longer forbids them', () => {
    expect(PAGE).toContain("connect-src 'self'");
    expect(PAGE).not.toContain("connect-src 'none'");
    expect(PAGE).toContain("style-src 'self' 'unsafe-inline'");
    expect(PAGE).toContain("script-src 'self' 'unsafe-inline'");
    expect(PAGE).toContain("font-src 'self' data:");
  });

  test('shared site layout: stylesheets, scripts, sidebar and mobile tabbar', () => {
    for (const href of ['/css/emerald-gold.css', '/css/sidebar-nav.css', '/css/service-workspace.css', '/fonts/hind-siliguri.css']) {
      expect(PAGE).toContain(href);
    }
    expect(PAGE).toContain('/js/sidebar-nav.js');
    expect(PAGE).toContain('/js/engine-feedback.js');
    expect(PAGE).toContain('/js/app.js');
    expect(PAGE).toContain('<div class="sidebar">');
    expect(PAGE).toContain("location.href='/dashboard.html'");
    expect(PAGE).toContain("location.href='/services.html'");
    expect(PAGE).toContain("location.href='/orders.html'");
    expect(PAGE).toContain("location.href='/history.html'");
    expect(PAGE).toContain("location.href='/wallet.html'");
    expect(PAGE).toContain('পাসপোর্ট ইঞ্জিন');
    expect(PAGE).toContain('<div class="m-tabbar">');
  });

  test('premium look comes from the shared theme, not a copied token set', () => {
    expect(PAGE).not.toContain('--pg-bg:#faf9f4');
    expect(PAGE).not.toContain('--pg-green:#006441');
    expect(PAGE).not.toContain('--pg-gold:#efb541');
    expect(PAGE).toContain('--pg-bg:var(--bg-page)');
    expect(PAGE).toContain('--pg-green:var(--primary-600)');
    expect(PAGE).toContain('var(--gold-gradient)');
    expect(PAGE).not.toContain('var(--pg-gold-2)');
    // The form's premium rules themselves are unchanged.
    expect(PAGE).toContain('body.flow-form aside{background:var(--pg-surface)');
  });

  test('Bengali chrome: lang, title, toolbar, tabs, no old English strings', () => {
    expect(PAGE).toContain('<html lang="bn">');
    expect(PAGE).toContain('<title>পাসপোর্ট ইঞ্জিন - All In One</title>');
    for (const s of ['অঞ্চল দেখুন', 'প্রিভিউ', 'প্রিন্ট']) {
      expect(PAGE).toContain(s);
    }
    // No HTML download path anymore (fix 2026-11-14): the toolbar's
    // HTML-save button, its wiring and Ctrl+S are all gone, and the
    // print button is labelled print only — it never was a download.
    for (const s of ['প্রিন্ট / PDF', 'HTML সংরক্ষণ করুন', 'id="save-button"', 'saveHTML', "key==='s'"]) {
      expect(PAGE).not.toContain(s);
    }
    for (const s of ['data-tab="engine">ইঞ্জিন', 'data-tab="text">লেখা', 'data-tab="photo">ছবি', 'data-tab="signature">স্বাক্ষর']) {
      expect(PAGE).toContain(s);
    }
    for (const s of ['Show regions', 'Save HTML', 'Document editor', 'Typography &amp; position', 'Upload photo', 'Upload signature', 'Passport Engine — Linked Editable Text']) {
      expect(PAGE).not.toContain(s);
    }
  });

  test('snapshotHTML builds a document-only export (bug fix 2026-11-14)', () => {
    // No whole-document clone, no site-shell strip list, no model JSON —
    // the export clones only #page-shell, cleans the editor affordances
    // off it, and wraps it in document-only CSS.
    expect(MAIN).not.toContain("root.querySelectorAll('.sidebar,.m-tabbar");
    expect(MAIN).toContain("const shell=$('page-shell').cloneNode(true);");
    expect(MAIN).toContain('cleanDocumentShell(shell);');
    expect(MAIN).toContain('const css=documentCSS();');
    expect(MAIN).toContain("shell.outerHTML");
  });

  test('price line: form entry with price 0 shows the free text', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    await flush();
    expect(r.chargeCalls[0].path).toBe('/passport/price');
    expect(r.els['passport-price-line'].textContent).toContain('বিনামূল্যে');
  });

  test('price line: form entry with a price shows the fee + balance', async () => {
    const r = runFlow({ chargeResponse: { ok: true, status: 200, body: { ok: true, price: 30, balance: 500, serviceId: 13, allowed: true } } });
    r.els['start-passport-button'].click();
    await flush();
    expect(r.els['passport-price-line'].textContent).toContain('সেবা চার্জ: ৳30');
    expect(r.els['passport-price-line'].textContent).toContain('ব্যালেন্স: ৳500');
  });

  test('Create calls the backend first, then downloads, and names the charge', async () => {
    const r = runFlow({ chargeResponse: { ok: true, status: 200, body: { ok: true, charged: 30, orderId: 'o1', balance: 470 } } });
    r.els['start-passport-button'].click();
    fillValid(r);
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await flush();
    const create = r.chargeCalls.find((c) => c.path === '/passport/create');
    expect(create).toBeTruthy();
    expect(create.opts.method).toBe('POST');
    expect(create.opts.body.passport_no).toBe('EJ0762655');
    expect(String(create.opts.body.idempotency_key)).toMatch(/^passport-/);
    expect(r.calls.exportHTML).toBe(1);
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].name).toBe('Passport-EJ0762655.pdf');
    expect(r.els['create-message'].textContent).toContain('চার্জ কাটা হয়েছে: ৳30');
  });

  test('Create with price 0 downloads and says no charge was taken', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    fillValid(r);
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await flush();
    expect(r.downloads).toHaveLength(1);
    expect(r.els['create-message'].textContent).toContain('কোনো চার্জ কাটা হয়নি');
  });

  test('Create blocked when the backend rejects (402): no download, real reason shown', async () => {
    const r = runFlow({ chargeResponse: { ok: false, status: 402, body: { error: 'INSUFFICIENT_BALANCE', message: 'পর্যাপ্ত ব্যালেন্স নেই। সেবাটির মূল্য ৳30, বর্তমান ব্যালেন্স ৳10।' } } });
    r.els['start-passport-button'].click();
    fillValid(r);
    r.els['create-passport-button'].click();
    await flush();
    expect(r.calls.exportHTML).toBe(0);
    expect(r.downloads).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('পর্যাপ্ত ব্যালেন্স নেই');
    expect(r.body.classList.contains('flow-form')).toBe(true);
  });

  test('Create blocked when the backend is unreachable: no download, Bengali error', async () => {
    const r = runFlow({ chargeFails: true });
    r.els['start-passport-button'].click();
    fillValid(r);
    r.els['create-passport-button'].click();
    await flush();
    expect(r.calls.exportHTML).toBe(0);
    expect(r.downloads).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('ইন্টারনেট সংযোগ নেই');
  });

  test('Create blocked when ABC is missing: no download, connection error', async () => {
    const r = runFlow({ withAbc: false });
    r.els['start-passport-button'].click();
    fillValid(r);
    r.els['create-passport-button'].click();
    await flush();
    expect(r.calls.exportHTML).toBe(0);
    expect(r.downloads).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('সেবার সাথে সংযোগ করা যাচ্ছে না');
  });

  test('double-clicking Create charges once and downloads once', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    fillValid(r);
    r.els['create-passport-button'].click();
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await flush();
    expect(r.chargeCalls.filter((c) => c.path === '/passport/create')).toHaveLength(1);
    expect(r.calls.exportHTML).toBe(1);
    expect(r.downloads).toHaveLength(1);
  });
});

describe('Create → direct real-PDF download (2026-11-14)', () => {
  async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  function fillValid(r) {
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-docType'].value = 'P';
    r.els['eng-countryCode'].value = 'BGD';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    r.els['eng-dob'].value = '1979-12-17';
    r.els['eng-sex'].value = 'M';
    r.els['eng-expiryDate'].value = '2035-01-01';
    r.els['eng-nationality'].value = 'BANGLADESHI';
  }

  test('Create success downloads a real PDF (not HTML), named after the passport number', async () => {
    const r = runFlow({ chargeResponse: { ok: true, status: 200, body: { ok: true, charged: 30, orderId: 'o1', balance: 470 } } });
    r.els['start-passport-button'].click();
    fillValid(r);
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await flush();
    expect(r.chargeCalls.filter((c) => c.path === '/passport/create')).toHaveLength(1);
    expect(r.pdfCalls).toHaveLength(1);
    expect(r.pdfCalls[0].path).toContain('/passport/pdf?');
    expect(r.pdfCalls[0].path).toContain('passport_no=EJ0762655');
    expect(r.pdfCalls[0].path).toContain('idempotency_key=passport-');
    // The /pdf call reuses the SAME idempotency key as the charge.
    const chargeIdem = r.chargeCalls.find((c) => c.path === '/passport/create').opts.body.idempotency_key;
    expect(r.pdfCalls[0].path).toContain('idempotency_key=' + encodeURIComponent(chargeIdem));
    // The document HTML is POSTed as the raw body (text/html).
    expect(r.pdfCalls[0].opts.body).toBe('<html>passport</html>');
    expect(r.pdfCalls[0].opts.headers['Content-Type']).toContain('text/html');
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].name).toBe('Passport-EJ0762655.pdf');
    expect(r.blobs).toHaveLength(1);
    expect(r.blobs[0].type).toBe('application/pdf');
    expect(String(r.blobs[0].parts[0]).slice(0, 5)).toBe('%PDF-');
    expect(r.els['create-message'].textContent).toContain('Passport PDF তৈরি হয়েছে');
    expect(r.els['create-message'].textContent).toContain('Passport-EJ0762655.pdf');
    expect(r.els['create-message'].textContent).toContain('চার্জ কাটা হয়েছে: ৳30');
  });

  test('Create success stores a delivery copy in engine-jobs (re-downloadable from History)', async () => {
    const r = runFlow({ chargeResponse: { ok: true, status: 200, body: { ok: true, charged: 30, orderId: 'o1', balance: 470 } } });
    r.els['start-passport-button'].click();
    fillValid(r);
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await flush();
    expect(r.downloads).toHaveLength(1);
    expect(r.engineJobCalls).toHaveLength(1);
    const call = r.engineJobCalls[0];
    expect(call.url).toBe('/api/engine-jobs');
    expect(call.opts.method).toBe('POST');
    expect(call.opts.headers.Authorization).toBe('Bearer test-token');
    expect(call.opts.body.fields.engine_id).toBe('passport');
    expect(call.opts.body.fields.ref_no).toBe('EJ0762655');
    expect(call.opts.body.fields.name).toBe('GOLAM KIBRIYA MD');
    expect(call.opts.body.fields.file.filename).toBe('Passport-EJ0762655.pdf');
    expect(call.opts.body.fields.file.value.type).toBe('application/pdf');
    // Same idempotency key as the charge — a retry reports the same
    // key, so History never gets a duplicate row.
    const chargeIdem = r.chargeCalls.find((c) => c.path === '/passport/create').opts.body.idempotency_key;
    expect(call.opts.body.fields.idempotency_key).toBe(chargeIdem);
  });

  test('PDF failure stores no delivery copy', async () => {
    const r = runFlow({ pdfFailTimes: 99 });
    r.els['start-passport-button'].click();
    fillValid(r);
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await flush();
    expect(r.downloads).toHaveLength(0);
    expect(r.engineJobCalls).toHaveLength(0);
  });

  test('retry after a PDF failure reports the delivery copy once, same idempotency key', async () => {
    const r = runFlow({ pdfFailTimes: 1, chargeResponse: { ok: true, status: 200, body: { ok: true, charged: 30, orderId: 'o1', balance: 470 } } });
    r.els['start-passport-button'].click();
    fillValid(r);
    // First Create: charge ok, PDF fails → no download, no report.
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await flush();
    expect(r.downloads).toHaveLength(0);
    expect(r.engineJobCalls).toHaveLength(0);
    // Retry: PDF succeeds → one download, exactly one report.
    r.els['create-passport-button'].click();
    await flush();
    expect(r.downloads).toHaveLength(1);
    expect(r.engineJobCalls).toHaveLength(1);
    const chargeIdem = r.chargeCalls.find((c) => c.path === '/passport/create').opts.body.idempotency_key;
    expect(r.engineJobCalls[0].opts.body.fields.idempotency_key).toBe(chargeIdem);
  });

  test('landing and Create state PDF before acting (fix 2026-11-14)', () => {
    expect(PAGE).toContain('Create চাপলে পাসপোর্ট PDF তৈরি হয়ে ডাউনলোড হবে।');
    expect(PAGE).toContain('Create — PDF ডাউনলোড করুন');
  });

  test('PDF failure shows a clear error and downloads NOTHING — no HTML fallback', async () => {
    const r = runFlow({ pdfFailTimes: 99 });
    r.els['start-passport-button'].click();
    fillValid(r);
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await flush();
    expect(r.chargeCalls.filter((c) => c.path === '/passport/create')).toHaveLength(1);
    expect(r.pdfCalls).toHaveLength(1);
    expect(r.downloads).toHaveLength(0);
    expect(r.blobs).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('PDF তৈরি করা যায়নি');
    expect(r.body.classList.contains('flow-form')).toBe(true);
  });

  test('a non-PDF answer from the server is an error, not a download', async () => {
    const r = runFlow({ pdfNonPdf: true });
    r.els['start-passport-button'].click();
    fillValid(r);
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await flush();
    expect(r.downloads).toHaveLength(0);
    expect(r.blobs).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('PDF তৈরি করা যায়নি');
  });

  test('retry after a PDF failure reuses the paid creation — one charge, no second charge', async () => {
    const r = runFlow({ pdfFailTimes: 1, chargeResponse: { ok: true, status: 200, body: { ok: true, charged: 30, orderId: 'o1', balance: 470 } } });
    r.els['start-passport-button'].click();
    fillValid(r);
    // First Create: charge ok, PDF fails → no download.
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await flush();
    expect(r.downloads).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('PDF তৈরি করা যায়নি');
    // Retry (same passport number): NO second charge, same idem, PDF now succeeds.
    r.els['create-passport-button'].click();
    await flush();
    expect(r.chargeCalls.filter((c) => c.path === '/passport/create')).toHaveLength(1);
    expect(r.pdfCalls).toHaveLength(2);
    const idemOf = (p) => decodeURIComponent(String(p).split('idempotency_key=')[1] || '');
    expect(idemOf(r.pdfCalls[1].path)).toBe(idemOf(r.pdfCalls[0].path));
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].name).toBe('Passport-EJ0762655.pdf');
    expect(r.blobs[0].type).toBe('application/pdf');
    expect(r.els['create-message'].textContent).toContain('Passport PDF তৈরি হয়েছে');
  });

  test('charge failure never reaches the PDF step', async () => {
    const r = runFlow({ chargeResponse: { ok: false, status: 402, body: { error: 'INSUFFICIENT_BALANCE', message: 'পর্যাপ্ত ব্যালেন্স নেই।' } } });
    r.els['start-passport-button'].click();
    fillValid(r);
    r.els['create-passport-button'].click();
    await flush();
    expect(r.pdfCalls).toHaveLength(0);
    expect(r.calls.exportHTML).toBe(0);
    expect(r.downloads).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('পর্যাপ্ত ব্যালেন্স নেই');
  });
});

describe('document-only export (bug fix 2026-11-14)', () => {
  // User report: Create downloaded the FULL ENGINE HTML (toolbar, form,
  // tabs, panels, editor scripts) with the document layers EMPTIED — it
  // only looked like a passport when opened, because the embedded editor
  // re-rendered it from #document-state. The export now builds only the
  // passport document. These tests run the REAL snapshotHTML() from the
  // page (sliced out of the editor IIFE) in vm against a stub DOM that
  // mirrors the live #page-shell, and assert on the produced HTML.
  const EXPORT_START = '/* ---- Document-only export (bug fix 2026-11-14) ----';
  const EXPORT_END = '/* ---- /Document-only export ---- */';
  const EXPORT_CODE = MAIN.slice(MAIN.indexOf(EXPORT_START), MAIN.indexOf(EXPORT_END));
  const STYLE_TEXT = PAGE.match(/<style>([\s\S]*?)<\/style>/)[1];

  // Minimal DOM stub: enough for cloneNode + querySelector(All) +
  // outerHTML, the only DOM surface snapshotHTML/cleanDocumentShell use.
  class StubStyle {
    constructor() { this.props = new Map(); }
    setProperty(k, v) { this.props.set(k, String(v)); }
    removeProperty(k) { this.props.delete(k); }
    getPropertyValue(k) { return this.props.get(k) || ''; }
    clone() { const s = new StubStyle(); s.props = new Map(this.props); return s; }
    get cssText() { return [...this.props.entries()].map(([k, v]) => k + ':' + v + ';').join(' '); }
  }
  function matchesSimple(el, part) {
    // tag, .class, [attr], tag.class, .a.b, tag[attr]
    const m = part.match(/^([a-zA-Z][a-zA-Z0-9]*)?((?:\.[a-zA-Z0-9_-]+)*)?(?:\[([a-zA-Z0-9_-]+)\])?$/);
    if (!m) return false;
    const [, tag, classes, attr] = m;
    if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    if (classes) {
      for (const c of classes.split('.').filter(Boolean)) {
        if (!el.classList.contains(c)) return false;
      }
    }
    if (attr && !el.hasAttribute(attr)) return false;
    return true;
  }
  function collectAll(el, out) {
    for (const c of el.children) { out.push(c); collectAll(c, out); }
    return out;
  }
  class StubEl {
    constructor(tag, attrs) {
      this.tagName = tag.toUpperCase();
      this.attributes = new Map(Object.entries(attrs || {}));
      this.children = [];
      this.parentNode = null;
      this.style = new StubStyle();
      this.text = '';
      this.classes = new Set(String((attrs || {}).class || '').split(/\s+/).filter(Boolean));
    }
    get id() { return this.attributes.get('id') || ''; }
    // Reflected attributes the export writes as properties (real DOM
    // reflects img.src / img.alt into attributes; the stub must too).
    get src() { return this.attributes.get('src') || ''; }
    set src(v) { this.attributes.set('src', String(v)); }
    get alt() { return this.attributes.get('alt') || ''; }
    set alt(v) { this.attributes.set('alt', String(v)); }
    get className() { return [...this.classes].join(' '); }
    set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get classList() {
      const self = this;
      return {
        add: (c) => self.classes.add(c),
        remove: (c) => self.classes.delete(c),
        contains: (c) => self.classes.has(c),
        toggle: (c, f) => { if (f === undefined) f = !self.classes.has(c); if (f) self.classes.add(c); else self.classes.delete(c); },
      };
    }
    get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this.text; }
    set textContent(v) { this.children = []; this.text = String(v); }
    getAttribute(n) { return this.attributes.has(n) ? this.attributes.get(n) : null; }
    setAttribute(n, v) { this.attributes.set(n, String(v)); }
    removeAttribute(n) { this.attributes.delete(n); }
    hasAttribute(n) { return this.attributes.has(n); }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    cloneNode(deep) {
      const c = new StubEl(this.tagName);
      c.attributes = new Map(this.attributes);
      c.classes = new Set(this.classes);
      c.style = this.style.clone();
      c.text = this.text;
      if (deep) for (const k of this.children) c.appendChild(k.cloneNode(true));
      return c;
    }
    replaceWith(n) {
      if (!this.parentNode) return;
      const i = this.parentNode.children.indexOf(this);
      this.parentNode.children.splice(i, 1, n);
      n.parentNode = this.parentNode;
    }
    remove() {
      if (!this.parentNode) return;
      const i = this.parentNode.children.indexOf(this);
      this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
    querySelectorAll(sel) {
      const out = [];
      for (const part of sel.split(',')) {
        const bits = part.trim().split(/\s+/);
        let pool = collectAll(this, []);
        if (bits.length === 2) {
          pool = pool.filter((el) => matchesSimple(el, bits[1]) && collectAll(this, []).some((a) => a !== el && matchesSimple(a, bits[0]) && collectAll(a, []).includes(el)));
        } else {
          pool = pool.filter((el) => matchesSimple(el, bits[0]));
        }
        for (const el of pool) if (!out.includes(el)) out.push(el);
      }
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    get outerHTML() {
      const voidTags = new Set(['IMG', 'BR', 'HR', 'INPUT', 'LINK', 'META']);
      let attrs = '';
      for (const [k, v] of this.attributes) {
        if (k === 'class') continue;
        attrs += ' ' + k + '="' + String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"';
      }
      if (this.classes.size) attrs += ' class="' + [...this.classes].join(' ') + '"';
      const css = this.style.cssText;
      if (css) attrs += ' style="' + css.replace(/"/g, '&quot;') + '"';
      const tag = this.tagName.toLowerCase();
      if (voidTags.has(this.tagName)) return '<' + tag + attrs + '>';
      const inner = this.children.length
        ? this.children.map((c) => c.outerHTML).join('')
        : String(this.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
    }
  }

  // A #page-shell mirroring the live one: scan artwork, rendered layers
  // (fields with text, photo/signature slots with data URIs), a drawn
  // dot-strip canvas, and the editor affordances the export must strip.
  function buildShell() {
    const shell = new StubEl('div', { id: 'page-shell', class: 'page-shell' });
    shell.appendChild(new StubEl('img', { id: 'scan', class: 'scan', src: 'data:image/webp;base64,SCANARTWORK' }));
    const erase = new StubEl('div', { id: 'erase-layer', class: 'page-layer erase-layer' });
    erase.style.setProperty('--sx', '0.44');
    erase.style.setProperty('--sy', '0.44');
    erase.appendChild(new StubEl('img', { class: 'erase-patch visible', src: 'data:image/png;base64,ERASEPATCH', 'data-patch-for': 'passport-no' }));
    shell.appendChild(erase);
    const imageLayer = new StubEl('div', { id: 'image-layer', class: 'page-layer image-layer' });
    const photo = new StubEl('div', { class: 'image-slot photo changed', 'data-slot': 'photo', tabindex: '0', role: 'button', 'aria-label': 'Replace photo' });
    photo.appendChild(new StubEl('img', { class: 'slot-image', src: 'data:image/jpeg;base64,USERPHOTO', alt: '' }));
    photo.appendChild(new StubEl('img', { class: 'slot-patch', src: 'data:image/png;base64,PHOTOPATCH', alt: '' }));
    imageLayer.appendChild(photo);
    const sig = new StubEl('div', { class: 'image-slot signature changed', 'data-slot': 'signature', tabindex: '0', role: 'button', 'aria-label': 'Replace signature' });
    sig.appendChild(new StubEl('img', { class: 'slot-image', src: 'data:image/png;base64,USERSIGNATURE', alt: '' }));
    imageLayer.appendChild(sig);
    shell.appendChild(imageLayer);
    const textLayer = new StubEl('div', { id: 'text-layer', class: 'page-layer text-layer' });
    const f1 = new StubEl('div', { class: 'field changed active', 'data-field': 'passport-no' });
    f1.style.setProperty('--text-color', '#000000');
    f1.style.setProperty('left', '100px');
    const t1 = new StubEl('span', { class: 'text', contenteditable: 'plaintext-only', tabindex: '0', role: 'textbox', 'aria-label': 'Passport No.' });
    t1.textContent = 'EJ0762655';
    f1.appendChild(t1);
    textLayer.appendChild(f1);
    const f2 = new StubEl('div', { class: 'field changed', 'data-field': 'mrz-2' });
    const t2 = new StubEl('span', { class: 'text', contenteditable: 'plaintext-only', tabindex: '0', role: 'textbox', 'aria-label': 'MRZ line 2' });
    t2.textContent = 'EJ0762655BGD7912171M3501011<<<<<<<<<<<<<<';
    f2.appendChild(t2);
    textLayer.appendChild(f2);
    const dotStrip = new StubEl('div', { class: 'dot-strip', 'aria-hidden': 'true' });
    dotStrip.style.setProperty('display', 'block');
    const canvas = new StubEl('canvas');
    canvas.width = 1523;
    canvas.height = 116;
    canvas.toDataURL = () => 'data:image/png;base64,DOTSTRIPDATA';
    dotStrip.appendChild(canvas);
    textLayer.appendChild(dotStrip);
    shell.appendChild(textLayer);
    return { shell, canvas, dotStrip };
  }

  function runExport(opts) {
    const { shell, canvas, dotStrip } = buildShell();
    const styleEl = new StubEl('style');
    styleEl.textContent = STYLE_TEXT;
    const model = { fields: [{ id: 'passport-no', text: (opts && opts.passportNo !== undefined) ? opts.passportNo : 'EJ0762655' }] };
    const documentStub = {
      querySelectorAll: (sel) => (sel === 'style' ? [styleEl] : []),
      querySelector: (sel) => {
        if (sel === '.dot-strip canvas') return canvas;
        if (sel === '.dot-strip') return dotStrip;
        if (sel === 'style') return styleEl;
        return null;
      },
      createElement: (tag) => new StubEl(tag),
      getElementById: (id) => (id === 'page-shell' ? shell : null),
    };
    const context = vm.createContext({
      document: documentStub,
      model,
      editRevision: 3,
      drainImages: async () => {},
      $: (id) => documentStub.getElementById(id),
    });
    vm.runInContext(EXPORT_CODE, context);
    return { context, shell, canvas };
  }

  const EDITOR_MARKERS = [
    'class="toolbar"', 'id="passport-landing"', 'id="panel-engine"', 'id="panel-text"',
    'id="panel-photo"', 'id="panel-signature"', 'id="document-state"', 'id="toast"',
    'id="print-button"', 'id="regions-button"', 'id="preview-button"',
    'window.passportEngine', 'window.documentEditor', 'function snapshotHTML',
    'id="eng-passportNo"', 'id="field-picker"', 'id="field-value"',
    'class="tabs"', 'Passport তৈরি করুন', 'id="passport-login-gate"',
    'id="create-passport-button"', 'id="eng-mrz-group"', 'id="eng-photo-group"',
    '<script', 'contenteditable', 'tabindex', 'data-field', 'data-slot',
  ];

  test('export contains the document and none of the editor', async () => {
    const { context } = runExport({});
    const { html, revision } = await context.snapshotHTML();
    expect(revision).toBe(3);
    for (const m of EDITOR_MARKERS) expect(html).not.toContain(m);
    // The document: shell, scan, rendered layers, filled data, MRZ.
    for (const m of ['id="page-shell"', 'id="scan"', 'id="text-layer"', 'id="image-layer"', 'id="erase-layer"', 'EJ0762655', 'EJ0762655BGD7912171M3501011', 'data:image/webp;base64,SCANARTWORK', 'data:image/jpeg;base64,USERPHOTO', 'data:image/png;base64,USERSIGNATURE', '@font-face', '.page-shell{', '.field .text', '<title>Passport-EJ0762655</title>']) {
      expect(html).toContain(m);
    }
    // Rendered fields and slots survive (the old export emptied them).
    expect(html).toContain('class="field changed"');
    expect(html).toContain('class="image-slot photo changed"');
    expect(html).toContain('class="image-slot signature changed"');
    // The `changed` class stays (it is what makes text/photo visible);
    // the editor `active` selection class is gone.
    expect(html).not.toContain('active');
    // Layers no longer carry the live editor's inline scale.
    expect(html).not.toContain('--sx:0.44');
    expect(html).not.toContain('--sy:0.44');
    // The document carries the fixed A4 scale instead.
    expect(html).toContain('.page-layer{transform:scale(0.31948366277,0.31965032307)}');
    expect(html).toContain('.page-shell{width:792px;');
  });

  test('export bakes the dotted strip canvas into an image, no canvas left', async () => {
    const { context } = runExport({});
    const { html } = await context.snapshotHTML();
    expect(html).toContain('data:image/png;base64,DOTSTRIPDATA');
    expect(html).not.toContain('<canvas');
    expect(html).toContain('.dot-strip img{display:block;width:100%;height:100%}');
  });

  test('export title falls back to Passport-Engine without a number', async () => {
    const { context } = runExport({ passportNo: '' });
    const { html } = await context.snapshotHTML();
    expect(html).toContain('<title>Passport-Engine</title>');
  });

  test('documentCSS keeps document rules and drops editor rules', () => {
    const { context } = runExport({});
    const css = context.documentCSS();
    for (const r of ['@font-face{font-family:ScanSans', ':root{color-scheme:light', '.page-shell{position:relative', '.scan{position:absolute', '.page-layer{position:absolute', '.field{position:absolute', '.field .text{display:block', '.field.changed .text{color:var(--text-color)}', '.image-slot{position:absolute', '.image-slot.changed .slot-image{display:block}', '@media print{', '@page{size:594pt 841pt']) {
      expect(css).toContain(r);
    }
    for (const r of ['.toolbar{', 'aside{', '.tabs{', '.tab-panel', 'button{', 'input[type=text]', '.passport-landing', 'body.flow-form', 'body.flow-landing', '.engine-group{', '@media(max-width:1060px)', '@media(max-width:740px)', '.toast{', '.footer-note{']) {
      expect(css).not.toContain(r);
    }
    // No editor rule leaks in via a selector list.
    expect(css).not.toContain('panel-engine');
    expect(css).not.toContain('passport-landing');
  });
});
