'use strict';
// original-fetcher.js — আসল BDRIS PDF আনয়ন, সম্পূর্ণ অটো (live-proven 2026-10-11, probe3c)
//
// লাইভ-প্রমাণিত রেসিপি — সাইট বদলালে আগে এখানে দেখুন:
//   ১) https://bdris.gov.bd/application/print সরাসরি (public পেজ, লগইন লাগে না);
//      WAF "Please type on browser" block দিলে /br/application হয়ে referer নিয়ে
//      আবার চেষ্টা (2026-10-15 fix: হোমপেজের লিংক hover-dropdown-এ থাকে বলে
//      selector wait চলে না — direct URL primary, /br/application fallback)
//   ২) ফর্ম ভরাও: appType option value-ই এনক্রিপ্টেড `data`; appId/date/nameEn/mobileNo/email
//   ৩) ক্যাপচা (250×50 data-URL PNG) → লোকাল সলভার (captcha-solve2) → প্রার্থী-তালিকা
//   ৪) প্রতি প্রার্থী: সাইটের নিজের callAjax('/api/application/print') → ২৯৮-char টোকেন →
//      সাধারণ fetch('/application/print/preview?data='+টোকেন, credentials:'include')
//      → 200 application/pdf = জয়; 400 JSON = ভুল প্রার্থী
//   নিয়ম: ভুল প্রার্থী সেশন/ক্যাপচা নষ্ট করে না; টোকেন একবার-ব্যবহারযোগ্য;
//         সলভার ট্রু-উত্তর না ধরলে পেজ রিলোড → নতুন ক্যাপচা (রাউন্ড)।
//   ৪টি সমান্তরাল worker — প্রত্যেকের আলাদা ক্যাপচা; যে কেউ আগে পেলে জয়।

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const S2 = require('./captcha-solve2.js');

const SITE = 'https://bdris.gov.bd';
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const ARCHIVE_DIR = path.join(__dirname, 'downloads');
const WORKERS = Math.max(1, parseInt(process.env.ORIG_WORKERS || '4', 10));
const JOB_TIMEOUT_MS = Math.max(20000, parseInt(process.env.ORIG_DEADLINE_MS || '150000', 10));
const CAND_CAP = Math.max(4, parseInt(process.env.ORIG_CANDS || '24', 10));
const ROUNDS_PER_WORKER = Math.max(1, parseInt(process.env.ORIG_ROUNDS || '3', 10));
const IDLE_CLOSE_MS = 4 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * Math.max(1, b - a));
function log(...a) { console.log('[ORIG]', new Date().toISOString().slice(11, 19), ...a); }

let tmplCache = null;
function templates() { if (!tmplCache) tmplCache = S2.loadTemplates(); return tmplCache; }

// ── browser lifecycle: আলাদা headless instance — মূল আবেদন-সেশনের সাথে কোনো সম্পর্ক নেই ──
let browser = null;
let idleTimer = null;
let activeJobs = 0;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors'],
  });
  return browser;
}
function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (activeJobs > 0) return;
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    browser = null;
    log('idle-close browser');
  }, IDLE_CLOSE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

async function newWorkerPage() {
  const b = await getBrowser();
  const ctx = await b.newContext({
    viewport: { width: 1280, height: 900 }, locale: 'bn-BD', acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
  await ctx.route('**/google-analytics**', (r) => r.abort().catch(() => {}));
  await ctx.route('**/googletagmanager**', (r) => r.abort().catch(() => {}));
  const page = await ctx.newPage();
  return { ctx, page };
}

// ── in-page ops (probe3c থেকে হুবহু — সাইটের নিজের callAjax + প্লেইন fetch) ──
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
      } catch (e) { if (!done) { done = true; clearTimeout(to); res({ err: 'throw ' + e.message }); } }
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

async function runOp(page, op, args) {
  try {
    return await page.evaluate(new Function('A', PAGE_OPS + '; return __OPS[A.op](...A.args);'), { op, args });
  } catch (e) {
    return { err: 'evaluate ' + String(e.message || e).split('\n')[0] };
  }
}

async function openPrintForm(page) {
  // Permanent fix (2026-10-15): "আবেদনপত্র প্রিন্ট" লিংক (a[href="/application/print"])
  // হোমপেজের hover-dropdown-এ থাকে — DOM-এ আসে না বলে selector wait সবসময় timeout.
  // Strategy: সরাসরি URL-এ যাওয়ার চেষ্টা; WAF "Please type on browser" block দিলে
  // /br/application হয়ে session/referer নিয়ে আবার চেষ্টা (দুটোই public, লগইন লাগে না)।
  const printUrl = SITE + '/application/print';
  let blocked = false;
  try {
    await page.goto(printUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 120) : '').catch(() => '');
    blocked = /please type on browser/i.test(bodyText);
  } catch (e) { blocked = true; }
  if (blocked) {
    await page.goto(SITE + '/br/application', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1200);
    await page.goto(printUrl, { waitUntil: 'domcontentloaded', timeout: 45000, referer: SITE + '/br/application' });
  }
  await page.waitForSelector('#appId', { timeout: 25000 });
  // util.js-এর callAjax আসার আগেই mint চালালে ব্যর্থ হয় — তাই অপেক্ষা
  await page.waitForFunction(() => typeof window.callAjax === 'function', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(700);
}

async function fillForm(page, rec) {
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

async function readCaptchaReady(page) {
  for (let i = 0; i < 4; i++) {
    await page.waitForFunction(() => {
      const ims = Array.from(document.querySelectorAll('img'));
      const im = ims.find((x) => /captcha/i.test(x.id + ' ' + x.className + ' ' + x.src));
      return im && im.complete && im.naturalWidth > 0;
    }, { timeout: 8000 }).catch(() => {});
    const cap = await runOp(page, 'readCaptcha', []);
    if (cap && cap.grayB64) return cap;
    await sleep(400);
  }
  return null;
}

// ── worker: নিজের কনটেক্সটে নিজের ক্যাপচা, প্রার্থী ধরে ধরে mint+preview ──
async function workerRun(rec, variants, job, wid, deadline) {
  const { ctx, page } = await newWorkerPage();
  try {
    for (let round = 1; round <= ROUNDS_PER_WORKER; round++) {
      if (job.done || Date.now() > deadline) return null;
      const nameEn = variants[(wid + round - 1) % variants.length];
      try { await openPrintForm(page); }
      catch (e) { log('W' + wid, 'open-fail', String(e.message || e).split('\n')[0].slice(0, 80)); await sleep(jitter(1200, 2500)); continue; }
      await fillForm(page, { ...rec, nameEn }).catch(() => {});
      const cap = await readCaptchaReady(page);
      if (!cap) { log('W' + wid, 'captcha-miss round', round); continue; }
      const gray = Buffer.from(cap.grayB64, 'base64');
      let cands = [];
      try { cands = S2.candidatesFromGray(gray, cap.w, cap.h, templates(), { cap: CAND_CAP }).list; }
      catch (e) { log('W' + wid, 'solve-err', String(e.message || e).slice(0, 100)); }
      if (!cands.length) cands = ['abc12'];
      const f = await runOp(page, 'fields', []);
      const base = { data: (f && f.data) || '', appId: rec.appId, date: rec.date, nameEn, mobileNo: rec.mobileNo, email: rec.email || '' };
      if (!base.data) { log('W' + wid, 'no-appType'); await sleep(800); continue; }
      log('W' + wid, 'round', round, 'name=' + nameEn.slice(0, 24), 'cands(' + cands.length + '):', cands.slice(0, 4).join(','));
      let mintFails = 0;
      for (const c of cands) {
        if (job.done || Date.now() > deadline) return null;
        const m = await runOp(page, 'mint', [{ fields: { ...base, captchaAns: c } }]);
        if (!m || !m.ok || !m.token) {
          mintFails++;
          if (mintFails >= 6) { log('W' + wid, 'mint-fail streak — reload'); break; }
          await sleep(jitter(120, 320));
          continue;
        }
        mintFails = 0;
        const url = SITE + '/application/print/preview?data=' + encodeURIComponent(String(m.token).trim());
        const p = await runOp(page, 'previewP', [{ url }]);
        if (p && p.ok && p.b64) return { b64: p.b64, bytes: p.len, answer: c, worker: wid, round };
        await sleep(jitter(120, 320));
      }
    }
    return null;
  } finally {
    await ctx.close().catch(() => {});
  }
}

function validPdf(buf) {
  return buf && buf.length > 8000 && buf[0] === 37 && buf[1] === 80 && buf[2] === 68 && buf[3] === 70;
}

async function runJob(rec, job) {
  const t0 = Date.now();
  const deadline = t0 + JOB_TIMEOUT_MS;
  const variants = [...new Set([rec.nameEn, ...(rec.altNameEn || [])].map((s) => String(s || '').trim()).filter(Boolean))];
  if (!variants.length) variants.push('');
  activeJobs++;
  try {
    const results = [];
    const workers = [];
    for (let w = 0; w < WORKERS; w++) {
      workers.push(workerRun(rec, variants, job, w + 1, deadline)
        .then((r) => { if (r && r.b64) job.done = true; results.push(r); return r; })
        .catch(() => null));
    }
    await Promise.all(workers);
    const hit = results.find((r) => r && r.b64 && validPdf(Buffer.from(r.b64, 'base64')));
    if (hit) {
      const buf = Buffer.from(hit.b64, 'base64');
      const file = 'bdris-original-' + rec.appId + '.pdf';
      fs.writeFileSync(path.join(FRONTEND_DIR, file), buf);
      try { fs.mkdirSync(ARCHIVE_DIR, { recursive: true }); fs.writeFileSync(path.join(ARCHIVE_DIR, Date.now() + '-' + file), buf); } catch { /* ঐচ্ছিক */ }
      log('HIT appId=' + rec.appId, buf.length + 'B', 'worker', hit.worker, 'round', hit.round, 'answer', hit.answer, (Date.now() - t0) + 'ms');
      return { ok: true, url: '/' + file, path: path.join(FRONTEND_DIR, file), bytes: buf.length, ms: Date.now() - t0, worker: hit.worker, round: hit.round };
    }
    job.done = true;
    log('MISS appId=' + rec.appId, (Date.now() - t0) + 'ms');
    return { ok: false, url: null, bytes: 0, ms: Date.now() - t0 };
  } finally {
    activeJobs--;
    scheduleIdleClose();
  }
}

// ── job registry: একই appId-র জন্য একবারই চলে; শেষ হলে সব listener পায় ──
const jobs = new Map(); // appId -> { status, promise, result, listeners }

function cachedOriginal(appId) {
  const key = String(appId || '').replace(/\D/g, '');
  if (!key) return null;
  const f = path.join(FRONTEND_DIR, 'bdris-original-' + key + '.pdf');
  try {
    const st = fs.statSync(f);
    if (st.size > 8000) {
      const fd = fs.openSync(f, 'r'); const h = Buffer.alloc(4); fs.readSync(fd, h, 0, 4, 0); fs.closeSync(fd);
      if (h[0] === 37 && h[1] === 80 && h[2] === 68 && h[3] === 70) {
        return { ok: true, url: '/bdris-original-' + key + '.pdf', path: f, bytes: st.size, cached: true };
      }
    }
  } catch { /* নেই */ }
  return null;
}

function ensureOriginal(rec, onDone) {
  const key = String(rec && rec.appId || '').replace(/\D/g, '');
  const cached = cachedOriginal(key);
  if (cached) { if (onDone) { try { onDone(cached); } catch { /* ignore */ } } return Promise.resolve({ status: 'done', result: cached }); }
  let j = jobs.get(key);
  if (j && j.status === 'running') {
    if (onDone) j.listeners.push(onDone);
    return j.promise;
  }
  j = { status: 'running', listeners: onDone ? [onDone] : [], result: null, startedAt: Date.now() };
  jobs.set(key, j);
  j.promise = runJob(rec, j)
    .then((r) => {
      j.status = r.ok ? 'done' : 'failed';
      j.result = r;
      for (const cb of j.listeners) { try { cb(r); } catch { /* ignore */ } }
      j.listeners = [];
      return j;
    })
    .catch((e) => {
      j.status = 'failed';
      j.result = { ok: false, url: null, bytes: 0, err: String(e.message || e) };
      for (const cb of j.listeners) { try { cb(j.result); } catch { /* ignore */ } }
      j.listeners = [];
      return j;
    });
  return j.promise;
}

function originalStatus(appId) {
  const j = jobs.get(String(appId || '').replace(/\D/g, ''));
  return j ? { status: j.status, startedAt: j.startedAt, result: j.result } : null;
}

function stopOriginalFetcher() {
  if (idleTimer) clearTimeout(idleTimer);
  try { if (browser) browser.close(); } catch { /* ignore */ }
  browser = null;
}

module.exports = { ensureOriginal, cachedOriginal, originalStatus, stopOriginalFetcher };

// ── CLI: node original-fetcher.js <appId> <date DD/MM/YYYY> <nameEn> <mobileNo> [email] [--human] ──
if (require.main === module) {
  const argv = process.argv.slice(2);
  const human = argv.includes('--human');
  const pos = argv.filter((a) => !a.startsWith('--'));
  const rec = { appId: pos[0], date: pos[1], nameEn: pos[2], mobileNo: pos[3], email: pos[4] || '' };
  if (!rec.appId || !rec.date || !rec.nameEn || !rec.mobileNo) {
    console.log('usage: node original-fetcher.js <appId> <date DD/MM/YYYY> <nameEn> <mobileNo> [email] [--human]');
    process.exit(1);
  }
  if (human) {
    // ডিবাগ মোড: ফর্ম খুলে ক্যাপচা সেভ করে orig-answer.txt-এর অপেক্ষা করে, তারপর একবার mint+preview
    (async () => {
      const { ctx, page } = await newWorkerPage();
      try {
        await openPrintForm(page);
        await fillForm(page, rec);
        const cap = await readCaptchaReady(page);
        if (!cap) throw new Error('captcha read fail');
        const raw = Buffer.from(cap.grayB64, 'base64');
        fs.writeFileSync(path.join(__dirname, 'orig-captcha-gray.raw'), raw);
        console.log('CAPTCHA_READY gray', cap.w + 'x' + cap.h, '— লিখুন:', path.join(__dirname, 'orig-answer.txt'));
        const af = path.join(__dirname, 'orig-answer.txt');
        try { fs.unlinkSync(af); } catch {}
        let ans = '';
        for (let i = 0; i < 240 && !ans; i++) {
          if (fs.existsSync(af)) ans = fs.readFileSync(af, 'utf8').trim();
          if (!ans) await sleep(500);
        }
        if (!ans) throw new Error('no answer');
        console.log('ANSWER', ans);
        const f = await runOp(page, 'fields', []);
        const m = await runOp(page, 'mint', [{ fields: { data: (f && f.data) || '', appId: rec.appId, date: rec.date, nameEn: rec.nameEn, mobileNo: rec.mobileNo, email: rec.email || '', captchaAns: ans } }]);
        console.log('MINT', JSON.stringify({ ok: m.ok, err: m.err, status: m.status }));
        if (m.ok && m.token) {
          const url = SITE + '/application/print/preview?data=' + encodeURIComponent(String(m.token).trim());
          const p = await runOp(page, 'previewP', [{ url }]);
          console.log('PREVIEW', JSON.stringify({ ok: p.ok, status: p.status, len: p.len, txt: (p.txt || '').slice(0, 120) }));
          if (p.ok && p.b64) {
            const buf = Buffer.from(p.b64, 'base64');
            const out = path.join(ARCHIVE_DIR, 'orig-human-test.pdf');
            fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
            fs.writeFileSync(out, buf);
            console.log('PDF SAVED', out, buf.length);
          }
        }
      } catch (e) { console.error('HUMAN-MODE ERR', e.message); }
      finally { await ctx.close().catch(() => {}); stopOriginalFetcher(); process.exit(0); }
    })();
  } else {
    ensureOriginal(rec, null).then((j) => {
      const r = j.result || {};
      console.log('RESULT', JSON.stringify(r));
      stopOriginalFetcher();
      process.exit(r.ok ? 0 : 2);
    });
  }
}
