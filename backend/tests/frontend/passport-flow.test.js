// Passport engine form-first flow — frontend only (text-reading + vm).
//
// Flow (user direction 2026-11-14): landing "Passport তৈরি করুন" → a
// SEPARATE form screen (1st page = form, only what the user fills up —
// no MRZ auto fields, no document preview, no editor chrome) → Create
// → DIRECT real-PDF download → result screen. NO EDITOR: the output is
// just the PDF (like the NID engines); a change after Create means
// refilling the form and pressing Create again. Automation (name
// auto-split, MRZ auto-generation, dates) still runs behind the scenes
// through the engine inputs — it is computed, not displayed. The output
// itself (MRZ TD3, dotted strip, name split, dates, photo/signature
// slots) is untouched — the change is the FLOW only, driven through the
// exposed document-engine APIs (window.passportEngine /
// window.documentEditor).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../../../frontend');
const PAGE = fs.readFileSync(path.join(FRONTEND, 'passport.html'), 'utf8');
const CSS = fs.readFileSync(path.join(FRONTEND, 'css/passport-flow.css'), 'utf8');

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
  // Balance pill (site-feel Fix 1): topbar (landing/form/result)
  // shows the wallet balance, bn-formatted. No editor pill anymore.
  els['balVal'] = makeEl('balVal', 'span');
  els['balVal'].textContent = '০';
  // Post-Create result screen (site-feel Fix 6): success first, no
  // editor — re-download, back to form, or start fresh.
  els['passport-result'] = makeEl('passport-result', 'section');
  els['result-message'] = makeEl('result-message', 'p');
  els['download-again-button'] = makeEl('download-again-button', 'button');
  els['back-to-form-button'] = makeEl('back-to-form-button', 'button');
  els['new-passport-button'] = makeEl('new-passport-button', 'button');
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
    expect(CSS).toContain('#passport-landing{display:none}');
    expect(CSS).toContain('body.flow-landing #passport-landing{display:block}');
  });

  test('landing state hides the document and the form (no editor anywhere)', () => {
    expect(CSS).toContain('body.flow-landing .document-area,body.flow-landing #panel-engine{display:none}');
    expect(PAGE).not.toContain('class="toolbar"');
    expect(PAGE).not.toContain('<aside');
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
    expect(CSS).toContain('.form-head{display:none}');
    expect(CSS).toContain("body.flow-form .form-head{display:block;margin:0 0 4px}");
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
    expect(CSS).toContain('.back-button{background:none;border:0;color:var(--muted);cursor:pointer;font-size:13px;padding:0;margin:0 0 2px;text-align:left}');
    expect(FLOW).toContain('back-to-landing-button');
    expect(FLOW).toContain('formEntered');
  });

  test('form screen has no editor chrome at all (no panel head, tabs, toolbar)', () => {
    expect(PAGE).not.toContain('class="toolbar"');
    expect(PAGE).not.toContain('<aside');
    expect(PAGE).not.toContain('class="tabs"');
    expect(PAGE).not.toContain('id="panel-text"');
    expect(PAGE).not.toContain('id="panel-photo"');
    expect(PAGE).not.toContain('id="panel-signature"');
    expect(CSS).toContain('body.flow-form #panel-engine>.helper{display:none}');
    expect(CSS).toContain('body.flow-form .document-area{display:none}');
  });

  test('form screen hides the MRZ group — the MRZ fields are not shown', () => {
    expect(CSS).toContain('body.flow-form #eng-mrz-group{display:none}');
    const groupAt = PAGE.indexOf('id="eng-mrz-group"');
    const mrz1At = PAGE.indexOf('id="eng-mrz1"');
    const mrz2At = PAGE.indexOf('id="eng-mrz2"');
    const createAt = PAGE.indexOf('id="create-passport-button"');
    expect(groupAt).toBeLessThan(mrz1At);
    expect(mrz1At).toBeLessThan(mrz2At);
    expect(mrz2At).toBeLessThan(createAt);
  });

  test('form screen hides the auto name-split fields', () => {
    expect(CSS).toContain('body.flow-form #eng-name-auto-row{display:none}');
    const rowAt = PAGE.indexOf('id="eng-name-auto-row"');
    const surnameAt = PAGE.indexOf('id="eng-surname"');
    const givenAt = PAGE.indexOf('id="eng-givenName"');
    const fatherAt = PAGE.indexOf('id="eng-fatherName"');
    expect(rowAt).toBeLessThan(surnameAt);
    expect(surnameAt).toBeLessThan(givenAt);
    expect(givenAt).toBeLessThan(fatherAt);
  });

  test('form screen hides preview, hints and auto-only controls — except validation', () => {
    expect(CSS).toContain('body.flow-form #eng-passportPreview,body.flow-form #eng-dotmx-note{display:none}');
    // Validation must stay VISIBLE on the form screen (findings 1–6): the
    // engine computes format/consistency issues, and Create now blocks on
    // them — hiding the line would make the block reason undiscoverable.
    // Only the other hints are hidden.
    expect(CSS).toContain('body.flow-form #panel-engine .engine-hint:not(#create-message):not(#engine-validation):not(#eng-nationality-hint){display:none}');
    expect(CSS).toContain('body.flow-form #engine-validation{color:#b3261e;font-weight:600}');
    expect(CSS).toContain('body.flow-form .auto-tag{display:none}');
    expect(CSS).toContain('body.flow-form #eng-dotstrip-row{display:none}');
  });

  test('passport-no input is limited to 9 characters (finding 5: MRZ truncates silently otherwise)', () => {
    const at = PAGE.indexOf('id="eng-passportNo"');
    expect(at).toBeGreaterThan(-1);
    expect(PAGE.slice(at, at + 200)).toContain('maxlength="9"');
  });

  test('form state is a two-column grid at the standard content width', () => {
    expect(CSS).toContain('body.flow-form main{grid-template-columns:minmax(0,1fr);max-width:1046px}');
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
    const docAt = PAGE.indexOf('class="document-area"');
    expect(groupAt).toBeGreaterThan(headAt);
    expect(groupAt).toBeLessThan(passportAt);
    expect(groupAt).toBeLessThan(createAt);
    expect(createAt).toBeLessThan(docAt);
  });

  test('form state does not hide the upload group — the confirmation stays hidden until a file is chosen', () => {
    expect(PAGE).not.toContain('eng-photo-group{display:none}');
    expect(CSS).toContain('.form-upload-status[hidden]{display:none}');
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
    expect(CSS).toContain('.form-sample-warning{margin:4px 0 0;color:#b3261e;font-weight:600;line-height:1.7}');
    expect(CSS).toContain('.form-sample-warning[hidden]{display:none}');
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

  test('the editor panels are gone entirely (text/photo/signature tabs + style controls)', () => {
    for (const id of ['panel-text', 'panel-photo', 'panel-signature', 'style-details', 'field-picker', 'field-value', 'style-controls', 'photo-fit', 'photo-cutout', 'preserve-stamp', 'signature-remove-white', 'signature-trim']) {
      expect(PAGE).not.toContain('id="' + id + '"');
    }
    expect(PAGE).not.toContain('অক্ষর ও অবস্থান');
    expect(PAGE).not.toContain('class="tabs"');
  });

  test('no editor status/unsaved machinery remains; the document-only export never touches it', () => {
    expect(MAIN).not.toContain('updateStatus');
    expect(MAIN).not.toContain('unsaved');
    expect(MAIN).not.toContain('beforeunload');
    expect(MAIN).not.toContain("const st=$('status')");
    // The document-only export (bug fix 2026-11-14) builds a fresh
    // document from #page-shell — it never references #status.
    expect(MAIN).not.toContain("root.querySelector('#status')");
  });

  test('form-state groups have no divider borders — spacing only, simpler premium look', () => {
    expect(CSS).toContain('body.flow-form .engine-group{border-top:0;margin-top:2px;padding-top:0}');
  });
});

describe('Create → download', () => {
  test('Create button + status message sit at the end of the form, outside the MRZ group', () => {
    expect(PAGE).toContain('id="create-passport-button"');
    expect(PAGE).toContain('Create — PDF ডাউনলোড করুন');
    expect(PAGE).toContain('id="create-message"');
    const createAt = PAGE.indexOf('id="create-passport-button"');
    const remrzAt = PAGE.indexOf('id="eng-remrz"');
    expect(createAt).toBeGreaterThan(remrzAt);
    const docAt = PAGE.indexOf('class="document-area"');
    expect(createAt).toBeLessThan(docAt);
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
    expect(FLOW).toContain("['passportNo','পাসপোর্ট নম্বর']");
    expect(FLOW).toContain("['docType','ধরন']");
    expect(FLOW).toContain("['countryCode','দেশের কোড']");
    expect(FLOW).toContain("['fullName','পুরো নাম']");
    expect(FLOW).toContain("['dob','জন্মতারিখ']");
    expect(FLOW).toContain("['sex','লিঙ্গ']");
    expect(FLOW).toContain("['expiryDate','মেয়াদের তারিখ']");
    expect(FLOW).toContain("['nationality','জাতীয়তা']");
  });

  test('Create blocks on engine validation issues and names the problem', () => {
    expect(FLOW).toContain('api.validate()');
    expect(FLOW).toContain('পাসপোর্ট তৈরির আগে ঠিক করুন:');
  });
});

describe('flow layer drives the document engine through frozen APIs', () => {
  test('the engine IIFE still exposes the same frozen APIs (no editor-only surface)', () => {
    expect(MAIN).toContain('window.passportEngine=Object.freeze');
    expect(MAIN).toContain('window.documentEditor=Object.freeze');
    expect(MAIN).toContain('applyAll:applyAllEngine');
    expect(MAIN).toContain('regenerateMRZ,');
    expect(MAIN).toContain('validate:validateEngine,');
    expect(MAIN).toContain('buildMrz1,buildMrz2,');
    expect(MAIN).toContain('getState:()=>clone(model),setText,');
    expect(MAIN).toContain('setImage:(type,input)=>track(setImage(type,input)),resetImage,exportHTML');
    expect(MAIN).not.toContain('setStyle,');
    expect(MAIN).not.toContain('resetRegion,');
    expect(MAIN).not.toContain('inspect:');
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
    // Defaults (user direction 2026-11-15): Type "P" and Country code
    // "BGD" are pre-filled; everything else is blank.
    expect(r.els['eng-docType'].value).toBe('P');
    expect(r.els['eng-countryCode'].value).toBe('BGD');
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

  test('filling + Create downloads the PDF and shows the result screen first (no editor — just the PDF)', async () => {
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
    expect(r.body.classList.contains('flow-result')).toBe(true);
    expect(r.els['create-message'].textContent).toContain('Passport PDF তৈরি হয়েছে');
    expect(r.els['result-message'].textContent).toContain('Passport-EJ0762655.pdf');
  });

  // Site-feel Fix 6: post-Create result screen — success first, no
  // editor; re-download is free (same stored blob).
  async function createOk() {
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
    return r;
  }

  test('result screen: download-again re-downloads the same PDF, no new charge', async () => {
    const r = await createOk();
    expect(r.body.classList.contains('flow-result')).toBe(true);
    r.els['download-again-button'].click();
    expect(r.downloads).toHaveLength(2);
    expect(r.downloads[1].name).toBe('Passport-EJ0762655.pdf');
    expect(r.chargeCalls.filter((c) => c.path === '/passport/create')).toHaveLength(1);
  });

  test('result screen: no editor entry point anywhere in the flow', async () => {
    const r = await createOk();
    expect(r.body.classList.contains('flow-result')).toBe(true);
    expect(PAGE).not.toContain('id="edit-more-button"');
    expect(PAGE).not.toContain('আরও সম্পাদনা করুন');
    expect(FLOW).not.toContain('edit-more-button');
    // The only exits are re-download, back to form, or a fresh start.
    expect(PAGE).toContain('id="download-again-button"');
    expect(PAGE).toContain('id="back-to-form-button"');
    expect(PAGE).toContain('id="new-passport-button"');
  });

  test('result screen: back-to-form returns to the form with the data kept', async () => {
    const r = await createOk();
    r.els['back-to-form-button'].click();
    expect(r.body.classList.contains('flow-form')).toBe(true);
    expect(r.body.classList.contains('flow-result')).toBe(false);
    expect(r.els['eng-passportNo'].value).toBe('EJ0762655');
  });

  test('result screen: new-passport blanks the form for a fresh start', async () => {
    const r = await createOk();
    r.els['new-passport-button'].click();
    expect(r.body.classList.contains('flow-form')).toBe(true);
    expect(r.body.classList.contains('flow-result')).toBe(false);
    expect(r.els['eng-passportNo'].value).toBe('');
    expect(r.els['eng-fullName'].value).toBe('');
    // A fresh start restores the defaults (user direction 2026-11-15).
    expect(r.els['eng-docType'].value).toBe('P');
    expect(r.els['eng-countryCode'].value).toBe('BGD');
  });

  test('result screen markup: success message, re-download, history link (no editor)', () => {
    expect(PAGE).toContain('id="passport-result"');
    expect(PAGE).toContain('id="result-message"');
    expect(PAGE).toContain('id="download-again-button"');
    expect(PAGE).toContain('আবার ডাউনলোড করুন');
    expect(PAGE).not.toContain('id="edit-more-button"');
    expect(PAGE).not.toContain('আরও সম্পাদনা করুন');
    expect(PAGE).toContain('href="/history.html"');
    expect(PAGE).toContain('ইতিহাসে দেখুন');
    expect(PAGE).toContain('id="back-to-form-button"');
    expect(PAGE).toContain('id="new-passport-button"');
  });

  test('result screen CSS: shown only in flow-result; form + document hidden there', () => {
    expect(CSS).toContain('#passport-result{display:none}');
    expect(CSS).toContain('body.flow-result #passport-result{display:block}');
    expect(CSS).toContain('body.flow-result .document-area,body.flow-result #panel-engine{display:none}');
    expect(CSS).toContain('body.flow-result #passport-topbar');
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
    expect(r.els['create-message'].textContent).toContain('জন্মতারিখ');
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
    expect(r.els['create-message'].textContent).toContain('মেয়াদের তারিখ');
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
    expect(r.els['create-message'].textContent).toContain('লিঙ্গ');
    expect(r.els['eng-sex'].focused).toBe(true);
  });

  test('Create blocked by an engine validation issue downloads nothing and names it (findings 1, 5)', () => {
    const r = runFlow({ validateIssues: ['তিন অক্ষরের জাতীয়তার কোড লিখুন; ইস্যুকারী দেশ থেকে এটি ধরে নেওয়া হয় না।'] });
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
    expect(r.els['create-message'].textContent).toContain('জাতীয়তার কোড');
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

describe('field defaults — Type P / Country code BGD (2026-11-15)', () => {
  // User direction: Type (ধরন) and Country code (দেশের কোড) are
  // pre-filled with defaults and stay editable — change or clear them.
  function fillRequired(r) {
    r.els['eng-passportNo'].value = 'EJ0762655';
    r.els['eng-fullName'].value = 'GOLAM KIBRIYA MD';
    r.els['eng-dob'].value = '1979-12-17';
    r.els['eng-sex'].value = 'M';
    r.els['eng-expiryDate'].value = '2035-01-01';
    r.els['eng-nationality'].value = 'BANGLADESHI';
  }

  test('defaults are a single source in the flow (FORM_DEFAULTS)', () => {
    expect(FLOW).toContain("var FORM_DEFAULTS = { docType: 'P', countryCode: 'BGD' };");
    expect(FLOW).toContain('FORM_KEYS.forEach(function(k){ setEng(k, FORM_DEFAULTS[k] || \'\'); });');
  });

  test('fresh form pre-fills Type P and Country code BGD', () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    expect(r.els['eng-docType'].value).toBe('P');
    expect(r.els['eng-countryCode'].value).toBe('BGD');
  });

  test('defaults are plain editable inputs, not disabled or readonly', () => {
    expect(PAGE).toContain('<input type="text" id="eng-docType" data-engine="docType" maxlength="1" spellcheck="false" autocomplete="off">');
    expect(PAGE).toContain('<input type="text" id="eng-countryCode" data-engine="countryCode" maxlength="3" spellcheck="false" autocapitalize="off" autocomplete="off">');
    const r = runFlow({});
    r.els['start-passport-button'].click();
    r.els['eng-docType'].value = 'D';
    r.els['eng-countryCode'].value = 'USA';
    expect(r.els['eng-docType'].value).toBe('D');
    expect(r.els['eng-countryCode'].value).toBe('USA');
  });

  test('clearing Type blocks Create naming ধরন', () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    fillRequired(r);
    r.els['eng-docType'].value = '';
    r.els['create-passport-button'].click();
    expect(r.calls.exportHTML).toBe(0);
    expect(r.downloads).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('ধরন পূরণ করুন।');
    expect(r.els['eng-docType'].focused).toBe(true);
    expect(r.body.classList.contains('flow-form')).toBe(true);
  });

  test('clearing Country code blocks Create naming দেশের কোড', () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    fillRequired(r);
    r.els['eng-countryCode'].value = '';
    r.els['create-passport-button'].click();
    expect(r.calls.exportHTML).toBe(0);
    expect(r.downloads).toHaveLength(0);
    expect(r.els['create-message'].textContent).toContain('দেশের কোড পূরণ করুন।');
    expect(r.els['eng-countryCode'].focused).toBe(true);
    expect(r.body.classList.contains('flow-form')).toBe(true);
  });

  test('Create with the untouched defaults proceeds (required gate passes)', async () => {
    const r = runFlow({});
    r.els['start-passport-button'].click();
    fillRequired(r);
    // docType 'P' and countryCode 'BGD' are the pre-filled defaults.
    expect(r.els['eng-docType'].value).toBe('P');
    expect(r.els['eng-countryCode'].value).toBe('BGD');
    r.els['create-passport-button'].click();
    await r.state.exportedPromise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.calls.exportHTML).toBe(1);
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].name).toBe('Passport-EJ0762655.pdf');
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
    expect(CSS).not.toContain('--pg-bg:#faf9f4');
    expect(CSS).not.toContain('--pg-green:#006441');
    expect(CSS).not.toContain('--pg-gold:#efb541');
    expect(CSS).toContain('--pg-bg:var(--bg-page)');
    expect(CSS).toContain('--pg-green:var(--primary-600)');
    expect(CSS).toContain('var(--gold-gradient)');
    expect(CSS).not.toContain('var(--pg-gold-2)');
    // The form's premium rules themselves are unchanged.
    expect(CSS).toContain('body.flow-form #panel-engine{background:var(--pg-surface)');
  });

  test('Bengali chrome: lang, title, no editor chrome, no old English strings', () => {
    expect(PAGE).toContain('<html lang="bn">');
    expect(PAGE).toContain('<title>পাসপোর্ট ইঞ্জিন - All In One</title>');
    // The editor is gone: no toolbar actions, no tabs, no print button.
    // (প্রিভিউ stays as a word inside a form hint — only the button id
    // is asserted absent.)
    for (const s of ['অঞ্চল দেখুন', 'প্রিন্ট', 'id="regions-button"', 'id="preview-button"', 'id="print-button"', 'data-tab="engine">ইঞ্জিন', 'data-tab="text">লেখা', 'data-tab="photo">ছবি', 'data-tab="signature">স্বাক্ষর', 'id="panel-text"', 'id="panel-photo"', 'id="panel-signature"']) {
      expect(PAGE).not.toContain(s);
    }
    // No HTML download path anymore (fix 2026-11-14): the toolbar's
    // HTML-save button, its wiring and Ctrl+S are all gone.
    for (const s of ['প্রিন্ট / PDF', 'HTML সংরক্ষণ করুন', 'id="save-button"', 'saveHTML', "key==='s'"]) {
      expect(PAGE).not.toContain(s);
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

  // Site-feel Fix 1: the balance pill (same as the other engines) in all
  // three views — topbar pill on landing/form, toolbar pill in the editor.
  test('balance pill: landing shows the real balance in Bengali digits', async () => {
    const r = runFlow({});
    await flush();
    expect(r.els['balVal'].textContent).toBe('৫০০');
  });

  test('balance pill markup: the topbar pill links to the wallet', () => {
    expect(PAGE).toContain('id="walletBadge"');
    expect(PAGE).toContain('id="balVal"');
    expect(PAGE).not.toContain('id="walletBadgeEditor"');
    expect(PAGE).not.toContain('id="balValEditor"');
    expect(PAGE).toContain("location.href='/wallet.html'");
    expect(PAGE).toContain('💳 ব্যালেন্স: ৳');
  });

  test('balance pill CSS: topbar shown on landing/form/result (no editor view)', () => {
    expect(CSS).toContain('#passport-topbar{display:none}');
    expect(CSS).toContain('body.flow-landing #passport-topbar,body.flow-form #passport-topbar,body.flow-result #passport-topbar');
  });

  // Site-feel Fix 2: the standard page header (emoji + Bengali h2 +
  // subtitle, same pattern as land-khatian/nid-replica) on landing/form.
  test('standard page header: emoji + Bengali h2 + subtitle in the topbar', () => {
    expect(PAGE).toContain('id="passport-topbar"');
    expect(PAGE).toContain('<h2>🛂 পাসপোর্ট ইঞ্জিন</h2>');
    expect(PAGE).toContain('ফর্ম পূরণ করুন — Create চাপলে পাসপোর্ট PDF তৈরি হয়ে ডাউনলোড হবে।');
  });

  // Two-column form (2026-11-15): the form is side-by-side premium at
  // the standard content width — no more 760px single column.
  // Two columns hold on mobile too (user direction 2026-11-15) — the
  // 740px query keeps only spacing tweaks, never a single-column
  // collapse.
  test('landing and form both fill the standard content width (1046px)', () => {
    expect(CSS).toContain('body.flow-landing main{display:block}');
    expect(CSS).not.toContain('body.flow-landing main{display:block;max-width:760px}');
    expect(CSS).toContain('body.flow-form main{grid-template-columns:minmax(0,1fr);max-width:1046px}');
  });

describe('two-column premium form (2026-11-15)', () => {
  // User complaint: the form was one very long column with no premium
  // sizing. Groups now lay their fields out in a 2-column grid on
  // desktop and on mobile too. Group + field order is unchanged; only
  // the layout moved.
  test('form groups use the two-column grid', () => {
    for (const rule of [
      'body.flow-form .form-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 16px}',
      'body.flow-form .form-grid>.engine-legend{grid-column:1/-1}',
      'body.flow-form .form-grid>.engine-row{grid-column:1/-1;gap:0 16px}',
      'body.flow-form .form-grid>.checkbox{grid-column:1/-1}',
      'body.flow-form .form-grid .span-2{grid-column:1/-1}',
      'body.flow-form #eng-emergency-box:not([hidden]){display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 16px}',
    ]) expect(CSS).toContain(rule);
    // The five visible groups carry the grid class; the MRZ group stays
    // hidden on the form screen and keeps its single-column rules.
    expect(PAGE.match(/class="engine-group form-grid"/g)).toHaveLength(5);
    expect(PAGE).toContain('<div class="engine-group" id="eng-mrz-group">');
  });

  test('passport number is one column, full name keeps its full span; pairs share a row', () => {
    // User direction 2026-11-15: the passport number box was too wide —
    // a 9-character number needs no full-width box. Full name stays wide.
    expect(PAGE).toContain('<div class="form-field"><label for="eng-passportNo">');
    expect(PAGE).not.toContain('<div class="form-field span-2"><label for="eng-passportNo">');
    expect(PAGE).toContain('<div class="form-field span-2"><label for="eng-fullName">');
    for (const id of ['eng-fatherName', 'eng-motherName', 'eng-birthPlace', 'eng-nationality', 'eng-nationalityCode', 'eng-personalNo', 'eng-previousPassport', 'eng-authority', 'eng-address1', 'eng-address2', 'eng-emergencyName']) {
      expect(PAGE).toContain('<div class="form-field"><label for="' + id + '">');
    }
    // The nationality hint travels with its field (it is the one hint
    // the form screen keeps visible).
    const fieldAt = PAGE.indexOf('<div class="form-field"><label for="eng-nationalityCode">');
    const hintAt = PAGE.indexOf('id="eng-nationality-hint"');
    const closeAt = PAGE.indexOf('</div>', fieldAt);
    expect(hintAt).toBeGreaterThan(fieldAt);
    expect(hintAt).toBeLessThan(closeAt);
  });

  test('field order is unchanged (visual order = DOM order)', () => {
    const ids = ['eng-passportNo', 'eng-docType', 'eng-countryCode', 'eng-fullName', 'eng-fatherName', 'eng-motherName', 'eng-spouseName', 'eng-dob', 'eng-sex', 'eng-issueDate', 'eng-expiryDate', 'eng-birthPlace', 'eng-nationality', 'eng-nationalityCode', 'eng-personalNo', 'eng-previousPassport', 'eng-authority', 'eng-address1', 'eng-address2', 'eng-sameEmergency', 'eng-emergency1', 'eng-emergency2', 'eng-phone', 'eng-relationship', 'eng-emergencyName'];
    let prev = -1;
    for (const id of ids) {
      const at = PAGE.indexOf('id="' + id + '"');
      expect(at).toBeGreaterThan(prev);
      prev = at;
    }
  });

  test('mobile stays two-column at the 740px breakpoint — no single-column collapse', () => {
    // User direction 2026-11-15: on mobile the form did not become
    // side-by-side. The 740px query keeps only spacing tweaks; the
    // grid, the emergency box and the photo/signature row stay 2-column.
    expect(CSS).not.toContain('body.flow-form .form-grid{grid-template-columns:minmax(0,1fr)}');
    expect(CSS).not.toContain('body.flow-form #eng-emergency-box:not([hidden]){grid-template-columns:minmax(0,1fr)}');
    expect(CSS).not.toContain('body.flow-form .form-upload-row{grid-template-columns:1fr}');
    expect(CSS).toContain('body.flow-form .form-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 16px}');
    expect(CSS).toContain('.form-upload-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}');
  });

  test('flow stylesheet is cache-busted for the new layout', () => {
    expect(PAGE).toContain('/css/passport-flow.css?v=5');
  });
});

describe('compact dense form (2026-11-15)', () => {
  // User frustration: even the two-column form was still 2166px tall at
  // 1366px. Tighter gaps, shorter inputs, tighter sections — dense, not
  // cramped. The 2166 → 1500 → 1295px height is verified in a real
  // browser (measure-defects.js / verify-defect-fixes-a.js); these tests
  // lock the density values in CSS.
  test('inputs are compact but keep 16px text (no iOS zoom on focus)', () => {
    expect(CSS).toContain('padding:5px 12px;font-size:16px;line-height:1.3;min-height:32px');
  });

  test('field labels sit tight to their inputs', () => {
    expect(CSS).toContain('body.flow-form #panel-engine .form-grid .form-field label{margin-top:2px}');
    expect(CSS).toContain('body.flow-form #panel-engine label:not(.checkbox){font-size:13px;font-weight:600;color:var(--pg-ink);margin:2px 0 2px}');
  });

  test('groups and legends are tight', () => {
    expect(CSS).toContain('body.flow-form .engine-group{border-top:0;margin-top:2px;padding-top:0}');
    expect(CSS).toContain('body.flow-form .engine-legend{font-size:11px;letter-spacing:.12em;color:var(--pg-green);margin:0}');
  });

  test('card, head, photo boxes and Create area are tight', () => {
    expect(CSS).toContain('body.flow-form #panel-engine{background:var(--pg-surface);border:1px solid var(--pg-line);border-radius:24px;box-shadow:var(--pg-shadow-md);padding:10px 20px 10px}');
    expect(CSS).toContain('body.flow-form .form-head h2{font-size:20px;');
    expect(CSS).toContain('body.flow-form #eng-photo-group .primary{background:var(--pg-surface);color:var(--pg-green);border:1px solid var(--pg-hover);border-radius:14px;padding:7px;font-size:13px;');
    expect(CSS).toContain('body.flow-form .create-actions{margin-top:8px;padding-top:6px;');
    expect(CSS).toContain('body.flow-form .create-actions .primary{background:var(--gold-gradient);color:var(--pg-gold-text);border-color:transparent;border-radius:14px;font-size:15px;font-weight:700;padding:10px;');
  });

  test('passport number is one grid column, full name keeps its full span', () => {
    // User direction 2026-11-15: a 9-character number needs no
    // full-width box. Before: 946px wide (span-2); after: ~465px.
    expect(PAGE).toContain('<div class="form-field"><label for="eng-passportNo">');
    expect(PAGE).not.toContain('<div class="form-field span-2"><label for="eng-passportNo">');
    expect(PAGE).toContain('<div class="form-field span-2"><label for="eng-fullName">');
  });

  test('mobile keeps the two-column grid and the tight card', () => {
    expect(CSS).not.toContain('body.flow-form .form-grid{grid-template-columns:minmax(0,1fr)}');
    expect(CSS).toContain('body.flow-form #panel-engine{padding:12px 14px 16px}');
  });

  test('date rows hold their tracks — date inputs shrink into their cells (2026-11-15)', () => {
    // Defect: the expiry input poked 73px past the card at 360px — the
    // native date input's intrinsic min-width blew the 1fr tracks out.
    expect(CSS).toContain('.engine-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 9px}');
    expect(CSS).toContain('body.flow-form .engine-row>div{min-width:0}');
    expect(CSS).toContain('body.flow-form input[type=date]{width:100%;min-width:0}');
    // Mobile: 14px date text so mm/dd/yyyy is fully visible in the
    // ~121px column (at 16px the year clipped to "mm/dd/").
    expect(CSS).toContain('body.flow-form input[type=date]{font-size:14px;padding:7px 8px}');
    expect(CSS).toContain('body.flow-form main{margin:12px auto 24px;padding:0 16px}');
  });
});

  // Site-feel Fix 4: Bengali kicker + Bengali-only section headers —
  // no English halves, no transliterated "লিংকড" in chrome.
  test('kicker and section headers are Bengali-only', () => {
    expect(PAGE).toContain('<p class="kicker">পাসপোর্ট ইঞ্জিন</p>');
    expect(PAGE).not.toContain('<p class="kicker">Passport Engine</p>');
    expect(PAGE).toContain('<p class="engine-legend">ছবি ও স্বাক্ষর</p>');
    expect(PAGE).toContain('<p class="engine-legend">পাসপোর্ট</p>');
    expect(PAGE).toContain('<p class="engine-legend">নাম ');
    expect(PAGE).toContain('<p class="engine-legend">পরিবার</p>');
    expect(PAGE).toContain('<p class="engine-legend">তারিখ ও ব্যক্তিগত তথ্য</p>');
    expect(PAGE).toContain('<p class="engine-legend">ঠিকানা ও যোগাযোগ</p>');
    expect(PAGE).toContain('MRZ · মেশিন-পাঠযোগ্য');
    expect(PAGE).not.toContain('সংযুক্ত তথ্য · মূল স্ক্যান সংরক্ষিত');
    expect(PAGE).not.toContain('লিংকড তথ্য');
    expect(PAGE).not.toContain('Photo &amp; signature');
    expect(PAGE).not.toContain('machine-readable');
  });

  // Site-feel Fix 8: Bengali labels + hints throughout the form and
  // editor. MRZ/TD3 stay as technical terms; the printed document's
  // own English (scan artwork, field values) is untouched.
  test('form labels are Bengali (no English halves)', () => {
    for (const s of [
      '<label for="eng-passportNo">পাসপোর্ট নম্বর',
      '<label for="eng-docType">ধরন</label>',
      '<label for="eng-countryCode">দেশের কোড</label>',
      '<label for="eng-fullName">পুরো নাম</label>',
      '<label for="eng-surname">পদবি (স্বয়ংক্রিয়)</label>',
      '<label for="eng-givenName">প্রদত্ত নাম (স্বয়ংক্রিয়)</label>',
      '<label for="eng-fatherName">পিতার নাম</label>',
      '<label for="eng-motherName">মাতার নাম</label>',
      '<label for="eng-spouseName">স্বামী/স্ত্রীর নাম</label>',
      '<label for="eng-dob">জন্মতারিখ</label>',
      '<label for="eng-sex">লিঙ্গ</label>',
      '<label for="eng-issueDate">ইস্যুর তারিখ</label>',
      '<label for="eng-expiryDate">মেয়াদের তারিখ</label>',
      '<label for="eng-birthPlace">জন্মস্থান</label>',
      '<label for="eng-nationality">জাতীয়তা</label>',
      '<label for="eng-nationalityCode">জাতীয়তার কোড (MRZ)</label>',
      '<label for="eng-personalNo">ব্যক্তিগত / এনআইডি নম্বর</label>',
      '<label for="eng-previousPassport">পূর্ববর্তী পাসপোর্ট নম্বর</label>',
      '<label for="eng-authority">ইস্যুকারী কর্তৃপক্ষ</label>',
      '<label for="eng-address1">ঠিকানা (প্রথম লাইন)</label>',
      '<label for="eng-phone">ফোন</label>',
      '<label for="eng-relationship">সম্পর্ক</label>',
      '<label for="eng-emergencyName">জরুরি কন্টাক্টের নাম</label>',
      '<label for="eng-mrz1">১ম লাইন</label>',
      '<label for="eng-mrz2">২য় লাইন</label>',
      '<option value="M">M — পুরুষ</option>',
      '<option value="F">F — নারী</option>',
      'MRZ আবার তৈরি করুন',
      'পাতায় আবার বসান',
    ]) expect(PAGE).toContain(s);
    for (const [id, en] of [
      ['eng-passportNo', 'Passport No.'],
      ['eng-docType', 'Type'],
      ['eng-countryCode', 'Country code'],
      ['eng-fullName', 'Full name'],
      ['eng-surname', 'Surname (auto)'],
      ['eng-givenName', 'Given name (auto)'],
      ['eng-fatherName', "Father's name"],
      ['eng-motherName', "Mother's name"],
      ['eng-spouseName', "Spouse's name"],
      ['eng-dob', 'Date of birth'],
      ['eng-sex', 'Sex'],
      ['eng-issueDate', 'Date of issue'],
      ['eng-expiryDate', 'Date of expiry'],
      ['eng-birthPlace', 'Place of birth'],
      ['eng-nationality', 'Nationality'],
      ['eng-nationalityCode', 'Nationality code'],
      ['eng-personalNo', 'Personal / NID No'],
      ['eng-previousPassport', 'Previous passport no'],
      ['eng-authority', 'Issuing authority'],
      ['eng-address1', 'Address line 1'],
      ['eng-address2', 'Address line 2'],
      ['eng-phone', 'Telephone'],
      ['eng-relationship', 'Relationship'],
      ['eng-emergencyName', 'Emergency contact name'],
      ['eng-mrz1', 'Line 1'],
      ['eng-mrz2', 'Line 2'],
    ]) expect(PAGE).not.toContain('<label for="' + id + '">' + en);
    // (Label-scoped: the document model's own printed English — e.g. the
    // passport's "Passport No." heading — is document content, not chrome,
    // and stays. These chrome strings appear nowhere in the model.)
    for (const s of [
      'Regenerate MRZ', 'Re-apply to page',
      'M — Male', 'F — Female', 'Unspecified',
    ]) expect(PAGE).not.toContain(s);
  });

  test('editor hints and validation messages are Bengali', () => {
    // Hints are page markup; validation/notify strings live in the editor script.
    for (const s of [
      'সংযুক্ত লেখা ও MRZ আপডেট হবে',
      'ডটেড স্ট্রিপ নিজে থেকে আপডেট হয়',
      'মূল বাক্স + ডানের ছাপা উল্লম্ব নম্বর',
      'পুরো নাম নিজে থেকে পদবি + প্রদত্ত নামে ভাগ হয়',
      'তারিখ পাতায় “17 DEC 1979” আকারে ছাপা হয়',
      'ইস্যুকারী দেশ থেকে আলাদা',
      'দুটো লাইনই উপরের তথ্য থেকে আবার তৈরি হয়',
    ]) expect(PAGE).toContain(s);
    for (const s of [
      'MRZ-এর চেক ডিজিট মিলছে না',
      'তিন অক্ষরের জাতীয়তার কোড লিখুন',
      // The surname/given-name message is built with a ternary, so the
      // literal is split: 'MRZ-এর জন্য লাতিন অক্ষরের ' + 'পদবি'.
      'MRZ-এর জন্য লাতিন অক্ষরের ',
    ]) expect(MAIN).toContain(s);
    for (const s of [
      'MRZ check digits do not match',
      'Enter the three-letter nationality code',
      'Use a Latin-letter surname',
      'Photo replaced in its original frame',
      // The editor panel upload confirmations are gone with the panels;
      // the form upload says ছবি/স্বাক্ষর যোগ হয়েছে (flow script).
      'ছবি মূল ফ্রেমে বদলে গেছে',
      'স্বাক্ষর মূল জায়গায় বদলে গেছে',
    ]) expect(MAIN).not.toContain(s);
  });

  // Site-feel Fix 9: neutral placeholders — the sample number/name no
  // longer read as pre-filled demo data. (EJ0762655 / GOLAM KIBRIYA MD
  // remain only as clearly-fake TEST input values, and inside the
  // document model's own sample record.)
  test('neutral placeholders: no sample number or name as placeholder', () => {
    expect(PAGE).toContain('placeholder="৯ অক্ষরের পাসপোর্ট নম্বর"');
    expect(PAGE).toContain('placeholder="পুরো নাম লিখুন"');
    expect(PAGE).not.toContain('placeholder="EJ0762655"');
    expect(PAGE).not.toContain('placeholder="GOLAM KIBRIYA MD"');
  });
  test('no editor toolbar remains — the topbar is the only page header', () => {
    expect(PAGE).toContain('<h2>🛂 পাসপোর্ট ইঞ্জিন</h2>');
    expect(PAGE).not.toContain('<h1>পাসপোর্ট ইঞ্জিন</h1>');
    expect(PAGE).not.toContain('class="toolbar"');
    expect(PAGE).not.toContain('.toolbar{');
    expect(PAGE).not.toContain('backdrop-filter:blur(10px)');
    expect(PAGE).not.toContain('background:#fffffff5');
    for (const s of ['id="regions-button"', 'id="preview-button"', 'id="print-button"', 'id="walletBadgeEditor"', 'id="balValEditor"']) {
      expect(PAGE).not.toContain(s);
    }
    expect(PAGE).toContain('id="passport-topbar"');
    expect(PAGE).toContain('id="walletBadge"');
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
