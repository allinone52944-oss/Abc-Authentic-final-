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
      username: user,
      createdAt: Date.now(), attempts: 0,
    });
    return { ok: true, sessionId: id, captcha };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: 'PORTAL_UNREACHABLE' };
  }
}

/**
 * Harvest [{section, label, value}] pairs from one document.
 * Serialised into page/frame evaluate calls, so it must not
 * close over module scope. The profile page is the ONLY data
 * source for a server copy: some accounts have no card
 * download at all, so mining the official PDF is not a
 * substitute for reading the profile properly.
 */
function harvestPairs() {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const pairs = [];
    const seen = new Set();
    // The portal prints placeholders for missing values ('--',
    // '-', 'N/A'). Treating one as data is worse than missing
    // data: a '--' National ID looked "present" and the server
    // copy printed '--' with a 'NID:--' QR.
    const PLACEHOLDERS = new Set(['--', '-', '—', '–', 'n/a', 'na', 'null', 'none']);
    const push = (section, label, value) => {
      label = clean(label);
      value = clean(value);
      if (!label || !value || label === value) return;
      if (PLACEHOLDERS.has(value.toLowerCase())) return;
      const key = label + '|' + value;
      if (seen.has(key)) return;
      seen.add(key);
      pairs.push({ section: clean(section), label, value });
    };
    // A value cell may carry the data in a readonly/disabled form
    // control instead of text — read the control's value then.
    const valueOf = (el) => {
      if (!el) return '';
      const ctl = el.querySelector ? el.querySelector('input, textarea, select') : null;
      if (ctl) {
        if (ctl.tagName === 'SELECT') {
          const opt = ctl.options && ctl.options[ctl.selectedIndex];
          return clean((opt && opt.text) || ctl.value);
        }
        return clean(ctl.value);
      }
      return clean(el.textContent);
    };
    const headingOf = (el) => {
      let node = el;
      for (let up = 0; up < 6 && node; up++) {
        node = node.parentElement;
        if (!node) break;
        const h = node.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > .card-header, :scope > legend, :scope > caption');
        if (h && clean(h.textContent)) return clean(h.textContent);
      }
      // The section title may be a preceding sibling block (the
      // portal prints address titles as standalone headers).
      let sib = el.previousElementSibling;
      for (let n = 0; n < 3 && sib; n++) {
        const t = clean(sib.textContent);
        if (t && t.length <= 60) return t;
        sib = sib.previousElementSibling;
      }
      return '';
    };
    document.querySelectorAll('table').forEach((tbl) => {
      let section = headingOf(tbl);
      if (tbl.caption && clean(tbl.caption.textContent)) section = clean(tbl.caption.textContent);
      tbl.querySelectorAll('tr').forEach((tr, idx) => {
        const cells = tr.querySelectorAll('th, td');
        // A lone first-row cell is the section title printed
        // inside the table, not a data row.
        if (idx === 0 && cells.length === 1) {
          const t = clean(cells[0].textContent);
          if (t && t.length <= 60) section = t;
          return;
        }
        if (cells.length >= 2) push(section, clean(cells[0].textContent), valueOf(cells[1]));
      });
    });
    document.querySelectorAll('dl').forEach((dl) => {
      const section = headingOf(dl);
      dl.querySelectorAll('dt').forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD') push(section, clean(dt.textContent), valueOf(dd));
      });
    });
    // Labelled form rows (Semantic UI .field and friends): a
    // <label> plus a sibling container holding the value control.
    document.querySelectorAll('.field, .form-group').forEach((row) => {
      const lab = row.querySelector(':scope > label, :scope > .label');
      if (!lab) return;
      const holder = row.querySelector(':scope > .input, :scope > div, :scope > span');
      if (holder && holder !== lab) push(headingOf(row), clean(lab.textContent), valueOf(holder));
    });
    // Last resort: "label: value" lines from the rendered text —
    // catches any layout the structural passes missed.
    const lines = String((document.body && document.body.innerText) || '').split('\n');
    for (const raw of lines) {
      const line = clean(raw);
      const m = line.match(/^([^:]{2,42})\s*[:：]\s*(.+)$/);
      if (m) push('', m[1], m[2]);
    }
    // Hidden form fields and page-embedded data: the identity
    // numbers sometimes live in hidden inputs or a script JSON
    // blob rather than visible table cells.
    document.querySelectorAll('input').forEach((inp) => {
      const nm = ((inp.name || '') + ' ' + (inp.id || '')).trim();
      if (nm && /nid|national|পরিচয়|pin|voter|ভোটার/i.test(nm)) {
        push('', nm, inp.value || '');
      }
    });
    document.querySelectorAll('script').forEach((sc) => {
      const txt = sc.textContent || '';
      const re = /["']?(nid|national[_-]?id|pin|voter[_-]?no)["']?\s*[:=]\s*["']?(\d[\d ]{9,16}\d)["']?/gi;
      let m;
      while ((m = re.exec(txt)) !== null) {
        push('', m[1], m[2]);
      }
    });
    return pairs;
}

/** Scrape pairs from one page or frame. */
async function scrapeProfilePairs(target) {
  return target.evaluate(harvestPairs).catch(() => []);
}

/**
 * Deep profile harvest: the main document, every frame, and
 * tab/accordion sections that only render after a click. The
 * identity section never appeared in the plain scrape of the
 * live profile page while personal/address sections did — so
 * it is either collapsed, tabbed, or framed.
 */
async function scrapeProfileDeep(page) {
  const seen = new Set();
  const merge = (into, more) => {
    for (const p of more || []) {
      const k = String(p.label || '') + '|' + String(p.value || '');
      if (!seen.has(k)) { seen.add(k); into.push(p); }
    }
  };
  const pairs = [];
  merge(pairs, await scrapeProfilePairs(page));
  let frames = 0;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    frames += 1;
    merge(pairs, await scrapeProfilePairs(frame));
  }
  let tabsClicked = 0;
  try {
    tabsClicked = await page.evaluate(() => {
      const KEY = /পরিচিতি|জাতীয়|ভোটার|পিন|তথ্য|প্রোফাইল|profile|identity|details/i;
      let n = 0;
      document.querySelectorAll('button, [role="tab"], .tab, .accordion-title, [data-toggle="tab"], [data-toggle="collapse"], h2, h3, h4, .card-header, .panel-heading, [aria-expanded], a').forEach((el) => {
        // Never follow a real link away from the profile page:
        // only in-page tab/accordion controls may be clicked.
        if (el.tagName === 'A') {
          const href = (el.getAttribute('href') || '').trim();
          if (href && !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:')) return;
        }
        const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 60 && KEY.test(t)) {
          try { el.click(); n += 1; } catch (_) { /* ignore */ }
        }
      });
      return n;
    }).catch(() => 0);
  } catch (_) { /* ignore */ }
  if (tabsClicked > 0) {
    await page.waitForTimeout(1200);
    merge(pairs, await scrapeProfilePairs(page));
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      merge(pairs, await scrapeProfilePairs(frame));
    }
  }
  return { pairs, frames, tabsClicked };
}

/** Find and fetch the citizen photo shown on the dashboard. */
async function fetchDashboardPhoto(page, context) {
  // Let in-flight images finish — a photo <img> that has not
  // loaded yet reports naturalWidth 0 and used to be skipped.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  const info = await page.evaluate(() => {
    const out = [];
    const skip = /logo|icon|flag|emblem|banner|sprite|loading/i;
    document.querySelectorAll('img').forEach((im) => {
      const src = im.currentSrc || im.src || '';
      if (!src) return;
      const tag = (src.slice(0, 200) + ' ' + (im.alt || '') + ' ' + (im.className || '')).toString();
      if (skip.test(tag) && !/photo|citizen|nid/i.test(tag)) return;
      let chrome = false;
      let anc = im.parentElement;
      while (anc) {
        if (/^(HEADER|NAV|FOOTER)$/.test(anc.tagName)) { chrome = true; break; }
        anc = anc.parentElement;
      }
      const rect = im.getBoundingClientRect ? im.getBoundingClientRect() : null;
      const item = {
        nw: im.naturalWidth || 0,
        nh: im.naturalHeight || 0,
        rw: im.clientWidth || 0,
        rh: im.clientHeight || 0,
        alt: im.alt || '',
        cls: (im.className && im.className.toString ? im.className.toString() : '') + ' ' + (im.id || ''),
        top: rect ? Math.round(rect.top + (window.scrollY || 0)) : 0,
        chrome,
      };
      if (src.startsWith('data:')) {
        const comma = src.indexOf(',');
        if (comma > 0) { item.kind = 'data'; item.data = src.slice(comma + 1); }
      } else {
        item.kind = 'url';
        item.src = src;
      }
      if (item.kind) out.push(item);
    });
    // The photo may be a CSS background on a portrait box rather
    // than an <img> at all.
    document.querySelectorAll('div, span, a, td').forEach((el) => {
      const cs = window.getComputedStyle ? getComputedStyle(el) : null;
      const bg = cs && cs.backgroundImage;
      if (!bg || bg === 'none') return;
      const m = /url\(["']?(https?:[^"')]+)["']?\)/.exec(bg);
      if (!m || skip.test(m[1])) return;
      const w = el.clientWidth || 0;
      const h = el.clientHeight || 0;
      if (w >= 30 && h >= 30 && h >= w * 0.8) {
        out.push({ kind: 'url', src: m[1], nw: w * 2, nh: h * 2, rw: w, rh: h, bg: true });
      }
    });
    return out;
  }).catch(() => []);

  const isImage = (buf) => buf && buf.length > 1200 &&
    ((buf[0] === 0xff && buf[1] === 0xd8) || // JPEG
     (buf[0] === 0x89 && buf[1] === 0x50) || // PNG
     (buf[0] === 0x52 && buf[1] === 0x49));  // WEBP (RIFF)
  const tryCandidate = async (c) => {
    try {
      if (c.kind === 'data') {
        const body = Buffer.from(c.data, 'base64');
        if (isImage(body)) return { buffer: body, width: c.nw, height: c.nh };
        return null;
      }
      const resp = await context.request.get(c.src, { timeout: 20000 }).catch(() => null);
      if (resp && resp.ok()) {
        const body = await resp.body();
        if (isImage(body)) return { buffer: body, width: c.nw, height: c.nh };
      }
      // Retry from inside the page (carries the page's own
      // headers/cookies if the bare request was refused).
      const b64 = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include' });
          if (!r.ok) return '';
          const buf = await r.arrayBuffer();
          let bin = '';
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i += 8192) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
          }
          return btoa(bin);
        } catch (_) { return ''; }
      }, c.src).catch(() => '');
      if (b64) {
        const body = Buffer.from(b64, 'base64');
        if (isImage(body)) return { buffer: body, width: c.nw, height: c.nh };
      }
    } catch (_) { /* try next candidate */ }
    return null;
  };
  // Tier 1: an image that LOOKS like a citizen photo
  // (photo/citizen/profile in its URL, alt or class, or an
  // inline data: image). A bare size sort once picked the EC
  // emblem (1200x1200, no 'logo' hint in its URL) over the
  // real thumbnail — generic images are never accepted on
  // size alone anymore.
  const hinted = (i) => /photo|citizen|profile|picture|avatar|user/i.test(
    (i.src || '') + ' ' + (i.alt || '') + ' ' + (i.cls || ''));
  const tier1 = (info || [])
    .filter((i) => (i.kind === 'data' ? true : i.nw >= 30 && i.nh >= 30))
    .filter((i) => i.kind === 'data' || hinted(i))
    .sort((a, b) => {
      const portrait = (i) => (i.nh >= i.nw ? 1 : 0);
      if (portrait(a) !== portrait(b)) return portrait(b) - portrait(a);
      return (b.nw * b.nh) - (a.nw * a.nh);
    });
  for (const c of tier1.slice(0, 4)) {
    const hit = await tryCandidate(c);
    if (hit) return hit;
  }
  // Tier 2 (last resort before a blank slot): a portrait image
  // sitting in the page's content area — not the header/footer
  // strip, not square like the emblem, moderate natural size.
  // The portal's citizen photo does not always carry a hint
  // in its URL, and a blank photo box is worse than a
  // well-filtered guess.
  const tier2 = (info || [])
    .filter((i) => i.kind === 'url' && !i.chrome && typeof i.top === 'number' && i.top >= 100)
    .filter((i) => i.nh >= i.nw * 1.1 && i.nw >= 80 && i.nw <= 900)
    .sort((a, b) => (b.nw * b.nh) - (a.nw * a.nh));
  for (const c of tier2.slice(0, 3)) {
    const hit = await tryCandidate(c);
    if (hit) return hit;
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
    let photo = await fetchDashboardPhoto(page, context);
    const dashPairs = await scrapeProfilePairs(page);
    await page.goto(BASE + '/citizen-home/profile', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    // Sections of this page render progressively — wait for the
    // network to settle and scroll through, or the first
    // (identity) section can still be empty at scrape time.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1200);
    // Deep harvest: plain scraping never surfaced the identity
    // section on the live profile page, so also read frames and
    // expand tabbed/collapsed sections.
    let deep = await scrapeProfileDeep(page);
    let profilePairs = deep.pairs;
    if (profilePairs.length < 5) {
      // The profile may live behind a menu link rather than the
      // canonical URL — follow whatever profile link exists.
      const href = await page.evaluate(() => {
        const a = document.querySelector('a[href*="profile" i]');
        return a ? a.href : '';
      }).catch(() => '');
      if (href && !page.url().includes(href)) {
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
        await page.waitForTimeout(800);
        deep = await scrapeProfileDeep(page);
        if (deep.pairs.length > profilePairs.length) profilePairs = deep.pairs;
      }
    }
    // Thin scrape (live 06:47 job: only 5 pairs, no name, no
    // tabs clicked) — the main content may render late or
    // behind section headers the first pass missed. Wait,
    // scroll and re-harvest twice before giving up.
    for (let attempt = 0; attempt < 2 && profilePairs.length < 10; attempt++) {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(2500);
      const again = await scrapeProfileDeep(page);
      if (again.pairs.length > profilePairs.length) {
        profilePairs = again.pairs;
        deep = again;
      }
    }
    if (!photo) photo = await fetchDashboardPhoto(page, context);
    // Profile pairs first: buildInputData keeps the first value
    // per field, and the profile page is the authoritative source.
    const seenPair = new Set();
    const pairs = [];
    for (const p of [...profilePairs, ...dashPairs]) {
      const k = String(p.label || '') + '|' + String(p.value || '');
      if (!seenPair.has(k)) { seenPair.add(k); pairs.push(p); }
    }
    await page.goto(BASE + '/citizen-home/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    // The official PDF is delivered as-is when the portal
    // offers a download — it is NEVER mined for data: some
    // accounts have no download at all, so the profile page is
    // the only data source. (Owner's correction, 2026-10-24.)
    const downloadPdf = await tryOfficialDownload(page);

    // Diagnostics only: label names, never values.
    try {
      const { buildInputData, hasCoreData } = require('./profile-map');
      const mapped = buildInputData(pairs);
      console.warn('[nid-server-copy] job data: pairs=' + pairs.length,
        'page=' + page.url(),
        'photo=' + Boolean(photo && photo.buffer),
        'frames=' + deep.frames, 'tabs=' + deep.tabsClicked,
        'core=' + hasCoreData(mapped),
        'name=' + Boolean(mapped['Name(Bangla)'] || mapped['Name(English)']),
        'nid=' + Boolean(mapped['National ID'] || mapped['Pin']),
        'dob=' + Boolean(mapped['Date of Birth']),
        'labels=' + pairs.map((p) => p.label).slice(0, 60).join('|').slice(0, 2000));
    } catch (_) { /* diagnostics only */ }

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

module.exports = { init, getInfo, startSession, submitCaptcha, closeSession, getJob, BASE, waitForLoginForm, captureCaptcha, scrapeProfilePairs, scrapeProfileDeep, fetchDashboardPhoto };
