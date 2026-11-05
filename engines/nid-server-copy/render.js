'use strict';
/**
 * engines/nid-server-copy/render.js — server-copy card renderer.
 *
 * Builds the card PDF from scraped portal profile data using the
 * EXACT SAME output pipeline as the NID card engine (its
 * make_fields.py + build_output.py), so the delivered card keeps
 * the established layout, fonts, barcode and photo placement.
 * The difference is only the input source: portal profile data
 * (this engine) instead of an uploaded form PDF (nid-replica).
 *
 * Each render runs in its own job dir (work/jobs/<uuid>/) because
 * the Python pipeline uses relative "work/" paths — concurrent
 * renders are fully isolated.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ENGINE_DIR = __dirname;
const PIPELINE_DIR = path.join(ENGINE_DIR, '..', 'nid-replica');
const JOBS_DIR = path.join(ENGINE_DIR, 'work', 'jobs');
const KEEP_JOBS = 50;
const TIMEOUT_MS = 120000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function runPython(scriptName, cwd) {
  const script = path.join(PIPELINE_DIR, scriptName);
  const r = spawnSync('python3', [script], {
    cwd,
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    exitCode: r.status,
    timedOut: !!r.error && r.error.code === 'ETIMEDOUT',
    stderr: String(r.stderr || ''),
  };
}

/**
 * @param {object} inputData  make_fields-compatible input data
 * @param {Buffer|null} photoBuffer  citizen photo bytes (any format PIL reads)
 * @param {Buffer|null} signBuffer  applicant signature bytes (optional;
 *   the shared pipeline picks up work/images/sign.png as xref 11)
 * @returns {Promise<{ok:boolean, pdfBuffer?, fields?, jobId?, error?}>}
 */
async function renderFromProfile(inputData, photoBuffer, signBuffer) {
  if (!inputData || typeof inputData !== 'object') {
    return { ok: false, error: 'NO_PROFILE_DATA' };
  }
  const id = crypto.randomUUID();
  if (!UUID_RE.test(id)) return { ok: false, error: 'RENDER_FAILED' };
  const dir = path.join(JOBS_DIR, id);
  try {
    fs.mkdirSync(path.join(dir, 'work', 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'work', 'input_data.json'), JSON.stringify(inputData, null, 1), 'utf8');
    // The pipeline's template (card slots) — same file the NID
    // card engine extracts from its output template.
    fs.copyFileSync(
      path.join(PIPELINE_DIR, 'template.json'),
      path.join(dir, 'work', 'template.json')
    );
    if (photoBuffer && Buffer.isBuffer(photoBuffer) && photoBuffer.length > 500) {
      // build_output.py looks for work/images/photo.png; PIL reads
      // the real format from the bytes regardless of the name.
      fs.writeFileSync(path.join(dir, 'work', 'images', 'photo.png'), photoBuffer);
    }
    if (signBuffer && Buffer.isBuffer(signBuffer) && signBuffer.length > 0) {
      // build_output.py picks up work/images/sign.png as the
      // applicant signature (xref 11); without it the template's
      // own signature stays, as before.
      fs.writeFileSync(path.join(dir, 'work', 'images', 'sign.png'), signBuffer);
    }
    pruneJobs();

    for (const script of ['make_fields.py', 'build_output.py']) {
      const r = runPython(script, dir);
      if (!r.ok) {
        console.warn(`[nid-server-copy] ${script} failed (job ${id}): exit=${r.exitCode} timedOut=${r.timedOut}`);
        if (r.stderr) console.warn('[nid-server-copy] stderr tail:', r.stderr.slice(-800));
        return { ok: false, error: r.timedOut ? 'ENGINE_TIMEOUT' : 'RENDER_FAILED' };
      }
    }

    const outPath = path.join(dir, 'work', 'output.pdf');
    if (!fs.existsSync(outPath)) return { ok: false, error: 'RENDER_FAILED' };
    const pdfBuffer = fs.readFileSync(outPath);
    if (pdfBuffer.length < 1000) return { ok: false, error: 'RENDER_FAILED' };

    let fields = {};
    try { fields = JSON.parse(fs.readFileSync(path.join(dir, 'work', 'fields.json'), 'utf8')); } catch (_) {}
    return { ok: true, pdfBuffer, fields, jobId: id };
  } catch (e) {
    console.warn('[nid-server-copy] renderFromProfile error:', e.message);
    return { ok: false, error: 'RENDER_FAILED' };
  }
}

module.exports = { renderFromProfile };
