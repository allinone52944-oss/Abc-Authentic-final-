/**
 * OriginalFetcher — আসল BDRIS PDF (কার্যালয়ের কপি) আনয়ন
 *
 * v1 (engines/bdris-apply/original-fetcher.js) থেকে migrate করা, live-proven
 * রেসিপি হুবহু রাখা হয়েছে (probe3c, 2026-10-11):
 *   ১) bdris.gov.bd → "জন্ম নিবন্ধন" nav hover → a[href="/application/print"]-এ CLICK
 *      (public পেজ, লগইন লাগে না; page.goto() দিয়ে সরাসরি গেলে WAF block দেয়)
 *   ২) ফর্ম: appType option value-ই এনক্রিপ্টেড `data`; appId/date/nameEn/mobileNo/email
 *   ৩) ক্যাপচা → লোকাল সলভার (captcha-solve2) → প্রার্থী-তালিকা
 *   ৪) প্রতি প্রার্থী: সাইটের callAjax('/api/application/print') → টোকেন →
 *      fetch('/application/print/preview?data='+টোকেন) → 200 application/pdf = জয়
 *
 * v2 পরিবর্তন:
 * - Class, কোনো global state নেই (browser/jobs সব instance-এর)
 * - BrowserManager থেকে isolated context — নিজস্ব browser instance নেই,
 *   idle-close নেই (browser lifecycle BrowserManager-এর)
 * - BUG FIX (v1): job 'running'-এ চিরতরে আটকে থাকত → ৫ মিনিটের job timeout;
 *   timeout-এ job.done সেট হয় (worker-রা abort করে), সব waiter-রা failure পায়
 * - BUG FIX (v1): jobs Map কখনো পরিষ্কার হতো না → finished job TTL-এর পর মুছে যায়
 * - Promise-based API (v1-এর onDone callback নয়)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SITE = 'https://bdris.gov.bd';

// v1-এর default ছিল 150s; v2-তে ৫ মিনিট (task requirement + hanging-bug fix)
const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_WORKERS = 4;
const DEFAULT_CAND_CAP = 24;
const DEFAULT_ROUNDS_PER_WORKER = 3;
// শেষ হওয়া job কতক্ষণ status-এর জন্য থাকবে, তারপর Map থেকে মুছে যাবে
const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;
const MIN_PDF_BYTES = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * Math.max(1, b - a));

// ── in-page ops (v1 probe3c থেকে হুবহু — সাইটের নিজের callAjax + প্লেইন fetch) ──
const PAGE_OPS = `
const __OPS = {
  async mint(A) {
    if (typeof callAjax !== 'function') return { err: 'no-global-callAjax' };
    return await new Promise((res) => {
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; res({ err: 'timeout' }); } }, A.waitMs || 20000);
      try {
        callAjax('/api/application/print', A.fields, 'POST',
          (data) => { if (!done) { done = true; clearTimeout(to); res({ ok: true, token: (typeof data === 'string') ? data : JSON.stringify(data) }); } },
          (xhr) => { if (!done) { done = true; clearTimeout(to); res({ ok: false, status: (xhr && xhr.status) || 0, txt: ((xhr && xhr.responseText) || '').slice(0, 160) }); } }
        );
      } catch (e) { if (!done) { done = true; res({ err: 'throw ' + e.message }); } }
    });
  },
  async previewP(A) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 30000);
      const r = await fetch(A.url, { credentials: 'include', cache: 'no-store', signal: ctl.signal });
      clearTimeout(to);
      const ct = r.headers.get('content-type') || '';
      if (r.status === 200 && ct.includes('pdf')) {
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length >= 5 && b[0] === 37 && b[1] === 80) {
          let s = ''; const CH = 0x8000;
          for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
          return { ok: true, status: 200, len: b.length, b64: btoa(s) };
        }
      }
      let txt = '';
      try { txt = (await r.text()).slice(0, 160); } catch {}
      return { ok: false, status: r.status, ct, txt };
    } catch (e) { return { ok: false, err: 'fetch ' + e.message }; }
  },
  async readCaptcha() {
    const ims = Array.from(document.querySelectorAll('img'));
    const im = ims.find((x) => /captcha/i.test(x.id + ' ' + x.className + ' ' + x.src));
    if (!im || !im.complete || !im.naturalWidth) return null;
    try {
      const cv = document.createElement('canvas');
      cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      const cx = cv.getContext('2d');
      cx.drawImage(im, 0, 0);
      const d = cx.getImageData(0, 0, cv.width, cv.height).data;
      const gray = new Uint8Array(cv.width * cv.height);
      for (let i = 0; i < gray.length; i++) gray[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
      let s = ''; const CH = 0x8000;
      for (let i = 0; i < gray.length; i += CH) s += String.fromCharCode.apply(null, gray.subarray(i, i + CH));
      return { w: cv.width, h: cv.height, grayB64: btoa(s) };
    } catch (e) { return null; }
  },
  async fields() {
    const s = document.querySelector('#appType');
    return { data: s ? s.value : '' };
  }
};
`;

class OriginalFetcher {
  constructor(options = {}) {
    if (!options.browserManager) {
      throw new Error('OriginalFetcher requires browserManager');
    }
    this.browserManager = options.browserManager;
    // PDF কোথায় লিখবে: আসল frontend dir (v1-এর engines/frontend/ পথটি dead ছিল)
    this.frontendDir = options.frontendDir
      || path.join(__dirname, '..', '..', '..', 'frontend');
    this.archiveDir = options.archiveDir
      || path.join(__dirname, '..', '..', 'downloads');
    // v1-এর সাথে shared index (read/write — v1 ফাইল modify নয়, শুধু JSON read/write)
    this.indexFile = options.indexFile
      || path.join(__dirname, '..', '..', 'originals-index.json');
    this.solve2 = options.solve2 || require('../../captcha-solve2.js');
    this.workers = Math.max(1, parseInt(options.workers || DEFAULT_WORKERS, 10));
    this.jobTimeoutMs = options.jobTimeoutMs !== undefined ? Math.max(50, parseInt(options.jobTimeoutMs, 10)) : DEFAULT_JOB_TIMEOUT_MS;
    this.candCap = Math.max(4, parseInt(options.candCap || DEFAULT_CAND_CAP, 10));
    this.roundsPerWorker = Math.max(1, parseInt(options.roundsPerWorker || DEFAULT_ROUNDS_PER_WORKER, 10));
    this.jobTtlMs = Math.max(100, parseInt(options.jobTtlMs || DEFAULT_JOB_TTL_MS, 10));

    this.jobs = new Map(); // appId -> { status, promise, result, startedAt, done }
    this.activeJobs = 0;
    this._tmplCache = null;
    this._log = options.log || ((...a) => console.log('[ORIG-v2]', ...a));
  }

  log(...a) { try { this._log(...a); } catch { /* ignore */ } }

  keyOf(appId) { return String(appId || '').replace(/\D/g, ''); }

  _templates() {
    if (!this._tmplCache) this._tmplCache = this.solve2.loadTemplates();
    return this._tmplCache;
  }

  // ── cache: আগেই আনা PDF ফাইল থাকলে সাথে সাথে ফেরত ──
  cachedOriginal(appId) {
    const key = this.keyOf(appId);
    if (!key) return null;
    const f = path.join(this.frontendDir, 'bdris-original-' + key + '.pdf');
    try {
      const st = fs.statSync(f);
      if (st.size > MIN_PDF_BYTES) {
        const fd = fs.openSync(f, 'r');
        const h = Buffer.alloc(4);
        fs.readSync(fd, h, 0, 4, 0);
        fs.closeSync(fd);
        if (h[0] === 37 && h[1] === 80 && h[2] === 68 && h[3] === 70) { // %PDF
          return { ok: true, url: '/bdris-original-' + key + '.pdf', path: f, bytes: st.size, cached: true };
        }
      }
    } catch { /* নেই */ }
    return null;
  }

  // ── job status (v1 originalStatus-এর সমতুল্য) ──
  getStatus(appId) {
    const j = this.jobs.get(this.keyOf(appId));
    return j ? { status: j.status, startedAt: j.startedAt, result: j.result } : null;
  }

  // ── shared index (v1-এর originals-index.json) — submit-সময়ের rec পড়া/লেখা ──
  loadRec(appId) {
    try {
      const m = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      return m[this.keyOf(appId)] || null;
    } catch { return null; }
  }

  saveRec(appId, rec) {
    try {
      let m = {};
      try { m = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { /* নতুন */ }
      m[this.keyOf(appId)] = rec;
      fs.writeFileSync(this.indexFile, JSON.stringify(m, null, 1));
      return true;
    } catch { return false; }
  }

  /**
   * আসল PDF নিশ্চিত করো — cache → চলমান job-এ join → নতুন job।
   * সবসময় settle হয় (v1-এর hanging bug এখানে fix)।
   * @returns Promise<job> — job.result = { ok, url, bytes, ... }
   */
  async ensureOriginal(rec) {
    const key = this.keyOf(rec && rec.appId);
    if (!key) throw new Error('MISSING_APPID');

    const cached = this.cachedOriginal(key);
    if (cached) return { status: 'done', result: cached };

    let job = this.jobs.get(key);
    if (job && job.status === 'running') {
      return job.promise; // একই appId-র চলমান job-এ join
    }

    job = { status: 'running', result: null, startedAt: Date.now(), done: false, promise: null };
    this.jobs.set(key, job);

    job.promise = this._runWithTimeout(rec, job)
      .then((r) => {
        const res = r && typeof r === 'object' ? r : { ok: false, url: null, bytes: 0 };
        this._settleJob(key, job, res.ok ? 'done' : 'failed', res);
        return job;
      })
      .catch((e) => {
        const res = { ok: false, url: null, bytes: 0, err: String((e && e.message) || e) };
        this._settleJob(key, job, 'failed', res);
        return job;
      });

    return job.promise;
  }

  _settleJob(key, job, status, result) {
    if (job.status !== 'running') return;
    job.status = status;
    job.result = result;
    job.done = true;
    // v1 কখনো Map পরিষ্কার করত না (memory leak) — TTL-এর পর মুছে ফেলো
    const t = setTimeout(() => {
      if (this.jobs.get(key) === job) this.jobs.delete(key);
    }, this.jobTtlMs);
    if (t.unref) t.unref();
  }

  // ── v1 bug fix: job-level timeout — worker আটকে গেলেও job 'running'-এ থাকে না ──
  async _runWithTimeout(rec, job) {
    let timer;
    const timeoutP = new Promise((_, reject) => {
      timer = setTimeout(() => {
        job.done = true; // worker-দের abort signal
        const e = new Error(`Original PDF fetch timed out after ${Math.round(this.jobTimeoutMs / 1000)}s`);
        e.code = 'JOB_TIMEOUT';
        reject(e);
      }, this.jobTimeoutMs);
    });
    try {
      return await Promise.race([this._runJob(rec, job), timeoutP]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── isolated worker context (BrowserManager — নিজস্ব browser নেই) ──
  async _newWorkerPage() {
    const ctx = await this.browserManager.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'bn-BD',
      acceptDownloads: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });
    await ctx.route('**/google-analytics**', (r) => r.abort().catch(() => {}));
    await ctx.route('**/googletagmanager**', (r) => r.abort().catch(() => {}));
    const page = await ctx.newPage();
    return { ctx, page };
  }

  async _runOp(page, op, args) {
    try {
      return await page.evaluate(
        new Function('A', PAGE_OPS + '; return __OPS[A.op](...A.args);'),
        { op, args }
      );
    } catch (e) {
      return { err: 'evaluate ' + String(e.message || e).split('\n')[0] };
    }
  }

  async _openPrintForm(page) {
    // v1 permanent fix (2026-10-15): WAF "Please type on browser" এড়াতে
    // page.goto() দিয়ে সরাসরি /application/print-এ যাওয়া যায় না —
    // সাইটের ভেতরে আসল link-এ click-ই স্থায়ী পথ।
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1000);
    const navItem = page.locator('.navbar-collapse .dropdown.yamm-fw:nth-child(2)').first();
    await navItem.hover().catch(() => {});
    await page.waitForTimeout(800);
    const printLink = page.locator('a[href="/application/print"]').first();
    await printLink.waitFor({ state: 'attached', timeout: 15000 });
    await printLink.click().catch(async () => { await printLink.evaluate((el) => el.click()).catch(() => {}); });
    await page.waitForSelector('#appId', { timeout: 25000 });
    await page.waitForFunction(() => typeof window.callAjax === 'function', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(700);
  }

  async _fillForm(page, rec) {
    await page.evaluate((cfg) => {
      const $ = window.jQuery;
      try { if ($ && $.validator && $.validator.methods) $.validator.methods.englishLettersOnly = function () { return true; }; } catch (e) {}
      const setV = (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return;
        if ($) { $(el).val(val).trigger('input').trigger('change'); }
        else { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      };
      const s = document.querySelector('#appType');
      if (s) { for (const o of s.options) if (o.text.includes('জন্ম নিবন্ধনের')) { if ($) $(s).val(o.value).trigger('change'); else s.value = o.value; } }
      setV('#appId', cfg.appId);
      setV('#date', cfg.date);
      setV('#nameEn', cfg.nameEn);
      setV('#mobileNo', cfg.mobileNo);
      setV('#email', cfg.email || '');
    }, rec);
  }

  async _readCaptchaReady(page) {
    for (let i = 0; i < 4; i++) {
      await page.waitForFunction(() => {
        const ims = Array.from(document.querySelectorAll('img'));
        const im = ims.find((x) => /captcha/i.test(x.id + ' ' + x.className + ' ' + x.src));
        return im && im.complete && im.naturalWidth > 0;
      }, { timeout: 8000 }).catch(() => {});
      const cap = await this._runOp(page, 'readCaptcha', []);
      if (cap && cap.grayB64) return cap;
      await sleep(400);
    }
    return null;
  }

  _validPdf(buf) {
    return buf && buf.length > MIN_PDF_BYTES
      && buf[0] === 37 && buf[1] === 80 && buf[2] === 68 && buf[3] === 70;
  }

  async _workerRun(rec, variants, job, wid, deadline) {
    const { ctx, page } = await this._newWorkerPage();
    try {
      for (let round = 1; round <= this.roundsPerWorker; round++) {
        if (job.done || Date.now() > deadline) return null;
        const nameEn = variants[(wid + round - 1) % variants.length];
        try { await this._openPrintForm(page); }
        catch (e) {
          this.log('W' + wid, 'open-fail', String(e.message || e).split('\n')[0].slice(0, 80));
          await sleep(jitter(1200, 2500));
          continue;
        }
        await this._fillForm(page, { ...rec, nameEn }).catch(() => {});
        const cap = await this._readCaptchaReady(page);
        if (!cap) { this.log('W' + wid, 'captcha-miss round', round); continue; }
        const gray = Buffer.from(cap.grayB64, 'base64');
        let cands = [];
        try { cands = this.solve2.candidatesFromGray(gray, cap.w, cap.h, this._templates(), { cap: this.candCap }).list; }
        catch (e) { this.log('W' + wid, 'solve-err', String(e.message || e).slice(0, 100)); }
        if (!cands.length) cands = ['abc12'];
        const f = await this._runOp(page, 'fields', []);
        const base = { data: (f && f.data) || '', appId: rec.appId, date: rec.date, nameEn, mobileNo: rec.mobileNo, email: rec.email || '' };
        if (!base.data) { this.log('W' + wid, 'no-appType'); await sleep(800); continue; }
        this.log('W' + wid, 'round', round, 'name=' + nameEn.slice(0, 24), 'cands(' + cands.length + '):', cands.slice(0, 4).join(','));
        let mintFails = 0;
        for (const c of cands) {
          if (job.done || Date.now() > deadline) return null;
          const m = await this._runOp(page, 'mint', [{ fields: { ...base, captchaAns: c } }]);
          if (!m || !m.ok || !m.token) {
            mintFails++;
            if (mintFails >= 6) { this.log('W' + wid, 'mint-fail streak — reload'); break; }
            await sleep(jitter(120, 320));
            continue;
          }
          mintFails = 0;
          const url = SITE + '/application/print/preview?data=' + encodeURIComponent(String(m.token).trim());
          const p = await this._runOp(page, 'previewP', [{ url }]);
          if (p && p.ok && p.b64) return { b64: p.b64, bytes: p.len, answer: c, worker: wid, round };
          await sleep(jitter(120, 320));
        }
      }
      return null;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async _runJob(rec, job) {
    const t0 = Date.now();
    const deadline = t0 + this.jobTimeoutMs;
    const variants = [...new Set([rec.nameEn, ...(rec.altNameEn || [])].map((s) => String(s || '').trim()).filter(Boolean))];
    if (!variants.length) variants.push('');
    this.activeJobs++;
    try {
      const results = [];
      const workers = [];
      for (let w = 0; w < this.workers; w++) {
        workers.push(
          this._workerRun(rec, variants, job, w + 1, deadline)
            .then((r) => { if (r && r.b64) job.done = true; results.push(r); return r; })
            .catch(() => null)
        );
      }
      await Promise.all(workers);
      const hit = results.find((r) => r && r.b64 && this._validPdf(Buffer.from(r.b64, 'base64')));
      if (hit) {
        const buf = Buffer.from(hit.b64, 'base64');
        const file = 'bdris-original-' + this.keyOf(rec.appId) + '.pdf';
        fs.writeFileSync(path.join(this.frontendDir, file), buf);
        try {
          fs.mkdirSync(this.archiveDir, { recursive: true });
          fs.writeFileSync(path.join(this.archiveDir, Date.now() + '-' + file), buf);
        } catch { /* সংরক্ষণ ঐচ্ছিক */ }
        this.log('HIT appId=' + rec.appId, buf.length + 'B', 'worker', hit.worker, 'round', hit.round, (Date.now() - t0) + 'ms');
        return { ok: true, url: '/' + file, path: path.join(this.frontendDir, file), bytes: buf.length, ms: Date.now() - t0, worker: hit.worker, round: hit.round };
      }
      job.done = true;
      this.log('MISS appId=' + rec.appId, (Date.now() - t0) + 'ms');
      return { ok: false, url: null, bytes: 0, ms: Date.now() - t0 };
    } finally {
      this.activeJobs--;
    }
  }

  async shutdown() {
    // BrowserManager-এর browser বন্ধ করি না — শুধু নিজের timer/job পরিষ্কার
    for (const [key, job] of this.jobs) {
      job.done = true;
      if (job.status === 'running') {
        job.status = 'failed';
        job.result = { ok: false, url: null, bytes: 0, err: 'shutdown' };
      }
      this.jobs.delete(key);
    }
    this.activeJobs = 0;
  }
}

module.exports = { OriginalFetcher };
