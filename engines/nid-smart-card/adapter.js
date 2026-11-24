'use strict';
/**
 * engines/nid-smart-card/adapter.js — Abc Authentic adapter for the
 * NID Smart Card Engine (NID form PDF → new smart card PDF, front+back
 * on one Letter page, MRZ + PDF417 barcode).
 *
 * v2 TEMPLATE ONLY. The extractor is based on the REPO's nid-replica
 * extract_input.py / make_fields.py (keeps the Nov improvements:
 * multi-line address, geo, OCR fixes) with only the v2.0 additions
 * ported: build_output_v2.py + output_template.pdf + layout detection
 * (nid_card_v2) + the v2.0 fixes. The zip's OLDER extract_input.py /
 * make_fields.py were NOT copied (they would regress the repo).
 *
 * Fixes carried (from the zip inspection):
 *   #2 clean_bn has no name-rewriting table / hardcoded spacings.
 *   #3 photo / signature / barcode / DOB-band replace failure FAILS
 *      the build loudly (Bengali RuntimeError, no PDF) — the template
 *      sample's image/barcode is never silently kept.
 *   #4 barcode `ds` comes only from form data; when absent it is
 *      omitted — the sample card's ds hex is never a fallback.
 *   #6 Voter No never stands in for the National ID (ID NO stays
 *      empty when the National ID is missing; the core-data gate
 *      blocks Create).
 *   #7 no TEMPLATE_GROUND_TRUTH / old-path code anywhere.
 *   #5 issue date defaults to today BUT is shown editable in the
 *      review step (frontend), so the user sees the default.
 *   Photo background sanitize uses cv2 when present; without it the
 *   original photo is used with a visible WARNING log (never silent).
 *
 * Integration (backend mounts at /api/nid-smart-card with JWT auth +
 * rate limit):
 *   extractFields(pdfBuffer) → per-job dir work/jobs/<uuid>/ becomes
 *     the process CWD for the engine scripts. Runs:
 *       extract_input.py input.pdf  → work/input_data.json + work/images/
 *       extract_template.py <abs template pdf> → work/template.json
 *       make_fields.py              → work/fields.json
 *     Returns { ok, jobId, fields, images:[{name, dataUrl}] }.
 *   buildCard(jobId, fieldsJson, images) → writes work/fields.json,
 *     runs build_output_v2.py → work/output.pdf. Returns
 *     { ok, pdfBuffer } or { ok:false, error, detail }.
 *
 * Python deps (server): pip3 install pymupdf Pillow pdf417gen
 * opencv-python-headless (dddocr optional — scanned-PDF OCR fallback).
 *
 * Security: jobId is UUID-validated and path-confined to the jobs dir.
 * Python stderr is never returned raw to the client (only the build's
 * own Bengali JSON error, which contains no paths, is surfaced).
 * Uploaded PII lives only in the per-job dir and is pruned (keep last 50).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { PYTHON, runCardPython, prepareCardTemplate, queueCardJob } = require('../shared/card-worker');

const ENGINE_DIR = __dirname;
const JOBS_DIR = path.join(ENGINE_DIR, 'work', 'jobs');
const KEEP_JOBS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _config = {};

function jobDir(id) {
    return path.join(JOBS_DIR, id);
}

function resolveJobDir(id) {
    if (!UUID_RE.test(String(id || ''))) return null;
    const dir = path.resolve(jobDir(id));
    if (!dir.startsWith(path.resolve(JOBS_DIR) + path.sep)) return null;
    return dir;
}

function pruneJobs() {
    try {
        fs.mkdirSync(JOBS_DIR, { recursive: true });
        const entries = fs.readdirSync(JOBS_DIR)
            .map((n) => ({ n, t: fs.statSync(path.join(JOBS_DIR, n)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
        for (const e of entries.slice(KEEP_JOBS)) {
            fs.rmSync(path.join(JOBS_DIR, e.n), { recursive: true, force: true });
        }
    } catch (_) { /* best effort */ }
}

function runPython(scriptName, args, cwd) {
    return runCardPython(path.join(ENGINE_DIR, scriptName), args, cwd);
}

// The build script prints log lines then ONE JSON line:
// {"ok": true, "output": ...} or {"ok": false, "error": "<Bengali>"}.
// Parse the last JSON object in stdout that carries an `ok` key.
function parseBuildJson(stdout) {
    const text = String(stdout || '');
    const matches = text.match(/\{[^{}]*"ok"[^{}]*\}/g) || [];
    for (let i = matches.length - 1; i >= 0; i--) {
        try {
            const obj = JSON.parse(matches[i]);
            if (obj && typeof obj.ok === 'boolean') return obj;
        } catch (_) { /* keep scanning */ }
    }
    return null;
}

function readImages(dir) {
    const out = [];
    try {
        const imgDir = path.join(dir, 'work', 'images');
        if (!fs.existsSync(imgDir)) return out;
        for (const f of fs.readdirSync(imgDir)) {
            if (!/\.(png|jpg|jpeg)$/i.test(f)) continue;
            const buf = fs.readFileSync(path.join(imgDir, f));
            if (buf.length > 8 * 1024 * 1024) continue; // sanity cap
            const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
            out.push({ name: f, dataUrl: `data:image/${ext};base64,${buf.toString('base64')}` });
        }
    } catch (_) { /* best effort */ }
    return out;
}

// Core-data gate (blank-card fix, audit 2026-11-08 #1): a smart card
// is meaningless without a name, an ID number and a date of birth.
// make_fields.py always emits these slots (empty string when the
// extract found nothing), and "প্রদানের তারিখ:" defaults to today's
// date — so it must NEVER count as core data. A blank/garbage
// extract must never build a card or be charged.
// Rule:
//   name = "নাম:" OR "Name:" non-empty
//   id   = "ID NO:" OR "Pin" non-empty
//   dob  = "Date of Birth:" non-empty
// All three groups are required. A missing key counts as empty.
const CORE_NAME_KEYS = ['নাম:', 'Name:'];
const CORE_ID_KEYS = ['ID NO:', 'Pin'];
const CORE_DOB_KEYS = ['Date of Birth:'];

const NO_CORE_DATA_MESSAGE = 'তথ্য অসম্পূর্ণ — নাম, জাতীয় পরিচয়পত্র নম্বর ও জন্মতারিখ ছাড়া কার্ড তৈরি করা যাবে না। সঠিক NID ফর্ম PDF আপলোড করুন। কোনো টাকা কাটা হয়নি।';

function _hasText(v) {
    return v !== null && v !== undefined && String(v).trim().length > 0;
}

function hasCoreData(fields) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
    const name = CORE_NAME_KEYS.some((k) => _hasText(fields[k]));
    const id = CORE_ID_KEYS.some((k) => _hasText(fields[k]));
    const dob = CORE_DOB_KEYS.some((k) => _hasText(fields[k]));
    return Boolean(name && id && dob);
}

// Bengali labels of the missing core-data groups (for diagnostics).
function missingCoreGroups(fields) {
    const f = (fields && typeof fields === 'object' && !Array.isArray(fields)) ? fields : {};
    const missing = [];
    if (!CORE_NAME_KEYS.some((k) => _hasText(f[k]))) missing.push('নাম');
    if (!CORE_ID_KEYS.some((k) => _hasText(f[k]))) missing.push('জাতীয় পরিচয়পত্র নম্বর');
    if (!CORE_DOB_KEYS.some((k) => _hasText(f[k]))) missing.push('জন্মতারিখ');
    return missing;
}

/**
 * Run the 3-step extract pipeline on an uploaded NID form PDF.
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{ok:boolean, jobId?, fields?, images?, error?}>}
 */
async function extractFields(pdfBuffer, ownerId) {
    if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 100) {
        return { ok: false, error: 'INVALID_PDF' };
    }
    if (pdfBuffer.length > 20 * 1024 * 1024) {
        return { ok: false, error: 'PDF_TOO_LARGE' };
    }
    // Quick magic-byte check (real PDF)
    const head = pdfBuffer.slice(0, 5).toString('ascii');
    if (head !== '%PDF-') {
        return { ok: false, error: 'NOT_A_PDF' };
    }
    const id = crypto.randomUUID();
    const dir = resolveJobDir(id);
    try {
        fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'input.pdf'), pdfBuffer);
        // Job ownership — only the creating user may build from this job
        if (ownerId) fs.writeFileSync(path.join(dir, '.owner'), String(ownerId));
        pruneJobs();

        const steps = [
            ['extract_input.py', () => runPython('extract_input.py', ['input.pdf'], dir)],
            ['extract_template.py', () => prepareCardTemplate(ENGINE_DIR, dir)],
            ['make_fields.py', () => runPython('make_fields.py', [], dir)],
        ];
        for (const [script, run] of steps) {
            const r = await run();
            if (!r.ok) {
                console.warn(`[nid-smart-card] ${script} failed (job ${id}): exit=${r.exitCode} signal=${r.signal} timedOut=${r.timedOut}`);
                if (r.stderr) console.warn('[nid-smart-card] stderr tail:', r.stderr.slice(-800));
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
                return { ok: false, error: r.timedOut ? 'ENGINE_TIMEOUT' : 'EXTRACT_FAILED' };
            }
        }

        const fieldsPath = path.join(dir, 'work', 'fields.json');
        if (!fs.existsSync(fieldsPath)) {
            return { ok: false, error: 'EXTRACT_FAILED' };
        }
        const fields = JSON.parse(fs.readFileSync(fieldsPath, 'utf8'));
        // Core-data gate: a blank/garbage extract (fields.json present
        // but no name/ID/DOB) is rejected here, before any job exists
        // to build from — so it can never reach the build/charge step.
        if (!hasCoreData(fields)) {
            console.warn(`[nid-smart-card] extract has no core data (job ${id}): missing ${missingCoreGroups(fields).join(', ')}`);
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
            return { ok: false, error: 'NO_CORE_DATA' };
        }
        const images = readImages(dir);
        return { ok: true, jobId: id, fields, images };
    } catch (e) {
        console.warn('[nid-smart-card] extractFields error:', e.message);
        try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        return { ok: false, error: 'EXTRACT_FAILED' };
    }
}

/**
 * Build the final smart-card PDF from (possibly edited) fields.
 * @param {string} jobId
 * @param {object} fieldsJson  {slotLabel: value}
 * @param {Array} images  optional [{name, dataUrl}] — photo.png and
 *   sign.png, like nid-replica (up to 10 images). The extracted
 *   photo/sign not re-passed are deleted, so a removed photo makes
 *   the build FAIL loudly (fix #3) instead of keeping the
 *   template's sample photo.
 *   NOTE: the applicant's sign.png is accepted, stored with the job
 *   and passed to the v2 builder as --holder-sign. The sample card
 *   (output_template.pdf) proves the card's only signature slot
 *   (xref 24, front below the photo) is the HOLDER's — there is no
 *   authority signature on the smart card, so shakkhor/ is NOT used
 *   by this engine. No sign.png -> the builder blanks the slot
 *   (the sample holder's signature never leaks) and the build
 *   still succeeds.
 * @returns {Promise<{ok:boolean, pdfBuffer?, error?, detail?}>}
 */
async function buildCard(jobId, fieldsJson, images, ownerId) {
    const dir = resolveJobDir(jobId);
    if (!dir || !fieldsJson || typeof fieldsJson !== 'object' || Array.isArray(fieldsJson)) {
        return { ok: false, error: 'INVALID_REQUEST' };
    }
    if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, 'work', 'input_data.json'))) {
        return { ok: false, error: 'JOB_NOT_FOUND' };
    }
    // Job ownership check
    if (ownerId) {
        let owner = null;
        try { owner = fs.readFileSync(path.join(dir, '.owner'), 'utf8').trim(); } catch (_) {}
        if (owner && owner !== String(ownerId)) return { ok: false, error: 'NOT_YOUR_JOB' };
    }
    // Core-data gate (authoritative): the fields may have been edited
    // in the UI after a good extract, so a blanked-out build is
    // rejected here too — BEFORE any build runs and therefore before
    // any charge (the route charges only after a successful build).
    if (!hasCoreData(fieldsJson)) {
        console.warn(`[nid-smart-card] build rejected, no core data (job ${jobId}): missing ${missingCoreGroups(fieldsJson).join(', ')}`);
        return { ok: false, error: 'NO_CORE_DATA' };
    }
    // Optional: replace extracted images with user-uploaded ones
    // (dataURLs) — photo.png and sign.png, like nid-replica.
    const imgDir = path.join(dir, 'work', 'images');
    if (Array.isArray(images)) {
        try { fs.mkdirSync(imgDir, { recursive: true }); } catch (_) {}
        const passedNames = new Set();
        for (const im of images.slice(0, 10)) {
            if (!im || !im.name || !im.dataUrl || typeof im.dataUrl !== 'string') continue;
            const safeName = path.basename(String(im.name)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
            if (safeName !== 'photo.png' && safeName !== 'sign.png') continue;
            passedNames.add(safeName);
            const m = im.dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
            if (!m || m[2].length > 14 * 1024 * 1024) continue; // cap at ~10MB decoded
            try { fs.writeFileSync(path.join(imgDir, safeName), Buffer.from(m[2], 'base64')); } catch (e) {}
        }
        // User removed the photo/sign: delete the extracted ones so
        // the build FAILS loudly for a missing photo (fix #3) —
        // never keep the template photo. (A removed sign.png means
        // the builder blanks the holder-signature slot; the sample
        // holder's signature never leaks.)
        if (!passedNames.has('photo.png') && fs.existsSync(path.join(imgDir, 'photo.png'))) {
            try { fs.unlinkSync(path.join(imgDir, 'photo.png')); } catch (_) {}
        }
        if (!passedNames.has('sign.png') && fs.existsSync(path.join(imgDir, 'sign.png'))) {
            try { fs.unlinkSync(path.join(imgDir, 'sign.png')); } catch (_) {}
        }
    }
    // Sanitize: keys/values must be strings, cap counts and sizes
    const clean = {};
    const keys = Object.keys(fieldsJson).slice(0, 60);
    for (const k of keys) {
        const ks = String(k).slice(0, 120);
        const v = fieldsJson[k];
        clean[ks] = (v === null || v === undefined) ? '' : String(v).slice(0, 2000);
    }
    try {
        const fieldsPath = path.join(dir, 'work', 'fields.json');
        fs.writeFileSync(fieldsPath, JSON.stringify(clean, null, 1), 'utf8');
        const outPath = path.join(dir, 'work', 'output.pdf');
        const photoPath = path.join(imgDir, 'photo.png');
        const args = [
            fieldsPath,
            path.join(ENGINE_DIR, 'output_template.pdf'),
            outPath,
            '--work', path.join(dir, 'work'),
            '--assets', ENGINE_DIR,
        ];
        // Pass the photo only when the file exists; when it does not,
        // the builder raises its own Bengali "ছবি পাওয়া যায়নি" error.
        if (fs.existsSync(photoPath)) args.push('--photo', photoPath);
        // Holder signature: the sample card proves the only signature
        // slot (xref 24, front below the photo) is the HOLDER's.
        // No file -> the builder blanks the slot (the sample
        // holder's signature never leaks) and the build succeeds.
        const signPath = path.join(imgDir, 'sign.png');
        if (fs.existsSync(signPath)) args.push('--holder-sign', signPath);
        const r = await runPython('build_output_v2.py', args, dir);
        const buildJson = parseBuildJson(r.stdout);
        if (!r.ok) {
            console.warn(`[nid-smart-card] build_output_v2.py failed (job ${jobId}): exit=${r.exitCode} signal=${r.signal} timedOut=${r.timedOut}`);
            if (r.stderr) console.warn('[nid-smart-card] stderr tail:', r.stderr.slice(-800));
            const detail = (buildJson && buildJson.error) ? String(buildJson.error) : null;
            return { ok: false, error: r.timedOut ? 'ENGINE_TIMEOUT' : 'BUILD_FAILED', detail };
        }
        if (!fs.existsSync(outPath)) {
            return { ok: false, error: 'BUILD_FAILED' };
        }
        const pdfBuffer = fs.readFileSync(outPath);
        if (pdfBuffer.length < 1000) {
            return { ok: false, error: 'BUILD_FAILED' };
        }
        return { ok: true, pdfBuffer };
    } catch (e) {
        console.warn('[nid-smart-card] buildCard error:', e.message);
        return { ok: false, error: 'BUILD_FAILED' };
    }
}

/**
 * Validate that a job exists and belongs to the user (for /create).
 * @returns {Promise<{ok:boolean, error?}>}
 */
async function validateJob(jobId, ownerId) {
    const dir = resolveJobDir(jobId);
    if (!dir || !fs.existsSync(dir) || !fs.existsSync(path.join(dir, 'work', 'input_data.json'))) {
        return { ok: false, error: 'JOB_NOT_FOUND' };
    }
    if (ownerId) {
        let owner = null;
        try { owner = fs.readFileSync(path.join(dir, '.owner'), 'utf8').trim(); } catch (_) {}
        if (owner && owner !== String(ownerId)) return { ok: false, error: 'NOT_YOUR_JOB' };
    }
    return { ok: true };
}

// Download filename base: the card's ID number, like nid-replica —
// 10/13/17 ASCII digits → the digits, anything else → 'smart-card'
// (the route appends '.pdf').
function outputBase(fields) {
    const raw = String((fields && (fields['ID NO:'] || fields['Pin'])) || '').trim();
    const ascii = raw.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09E6));
    const digits = ascii.replace(/[^0-9]/g, '');
    return /^\d{10}$|^\d{13}$|^\d{17}$/.test(digits) ? digits : 'smart-card';
}

function init(config) {
    _config = Object.assign({}, config || {});
    try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch (_) {}
    // Preflight: python3 + deps present?
    try {
        const r = spawnSync(PYTHON, ['-c', 'import pymupdf, PIL, pdf417gen; print("ok")'],
            { timeout: 15000, encoding: 'utf8' });
        if (r.status === 0) {
            console.log('[nid-smart-card] engine ready (python deps ok)');
        } else {
            console.warn('[nid-smart-card] python deps missing — run: pip3 install pymupdf Pillow pdf417gen opencv-python-headless');
        }
        const c = spawnSync(PYTHON, ['-c', 'import cv2; print("ok")'],
            { timeout: 15000, encoding: 'utf8' });
        if (c.status !== 0) {
            console.warn('[nid-smart-card] cv2 missing — photo background sanitize degrades to the original photo (visible WARNING log); install: pip3 install opencv-python-headless');
        }
    } catch (e) {
        console.warn('[nid-smart-card] python3 not available:', e.message);
    }
    return { ok: true };
}

function getInfo() {
    return {
        id: 'nid-smart-card',
        name: 'Sign to Smart Card Pdf',
        name_bn: 'স্মার্ট কার্ড পিডিএফ',
        version: '2.0.0',
        capabilities: ['extract-fields', 'card-pdf'],
        mode: 'v2-template-only',
        input: { pdf: 'NID form PDF (voter registration form)' }
    };
}

module.exports = {
    init, getInfo,
    extractFields: queueCardJob(extractFields),
    buildCard: queueCardJob(buildCard),
    validateJob, hasCoreData, missingCoreGroups, outputBase, NO_CORE_DATA_MESSAGE, parseBuildJson,
};
