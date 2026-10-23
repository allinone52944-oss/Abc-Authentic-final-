'use strict';
/**
 * engines/nid-server-copy/portal.js — NID portal (nid-pub) driver.
 *
 * Interactive login against https://services.nidw.gov.bd/nid-pub/ :
 *   startSession(ownerId, username, password)
 *     -> opens the portal login, fills ID + password, returns the
 *        captcha image for the customer to read.
 *   submitCaptcha(sessionId, ownerId, captchaText)
 *     -> submits; on success scrapes the citizen profile (label /
 *        value pairs), the dashboard photo, and tries the official
 *        card download. On failure returns a fresh captcha.
 *
 * The customer's portal password is typed straight into the portal
 * form and is NEVER stored, logged or returned. Sessions are bound
 * to the owning user, capped at 3 captcha attempts and expire after
 * 10 minutes. The browser is closed as soon as data is collected.
 */

const crypto = require('crypto');

const BASE = process.env.NIDW_BASE || 'https://services.nidw.gov.bd/nid-pub';
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const NAV_TIMEOUT = 60000;

const sessions = new Map();

// Collected jobs: after a successful login the scraped profile,
// photo and official download (when present) are kept under a
// job id so the customer can choose what to download — the NID
// card, the server copy, or both. Owner-bound, 30-minute TTL.
const JOB_TTL_MS = 30 * 60 * 1000;
const jobs = new Map();

function sweepJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}
const jobSweeper = setInterval(sweepJobs, 60 * 1000);
if (jobSweeper.unref) jobSweeper.unref();

function getJob(jobId, ownerId) {
  sweepJobs();
  const j = jobs.get(String(jobId || ''));
  if (!j) return null;
  if (String(j.ownerId) !== String(ownerId)) return null;
  return j;
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    // Same server also runs the BDRIS engine, which bundles
    // Playwright — reuse its install until this engine's own
    // node_modules are present.
    return require('../bdris-apply/node_modules/playwright');
  }
}

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      closeSession(id).catch(() => {});
    }
  }
}
const sweeper = setInterval(sweep, 60 * 1000);
if (sweeper.unref) sweeper.unref();

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { await s.browser.close(); } catch (_) { /* already gone */ }
}

function getOwnedSession(id, ownerId) {
  const s = sessions.get(String(id || ''));
  if (!s) return null;
  if (String(s.ownerId) !== String(ownerId)) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    closeSession(id).catch(() => {});
    return null;
  }
  return s;
}

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 1200 })) return loc;
    } catch (_) { /* try next */ }
  }
  return null;
}

async function captureCaptcha(page) {
  const img = await firstVisible(page, ['#captcha-image', 'img[src*="captcha" i]', 'img[id*="captcha" i]']);
  if (!img) return null;
  // The captcha image is populated by the portal's JS after the
  // form renders — wait until it actually carries pixels before
  // screenshotting, otherwise the customer gets a blank box.
  await page.waitForFunction(() => {
    const el = document.querySelector('#captcha-image, img[src*="captcha" i], img[id*="captcha" i]');
    return !!el && el.complete && el.naturalWidth > 0;
  }, { timeout: 15000 }).catch(() => {});
  const buf = await img.screenshot();
  return 'data:image/png;base64,' + buf.toString('base64');
}

/** Diagnostics for when the portal does not behave as expected. */
async function pageSnapshot(page) {
  try {
    const data = await page.evaluate(() => {
      const inputs = [];
      document.querySelectorAll('input').forEach((i) => {
        inputs.push((i.getAttribute('name') || i.id || i.type || '?') + ':' + (i.offsetParent ? 'v' : 'h'));
      });
      return { title: document.title || '', inputs: inputs.slice(0, 20) };
    });
    return { url: page.url(), title: data.title, inputs: data.inputs };
  } catch (_) {
    return { url: page.url(), title: '', inputs: [] };
  }
}

/**
 * The portal's login form is rendered by its own JavaScript
 * (ajax-login.js) some time AFTER domcontentloaded — the raw HTML
 * shell contains only the captcha input. Wait for the username
 * field to actually appear; if an announcement overlay or a
 * login gate stands in the way, clear it and keep waiting.
 */
async function waitForLoginForm(page) {
  const USER_SEL = 'input[name="username"], #username';
  try {
    await page.waitForSelector(USER_SEL, { state: 'visible', timeout: 20000 });
    return true;
  } catch (_) { /* form not rendered yet — try clearing gates */ }

  // Announcement / notice overlay (the portal shows one often).
  const closer = await firstVisible(page, ['#close-announcement', '.announcement .close', '[class*="notice"] .close', '[class*="notice"] button']);
  if (closer) {
    await closer.click().catch(() => {});
    await page.waitForTimeout(800);
  }
  // A login link/tab that reveals the form.
  const gate = await firstVisible(page, ['a[href*="login" i]', 'button:has-text("লগইন")', 'a:has-text("লগইন")', 'button:has-text("Login")', 'a:has-text("Login")']);
  if (gate) {
    await gate.click().catch(() => {});
    await page.waitForTimeout(800);
  }
  try {
    await page.waitForSelector(USER_SEL, { state: 'visible', timeout: 20000 });
    return true;
  } catch (_) {
    return false;
  }
}

async function refreshCaptcha(page) {
  const btn = await firstVisible(page, ['#reload-captcha', 'button[onclick*="captcha" i]', 'a[onclick*="captcha" i]']);
  if (btn) {
    try { await btn.click(); await page.waitForTimeout(900); } catch (_) { /* fall through */ }
  }
  return captureCaptcha(page);
}

async function startSession(ownerId, username, password) {
  const user = String(username || '').trim();
  const pass = String(password || '');
  if (!user || !pass) return { ok: false, error: 'MISSING_CREDENTIALS' };

  sweep();
  let browser = null;
  try {
    const { chromium } = loadPlaywright();
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
    });
    const context = await browser.newContext({
      acceptDownloads: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      locale: 'bn-BD',
    });
    const page = await context.newPage();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    const formReady = await waitForLoginForm(page);
    const userField = formReady ? await firstVisible(page, ['input[name="username"]', '#username', 'input[type="text"]']) : null;
    const passField = formReady ? await firstVisible(page, ['input[name="password"]', '#password', 'input[type="password"]']) : null;
    if (!userField || !passField) {
      console.warn('[nid-server-copy] login form not found:', JSON.stringify(await pageSnapshot(page)));
      await browser.close().catch(() => {});
      return { ok: false, error: 'PORTAL_CHANGED' };
    }
    await userField.fill(user);
    await passField.fill(pass);

    const captcha = await captureCaptcha(page);
    if (!captcha) {
      await browser.close().catch(() => {});
      return { ok: false, error: 'CAPTCHA_NOT_FOUND' };
    }

    const id = crypto.randomUUID();
    sessions.set(id, {
      id, ownerId, browser, context, page,
      createdAt: Date.now(), attempts: 0,
    });
    return { ok: true, sessionId: id, captcha };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: 'PORTAL_UNREACHABLE' };
  }
}

/** Scrape [{section, label, value}] pairs from the profile page. */
async function scrapeProfilePairs(page) {
  return page.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const pairs = [];
    const headingOf = (el) => {
      let node = el;
      for (let up = 0; up < 6 && node; up++) {
        node = node.parentElement;
        if (!node) break;
        const h = node.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > .card-header, :scope > legend, :scope > caption');
        if (h && clean(h.textContent)) return clean(h.textContent);
      }
      return '';
    };
    document.querySelectorAll('table').forEach((tbl) => {
      const section = headingOf(tbl);
      tbl.querySelectorAll('tr').forEach((tr) => {
        const cells = tr.querySelectorAll('th, td');
        if (cells.length >= 2) {
          const label = clean(cells[0].textContent);
          const value = clean(cells[1].textContent);
          if (label && value && label !== value) pairs.push({ section, label, value });
        }
      });
    });
    document.querySelectorAll('dl').forEach((dl) => {
      const section = headingOf(dl);
      const dts = dl.querySelectorAll('dt');
      dts.forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD') {
          const label = clean(dt.textContent);
          const value = clean(dd.textContent);
          if (label && value) pairs.push({ section, label, value });
        }
      });
    });
    return pairs;
  }).catch(() => []);
}

/** Find and fetch the citizen photo shown on the dashboard. */
async function fetchDashboardPhoto(page, context) {
  const info = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('img').forEach((im) => {
      const src = im.currentSrc || im.src || '';
      if (!src || src.startsWith('data:')) return;
      out.push({
        src,
        nw: im.naturalWidth || 0,
        nh: im.naturalHeight || 0,
        rw: im.clientWidth || 0,
        rh: im.clientHeight || 0,
      });
    });
    return out;
  }).catch(() => []);

  const candidates = (info || [])
    .filter((i) => i.nw >= 80 && i.nh >= 80 && !/logo|icon|flag|emblem/i.test(i.src))
    .sort((a, b) => {
      const portrait = (i) => (i.nh > i.nw ? 1 : 0);
      if (portrait(a) !== portrait(b)) return portrait(b) - portrait(a);
      return (b.nw * b.nh) - (a.nw * a.nh);
    });
  for (const c of candidates.slice(0, 3)) {
    try {
      const resp = await context.request.get(c.src, { timeout: 20000 });
      if (resp.ok()) {
        const body = await resp.body();
        if (body && body.length > 2000) {
          return { buffer: body, width: c.nw, height: c.nh };
        }
      }
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

/** Try the official card download; returns a PDF Buffer or null. */
async function tryOfficialDownload(page) {
  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await page.goto(BASE + '/citizen-home/nid/download', { waitUntil: 'commit', timeout: NAV_TIMEOUT }).catch(() => {});
    const download = await downloadPromise;
    if (!download) return null;
    const filePath = await download.path().catch(() => null);
    if (!filePath) return null;
    const fs = require('fs');
    const buf = fs.readFileSync(filePath);
    if (buf && buf.length > 1000 && buf.slice(0, 5).toString('ascii') === '%PDF-') return buf;
    return null;
  } catch (_) {
    return null;
  }
}

async function submitCaptcha(sessionId, ownerId, captchaText) {
  const s = getOwnedSession(sessionId, ownerId);
  if (!s) return { ok: false, error: 'SESSION_EXPIRED' };
  const text = String(captchaText || '').trim();
  if (!text) return { ok: false, error: 'CAPTCHA_REQUIRED', retry: true };

  s.attempts += 1;
  const { page, context } = s;
  try {
    await page.waitForSelector('input[name="captcha"], #captcha', { state: 'visible', timeout: 10000 }).catch(() => {});
    const capField = await firstVisible(page, ['input[name="captcha"]', '#captcha', 'input[placeholder*="captcha" i]']);
    if (!capField) {
      console.warn('[nid-server-copy] captcha field not found:', JSON.stringify(await pageSnapshot(page)));
      await closeSession(s.id);
      return { ok: false, error: 'PORTAL_CHANGED' };
    }
    await capField.fill(text);

    const submit = await firstVisible(page, [
      'button[type="submit"]', 'input[type="submit"]',
      'button:has-text("Login")', 'button:has-text("লগইন")', 'button:has-text("প্রবেশ")',
    ]);
    if (submit) await submit.click();
    else await capField.press('Enter');

    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const url = page.url();
    if (!url.includes('citizen-home')) {
      // Still on the login page — wrong captcha or credentials.
      let message = '';
      try {
        message = await page.evaluate(() => {
          const el = document.querySelector('.alert, .error, .alert-danger, [class*="error"]');
          return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
        });
      } catch (_) { /* ignore */ }
      if (s.attempts >= MAX_ATTEMPTS) {
        await closeSession(s.id);
        return { ok: false, error: 'LOGIN_FAILED', message, final: true };
      }
      const captcha = await refreshCaptcha(page);
      return { ok: false, error: 'LOGIN_FAILED', message, captcha, retry: true };
    }

    // Logged in. Collect everything, then close the browser and
    // keep the data as a job — the customer picks what to
    // download (NID card and/or server copy) from here.
    const photo = await fetchDashboardPhoto(page, context);
    await page.goto(BASE + '/citizen-home/profile', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(800);
    const pairs = await scrapeProfilePairs(page);
    await page.goto(BASE + '/citizen-home/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    const downloadPdf = await tryOfficialDownload(page);

    await closeSession(s.id);

    const jobId = crypto.randomUUID();
    jobs.set(jobId, {
      id: jobId, ownerId: s.ownerId, pairs, photo, downloadPdf,
      createdAt: Date.now(),
    });
    let holderName = '';
    for (const p of pairs || []) {
      const lbl = String((p && p.label) || '').toLowerCase();
      if (lbl === 'name' || lbl.includes('name (english)') || lbl.includes('নাম (ইংরেজি)')) {
        holderName = String(p.value || '').trim();
        if (holderName) break;
      }
    }
    return { ok: true, jobId, hasDownload: !!downloadPdf, holderName };
  } catch (e) {
    await closeSession(s.id);
    return { ok: false, error: 'PORTAL_ERROR' };
  }
}

function getInfo() {
  return {
    id: 'nid-server-copy',
    name: 'NID Server Copy',
    name_bn: 'এনআইডি সার্ভার কপি',
    version: '1.0.0',
    capabilities: ['portal-login', 'captcha-relay', 'card-pdf'],
    mode: 'interactive-portal',
    input: { credentials: 'customer NID portal ID + password (never stored)', captcha: 'image captcha relay' },
  };
}

function init() {
  try {
    loadPlaywright();
    return { ok: true };
  } catch (e) {
    console.warn('[nid-server-copy] playwright not available:', e.message);
    return { ok: false, error: 'PLAYWRIGHT_MISSING' };
  }
}

module.exports = { init, getInfo, startSession, submitCaptcha, closeSession, getJob, BASE, waitForLoginForm, captureCaptcha };
