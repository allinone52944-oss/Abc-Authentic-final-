// captcha-solve2.js — production captcha candidate generator (two complementary sources):
//  A) sliding-DP k-best (DejaVu bold templates, start-anchored, wide beams) — windowFeat pipeline
//  B) segmented per-glyph font-template classification (cutSegments + glyphFeat) — product candidates
// candidatesFromGray(gray,w,h) -> ranked unique strings (union, interleaved).
// CLI: node captcha-solve2.js build   -> renders font templates into font-templates-dejavu.json
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./captcha-core.js');

const TMPL_FILE = path.join(__dirname, 'font-templates-dejavu.json');
const CHARSET_BASE = '235678bcdefghkmnprstvwxy';
const SIZE = 20;

function l2f(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s / a.length;
}

function windowFeat(mask, w, h, x0, x1, size) {
  let minY = h, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
    if (mask[y * w + x]) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxY < 0) return { feat: new Float32Array(size * size), empty: true };
  const bx = Math.max(0, x0), bxe = Math.min(w - 1, x1);
  const bw = x1 - x0 + 1, bh = maxY - minY + 1;
  const feat = new Float32Array(size * size);
  for (let ty = 0; ty < size; ty++) {
    const sy = minY + (ty + 0.5) * bh / size - 0.5;
    const y1 = Math.max(minY, Math.min(maxY, Math.floor(sy)));
    const y2 = Math.max(minY, Math.min(maxY, y1 + 1));
    const fy = Math.max(0, Math.min(1, sy - y1));
    for (let tx = 0; tx < size; tx++) {
      const sx = bx + (tx + 0.5) * bw / size - 0.5;
      const x1c = Math.max(bx, Math.min(bxe, Math.floor(sx)));
      const x2c = Math.max(bx, Math.min(bxe, x1c + 1));
      const fx = Math.max(0, Math.min(1, sx - x1c));
      const g = (xx, yy) => (xx >= bx && xx <= bxe) ? mask[yy * w + xx] : 0;
      const g11 = g(x1c, y1), g21 = g(x2c, y1), g12 = g(x1c, y2), g22 = g(x2c, y2);
      feat[ty * size + tx] = (g11 * (1 - fx) + g21 * fx) * (1 - fy) + (g12 * (1 - fx) + g22 * fx) * fy;
    }
  }
  return { feat, empty: false };
}

function loadTemplates() {
  return JSON.parse(fs.readFileSync(TMPL_FILE, 'utf8'));
}

// ---------- source A: sliding-DP k-best ----------
function kbestDP(mask, w, h, fontChars, chars, opts) {
  const T = (opts && opts.T) || 12;
  const KMAX = (opts && opts.KMAX) || 26;
  const bbox = C.textBBox(mask, w, h);
  if (!bbox) return [];
  const x0 = bbox.minX, x1 = bbox.maxX;
  const cost = {}; const widthUse = {};
  for (const ch of chars) {
    const tmpl = fontChars[ch];
    const wc = tmpl.w;
    cost[ch] = new Float64Array(w + 1).fill(1e9);
    widthUse[ch] = new Int32Array(w + 1).fill(wc);
    for (let x = x0; x <= x1 - 8; x++) {
      let best = 1e9, bw = wc;
      for (let dw = -3; dw <= 3; dw++) {
        const ww = wc + dw;
        if (ww < 8 || x + ww - 1 > x1 + 2) continue;
        const wf = windowFeat(mask, w, h, x, x + ww - 1, SIZE);
        if (wf.empty) continue;
        const d = l2f(wf.feat, tmpl.feat);
        if (d < best) { best = d; bw = ww; }
      }
      cost[ch][x] = best; widthUse[ch][x] = bw;
    }
  }
  let beams = new Array(w + 3).fill(null).map(() => []);
  for (const ch of chars) {
    const cst = cost[ch][x0];
    if (cst >= 1e9) continue;
    beams[x0].push({ cost: cst, ch, parent: null });
  }
  beams[x0].sort((a, b) => a.cost - b.cost);
  if (beams[x0].length > T) beams[x0].length = T;
  const levels = [beams];
  for (let k = 2; k <= 7; k++) {
    const prev = levels[k - 2];
    const ndp = new Array(w + 3).fill(null).map(() => []);
    for (let x = x0; x <= x1; x++) {
      const entries = prev[x];
      if (!entries.length) continue;
      const x2max = Math.min(x1, x + 40);
      for (let x2 = x + 6; x2 <= x2max; x2++) {
        const bucket = ndp[x2];
        for (const chNext of chars) {
          const cst = cost[chNext][x2];
          if (cst >= 1e9) continue;
          for (const e of entries) bucket.push({ cost: e.cost + cst, ch: chNext, parent: e });
        }
      }
    }
    for (let x = x0; x <= x1; x++) {
      if (ndp[x].length > 1) { ndp[x].sort((a, b) => a.cost - b.cost); if (ndp[x].length > T) ndp[x].length = T; }
    }
    levels.push(ndp);
  }
  const all = [];
  for (const n of [5, 6, 7]) {
    const dp = levels[n - 1];
    for (let x = x0; x <= x1; x++) {
      for (const e of dp[x]) {
        const cover = (x + widthUse[e.ch][x] - 1) - x1;
        if (cover < -12 || cover > 3) continue;
        const str = [];
        let cur = e;
        while (cur) { str.unshift(cur.ch); cur = cur.parent; }
        if (str.length !== n) continue;
        all.push({ s: str.join(''), norm: e.cost / n });
      }
    }
  }
  all.sort((a, b) => a.norm - b.norm);
  const seen = new Set(); const out = [];
  for (const a of all) { if (!seen.has(a.s)) { seen.add(a.s); out.push(a.s); if (out.length >= KMAX) break; } }
  return out;
}

// ---------- source B: segmented per-glyph product ----------
function segFontProduct(mask, w, h, n, fontChars, chars, Kp, KMAX) {
  const bbox = C.textBBox(mask, w, h);
  if (!bbox) return { cands: [], avgBest: 1e9 };
  const segs = C.cutSegments(mask, w, h, bbox, n);
  if (segs.length !== n) return { cands: [], avgBest: 1e9 };
  const perPos = segs.map((sg) => {
    const gf = C.glyphFeat(mask, w, h, sg, SIZE);
    const scored = chars.map((ch) => ({ ch, d: l2f(gf.feat, fontChars[ch].feat) }));
    scored.sort((a, b) => a.d - b.d);
    return scored;
  });
  const out = [];
  const rec = (k, str, sum) => {
    if (out.length > 20000) return;
    if (k === n) { out.push({ s: str, sum }); return; }
    for (let i = 0; i < Kp && i < perPos[k].length; i++) rec(k + 1, str + perPos[k][i].ch, sum + perPos[k][i].d);
  };
  rec(0, '', 0);
  out.sort((a, b) => a.sum - b.sum);
  const seen = new Set(); const cands = [];
  for (const c of out) { if (!seen.has(c.s)) { seen.add(c.s); cands.push(c.s); if (cands.length >= KMAX) break; } }
  const avgBest = perPos.reduce((s, p) => s + p[0].d, 0) / n;
  return { cands, avgBest };
}

// ---------- union ----------
function candidatesFromGray(gray, w, h, tmpl, opts) {
  const o = opts || {};
  const chars = Object.keys(tmpl.glyphs);
  const mask = (() => {
    const m = C.inkMask(gray, w, h, {});
    const lr = C.removeStrikeLine(m, w, h, {});
    C.cleanSpecks(lr.mask, w, h, 8);
    return lr.mask;
  })();
  const Kp = o.Kp || 3;
  const s5 = segFontProduct(mask, w, h, 5, tmpl.glyphs, chars, Kp, 24);
  const s6 = segFontProduct(mask, w, h, 6, tmpl.glyphs, chars, Kp, 16);
  const dp = kbestDP(mask, w, h, tmpl.glyphs, chars, { T: o.T || 12, KMAX: o.KMAX_DP || 24 });
  const list = [];
  const push = (s) => { if (s && !list.includes(s)) list.push(s); };
  // confidence-first seeds
  if (s5.cands[0]) push(s5.cands[0]);
  if (dp[0]) push(dp[0]);
  if (s6.avgBest < s5.avgBest * 0.9 && s6.cands[0]) push(s6.cands[0]);
  // interleave seg-font(5) and DP
  const maxLen = Math.max(s5.cands.length, dp.length);
  for (let i = 1; i < maxLen; i++) {
    if (s5.cands[i]) push(s5.cands[i]);
    if (dp[i]) push(dp[i]);
  }
  // 6-glyph candidates last (only when they look plausible), then the rest
  if (s6.avgBest < s5.avgBest * 0.95) for (const s of s6.cands) push(s);
  return { list: list.slice(0, o.cap || 36), s5, s6, dp };
}

// ---------- font template build (run once) ----------
async function buildTemplates() {
  const { chromium } = require('playwright');
  const real = C.loadReal();
  const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'gt-cuts.json'), 'utf8'));
  const CHARSET = CHARSET_BASE.split('');
  for (const s of real) for (const ch of s.label) if (!CHARSET.includes(ch)) CHARSET.push(ch);
  // digit median ink height from GT cuts
  let digitH = [];
  for (const s of real) {
    const m = C.inkMask(s.gray, s.w, s.h, {});
    const lr = C.removeStrikeLine(m, s.w, s.h, {});
    C.cleanSpecks(lr.mask, s.w, s.h, 8);
    const mask = lr.mask;
    const cuts = gt[String(s.i)];
    const bbox = C.textBBox(mask, s.w, s.h);
    const segs = []; let xs = bbox.minX;
    for (const c of cuts) { segs.push({ x0: xs, x1: c }); xs = c + 1; }
    segs.push({ x0: xs, x1: bbox.maxX });
    const charsArr = s.label.split('');
    segs.forEach((sg, k) => {
      if ('235678'.includes(charsArr[k])) {
        let minY = s.h, maxY = -1;
        for (let y = 0; y < s.h; y++) for (let x = sg.x0; x <= sg.x1; x++) if (mask[y * s.w + x]) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
        if (maxY > 0) digitH.push(maxY - minY + 1);
      }
    });
  }
  digitH.sort((a, b) => a - b);
  const targetH = digitH[Math.floor(digitH.length / 2)];
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 300 } });
  const ttf = fs.readFileSync(path.join(__dirname, 'dejavu-tmp', 'dejavu-fonts-ttf-2.37', 'ttf', 'DejaVuSans-Bold.ttf'));
  await page.setContent('<style>@font-face{font-family:"DejaVu Captcha";src:url(data:font/ttf;base64,' + ttf.toString('base64') + ') format("truetype");}</style>');
  const glyphs = await page.evaluate(async ({ CHARSET, targetH }) => {
    await document.fonts.load('bold 60px "DejaVu Captcha"');
    let S = 60;
    for (let iter = 0; iter < 3; iter++) {
      const cv = document.createElement('canvas'); cv.width = 200; cv.height = 200;
      const cx = cv.getContext('2d');
      cx.font = 'bold ' + S + 'px "DejaVu Captcha"';
      cx.fillStyle = '#000'; cx.fillText('8', 20, 150);
      const d = cx.getImageData(0, 0, 200, 200).data;
      let minY = 200, maxY = -1;
      for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) if (d[(y * 200 + x) * 4 + 3] > 128) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
      S = Math.round(S * targetH / (maxY - minY + 1));
    }
    const out = {};
    for (const ch of CHARSET) {
      const cv = document.createElement('canvas'); cv.width = 120; cv.height = 120;
      const cx = cv.getContext('2d');
      cx.font = 'bold ' + S + 'px "DejaVu Captcha"';
      cx.fillStyle = '#000'; cx.textBaseline = 'alphabetic';
      cx.fillText(ch, 30, 90);
      const d = cx.getImageData(0, 0, 120, 120).data;
      let minX = 120, maxX = -1, minY = 120, maxY = -1;
      for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) if (d[(y * 120 + x) * 4 + 3] > 128) {
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const mask = new Float32Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) mask[y * bw + x] = d[((y + minY) * 120 + (x + minX)) * 4 + 3] / 255;
      const feat = new Float32Array(400);
      for (let ty = 0; ty < 20; ty++) for (let tx = 0; tx < 20; tx++) {
        const sy = (ty + 0.5) * bh / 20 - 0.5, sx = (tx + 0.5) * bw / 20 - 0.5;
        const y1 = Math.max(0, Math.min(bh - 1, Math.floor(sy))), y2 = Math.max(0, Math.min(bh - 1, y1 + 1));
        const x1 = Math.max(0, Math.min(bw - 1, Math.floor(sx))), x2 = Math.max(0, Math.min(bw - 1, x1 + 1));
        const fy = Math.max(0, Math.min(1, sy - y1)), fx = Math.max(0, Math.min(1, sx - x1));
        const g11 = mask[y1 * bw + x1], g21 = mask[y1 * bw + x2], g12 = mask[y2 * bw + x1], g22 = mask[y2 * bw + x2];
        feat[ty * 20 + tx] = (g11 * (1 - fx) + g21 * fx) * (1 - fy) + (g12 * (1 - fx) + g22 * fx) * fy;
      }
      out[ch] = { w: bw, h: bh, feat: Array.from(feat, (v) => Math.round(v * 10000) / 10000) };
    }
    return { S, glyphs: out };
  }, { CHARSET, targetH });
  await browser.close();
  fs.writeFileSync(TMPL_FILE, JSON.stringify({ S: glyphs.S, targetH, charset: CHARSET.join(''), glyphs: glyphs.glyphs }));
  console.log('TEMPLATES SAVED:', TMPL_FILE, 'S =', glyphs.S, 'chars =', Object.keys(glyphs.glyphs).join(''));
}

module.exports = { candidatesFromGray, loadTemplates, kbestDP, segFontProduct, buildTemplates };

if (require.main === module) {
  if (process.argv[2] === 'build') {
    buildTemplates().catch((e) => { console.error('BUILD FAILED', e); process.exit(1); });
  } else {
    console.log('usage: node captcha-solve2.js build');
  }
}
