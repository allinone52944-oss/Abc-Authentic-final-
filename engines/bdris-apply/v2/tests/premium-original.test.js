/**
 * PREMIUM (2026-10-28) — post-submit original copy, premium system:
 * - STEP_LABELS: exactly the 4 fetch steps, non-empty labels, no
 *   personal-data placeholders (no numbers, no names).
 * - ensureOriginal progress: a running job notifies every listener
 *   (creator + joiner) once per step, in order; a cached hit notifies
 *   nobody (instant — nothing to show); a throwing listener never
 *   breaks the job or other listeners.
 * No browser, no live contact, no personal data. Fixture values only.
 * Run: node --test engines/bdris-apply/v2/tests/premium-original.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OriginalFetcher, STEP_LABELS } = require('../services/OriginalFetcher');

function fetcher() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orig-premium-'));
  return new OriginalFetcher({
    browserManager: {},
    frontendDir: path.join(dir, 'frontend'),
    archiveDir: path.join(dir, 'archive'),
    indexFile: path.join(dir, 'originals-index.json'),
    log: () => {},
  });
}

const rec = { appId: '1234567', date: '2020-01-01', nameEn: 'TEST', mobileNo: '01000000000' };

describe('PREMIUM STEP_LABELS', () => {
  it('has exactly the 4 fetch steps with non-empty, personal-data-free labels', () => {
    assert.deepEqual(Object.keys(STEP_LABELS), ['print-page', 'captcha', 'search', 'pdf']);
    for (const label of Object.values(STEP_LABELS)) {
      assert.equal(typeof label, 'string');
      assert.ok(label.trim().length > 0, 'label must not be empty');
      assert.ok(!/\d{4}/.test(label), 'label must not carry numbers');
    }
  });
});

describe('PREMIUM ensureOriginal progress', () => {
  it('notifies the creator once per step, in order', async () => {
    const f = fetcher();
    f._runJob = async (r, job) => {
      for (const s of Object.keys(STEP_LABELS)) f._progress(job, s);
      return { ok: true, url: '/bdris-original-1234567.pdf', bytes: 9000 };
    };
    const seen = [];
    const job = await f.ensureOriginal(rec, (s) => seen.push(s));
    assert.equal(job.result.ok, true);
    assert.deepEqual(seen, ['print-page', 'captcha', 'search', 'pdf']);
  });

  it('drops duplicate step notifications', async () => {
    const f = fetcher();
    f._runJob = async (r, job) => {
      f._progress(job, 'captcha');
      f._progress(job, 'captcha');
      f._progress(job, 'print-page');
      return { ok: true, url: '/x.pdf', bytes: 9000 };
    };
    const seen = [];
    await f.ensureOriginal(rec, (s) => seen.push(s));
    assert.deepEqual(seen, ['captcha', 'print-page']);
  });

  it('notifies a joiner too, not just the creator', async () => {
    const f = fetcher();
    let release;
    const gate = new Promise((res) => { release = res; });
    f._runJob = async (r, job) => {
      await gate;
      for (const s of Object.keys(STEP_LABELS)) f._progress(job, s);
      return { ok: true, url: '/x.pdf', bytes: 9000 };
    };
    const seen1 = [];
    const seen2 = [];
    const p1 = f.ensureOriginal(rec, (s) => seen1.push(s));
    const p2 = f.ensureOriginal(rec, (s) => seen2.push(s));
    release();
    await Promise.all([p1, p2]);
    assert.deepEqual(seen1, ['print-page', 'captcha', 'search', 'pdf']);
    assert.deepEqual(seen2, ['print-page', 'captcha', 'search', 'pdf']);
  });

  it('a throwing listener breaks neither the job nor other listeners', async () => {
    const f = fetcher();
    let release;
    const gate = new Promise((res) => { release = res; });
    f._runJob = async (r, job) => {
      await gate;
      for (const s of Object.keys(STEP_LABELS)) f._progress(job, s);
      return { ok: true, url: '/x.pdf', bytes: 9000 };
    };
    const seen = [];
    const p1 = f.ensureOriginal(rec, () => { throw new Error('listener boom'); });
    const p2 = f.ensureOriginal(rec, (s) => seen.push(s));
    release();
    const [job] = await Promise.all([p1, p2]);
    assert.equal(job.result.ok, true);
    assert.deepEqual(seen, ['print-page', 'captcha', 'search', 'pdf']);
  });

  it('a cached hit notifies nobody', async () => {
    const f = fetcher();
    const dir = f.frontendDir;
    fs.mkdirSync(dir, { recursive: true });
    const buf = Buffer.alloc(9000, 0);
    buf.write('%PDF-1.4 fake', 0);
    fs.writeFileSync(path.join(dir, 'bdris-original-1234567.pdf'), buf);
    const seen = [];
    const job = await f.ensureOriginal(rec, (s) => seen.push(s));
    assert.equal(job.result.cached, true);
    assert.deepEqual(seen, []);
  });
});
