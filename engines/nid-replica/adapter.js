'use strict';
/**
 * engines/nid-replica/adapter.js — Abc Authentic adapter for the
 * NID Replica Engine (NID form PDF → NID card replica PDF).
 *
 * WRAPPING ONLY — the engine folder is an as-is copy of
 * NID-Engine-Fixed.zip contents (extract_input.py, extract_template.py,
 * make_fields.py, build_output.py, output_template.pdf, template.json,
 * fonts/, shakkhor/). No engine Python logic is modified here.
 * Deterministic: same input → same output.
 *
 * Integration (backend mounts at /api/nid-engine with JWT auth + rate limit):
 *   extractFields(pdfBuffer) → per-job dir work/jobs/<uuid>/ becomes the
 *     process CWD for the engine scripts (they use relative "work/" paths,
 *     so each job is fully isolated). Runs:
 *       extract_input.py input.pdf  → work/input_data.json + work/images/
 *       extract_template.py <abs template pdf> → work/template.json
 *       make_fields.py              → work/fields.json
 *     Returns { ok, jobId, fields, images:[{name, dataUrl}] }.
 *   buildCard(jobId, fieldsJson) → writes work/fields.json, runs
 *     build_output.py → work/output.pdf. Returns { ok, pdfBuffer }.
 *
 * Python deps (VM): pip3 install pymupdf Pillow pdf417gen
 * (dddocr optional — scanned-PDF OCR fallback only).
 *
 * Security: jobId is UUID-validated and path-confined to the jobs dir.
 * Python stderr is never returned raw to the client (generic error codes).
 * Uploaded PII lives only in the per-job dir and is pruned (keep last 50).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ENGINE_DIR = __dirname;
const JOBS_DIR = path.join(ENGINE_DIR, 'work', 'jobs');
const KEEP_JOBS = 50;
const TIMEOUT_MS = 120000;
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
    const script = path.join(ENGINE_DIR, scriptName);
    const r = spawnSync('python3', [script, ...args], {
        cwd,
        timeout: TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    return {
        ok: r.status === 0,
        exitCode: r.status,
        signal: r.signal || null,
        timedOut: !!r.error && r.error.code === 'ETIMEDOUT',
        stdout: String(r.stdout || ''),
        // stderr kept for server logs only — never sent to client
        stderr: String(r.stderr || ''),
    };
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
        // L-7: job ownership — only the creating user may build from this job
        if (ownerId) fs.writeFileSync(path.join(dir, '.owner'), String(ownerId));
        pruneJobs();

        const steps = [
            ['extract_input.py', ['input.pdf']],
            ['extract_template.py', [path.join(ENGINE_DIR, 'output_template.pdf')]],
            ['make_fields.py', []],
        ];
        for (const [script, args] of steps) {
            const r = runPython(script, args, dir);
            if (!r.ok) {
                console.warn(`[nid-replica] ${script} failed (job ${id}): exit=${r.exitCode} signal=${r.signal} timedOut=${r.timedOut}`);
                if (r.stderr) console.warn('[nid-replica] stderr tail:', r.stderr.slice(-800));
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
                return { ok: false, error: r.timedOut ? 'ENGINE_TIMEOUT' : 'EXTRACT_FAILED' };
            }
        }

        const fieldsPath = path.join(dir, 'work', 'fields.json');
        if (!fs.existsSync(fieldsPath)) {
            return { ok: false, error: 'EXTRACT_FAILED' };
        }
        const fields = JSON.parse(fs.readFileSync(fieldsPath, 'utf8'));
        const images = readImages(dir);
        return { ok: true, jobId: id, fields, images };
    } catch (e) {
        console.warn('[nid-replica] extractFields error:', e.message);
        try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        return { ok: false, error: 'EXTRACT_FAILED' };
    }
}

/**
 * Build the final NID card PDF from (possibly edited) fields.
 * @param {string} jobId
 * @param {object} fieldsJson  {slotLabel: value}
 * @returns {Promise<{ok:boolean, pdfBuffer?, error?}>}
 */
async function buildCard(jobId, fieldsJson, images, ownerId) {
    const dir = resolveJobDir(jobId);
    if (!dir || !fieldsJson || typeof fieldsJson !== 'object' || Array.isArray(fieldsJson)) {
        return { ok: false, error: 'INVALID_REQUEST' };
    }
    if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, 'work', 'input_data.json'))) {
        return { ok: false, error: 'JOB_NOT_FOUND' };
    }
    // L-7: job ownership check
    if (ownerId) {
        let owner = null;
        try { owner = fs.readFileSync(path.join(dir, '.owner'), 'utf8').trim(); } catch (_) {}
        if (owner && owner !== String(ownerId)) return { ok: false, error: 'NOT_YOUR_JOB' };
    }
    // Optional: replace extracted images with user-uploaded ones (dataURLs)
    if (Array.isArray(images)) {
        const imgDir = path.join(dir, 'work', 'images');
        try { fs.mkdirSync(imgDir, { recursive: true }); } catch (_) {}
        const passedNames = new Set();
        for (const im of images.slice(0, 10)) {
            if (!im || !im.name || !im.dataUrl || typeof im.dataUrl !== 'string') continue;
            const safeName = path.basename(String(im.name)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
            passedNames.add(safeName);
            const m = im.dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
            if (!m || m[2].length > 14 * 1024 * 1024) continue; // cap at ~10MB decoded
            try { fs.writeFileSync(path.join(imgDir, safeName), Buffer.from(m[2], 'base64')); } catch (e) {}
        }
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
        if (!fs.existsSync(path.join(dir, 'work', 'input_data.json'))) {
            return { ok: false, error: 'JOB_NOT_FOUND' };
        }
        fs.writeFileSync(fieldsPath, JSON.stringify(clean, null, 1), 'utf8');
        const r = runPython('build_output.py', [], dir);
        if (!r.ok) {
            console.warn(`[nid-replica] build_output.py failed (job ${jobId}): exit=${r.exitCode} signal=${r.signal} timedOut=${r.timedOut}`);
            if (r.stderr) console.warn('[nid-replica] stderr tail:', r.stderr.slice(-800));
            return { ok: false, error: r.timedOut ? 'ENGINE_TIMEOUT' : 'BUILD_FAILED' };
        }
        const outPath = path.join(dir, 'work', 'output.pdf');
        if (!fs.existsSync(outPath)) {
            return { ok: false, error: 'BUILD_FAILED' };
        }
        const pdfBuffer = fs.readFileSync(outPath);
        if (pdfBuffer.length < 1000) {
            return { ok: false, error: 'BUILD_FAILED' };
        }
        return { ok: true, pdfBuffer };
    } catch (e) {
        console.warn('[nid-replica] buildCard error:', e.message);
        return { ok: false, error: 'BUILD_FAILED' };
    }
}

function init(config) {
    _config = Object.assign({}, config || {});
    try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch (_) {}
    // Preflight: python3 + deps present?
    try {
        const r = spawnSync('python3', ['-c', 'import pymupdf, PIL, pdf417gen; print("ok")'],
            { timeout: 15000, encoding: 'utf8' });
        if (r.status === 0) {
            console.log('[nid-replica] engine ready (python deps ok)');
        } else {
            console.warn('[nid-replica] python deps missing — run: pip3 install pymupdf Pillow pdf417gen');
        }
    } catch (e) {
        console.warn('[nid-replica] python3 not available:', e.message);
    }
    return { ok: true };
}

function getInfo() {
    return {
        id: 'nid-replica',
        name: 'NID Card Replica',
        name_bn: 'এনআইডি কার্ড রেপ্লিকা',
        version: '1.0.0',
        capabilities: ['extract-fields', 'card-pdf'],
        mode: 'as-is-wrap',
        input: { pdf: 'NID form PDF (voter registration form)' }
    };
}

module.exports = { init, getInfo, extractFields, buildCard };
