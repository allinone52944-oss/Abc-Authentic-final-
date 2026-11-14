// ============================================================
// Passport engine — server-side PDF rendering (2026-11-14).
//
// Create downloads a REAL PDF directly. The client POSTs the
// document-only HTML (snapshotHTML: the rendered #page-shell with
// scan artwork, data, MRZ, photo/signature as embedded data) to
// POST /api/passport/pdf, and this module renders it to a genuine
// 1-page A4 PDF in headless Chromium and returns the bytes.
//
// Why server-side (not a client-side library):
//   - Puppeteer is already a backend dependency and the codebase
//     already renders PDFs this way (engines/birth-final/
//     certificate-builder.js + server.js /generate-pdf): same
//     launch flags, same page.pdf({ preferCSSPageSize }) call,
//     same @page A4 pattern. No new install, no external CDN.
//   - The document is a fixed 792px scaled layer over scan
//     artwork with data: fonts/images — Chromium renders it
//     natively and exactly. A client-side rasterizer
//     (html2canvas) would re-rasterize it and can break the
//     layout and the Bengali fonts.
//   - The page CSP (connect-src 'self') already allows the
//     same-origin POST; no CSP change, no client bundle bloat
//     (the page is already ~9MB).
//
// Money: this module never charges and never creates orders —
// the /pdf route only renders after POST /create already charged
// and recorded the order. A failed render throws; the route
// turns it into a clear 500 and the frontend downloads NOTHING
// (no HTML fallback).
//
// Concurrency: renders are serialized through a module-level
// queue — one Chromium at a time — so parallel Creates cannot
// exhaust memory with parallel browsers.
// ============================================================
// NOTE: puppeteer is required LAZILY inside launchBrowser(), not at
// module load — puppeteer v25 is ESM-only, and a top-level require()
// breaks the backend Jest suite (CommonJS runtime) even for tests
// that never render. Plain Node 24 (production) supports require()
// of ESM, so the lazy require works there and in the browser check.
const { safeLog } = require('../security');

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-lcd-text',
  '--force-color-profile=srgb',
];

// Chromium candidates, in order. CHROME_PATH wins when set (same
// convention as engines/birth-final/server.js); otherwise Puppeteer's
// bundled Chromium; then the well-known system locations. The
// production server already runs Chromium for the BDRIS bot, so at
// least one candidate is expected to exist.
function chromeCandidates() {
  const list = [
    process.env.CHROME_PATH || '',
    '', // Puppeteer's bundled Chromium (executablePath omitted)
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/meta-chromium/chrome',
  ];
  const seen = new Set();
  return list.filter((p) => {
    const key = p || '<bundled>';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function launchBrowser() {
  // Lazy require (see the note at the top of this file): puppeteer
  // is ESM-only, so it is loaded only when a render actually runs.
  const puppeteer = require('puppeteer');
  let lastErr = null;
  for (const exe of chromeCandidates()) {
    try {
      const opts = { headless: true, args: LAUNCH_ARGS };
      if (exe) opts.executablePath = exe;
      return await puppeteer.launch(opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Chromium চালু করা যায়নি।');
}

// The snapshot HTML already carries an @page rule (594pt 841pt, A4)
// inside @media print. Only add one when the caller sent HTML
// without any @page rule, so the PDF is A4 even then.
function ensurePageRule(html) {
  if (html.indexOf('@page') >= 0) return html;
  const rule = '<style>@page{size:A4;margin:0}</style>';
  const headAt = html.indexOf('</head>');
  if (headAt >= 0) return html.slice(0, headAt) + rule + html.slice(headAt);
  return rule + html;
}

async function renderOnce(html) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // A4 at 96dpi — the document shell is 792px wide, so it fills
    // the page width exactly; the scaled layer is ~1121px tall
    // against a 1123px page, so it stays on one page.
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    // domcontentloaded, NOT networkidle0: the document is fully
    // self-contained (data: fonts/images), so there is no network to
    // go idle — networkidle0 can hang on a multi-MB page. Fonts and
    // images are waited for explicitly below instead.
    await page.setContent(ensurePageRule(html), { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Bengali fonts + images must be fully loaded before the PDF,
    // or the layout breaks (blank text, missing artwork/photo).
    // Bounded so a stuck font/image can delay the render at most
    // 30s, never hang it forever.
    await page.evaluate(async () => {
      const timeout = new Promise((resolve) => setTimeout(resolve, 30000));
      const ready = (async () => {
        if (document.fonts) await document.fonts.ready;
        const imgs = Array.from(document.querySelectorAll('img'));
        await Promise.all(imgs.map((img) => (
          (typeof img.decode === 'function' ? img.decode() : Promise.resolve()).catch(() => {})
        )));
      })();
      await Promise.race([ready, timeout]);
    });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}

// Serialize renders: one Chromium at a time.
let queue = Promise.resolve();
function renderPassportPdf(html) {
  if (!html || typeof html !== 'string' || html.length < 100 || html.indexOf('<') < 0) {
    return Promise.reject(new Error('পাসপোর্ট ডকুমেন্ট পাওয়া যায়নি।'));
  }
  const run = queue.then(() => renderOnce(html));
  // Keep the queue alive past a failure so later renders still run.
  queue = run.catch(() => {});
  return run;
}

module.exports = { renderPassportPdf, ensurePageRule };
