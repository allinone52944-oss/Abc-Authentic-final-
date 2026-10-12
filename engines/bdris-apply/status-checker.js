'use strict';
// status-checker.js — BDRIS অ্যাকাউন্ট দিয়ে "আবেদনের বর্তমান অবস্থা" আনা (2026-10-11)
//
// লাইভ-ম্যাপ (login-inline.js + probe-status4 থেকে):
//   ১) bdris.gov.bd root → /login (referer লাগে — সরাসরি গেলে WAF গেট)
//   ২) ফর্ম: userType radio (BANGLADESH/MISSION), #username, #password, #mobileEmail,
//      ক্যাপচা img + #answer → #sendOtpBtn (ajax POST /login/send-otp)
//   ৩) সফল হলে: #usernamePassDiv ও #sendOtpBtn হাইড, #otpDiv শো (৩০০ সেকেন্ড)
//   ৪) #otp-তে কোড → #loginBtn/#loginForm submit → পোর্টাল
//   ৫) /br/application/status → আবেদনের তালিকা scrape
// নিয়ম: ভুল পাসওয়ার্ডে auto-retry নয় (৩ ভুলে ৩০ মিনিট লক) — শুধু ক্যাপচা-ভুলে
// পরের প্রার্থী দিয়ে আবার চেষ্টা। ক্যাপচা সলভার: captcha-solve2 (একই টেমপ্লেট)।

const { chromium } = require('playwright');
const S2 = require('./captcha-solve2.js');

const IDLE_CLOSE_MS = 4 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * Math.max(1, b - a));
function log(...a) { console.log('[STATUS]', new Date().toISOString().slice(11, 19), ...a); }

let tmplCache = null;
function templates() { if (!tmplCache) tmplCache = S2.loadTemplates(); return tmplCache; }

let browser = null;
let ctx = null;
let page = null;
let idleTimer = null;
let lastDialog = null;
let lastBase = null;

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    try { if (ctx) await ctx.close(); } catch { /* ignore */ }
    ctx = null; page = null;
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    browser = null;
    log('idle-close');
  }, IDLE_CLOSE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

async function ensurePage() {
  if (page && !page.isClosed()) return page;
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors'],
    });
  }
  ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 }, locale: 'bn-BD',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
  await ctx.route('**/google-analytics**', (r) => r.abort().catch(() => {}));
  await ctx.route('**/googletagmanager**', (r) => r.abort().catch(() => {}));
  page = await ctx.newPage();
  page.on('dialog', async (d) => {
    lastDialog = String(d.message() || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    log('DIALOG:', lastDialog);
    await d.dismiss().catch(() => {});
  });
  scheduleIdleClose();
  return page;
}

// ── ক্যাপচা পড়া: /captcha/i দেওয়া img → gray base64 (original-fetcher-এর মতোই) ──
const READ_CAPTCHA = `
(() => {
  const ims = Array.from(document.querySelectorAll('img'));
  const im = ims.find((x) => /captcha/i.test((x.id || '') + ' ' + (x.className || '') + ' ' + (x.src || '')));
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
})()
`;

async function readCaptcha(pg) {
  for (let i = 0; i < 4; i++) {
    const cap = await pg.evaluate(READ_CAPTCHA).catch(() => null);
    if (cap && cap.grayB64) return cap;
    await sleep(400);
  }
  return null;
}

// লগইন পাতা: root → লিংক, না পেলে সরাসরি /login (referer root)
async function gotoLogin(pg, base) {
  const loginUrl = base + '/login';
  try {
    await pg.goto(base, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const link = pg.locator('a[href*="/login"]').first();
    if (await link.count().catch(() => 0)) {
      await link.click({ timeout: 8000 }).catch(async () => { await link.evaluate((el) => el.click()).catch(() => {}); });
      await pg.waitForSelector('#username', { timeout: 20000 });
      return;
    }
  } catch { /* নিচের সরাসরি যাওয়া */ }
  await pg.goto(loginUrl, {
    waitUntil: 'domcontentloaded', timeout: 45000,
    referer: base + '/',
  }).catch(() => {});
  await pg.waitForSelector('#username', { timeout: 20000 });
}

async function fillLoginForm(pg, opts, captchaAns) {
  await pg.evaluate((a) => {
    const q = (s) => document.querySelector(s);
    // userType radio — সাইট নিজেই hidden userTypeRadio সেট করে (click হ্যান্ডলার)
    const want = String(a.userType || 'BANGLADESH').toUpperCase();
    const radios = Array.from(document.querySelectorAll('input[name="userType"]'));
    const r = radios.find((x) => String(x.value || '').toUpperCase() === want) || radios[0];
    if (r) r.click();
    const setV = (sel, val) => {
      const el = q(sel);
      if (!el || val == null) return;
      el.value = String(val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setV('#username', a.username);
    setV('#password', a.password);
    setV('#mobileEmail', a.mobileEmail);
    setV('#answer', a.captchaAns);
  }, { ...opts, captchaAns }).catch(() => {});
}

// sendOtp-র ফল: #otpDiv এল = ok; dialog/toast = বার্তা
async function waitOtpOutcome(pg, ms) {
  const deadline = Date.now() + ms;
  lastDialog = null;
  while (Date.now() < deadline) {
    const st = await pg.evaluate(() => {
      const vis = (el) => !!(el && (el.offsetParent !== null || el.getClientRects().length));
      const otpDiv = document.querySelector('#otpDiv');
      const sBtn = document.querySelector('#sendOtpBtn');
      const toasts = [];
      document.querySelectorAll('.jq-toast-single').forEach((t) => {
        if (!vis(t)) return;
        const txt = (t.innerText || '').trim().replace(/\s+/g, ' ');
        if (txt) toasts.push({ txt: txt.slice(0, 160), err: !!t.querySelector('.jq-icon-error, .jq-icon-error-circle') });
      });
      const inv = [];
      document.querySelectorAll('.invalid-feedback').forEach((e) => {
        if (!vis(e)) return;
        const t = (e.innerText || '').trim();
        if (t) inv.push(t.slice(0, 120));
      });
      return { otpVisible: vis(otpDiv), sBtnVisible: vis(sBtn), toasts: toasts.slice(-3), inv: inv.slice(0, 3) };
    }).catch(() => ({ otpVisible: false, sBtnVisible: false, toasts: [], inv: [] }));
    if (st.otpVisible && !st.sBtnVisible) return { ok: true };
    const msg = lastDialog
      || (st.toasts.find((t) => t.err) || {}).txt
      || (st.inv[0] || '')
      || (st.toasts[0] || {}).txt;
    if (msg) {
      const captchaWrong = /ক্যাপচা|captcha/i.test(msg);
      return { ok: false, captchaWrong, message: msg };
    }
    await sleep(500);
  }
  return { ok: false, captchaWrong: true, message: '' }; // চুপ — ক্যাপচা বদলে আবার চেষ্টা লাভজনক
}

async function statusOpen(opts, emit) {
  const pg = await ensurePage();
  const base = opts.base; // mock বা আসল
  lastBase = base;
  emit('প্রথমে BDRIS লগইন পাতা খোলা হচ্ছে…');
  await gotoLogin(pg, base);
  const ROUNDS = 3;
  for (let round = 1; round <= ROUNDS; round++) {
    // প্রতি রাউন্ডে ক্যাপচা নতুন করে পড়ি (ভুলের পর সাইট ছবি বদলে দেয়)
    const cap = await readCaptcha(pg);
    let cands = [];
    if (cap) {
      try { cands = S2.candidatesFromGray(Buffer.from(cap.grayB64, 'base64'), cap.w, cap.h, templates(), { cap: 10 }).list; }
      catch (e) { log('solve-err', String(e.message || e).slice(0, 100)); }
    }
    if (!cands.length) cands = ['abc12'];
    log('round', round, 'cands(' + cands.length + '):', cands.slice(0, 4).join(','));
    // একই ছবিতে সেরা ২টি প্রার্থী খাটিয়ে দেখি; ক্যাপচা ভুল হলে নতুন রাউন্ডে নতুন ছবি
    for (const c of cands.slice(0, 2)) {
      await fillLoginForm(pg, opts, c);
      emit('ক্যাপচা বসিয়ে কোড পাঠানো হচ্ছে… (চেষ্টা ' + round + ')');
      await pg.click('#sendOtpBtn, .sendOtpBtn').catch(() => {});
      const out = await waitOtpOutcome(pg, 15000);
      if (out.ok) return { ok: true, attempts: round };
      if (!out.captchaWrong) {
        // পাসওয়ার্ড/ইউজারনেম ভুল ইত্যাদি — auto-retry নয় (লকআউট এড়াতে)
        return { ok: false, message: out.message || 'লগইন তথ্য মেলেনি — আবার দেখে চেষ্টা করুন' };
      }
      if (out.message) log('captcha-retry:', out.message);
      await sleep(jitter(500, 1000));
    }
  }
  return { ok: false, message: 'ক্যাপচা মিলিয়ে নেওয়া যায়নি — আবার চেষ্টা করুন' };
}

async function statusOtp(otp, opts, emit) {
  const pg = await ensurePage();
  const base = opts.base;
  lastBase = base;
  emit('কোড যাচাই হচ্ছে…');
  lastDialog = null;
  await pg.waitForSelector('#otp, input[name="otp"]', { state: 'visible', timeout: 15000 }).catch(() => {});
  await pg.fill('#otp', String(otp || '').replace(/\D/g, '')).catch(() => {});
  const nav = pg.waitForNavigation({ timeout: 40000 }).catch(() => null);
  await pg.click('#loginBtn, button[type="submit"], input[type="submit"]').catch(async () => {
    await pg.evaluate(() => {
      const f = document.querySelector('#loginForm') || document.querySelector('form');
      if (f) f.submit();
    }).catch(() => {});
  });
  await nav;
  await pg.waitForTimeout(1500);
  const url = pg.url();
  if (/\/login/.test(url) && !/status/.test(url)) {
    // ফিরে এসেছে — OTP ভুল/মেয়াদোত্তীর্ণ
    const msg = lastDialog || 'কোডটি মেলেনি বা মেয়াদ শেষ — আবার চেষ্টা করুন';
    return { ok: false, message: msg };
  }
  emit('লগইন সফল — আবেদনের তালিকা আনা হচ্ছে…');
  await pg.goto(base + '/br/application/status', {
    waitUntil: 'domcontentloaded', timeout: 45000,
    referer: base + '/',
  }).catch(() => {});
  await pg.waitForTimeout(2500);
  const data = await scrapeStatus(pg);
  return { ok: true, ...data };
}

async function scrapeStatus(pg) {
  return await pg.evaluate(() => {
    const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const tables = [];
    document.querySelectorAll('table').forEach((t) => {
      const head = Array.from(t.querySelectorAll('thead th')).map((x) => clean(x.innerText));
      const rows = Array.from(t.querySelectorAll('tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => clean(td.innerText)).slice(0, 12));
      const body = rows.some((r) => r.length) ? rows : Array.from(t.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => clean(td.innerText)).slice(0, 12));
      const cleanRows = body.filter((r) => r.some(Boolean));
      if (cleanRows.length || head.some(Boolean)) tables.push({ head: head.filter(Boolean), rows: cleanRows.slice(0, 50) });
    });
    const main = document.querySelector('main, .container, #content, .content') || document.body;
    const text = clean(main.innerText).slice(0, 3000);
    const title = clean((document.querySelector('h1, h2, .page-title') || {}).innerText || document.title || '');
    return { tables: tables.filter((t) => t.rows.length || t.head.length), text, title, url: location.href };
  }).catch(() => ({ tables: [], text: '', title: '', url: '' }));
}

async function statusRefresh(opts, emit) {
  const base = (opts && opts.base) || lastBase;
  if (!base || !page || page.isClosed()) {
    return { ok: false, message: 'লগইন সেশনটি বন্ধ হয়ে গেছে — আবার লগইন করুন', relogin: true };
  }
  const pg = page;
  scheduleIdleClose(); // রিফ্রেশ নিজেও সেশন জীবিত রাখে
  emit && emit('সর্বশেষ অবস্থা আবার আনা হচ্ছে…');
  await pg.goto(base + '/br/application/status', {
    waitUntil: 'domcontentloaded', timeout: 45000,
    referer: base + '/',
  }).catch(() => {});
  await pg.waitForTimeout(2000);
  if (/\/login/.test(pg.url())) {
    return { ok: false, message: 'সেশন শেষ হয়ে গেছে — আবার লগইন করুন', relogin: true };
  }
  const data = await scrapeStatus(pg);
  return { ok: true, ...data };
}

async function statusClose() {
  if (idleTimer) clearTimeout(idleTimer);
  try { if (ctx) await ctx.close(); } catch { /* ignore */ }
  ctx = null; page = null;
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  browser = null;
}

module.exports = { statusOpen, statusOtp, statusRefresh, statusClose };
