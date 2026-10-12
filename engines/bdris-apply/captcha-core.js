'use strict';
// captcha-core.js — BDRIS print-captcha solver (no external deps)
// pipeline: gray(250x50) -> inkMask(per-column adaptive) -> removeStrikeLine(Hough) ->
//           speck cleanup -> text bbox -> DP cut into 5 glyphs -> 20x20 normalize -> NN classify
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEF_OPTS = { n: 5, rel: 0.62, floor: 42, size: 20, minAspect: 0 };

// ---------- segmentation ----------
function inkMask(gray, w, h, opts = {}) {
  const rel = opts.rel != null ? opts.rel : DEF_OPTS.rel;
  const floor = opts.floor != null ? opts.floor : DEF_OPTS.floor;
  const mask = new Uint8Array(w * h);
  const col = new Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = gray[y * w + x];
    col.sort((a, b) => a - b);
    const bg = col[Math.min(h - 1, Math.floor(0.85 * (h - 1)))];
    const t = Math.max(floor, Math.min(200, rel * bg));
    for (let y = 0; y < h; y++) if (gray[y * w + x] < t) mask[y * w + x] = 1;
  }
  return mask;
}

function runsInColumn(mask, w, h, x) {
  const runs = [];
  let y = 0;
  while (y < h) {
    if (mask[y * w + x]) {
      const y0 = y;
      while (y < h && mask[y * w + x]) y++;
      runs.push([y0, y - 1]);
    } else y++;
  }
  return runs;
}

function removeStrikeLine(mask, w, h, opts = {}) {
  const cols = [];
  for (let x = 0; x < w; x++) cols.push(runsInColumn(mask, w, h, x));
  // Hough: y = s*x + b ; vote columns with a run center near the line
  let best = { score: 0, s: 0, b: 0 };
  for (let s = -0.6; s <= 0.601; s += 0.02) {
    const bMin = Math.floor(-Math.max(0, s) * (w - 1)) - 4;
    const bMax = Math.ceil(h - 1 - Math.min(0, s) * (w - 1)) + 4;
    const votes = new Int16Array(bMax - bMin + 1);
    for (let x = 0; x < w; x++) {
      const runs = cols[x];
      if (!runs.length) continue;
      for (const r of runs) {
        const cy = (r[0] + r[1]) / 2;
        const bb = cy - s * x;
        const lo = Math.max(0, Math.round(bb - 2.5) - bMin);
        const hi = Math.min(votes.length - 1, Math.round(bb + 2.5) - bMin);
        for (let q = lo; q <= hi; q++) votes[q]++;
      }
    }
    for (let q = 0; q < votes.length; q++) if (votes[q] > best.score) best = { score: votes[q], s, b: q + bMin };
  }
  if (best.score < 0.5 * w) return { mask, removed: 0, line: null };
  let removed = 0;
  const restore = opts.restore !== false;
  for (let x = 0; x < w; x++) {
    const cyL = best.s * x + best.b;
    const runs = cols[x];
    let pick = null, pickD = 1e9;
    for (const r of runs) {
      const cy = (r[0] + r[1]) / 2;
      const d = Math.abs(cy - cyL);
      if (d < pickD) { pickD = d; pick = r; }
    }
    if (!pick || pickD > 4.5) continue;
    const len = pick[1] - pick[0] + 1;
    if (len <= 9) {
      for (let y = pick[0]; y <= pick[1]; y++) if (mask[y * w + x]) { mask[y * w + x] = 0; removed++; }
    } else {
      const yLo = Math.max(pick[0], Math.floor(cyL - 2.75));
      const yHi = Math.min(pick[1], Math.ceil(cyL + 2.75));
      for (let y = yLo; y <= yHi; y++) {
        if (!mask[y * w + x]) continue;
        if (restore) {
          // stroke crossing the line: ink present just above AND below the band -> keep (glyph), else clear (line)
          let above = false, below = false;
          for (let yy = Math.max(pick[0], yLo - 3); yy < yLo; yy++) if (mask[yy * w + x]) { above = true; break; }
          for (let yy = yHi + 1; yy <= Math.min(pick[1], yHi + 3); yy++) if (mask[yy * w + x]) { below = true; break; }
          if (above && below) continue;
        }
        mask[y * w + x] = 0; removed++;
      }
    }
  }
  return { mask, removed, line: best };
}

function cleanSpecks(mask, w, h, minArea = 8) {
  const seen = new Uint8Array(w * h);
  const stack = [];
  let kept = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    let area = 0, minX = w, maxX = -1, minY = h, maxY = -1;
    stack.length = 0; stack.push(i); seen[i] = 1;
    const comp = [];
    while (stack.length) {
      const p = stack.pop(); comp.push(p);
      const px = p % w, py = (p / w) | 0;
      area++;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (area < minArea || (bw <= 3 && bh <= 3)) { for (const p of comp) mask[p] = 0; }
    else kept++;
  }
  return kept;
}

function textBBox(mask, w, h) {
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (mask[y * w + x]) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, maxX, minY, maxY };
}

function cutSegments(mask, w, h, bbox, n) {
  const c = new Int32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) c[x]++;
  const x0 = bbox.minX, x1 = bbox.maxX, total = x1 - x0 + 1;
  const avg = total / n;
  const minW = Math.max(8, Math.floor(total * 0.08));
  const maxW = Math.max(minW + 1, Math.ceil(total * 0.38));
  // wide-gap-aware cost: ink mass in a ±2 window (true gaps beat narrow internal valleys like the waist of '8')
  const cs = new Float64Array(w + 1);
  for (let x = 0; x < w; x++) cs[x + 1] = cs[x] + c[x];
  const win = (a, b) => cs[Math.min(w, b + 1)] - cs[Math.max(0, a)];
  const cutCost = (x) => win(x - 2, x + 2) * 1.0;
  const LAM = 0.55; // width-uniformity prior: strong vs weak ink signals, decisive vs interior cuts
  const widCost = (e1, e2) => LAM * Math.pow((e2 - e1) - avg, 2);
  const INF = 1e12;
  // dp[k][end] : k segments placed, last segment ends at end (cut after it if k<n)
  let dp = new Float64Array(w).fill(INF);
  let par = [];
  for (let e = x0 + minW - 1; e <= Math.min(x1, x0 + maxW - 1); e++) dp[e] = widCost(x0 - 1, e);
  for (let k = 1; k < n; k++) {
    const ndp = new Float64Array(w).fill(INF);
    const npar = new Int32Array(w).fill(-1);
    for (let e = x0 + minW - 1; e <= x1; e++) {
      if (dp[e] === INF) continue;
      for (let e2 = e + minW; e2 <= Math.min(x1, e + maxW); e2++) {
        if (e2 - x1 > (n - k) * maxW) continue;
        const cost = dp[e] + cutCost(e) + widCost(e, e2);
        if (cost < ndp[e2]) { ndp[e2] = cost; npar[e2] = e; }
      }
    }
    dp = ndp; par.push(npar);
  }
  let end = x1;
  if (dp[end] === INF) {
    // fallback: even split
    const segs = [];
    const step = total / n;
    for (let k = 0; k < n; k++) segs.push({ x0: Math.round(x0 + k * step), x1: Math.round(x0 + (k + 1) * step) - 1 });
    segs[n - 1].x1 = x1;
    return segs;
  }
  const ends = [end]; // end of last segment
  for (let k = n - 1; k >= 1; k--) { end = par[k - 1][end]; ends.unshift(end); }
  const segs = [];
  for (let k = 0; k < n; k++) segs.push({ x0: k === 0 ? x0 : ends[k - 1] + 1, x1: ends[k] });
  return segs;
}

function glyphFeat(mask, w, h, seg, size) {
  let minY = h, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = seg.x0; x <= seg.x1; x++) {
    if (mask[y * w + x]) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxY < 0) return { feat: new Float32Array(size * size), box: null };
  const bx = seg.x0, by = minY, bw = seg.x1 - seg.x0 + 1, bh = maxY - minY + 1;
  const feat = new Float32Array(size * size);
  for (let ty = 0; ty < size; ty++) {
    const sy = by + (ty + 0.5) * bh / size - 0.5;
    const y1 = Math.max(by, Math.min(maxY, Math.floor(sy)));
    const y2 = Math.max(by, Math.min(maxY, y1 + 1));
    const fy = Math.max(0, Math.min(1, sy - y1));
    for (let tx = 0; tx < size; tx++) {
      const sx = bx + (tx + 0.5) * bw / size - 0.5;
      const x1 = Math.max(bx, Math.min(seg.x1, Math.floor(sx)));
      const x2 = Math.max(bx, Math.min(seg.x1, x1 + 1));
      const fx = Math.max(0, Math.min(1, sx - x1));
      const g11 = mask[y1 * w + x1], g21 = mask[y1 * w + x2];
      const g12 = mask[y2 * w + x1], g22 = mask[y2 * w + x2];
      feat[ty * size + tx] = (g11 * (1 - fx) + g21 * fx) * (1 - fy) + (g12 * (1 - fx) + g22 * fx) * fy;
    }
  }
  return { feat, box: { x0: bx, y0: by, w: bw, h: bh } };
}

// ---------- full pipeline ----------
function segment(gray, w, h, opts = {}) {
  const n = opts.n || DEF_OPTS.n;
  const size = opts.size || DEF_OPTS.size;
  const mask = inkMask(gray, w, h, opts);
  const lr = removeStrikeLine(mask, w, h, opts);
  cleanSpecks(lr.mask, w, h, opts.minArea || 8);
  const bbox = textBBox(lr.mask, w, h);
  if (!bbox) return { feats: [], mask: lr.mask, bbox: null, line: lr.line };
  const segs = cutSegments(lr.mask, w, h, bbox, n);
  const feats = segs.map((s) => glyphFeat(lr.mask, w, h, s, size));
  return { feats, mask: lr.mask, bbox, segs, line: lr.line, lineRemoved: lr.removed };
}

function l2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s / a.length;
}

function classify(feat, templates) {
  let best = null, second = null;
  for (const t of templates) {
    const d = l2(feat, t.feat);
    if (!best || d < best.d) { second = best; best = { d, ch: t.ch, i: t.i }; }
    else if (!second || d < second.d) second = { d, ch: t.ch, i: t.i };
  }
  return { ch: best ? best.ch : '?', d1: best ? best.d : 0, d2: second ? second.d : 0, margin: best && second ? (second.d - best.d) : 0 };
}

function solve(gray, w, h, templates, opts = {}) {
  const seg = segment(gray, w, h, opts);
  if (!seg.feats.length) return { text: '', conf: 0, glyphs: [] };
  const glyphs = seg.feats.map((f) => classify(f.feat, templates));
  const text = glyphs.map((g) => g.ch).join('');
  const conf = glyphs.reduce((s, g) => s + Math.min(1, g.margin / 0.02), 0) / glyphs.length;
  return { text, conf, glyphs, seg };
}

// ---------- training / self-test ----------
function loadReal(file) {
  const j = JSON.parse(fs.readFileSync(file || path.join(__dirname, 'captcha-real.json'), 'utf8'));
  return j.samples.map((s) => ({ i: s.i, label: s.label, w: s.w, h: s.h, gray: zlib.inflateSync(Buffer.from(s.gray_b64, 'base64')) }));
}

function buildTemplates(samples, opts = {}) {
  const templates = [];
  const stats = [];
  for (const s of samples) {
    const seg = segment(s.gray, s.w, s.h, opts);
    const chars = String(s.label || '').split('');
    const row = { i: s.i, label: s.label, n: seg.feats.length, ok: seg.feats.length === chars.length };
    if (seg.feats.length === 5 && chars.length === 5) {
      seg.feats.forEach((f, k) => templates.push({ ch: chars[k], i: s.i, k, feat: Array.from(f.feat) }));
    }
    stats.push(row);
  }
  return { templates, stats };
}

function selfTest(samples, opts = {}) {
  const { templates } = buildTemplates(samples, opts);
  // glyph-level leave-one-out: classify each glyph with templates excluding itself
  let total = 0, correct = 0, exact = 0;
  const conf = {};
  for (const s of samples) {
    const seg = segment(s.gray, s.w, s.h, opts);
    const chars = String(s.label || '').split('');
    if (seg.feats.length !== 5 || chars.length !== 5) { total += 5; continue; }
    let allOk = true;
    seg.feats.forEach((f, k) => {
      const others = templates.filter((t) => !(t.i === s.i && t.k === k));
      const r = classify(f.feat, others);
      total++;
      if (r.ch === chars[k]) correct++; else allOk = false;
      const key = chars[k] + '->' + r.ch;
      conf[key] = (conf[key] || 0) + 1;
    });
    if (allOk) exact++;
  }
  const mistakes = Object.entries(conf).filter(([k]) => { const [a, b] = k.split('->'); return a !== b; }).sort((a, b) => b[1] - a[1]);
  return { total, correct, acc: total ? correct / total : 0, exact, exactAcc: samples.length ? exact / samples.length : 0, mistakes };
}

module.exports = { inkMask, removeStrikeLine, cleanSpecks, textBBox, cutSegments, glyphFeat, segment, solve, classify, loadReal, buildTemplates, selfTest };

// ---------- CLI ----------
if (require.main === module) {
  const cmd = process.argv[2] || 'selftest';
  const real = loadReal();
  if (cmd === 'selftest') {
    for (const sweep of [
      { rel: 0.62, floor: 42 },
      { rel: 0.55, floor: 38 },
      { rel: 0.70, floor: 46 },
      { rel: 0.62, floor: 52 },
    ]) {
      const r = selfTest(real, sweep);
      console.log('OPTS', JSON.stringify(sweep), '→ glyph acc:', (r.acc * 100).toFixed(1) + '%', '(' + r.correct + '/' + r.total + ')', 'exact:', r.exact + '/' + real.length, (r.exactAcc * 100).toFixed(0) + '%');
      if (r.mistakes.length) console.log('   mistakes:', r.mistakes.slice(0, 8).map(([k, v]) => k + '×' + v).join(', '));
    }
  } else if (cmd === 'build') {
    const { templates, stats } = buildTemplates(real);
    fs.writeFileSync(path.join(__dirname, 'captcha-templates.json'), JSON.stringify({ charset: [...new Set(templates.map((t) => t.ch))].join(''), templates }));
    console.log('TEMPLATES:', templates.length, 'chars:', [...new Set(templates.map((t) => t.ch))].join(''));
    console.log('rows:', stats.map((s) => '#' + s.i + ' ' + (s.ok ? 'ok' : 'BAD n=' + s.n) + ' ' + s.label).join(' | '));
  } else if (cmd === 'dump') {
    const idx = parseInt(process.argv[3] || '0', 10);
    const s = real.find((x) => x.i === idx);
    const seg = segment(s.gray, s.w, s.h, {});
    console.log('sample', s.i, 'label', s.label, 'line:', JSON.stringify(seg.line), 'removed:', seg.lineRemoved, 'segs:', JSON.stringify(seg.segs), 'bbox:', JSON.stringify(seg.bbox));
    const chars = s.label.split('');
    const { templates } = buildTemplates(real, {});
    seg.feats.forEach((f, k) => {
      const others = templates.filter((t) => !(t.i === s.i && t.k === k));
      const r = classify(f.feat, others);
      console.log('  glyph', k, 'true:', chars[k], 'pred:', r.ch, 'd1:', r.d1.toFixed(5), 'mar:', r.margin.toFixed(5));
    });
    // ascii dump of mask (2x2 blocks)
    for (let y = 0; y < s.h; y += 2) {
      let line = '';
      for (let x = 0; x < s.w; x += 2) {
        const a = seg.mask[y * s.w + x] || seg.mask[y * s.w + x + 1] || seg.mask[(y + 1) * s.w + x] || seg.mask[(y + 1) * s.w + x + 1];
        line += a ? '#' : '.';
      }
      console.log(String(y).padStart(2) + '|' + line + '|');
    }
  }
}
