/* ============================================================================
 * BDRIS Auto-fill Bot — Backend v4
 * ----------------------------------------------------------------------------
 * আসল bdris.gov.bd ফর্ম-স্ট্রাকচার অনুযায়ী (live-verified 2026-10-10):
 *
 *   Entry: https://bdris.gov.bd root দিয়ে ঢুকে /br/application
 *          (সরাসরি deep-link-এ gate page আসে)
 *   S0 (ধাপ ০): আবেদনের ভিত্তি — radio officeAddressType (BIRTHPLACE/PERMANENT)
 *               + দূতাবাস checkbox → "পরবর্তী"
 *   S1 (ধাপ ১): ব্যক্তির পরিচিতি — নাম (প্রথম/শেষ × বাংলা/ইংরেজি),
 *               DOB (DD/MM/YYYY), কততম সন্তান (১–১১), লিঙ্গ, দেশ,
 *               জন্মস্থানের ঠিকানা cascade
 *               (বিভাগ→জেলা→সিটি কর্পোরেশন/উপজেলা→পৌরসভা/ইউনিয়ন→ওয়ার্ড)
 *               + ৪৫+ দিন বয়সে "অ্যাটাচমেন্ট অ্যাভেইলেবিলিটি চেক" modal
 *               (সবুজ "আছে" বাটন চাপতে হয়)
 *               NOTE: পোস্ট কোডের ঘর সাইটে নেই
 *   S2 (ধাপ ২): পিতামাতা — নাম* + জাতীয়তা*;
 *               2013-এর আগে জন্ম: BRN/DOB optional, Verify বাটন নেই (বাইপাস)
 *               2013-এর পরে জন্ম: BRN* + DOB* + Verify বাটন (Verify ছাড়া
 *               পরের ধাপে যাওয়া যায় না)
 *   S2B (ঠিকানার ধাপ): "জন্মস্থানের ঠিকানা ও স্থায়ী ঠিকানা একই" /
 *               "স্থায়ী ঠিকানা ও বর্তমান ঠিকানা একই" checkbox;
 *               সরাসরি fill-এ field নাম permAddr* / prsntAddr*
 *   S3 (ধাপ ৩): প্রত্যয়ন (নিজ/অন্যান্য radio + declaration) + ডকুমেন্ট —
 *               প্রতি row-তে File Type 40/41 (select.attchment-type-upload)
 *               + Start বাটন; File Sub Type খালি থাকে
 *   S4 (ধাপ ৪): OTP — ইমেইল + ফোন → "ওটিপি পাঠান" → এক OTP বক্স → "সাবমিট"
 *
 * Env: PORT, BDRIS_URL, HEADLESS, SLOWMO, SESSION_TIMEOUT_MIN, MOCK_BDRIS
 * ========================================================================== */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { chromium } = require('playwright');
const path = require('path');
const { ensureOriginal, cachedOriginal } = require('./original-fetcher');
const STATUS_CHECK = require('./status-checker.js');

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 30 * 1024 * 1024 });

// ═══════════ ABC Authentic integration: socket auth (C-1 fix, 2026-10-15) ═══════════
// JWT_SECRET সেট থাকলে (abc-authentic backend-এর subprocess হিসেবে চললে) প্রতিটা
// socket-কে handshake-এ valid JWT দিতেই হবে — anonymous socket আর কিছু করতে পারবে না।
// JWT_SECRET না থাকলে (standalone BDRIS bot হিসেবে) আগের মতোই খোলা থাকে।
const crypto = require('crypto');
const ABC_JWT_SECRET = process.env.JWT_SECRET || '';
function verifyJwtHS256(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const sig = crypto.createHmac('sha256', ABC_JWT_SECRET).update(parts[0] + '.' + parts[1]).digest('base64url');
    if (sig.length !== parts[2].length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(parts[2]))) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp + 60) return null; // 60s clock skew
    return payload;
  } catch { return null; }
}
// Charge receipt: backend /charge/* endpoint দেয় — v1.<userId>.<kind>.<ref>.<ts>.<mac>
function verifyChargeToken(tok, userId, kind) {
  try {
    if (!ABC_JWT_SECRET || !tok) return false;
    const p = String(tok).split('.');
    if (p.length !== 6 || p[0] !== 'v1') return false;
    const [, tUid, tKind, tRef, tTs, tMac] = p;
    if (tKind !== kind) return false;
    if (String(tUid) !== String(userId)) return false;
    const ts = parseInt(tTs, 10);
    if (!ts || Math.abs(Date.now() - ts) > 30 * 60 * 1000) return false; // 30 min window
    const mac = crypto.createHmac('sha256', ABC_JWT_SECRET).update(p.slice(0, 5).join('.')).digest('hex');
    if (mac.length !== tMac.length) return false;
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(tMac));
  } catch { return false; }
}
io.use((socket, next) => {
  if (!ABC_JWT_SECRET) { socket.abcUser = null; return next(); } // standalone mode
  const token = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
  const payload = verifyJwtHS256(token);
  if (!payload) return next(new Error('UNAUTHORIZED'));
  const uid = payload.id || payload.sub || payload.userId;
  if (!uid) return next(new Error('UNAUTHORIZED'));
  socket.abcUser = { id: String(uid), role: payload.role || 'user' };
  next();
});

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const PORT = parseInt(process.env.PORT || '3000', 10);
const BDRIS_URL = process.env.BDRIS_URL || 'https://bdris.gov.bd/br/application';
const TARGET_URL = () => (process.env.MOCK_BDRIS === '1' ? `http://localhost:${PORT}/mock-bdris` : BDRIS_URL);
// ব্রাউজার সবসময় অদৃশ্য (user নিয়ম: bot-এর কাজ পর্দায় দেখা যাবে না) —
// ডিবাগের দরকারে HEADLESS=0 দিলে তবেই দৃশ্যমান হবে।
const HEADLESS = process.env.HEADLESS !== '0';
const SLOWMO = parseInt(process.env.SLOWMO || '40', 10);
const SESSION_TIMEOUT_MS = (parseInt(process.env.SESSION_TIMEOUT_MIN || '25', 10)) * 60 * 1000;
const MOCK_MODE = process.env.MOCK_BDRIS === '1';
// M-18 fix (2026-10-15): PII redaction for console logs — phone numbers and
// OTP-like digit runs are masked outside MOCK mode.
const redactPII = (s) => String(s == null ? '' : s)
  .replace(/01[0-9]{9}/g, '01*********')
  .replace(/\b\d{6}\b/g, '******');
const STEP_TIMEOUT_MS = 180000;

let browser = null;
let context = null;
let page = null;
let isLaunching = false;
let lastActivity = Date.now();
// C-1 fix (2026-10-17): session ownership — একটাই global browser/page বলে
// একসাথে দুই user চালালে data corrupt হতো। এখন একবারে একজনই সেশন
// চালাতে পারবে; অন্যজন "ব্যস্ত" বার্তা পাবে। multi-user parallel-এর জন্য
// per-context isolation লাগবে (ভবিষ্যৎ কাজ)।
let sessionOwner = null;
// শেষ OTP-নেটওয়ার্ক ফল (2026-10-11): সাইটের otpSentError non-JSON 400-তে চুপচাপ
// ক্র্যাশ করে — তাই response listener এখানে ধরিয়ে রাখে, S4prep আসল কারণ দেখাতে পারে
let lastOtpNet = null;
// আবেদনকারীর DOB (S1 থেকে) — S2-তে pre-2013 parent flow সিদ্ধান্তে লাগে
let applicantDobIso = null;
// আবেদনের কপি PDF বানাতে S0–S4 ধাপের তথ্য এখানে জমা রাখি
let appData = {};

const mockReports = [];

// ═══════════ Draft persistence (server-side, drafts/<user>/) ═══════════
// OTP-এর আগে সম্পূর্ণ আবেদন draft হিসেবে থেকে যাবে — পরে যেকোনো সময়
// নম্বর দিয়ে OTP নিয়ে সাবমিট করা যাবে। /tmp নয় — স্থায়ী ডিস্কে।
// C-1 fix (2026-10-15): draft এখন per-user — একজনের draft আরেকজন দেখতে পাবে না।
const DRAFTS_DIR = path.join(__dirname, 'drafts');
try { require('fs').mkdirSync(DRAFTS_DIR, { recursive: true }); } catch { /* ignore */ }
function draftsDirFor(userId) {
  if (!userId) return DRAFTS_DIR; // standalone mode: legacy shared dir
  const safe = String(userId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || 'anon';
  const d = path.join(DRAFTS_DIR, 'u_' + safe);
  try { require('fs').mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
}
function saveDraft(data, userId) {
  const raw = (data && data.draftId) || ('draft-' + Date.now().toString(36));
  // path traversal বন্ধ — draftId কখনো ফাইলের বাইরে যেতে পারবে না
  const id = String(raw).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80) || ('draft-' + Date.now().toString(36));
  const rec = Object.assign({}, data, { draftId: id, savedAt: new Date().toISOString() });
  require('fs').writeFileSync(path.join(draftsDirFor(userId), id + '.json'), JSON.stringify(rec));
  return { draftId: id, savedAt: rec.savedAt };
}
function listDrafts(userId) {
  const fs = require('fs');
  try {
    return fs.readdirSync(draftsDirFor(userId)).filter(f => f.endsWith('.json')).map(f => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(draftsDirFor(userId), f), 'utf8'));
        return {
          draftId: r.draftId, savedAt: r.savedAt, uiStep: parseInt(r.uiStep, 10) || 0,
          name: [r.s1 && r.s1.firstNameBn, r.s1 && r.s1.lastNameBn].filter(Boolean).join(' ') || '(নাম নেই)',
          dob: (r.s1 && r.s1.dob) || '',
        };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  } catch { return []; }
}
function loadDraft(userId, id) {
  const fs = require('fs');
  const f = path.join(draftsDirFor(userId), String(id).replace(/[^a-zA-Z0-9-]/g, '') + '.json');
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function deleteDraft(userId, id) {
  const fs = require('fs');
  const f = path.join(draftsDirFor(userId), String(id).replace(/[^a-zA-Z0-9-]/g, '') + '.json');
  fs.unlinkSync(f);
}

// ── ঠিকানা বই (স্থায়ী): নাম দিয়ে ঠিকানা সেভ, কোনো ট্যাগ নেই ──
// C-1 fix (2026-10-15): per-user — addresses/u_<id>.json
// যেকোনো ঠিকানার ঘরে (জন্ম/স্থায়ী/বর্তমান) ব্যবহারযোগ্য।
const ADDR_DIR = __dirname;
function addrFileFor(userId) {
  if (!userId) return path.join(ADDR_DIR, 'addresses.json'); // standalone: legacy
  const safe = String(userId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || 'anon';
  return path.join(ADDR_DIR, 'addresses_u_' + safe + '.json');
}
function loadAddresses(userId) {
  try { return JSON.parse(require('fs').readFileSync(addrFileFor(userId), 'utf8')); }
  catch { return []; }
}
function saveAddresses(userId, list) {
  require('fs').writeFileSync(addrFileFor(userId), JSON.stringify(list, null, 1));
}
function upsertAddress(userId, a) {
  const list = loadAddresses(userId);
  const id = a.id || ('addr-' + Date.now().toString(36));
  const rec = Object.assign({}, a, { id });
  const i = list.findIndex(x => x.id === id);
  if (i >= 0) list[i] = rec; else list.push(rec);
  saveAddresses(userId, list);
  return list;
}

// ═══════════ utilities ═══════════
function ts() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
function touchSession() { lastActivity = Date.now(); }

function status(socket, st, message, level) {
  const lvl = level || (st === 'ERROR' ? 'err'
    : st === 'COMPLETED' ? 'ok' : st === 'READY' ? 'ok'
    : st === 'OTP_WAITING' ? 'ok' : 'info');
  console.log(`[${ts()}] [${st}] ${message}`);
  socket.emit('BOT_STATUS', { status: st, message, level: lvl });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`সময় শেষ (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isoToBdFormat(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

// নাম পরিষ্কার — ডট-কনভেনশন (pran-এর সিস্টেম, 2026-10-10):
// নামের পাশের ডট ("রাজু.") single-name মার্কার — নীরবে সরিয়ে দাও;
// শুধু ডট/চিহ্ন থাকলে ফাঁকা (১-নামের লজিক) — বট কিছু বসাবে না, বার্তাও নয়
function hasLetters(s) {
  return /[A-Za-z\u0980-\u09FF]/.test(String(s || ''));
}
function cleanName(s) {
  // নিয়ম (user, 2026-10-13): নামের পাশে যে চিহ্নই থাকুক — ডট, কোলন,
  // ব্যাকটিক, *, / — কোনোটাতেই আবেদন আটকাবে না। অক্ষর (বাংলা/ইংরেজি),
  // স্পেস আর ব্যাকটিক (cinno — শেষ ধাপের জন্য রাখা) ছাড়া বাকি সব চিহ্ন
  // বাদ; চিহ্ন-শুধু থাকলে ফাঁকা (১-নামের লজিকে এগিয়ে যাবে)।
  const t = String(s || '').replace(/[^A-Za-z\u0980-\u09FF\u200C\u200D` ]/g, '').replace(/\s+/g, ' ').trim();
  return hasLetters(t) ? t : '';
}
// 2026-10-11 (live-verified): BDRIS নামে ` (cinno) একদমই নেয় না — English ঘরে
// validateForm ব্লক করে, Bangla ঘরে সাইট নিজেই মুছে দেয়। তাই সাইটে টাইপ হয়
// cinno-ছাড়া রূপ (transitName), আর ধাপ-ভ্যালিডেশন পাসের পর চূড়ান্ত সাবমিটের
// ঠিক আগে আসল রূপ (cleanName — cinno-সহ) নীরবে ফিল্ডে বসানো হয় (S4-এ sneak)।
// কোথাও সাইট আটকালে সাথে সাথে cinno বাদ দিয়ে আবার — নাগরিক কোনোভাবেই আটকাবে না।
function transitName(s) {
  return cleanName(s).replace(/`/g, '').trim();
}

// ── আসল PDF (কার্যালয়ের কপি) — স্থায়ী ফেচ-সার্ভিসের জন্য রেকর্ড (2026-10-11) ──
// পাবলিক print-লুকআপে সাবমিট হওয়া হুবহু নাম/তারিখ/মোবাইল লাগে। cinno-সহ রূপ
// প্রাইমারি, cinno-ছাড়া রূপ বিকল্প; ১-নাম কখনো ডাবল করা হয় না — এক-নাম রূপই থাকে।
const ORIG_INDEX_FILE = path.join(__dirname, 'originals-index.json');
function origIndexLoad() {
  try { return JSON.parse(require('fs').readFileSync(ORIG_INDEX_FILE, 'utf8')); } catch { return {}; }
}
function origIndexGet(ack) { return origIndexLoad()[String(ack)] || null; }
function origIndexPut(ack, rec) {
  try {
    const m = origIndexLoad();
    m[String(ack)] = rec;
    require('fs').writeFileSync(ORIG_INDEX_FILE, JSON.stringify(m, null, 1));
  } catch { /* ঐচ্ছিক */ }
}
function buildOriginalRec(ackNum) {
  const A = appData.s1 || {};
  const S4 = appData.s4prep || {};
  const singleEn = !!(appData.singleName && appData.singleName.en);
  const gate = !!appData.gatePassedNames;
  const fClean = cleanName(A.firstNameEn), fStrip = transitName(A.firstNameEn);
  const lClean = cleanName(A.lastNameEn), lStrip = transitName(A.lastNameEn);
  const variants = [];
  if (singleEn) {
    variants.push(fClean, fStrip);
  } else if (gate && !lStrip) {
    variants.push((fClean + ' ' + fClean).trim(), (fStrip + ' ' + fStrip).trim(), fClean, fStrip);
  } else {
    variants.push([fClean, lClean].filter(Boolean).join(' ').trim());
    variants.push([fStrip, lStrip].filter(Boolean).join(' ').trim());
  }
  const uniq = [...new Set(variants.filter(Boolean))];
  if (!uniq.length) return null;
  const rec = {
    appId: String(ackNum),
    date: isoToBdFormat(String(A.dob || '')),
    nameEn: uniq[0],
    mobileNo: String(S4.phone || '').replace(/[^\d]/g, ''),
    email: String(S4.email || '').trim(),
  };
  if (uniq.length > 1) rec.altNameEn = uniq.slice(1);
  if (!rec.date || !rec.mobileNo) return null;
  return rec;
}

// cinno-তালিকা (2026-10-11): কোন কোন ঘরে cinno-সহ আসল রূপ বসাতে হবে। গুরুত্বপূর্ণ —
// নিজের নামের hidden join (#personNameBn/#personNameEn) সহ, কারণ সাইটের OTP-বডি ও
// চূড়ান্ত সাবমিট ওই joined ঘরগুলো থেকেই নাম পড়ে (অন্যান্য নাম সরাসরি ভিজিবল ঘর থেকেই যায়)।
function buildCinnos(appData) {
  const cinnos = [];
  const add = (sels, v) => {
    const tgt = cleanName(v);
    const clean = transitName(v);
    if (String(tgt).includes('`') && tgt !== clean) cinnos.push([sels, tgt, clean]);
  };
  const A = appData.s1 || {};
  add(['#personFirstNameBn', 'input[name$="personFirstNameBn"]'], A.firstNameBn);
  add(['#personLastNameBn', 'input[name$="personLastNameBn"]'], A.lastNameBn);
  add(['#personFirstNameEn', 'input[name$="personFirstNameEn"]'], A.firstNameEn);
  add(['#personLastNameEn', 'input[name$="personLastNameEn"]'], A.lastNameEn);
  // ১-নামের গেট-পাস হয়েছিল? শেষের নামে প্রথম নামের রূপই বসেছিল — cinno-সহ সংস্করণ
  if (appData.gatePassedNames && !hasLetters(transitName(A.lastNameBn))) {
    const tgtBn = cleanName(A.firstNameBn);
    const tgtEn = cleanName(A.firstNameEn);
    if (String(tgtBn).includes('`')) cinnos.push([['#personLastNameBn', 'input[name$="personLastNameBn"]'], tgtBn, transitName(A.firstNameBn)]);
    if (String(tgtEn).includes('`')) cinnos.push([['#personLastNameEn', 'input[name$="personLastNameEn"]'], tgtEn, transitName(A.firstNameEn)]);
  }
  {
    // সাইটের join-নিয়ম হুবহু: প্রথম + " " + শেষ (খালি হলেও হুবহু)।
    // ১-নাম স্থায়ী নিয়ম (2026-10-11): single ফ্ল্যাগ থাকলে join-এও নাম একবারই —
    // শেষের নাম যাই থাকুক (খালি / গেট-পাসের ডাবল), চূড়ান্ত রেকর্ডে ডাবল কখনো নয়।
    const gate = !!appData.gatePassedNames;
    const singleBn = !!(appData.singleName && appData.singleName.bn);
    const singleEn = !!(appData.singleName && appData.singleName.en);
    const lastBn = (gate && !hasLetters(transitName(A.lastNameBn))) ? A.firstNameBn : A.lastNameBn;
    const lastEn = (gate && !hasLetters(transitName(A.lastNameEn))) ? A.firstNameEn : A.lastNameEn;
    const joinBn = ['#personNameBn', 'input[name="personInfoForBirth.personNameBn"]'];
    const joinEn = ['#personNameEn', 'input[name="personInfoForBirth.personNameEn"]'];
    if (singleBn && hasLetters(A.firstNameBn)) {
      cinnos.push([joinBn, cleanName(A.firstNameBn), transitName(A.firstNameBn)]);
    } else {
      const tgtBn = cleanName(A.firstNameBn) + ' ' + cleanName(lastBn);
      const clnBn = transitName(A.firstNameBn) + ' ' + transitName(lastBn);
      if (String(tgtBn).includes('`') && tgtBn !== clnBn) cinnos.push([joinBn, tgtBn, clnBn]);
    }
    if (singleEn && hasLetters(A.firstNameEn)) {
      cinnos.push([joinEn, cleanName(A.firstNameEn), transitName(A.firstNameEn)]);
    } else {
      const tgtEn = cleanName(A.firstNameEn) + ' ' + cleanName(lastEn);
      const clnEn = transitName(A.firstNameEn) + ' ' + transitName(lastEn);
      if (String(tgtEn).includes('`') && tgtEn !== clnEn) cinnos.push([joinEn, tgtEn, clnEn]);
    }
  }
  const P = appData.s2 || {};
  if (P.father) {
    add(['#fatherNameBn', 'input[name="personInfoForBirth.father.personNameBn"]'], P.father.nameBn);
    add(['#fatherNameEn', 'input[name="personInfoForBirth.father.personNameEn"]'], P.father.nameEn);
  }
  if (P.mother) {
    add(['#motherNameBn', 'input[name="personInfoForBirth.mother.personNameBn"]'], P.mother.nameBn);
    add(['#motherNameEn', 'input[name="personInfoForBirth.mother.personNameEn"]'], P.mother.nameEn);
  }
  return cinnos;
}
async function applyCinnos(page, cinnos, on) {
  if (!cinnos.length) return 0;
  return await page.evaluate(([items, withCinno]) => {
    let c = 0;
    for (const [sels, tgt, clean] of items) {
      let el = null;
      for (const s of sels) { el = document.querySelector(s); if (el) break; }
      if (!el) continue;
      el.value = withCinno ? tgt : clean;
      c++;
    }
    return c;
  }, [cinnos, !!on]).catch(() => 0);
}
// নামের *Letters* রুলগুলো শিথিল (শুধু এই সেশনের in-page স্টেট — সার্ভারই শেষ বিচারক;
// required/length/date সব অটুট থাকে)। এতে সাইটের নিজের হ্যান্ডলার cinno-সহ নাম পাঠায়।
async function relaxNameRules(page) {
  return await page.evaluate(() => {
    try {
      const $ = window.jQuery;
      if (!$ || !$.validator) return 'no-jquery';
      Object.keys($.validator.methods).forEach((m) => {
        if (/letters/i.test(m)) $.validator.methods[m] = function () { return true; };
      });
      const v = $('.form-to-be-validated').data('validator');
      if (v && v.settings && v.settings.rules) {
        Object.keys(v.settings.rules).forEach((k) => {
          const r = v.settings.rules[k];
          if (r && typeof r === 'object') {
            Object.keys(r).forEach((rk) => { if (/letters/i.test(rk)) delete r[rk]; });
          }
        });
      }
      return 'relaxed';
    } catch (e) { return 'ERR:' + String(e && e.message); }
  }).catch(() => 'eval-fail');
}

// ═══ ১-নাম স্থায়ী নিয়ম (user-mandated, 2026-10-11) ═══
// শেষের নাম ফাঁকা থাকলে ঘর খালিই থাকবে — নাম কখনো ডাবল হবে না, বট কিছু বসাবে না।
// সাইটের required-রুল শুধু এই সেশনের জন্য শিথিল করি; তাতেও সাইট আটকালে
// "নাগরিক আটকাবে না" নিয়মে বাধ্য-পূরণ (ভিজিবল ঘরে) হয় — আর চূড়ান্ত সাবমিটে
// join-নাম trim করে রেকর্ডে এক-নামই রাখা হয় (buildCinnos দেখুন)।
const LAST_SELS = {
  bn: ['#personLastNameBn', 'input[name="personInfoForBirth.personLastNameBn"]', 'input[name$="personLastNameBn"]'],
  en: ['#personLastNameEn', 'input[name="personInfoForBirth.personLastNameEn"]', 'input[name$="personLastNameEn"]'],
};
async function relaxEmptyLast(page, which) {
  if (!which || (!which.bn && !which.en)) return 'skip';
  return await page.evaluate((w) => {
    try {
      const $ = window.jQuery;
      const ids = [];
      if (w.bn) ids.push('personLastNameBn');
      if (w.en) ids.push('personLastNameEn');
      ids.forEach((id) => {
        const el = document.querySelector('#' + id)
          || document.querySelector('input[name="personInfoForBirth.' + id + '"]')
          || document.querySelector('input[name$="' + id + '"]');
        if (!el) return;
        try { el.required = false; el.removeAttribute('required'); } catch (e) {}
        if ($) $(el).removeClass('error').closest('.form-group, .mb-3, .col-md-6, .col-md-4').find('label.error, .text-danger, .invalid-feedback').remove();
      });
      if ($ && $.validator) {
        const v = $('.form-to-be-validated').data('validator');
        if (v && v.settings && v.settings.rules) {
          Object.keys(v.settings.rules).forEach((k) => {
            if (/personLastName(Bn|En)$/.test(k)) {
              const r = v.settings.rules[k];
              if (r && typeof r === 'object' && 'required' in r) delete r.required;
              else if (typeof r === 'string' && /required/.test(r)) delete v.settings.rules[k];
            }
          });
        }
      }
      return 'ok';
    } catch (e) { return 'ERR:' + String(e && e.message); }
  }, which).catch(() => 'fail');
}
async function emptyLastVisible(page, which) {
  if (!which || (!which.bn && !which.en)) return 0;
  return await page.evaluate((w) => {
    let n = 0;
    const set = (sels) => {
      let el = null;
      for (const s of sels) { el = document.querySelector(s); if (el) break; }
      if (el && String(el.value || '') !== '') { el.value = ''; n++; }
    };
    if (w.bn) set(['#personLastNameBn', 'input[name="personInfoForBirth.personLastNameBn"]', 'input[name$="personLastNameBn"]']);
    if (w.en) set(['#personLastNameEn', 'input[name="personInfoForBirth.personLastNameEn"]', 'input[name$="personLastNameEn"]']);
    return n;
  }, which).catch(() => 0);
}
// শেষ-নামের ঘর (খালি থাকলে) প্রথম নাম দিয়ে বাধ্য-পূরণ — কেবল সাইট আটকালে, শেষ-উপায়ে
async function fillDoubledLast(page, s1, which) {
  const A = s1 || {};
  return await page.evaluate(([w, bnv, env]) => {
    let n = 0;
    const set = (sels, val) => {
      if (!val) return;
      let el = null;
      for (const s of sels) { el = document.querySelector(s); if (el) break; }
      if (el && !/[A-Za-z\u0980-\u09FF]/.test(String(el.value || ''))) { el.value = val; n++; }
    };
    if (w.bn) set(['#personLastNameBn', 'input[name="personInfoForBirth.personLastNameBn"]', 'input[name$="personLastNameBn"]'], bnv);
    if (w.en) set(['#personLastNameEn', 'input[name="personInfoForBirth.personLastNameEn"]', 'input[name$="personLastNameEn"]'], env);
    return n;
  }, [which, transitName(A.firstNameBn), transitName(A.firstNameEn)]).catch(() => 0);
}

// বাংলা লেবেল normalization (live-verified 2026-10-10):
// পেজে "রাজবাড়ী" (ড় = U+09DC) আসে, টাইপ করা মানে "রাজবাড়ী" (ড় = ড+়) হতে পারে।
// NFKC + ড়→ড় একরূপ + ZWJ/ZWNJ বাদ → select মিলিয়ে নেওয়া যায়।
function bnNorm(s) {
  return String(s || '').normalize('NFKC')
    .replace(/ড়/g, 'ড়')
    .replace(/[\u200C\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function bnToArab(s) {
  return String(s || '').replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
}
// কততম সন্তান: সাইটে শুধু সংখ্যা (১–১১) — "১ম"/"২য়"/"3rd" → "৩" (2026-10-13 live-verified)
function thChildSite(v) {
  const m = bnToArab(bnNorm(v)).match(/(\d{1,2})/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 11) return String(n).replace(/[0-9]/g, d => '০১২৩৪৫৬৭৮৯'[+d]);
  }
  return v;
}
// ওয়ার্ড: "৩নং" / "3" / "ওয়ার্ড-৩" → ["ওয়ার্ড - 3", ...] candidate list
function wardCandidates(raw) {
  const t = bnNorm(raw);
  const cands = [];
  if (t) cands.push(t);
  const m = bnToArab(t).match(/(\d{1,2})/);
  if (m) {
    const n = String(parseInt(m[1], 10));
    const bn = String(n).replace(/[0-9]/g, d => '০১২৩৪৫৬৭৮৯'[+d]);
    cands.push(`ওয়ার্ড - ${n}`, `ওয়ার্ড-${n}`, `ওয়ার্ড - ${bn}`, `ওয়ার্ড-${bn}`, n, bn);
  }
  return [...new Set(cands)];
}
// পৌরসভা/ইউনিয়ন — সিটি কর্পোরেশনে "অঞ্চল" আসে: "অঞ্চল - ৭" ↔ "অঞ্চল - 7" ↔ "অঞ্চল-৭"
function unionCandidates(raw) {
  const t = bnNorm(raw);
  const cands = [t, bnToArab(t)];
  for (const b of [t, bnToArab(t)]) {
    cands.push(b.replace(/\s*-\s*/, '-'), b.replace(/\s*-\s*/, ' - '));
  }
  return [...new Set(cands.filter(Boolean))];
}
// applicant DOB (ISO) → 2013-এর আগে কিনা (pran-এর নিয়ম; 2013 সাল নিজে unverified)
function isPre2013(iso) {
  if (!iso) return false;
  return String(iso).slice(0, 10) < '2013-01-01';
}

// ═══════════ Playwright helpers ═══════════
// union selector-এ সবসময় প্রথম VISIBLE element (hidden ডুপ্লিকেট এড়াতে)
async function waitVisible(selectors, timeout = 12000) {
  const list = Array.isArray(selectors)
    ? selectors
    : selectors.split(/,(?![^(]*\))/).map(s => s.trim()).filter(Boolean);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of list) {
      let n = 0;
      try { n = await page.locator(sel).count(); } catch { n = 0; }
      for (let i = 0; i < n; i++) {
        const el = page.locator(sel).nth(i);
        try { if (await el.isVisible()) return el; } catch { /* next */ }
      }
    }
    await page.waitForTimeout(350);
  }
  return null;
}
async function waitEl(selector, timeout = 12000) { return waitVisible(selector, timeout); }

// ডায়াগনস্টিক: সিলেক্টরগুলোর বর্তমান DOM-অবস্থা — কী মিলল, দৃশ্যমান কিনা, কত অপশন
async function domSnapshot(selectors) {
  return page.evaluate((sels) => {
    const out = [];
    for (const s of sels) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(s)); } catch { continue; }
      for (const n of nodes.slice(0, 2)) {
        const r = n.getBoundingClientRect();
        out.push({
          sel: s, tag: n.tagName, id: n.id || '', name: n.getAttribute('name') || '',
          vis: r.width > 0 && r.height > 0, disp: getComputedStyle(n).display || '',
          nOpt: n.options ? n.options.length : -1,
          cur: n.value != null ? String(n.value).slice(0, 20) : null,
          opts: n.options ? Array.from(n.options).slice(0, 3).map(o => String(o.text || '').trim().slice(0, 16)) : null,
        });
      }
    }
    return out;
  }, selectors).catch((e) => [{ err: String((e && e.message) || e).slice(0, 120) }]);
}

// Playwright-এর viewport-চেক মাঝে মাঝে modal-বাটনে "element is outside of the
// viewport" retry-loop করে ৩০s নষ্ট করে ব্যর্থ হয় (live 2026-10-11, attachment
// modal-এর "আমার কাছে এই ডকুমেন্টগুলি আছে" বাটন)। তাই লাগলে DOM-level ক্লিক
// ফলব্যাক — jQuery handler তাতেও ঠিকঠাক চলে।
async function robustClick(target, label = '', timeout = 8000) {
  try {
    await target.click({ timeout });
    return true;
  } catch (e) {
    try {
      await target.evaluate((el) => el.click());
      console.log('ROBUST-CLICK (dom):', label);
      return true;
    } catch (e2) {
      console.error('robustClick failed:', label, e2.message.slice(0, 120));
      return false;
    }
  }
}

async function waitForOptions(selector, timeout = 10000) {
  try {
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      return el && el.options && el.options.length > 1;
    }, selector, { timeout });
    return true;
  } catch { return false; }
}

// অপশন scan — normalized exact → সবচেয়ে লম্বা substring মিলে option value ফেরায়
// (Playwright evaluate একটাই arg নেয় — object wrap; নইলে "Too many arguments")
async function scanOptionValue(selectors, label) {
  try {
    const hit = await page.evaluate(({ sels, l }) => {
      // ঁ (chandrabindu) বাদ — ইউজার "পাঁচুরিয়া" লিখলেও সাইটের "পাচুরিয়া" মিলবে (live-verified 2026-10-10)
      const norm = (t) => String(t || '').normalize('NFKC')
        .replace(/ড়/g, 'ড়')
        .replace(/[\u200C\u200D\u0981]/g, '')
        .replace(/\s+/g, ' ').trim();
      const nl = norm(l);
      const list = Array.isArray(sels) ? sels : [sels];
      let s = null, sAny = null;
      for (const s0 of list) {
        try { s = document.querySelector(s0); } catch { s = null; }
        if (!s) continue;
        if (!sAny) sAny = s;
        if (s.options && s.options.length > 1) break; // অপশনসহ select আগে (খালি কাকতালীয় এড়াতে)
        s = null;
      }
      if (!s) s = sAny;
      if (!s) return null;
      const opts = Array.from(s.options)
        .filter(o => o.value !== '' && !/নির্বাচন করুন/.test(o.text))
        .map(o => ({ v: o.value, t: norm(o.text) }));
      const exact = opts.find(o => o.t === nl);
      if (exact) return { v: exact.v, t: exact.t };
      const subs = opts.filter(o => o.t && (o.t.includes(nl) || nl.includes(o.t)));
      subs.sort((a, b) => b.t.length - a.t.length);
      return subs[0] ? { v: subs[0].v, t: subs[0].t } : null;
    }, { sels: Array.isArray(selectors) ? selectors : [selectors], l: String(label) });
    return hit && hit.v ? hit.v : null;
  } catch (e) {
    console.error('option-scan:', e.message);
    return null;
  }
}

async function selectByLabel(selector, label, socket, fieldName) {
  if (!label || !String(label).trim()) {
    status(socket, 'PROGRESS', `⊘ ${fieldName}: মান দেওয়া হয়নি, এড়িয়ে যাওয়া হলো`, 'warn');
    return { ok: true, skipped: true };
  }
  const el = await waitEl(selector);
  if (!el) {
    const reason = `${fieldName} ঘর পাওয়া যায়নি`;
    status(socket, 'PROGRESS', `⚠ ${reason}`, 'warn');
    return { ok: false, field: fieldName, reason };
  }
  const lbl = String(label).trim();
  const scanned = await scanOptionValue(selector, lbl);
  // value-দিয়ে বসানো সবচেয়ে নির্ভরযোগ্য; এরপর raw label/value, শেষে exact-label
  const candidates = [...new Set([scanned, lbl].filter(Boolean))];
  for (const cand of candidates) {
    try {
      await el.selectOption(cand, { timeout: 6000 });
      await page.waitForTimeout(1100);
      status(socket, 'PROGRESS', `✔ ${fieldName}: "${lbl}"`, 'ok');
      return { ok: true };
    } catch { /* পরের কৌশল */ }
  }
  try {
    await el.selectOption({ label: lbl }, { timeout: 6000 });
    await page.waitForTimeout(1100);
    status(socket, 'PROGRESS', `✔ ${fieldName}: "${lbl}"`, 'ok');
    return { ok: true };
  } catch { /* নিচে */ }
  const reason = `"${lbl}" অপশন পাওয়া যায়নি (${fieldName})`;
  status(socket, 'PROGRESS', `⚠ ${reason}`, 'warn');
  return { ok: false, field: fieldName, reason };
}

async function typeInto(selector, value, socket, fieldName, opts = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (opts.required) {
      const reason = `${fieldName} খালি — পূরণ আবশ্যক`;
      status(socket, 'PROGRESS', `⚠ ${reason}`, 'warn');
      return { ok: false, field: fieldName, reason };
    }
    return { ok: true, skipped: true };
  }
  const el = await waitEl(selector);
  if (!el) {
    const reason = `${fieldName} ঘর পাওয়া যায়নি`;
    status(socket, 'PROGRESS', `⚠ ${reason}`, 'warn');
    return { ok: false, field: fieldName, reason };
  }
  try {
    await el.fill('');
    if (opts.typeCharByChar) await el.type(String(value), { delay: 60 });
    else await el.fill(String(value));
    if (opts.pressTab !== false) { await page.keyboard.press('Tab').catch(() => {}); }
    status(socket, 'PROGRESS', `✔ ${fieldName} পূরণ হয়েছে`, 'ok');
    return { ok: true };
  } catch (e) {
    console.error(`${fieldName} fill:`, e.message);
    const reason = `${fieldName} ঘরে লেখা যায়নি — আবার চেষ্টা করুন`;
    status(socket, 'PROGRESS', `⚠ ${reason}`, 'warn');
    return { ok: false, field: fieldName, reason };
  }
}

// ── ঠিকানা cascade (BDRIS logic): যেকোনো section-এ বসানো যায় ──
// prefix: 'birthPlace' | 'permAddr' | 'prsntAddr'  (live-verified 2026-10-10:
// স্থায়ী = permAddr*, বর্তমান = prsntAddr*; "permanentAddress"/"presentAddress" ভুল)
// d: { division, district, cityCorpUpazila, paurasavaUnion, ward,
//      postOfficeBn/postBn, postOfficeEn/postEn, villageBn/vilBn, villageEn/vilEn,
//      houseRoadBn/houseBn, houseRoadEn/houseEn }
// NOTE: BDRIS-এ পোস্ট কোডের ঘর নেই — d.postCode থাকলেও বসানো হয় না।
async function fillAddressSection(prefix, d, socket, failed) {
  const keep = (r) => { if (r && !r.ok && !r.skipped) failed.push({ field: r.field, reason: r.reason }); };
  // দেশ আগে বসাই — কোনো সেকশনে খালি থাকলে সাইট "পরবর্তী"-তে আটকায় (2026-10-11: perm/prsnt
  // সেকশনে দেশ আলাদা করে বসানো হচ্ছিল না)। ডিফল্ট বাংলাদেশ।
  const countrySels = [`#${prefix}Country`, `select[name="${prefix}Country"]`];
  const hasCountry = await page.evaluate((ss) => {
    for (const s of ss) {
      try { const e = document.querySelector(s); if (e && e.options && e.options.length > 1) return true; } catch { /* next */ }
    }
    return false;
  }, countrySels).catch(() => false);
  if (hasCountry) keep(await selectByLabel(countrySels, d.country || 'বাংলাদেশ', socket, 'দেশ'));
  keep(await selectByLabel([`#${prefix}Div`, `select[name="${prefix}Div"]`], d.division, socket, 'বিভাগ'));
  await waitForOptions(`select[name="${prefix}Dist"]`, 8000);
  keep(await selectByLabel([`#${prefix}Dist`, `select[name="${prefix}Dist"]`], d.district, socket, 'জেলা'));
  await waitForOptions(`select[name="${prefix}CityCorpCantOrUpazila"]`, 8000);
  keep(await selectByLabel([`#${prefix}CityCorpCantOrUpazila`, `select[name="${prefix}CityCorpCantOrUpazila"]`],
    d.cityCorpUpazila, socket, 'সিটি কর্পোরেশন/উপজেলা'));
  // ── অঞ্চল/পৌরসভা-ইউনিয়ন + ওয়ার্ড (live-verified 2026-10-11, ঢাকা দক্ষিণ সিটি কর্পোরেশন) ──
  // সিটি কর্পোরেশন-ধাঁচ: PaurasavaOrUnion select খালি থাকে; "অঞ্চল - ৭" আসে WardInCityCorp
  // select-এ; অঞ্চল বাছলে ওয়ার্ড ("ওয়ার্ড - 71") লোড হয় WardInPaurasavaOrUnion select-এ।
  // ইউনিয়ন-ধাঁচ আগের মতোই: PaurasavaOrUnion → WardInPaurasavaOrUnion।
  const cityCorp = /সিটি কর্পোরেশন/.test(String(d.cityCorpUpazila || ''));
  const unionSlot = [`#${prefix}PaurasavaOrUnion`, `select[name="${prefix}PaurasavaOrUnion"]`];
  const cityWard = [`#${prefix}WardInCityCorp`, `select[name="${prefix}WardInCityCorp"]`];
  const unionWard = [`#${prefix}WardInPaurasavaOrUnion`, `select[name="${prefix}WardInPaurasavaOrUnion"]`];
  const hasOpts = async (sels) => page.evaluate((ss) => {
    for (const s of ss) {
      try { const e = document.querySelector(s); if (e && e.options && e.options.length > 1) return true; } catch { /* next */ }
    }
    return false;
  }, sels).catch(() => false);
  const firstMatch = async (sels, cands, label) => {
    for (const c of cands) {
      const r = await selectByLabel(sels, c, socket, label);
      if (r.ok) return r;
    }
    return { ok: false, field: label, reason: `"${label}" অপশনের মান পাওয়া যায়নি` };
  };
  if (d.paurasavaUnion) {
    let zonePath = cityCorp && (await hasOpts(cityWard));
    if (!zonePath && cityCorp) {
      // সিটি কর্পোরেশন বাছার পর অঞ্চল-তালিকা অ্যাসিন্ক লোড হয় — একটু অপেক্ষা করি
      zonePath = (await waitForOptions(`select[name="${prefix}WardInCityCorp"]`, 5000)) && (await hasOpts(cityWard));
    }
    if (zonePath) {
      keep(await firstMatch(cityWard, unionCandidates(d.paurasavaUnion), 'অঞ্চল'));
    } else {
      if (!(await hasOpts(unionSlot))) await waitForOptions(`select[name="${prefix}PaurasavaOrUnion"]`, 8000);
      keep(await firstMatch(unionSlot, unionCandidates(d.paurasavaUnion), 'পৌরসভা/ইউনিয়ন'));
    }
  }
  if (d.ward) {
    if (cityCorp) {
      // অঞ্চল বাছার পর ওয়ার্ড-তালিকা অ্যাসিন্ক আসে — অপেক্ষা করে বসাই
      if (!(await hasOpts(unionWard))) await waitForOptions(`select[name="${prefix}WardInPaurasavaOrUnion"]`, 8000);
      if (await hasOpts(unionWard)) keep(await firstMatch(unionWard, wardCandidates(d.ward), 'ওয়ার্ড'));
      else if (await hasOpts(cityWard)) keep(await firstMatch(cityWard, wardCandidates(d.ward), 'ওয়ার্ড'));
      else keep({ ok: false, field: 'ওয়ার্ড', reason: `"${d.ward}" অপশনের তালিকা আসেনি` });
    } else {
      if (!(await hasOpts(unionWard))) await waitForOptions(`select[name="${prefix}WardInPaurasavaOrUnion"]`, 6000);
      if (await hasOpts(unionWard)) keep(await firstMatch(unionWard, wardCandidates(d.ward), 'ওয়ার্ড'));
      else if (await hasOpts(cityWard)) keep(await firstMatch(cityWard, wardCandidates(d.ward), 'ওয়ার্ড'));
      else keep({ ok: false, field: 'ওয়ার্ড', reason: `"${d.ward}" অপশনের তালিকা আসেনি` });
    }
  }
  const addr = async (idPart, value, label, required) => {
    if (!value && !required) return;
    keep(await typeInto([`#${idPart}`, `input[name="${idPart}"]`], value, socket, label, { required }));
  };
  await addr(prefix + 'PostOfc', d.postOfficeBn || d.postBn, 'ডাকঘর (বাংলা)', true);
  await addr(prefix + 'PostOfcEn', d.postOfficeEn || d.postEn, 'ডাকঘর (ইংরেজি)', true);
  // পোস্ট কোড — সাইটের দৃশ্যমান ফর্মে সাধারণত hidden থাকে (validation-এ কখনো দাবি করে না,
  // live-verified 2026-10-10); দৃশ্যমান থাকলে বসাই, নইলে চুপচাপ এড়াই
  if (d.postCode) {
    const pcEl = await waitVisible([`#${prefix}PostCode`, `input[name="${prefix}PostCode"]`], 3000);
    if (pcEl) keep(await typeInto([`#${prefix}PostCode`, `input[name="${prefix}PostCode"]`], d.postCode, socket, 'পোস্ট কোড', {}));
  }
  await addr(prefix + 'VilAreaTownBn', d.villageBn || d.vilBn, 'গ্রাম/পাড়া/মহল্লা', true);
  await addr(prefix + 'VilAreaTownEn', d.villageEn || d.vilEn, 'গ্রাম/পাড়া/মহল্লা (ইংরেজি)', true);
  await addr(prefix + 'HouseRoadBn', d.houseRoadBn || d.houseBn, 'বাসা ও সড়ক (বাংলা)', false);
  await addr(prefix + 'HouseRoadEn', d.houseRoadEn || d.houseEn, 'বাসা ও সড়ক (ইংরেজি)', false);
}

// "পরবর্তী" — visible বাটন খুঁজে, enabled যাচাই করে ক্লিক
async function clickNextAndWait(socket, label, opts = {}) {
  // ১-নাম: প্রতিটি ধাপের "পরবর্তী"-র আগে required-রুল শিথিল রাখি (সাইট কোনো ধাপে
  // আবার রুল বসালেও যেন খালি শেষ-নামে আটকাতে না পারে)
  if (appData.singleName && (appData.singleName.bn || appData.singleName.en)) {
    await relaxEmptyLast(page, appData.singleName).catch(() => {});
  }
  // একাধিক সেকশনের "পরবর্তী" একসাথে দৃশ্যমান থাকলে সবার নিচেরটি (চলমান সেকশনেরটিই) বাছাই করি —
  // নাহলে ভুল সেকশনের বাটনে ক্লিক পড়ে চুপচাপ আটকে থাকতে পারে (2026-10-11 live ধরা পড়েছে)
  const btnSels = ['button:has-text("পরবর্তী")', 'button:has-text("Next")'];
  let el = null;
  const deadline = Date.now() + 12000;
  while (!el && Date.now() < deadline) {
    const found = [];
    for (const sel of btnSels) {
      const n = await page.locator(sel).count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const cand = page.locator(sel).nth(i);
        try {
          if (await cand.isVisible()) {
            const bb = await cand.boundingBox();
            if (bb) found.push({ cand, y: bb.y });
          }
        } catch { /* next */ }
      }
    }
    if (found.length) { found.sort((a, b) => a.y - b.y); el = found[found.length - 1].cand; break; }
    await page.waitForTimeout(350);
  }
  if (!el) {
    const reason = `"${label}" বাটন পাওয়া যায়নি`;
    status(socket, 'PROGRESS', `⚠ ${reason}`, 'warn');
    return { ok: false, field: label, reason };
  }
  // BDRIS "পরবর্তী" required পূর্ণ না হলে disabled রাখে
  let enabled = await el.isEnabled().catch(() => true);
  if (!enabled) {
    status(socket, 'PROGRESS', `⏳ "${label}" বাটন এখনো সক্রিয় হয়নি — ৩ সেকেন্ড অপেক্ষা…`, 'warn');
    await page.waitForTimeout(3000);
    enabled = await el.isEnabled().catch(() => true);
  }
  if (!enabled) {
    const reason = `"${label}" বাটন সক্রিয় হয়নি — কোনো আবশ্যক (*) ঘর বাদ পড়েছে বা ভুল আছে`;
    status(socket, 'PROGRESS', `⚠ ${reason}`, 'warn');
    return { ok: false, field: label, reason };
  }
  const beforeUrl = page.url();
  try {
    const binfo = await el.evaluate((e) => {
      let p = e, sec = '';
      for (let i = 0; i < 10 && p; i++, p = p.parentElement) { if (p.id) { sec = p.id; break; } }
      return `"${(e.innerText || '').trim().slice(0, 22)}" @${sec || '?'}`;
    });
    console.log('CLICK-NEXT:', binfo);
  } catch { /* ডায়াগনস্টিক — ব্যর্থ হলেও চলবে */ }
  await robustClick(el, `next:${label}`, 10000);
  status(socket, 'PROGRESS', `✔ "${label}" ক্লিক করা হয়েছে`, 'ok');
  // এগোনোর লক্ষণ: URL বদল / বাটন লুকানো / পরের ধাপের anchor
  try {
    await page.waitForFunction(([u]) => location.href !== u, [beforeUrl], { timeout: 3000 }).catch(() => {});
    await el.waitFor({ state: 'hidden', timeout: 6000 }).catch(() => {});
    if (opts.nextAnchor) {
      await waitVisible(opts.nextAnchor, 8000);
    }
  } catch { /* fallback নিচে */ }
  await page.waitForTimeout(900);
  return { ok: true };
}

// "পরবর্তী" ক্লিকের পর সাইট validation-এ আটকালো কিনা — modal handle-এর পরে ডাকতে হবে
// (live-verified 2026-10-10: শেষের নাম ফাঁকা থাকলে বাটন সক্রিয় দেখালেও ক্লিকে
// লাল "অনুগ্রহ করে ঘরটি পূরণ করুন!" আসে, পরের ধাপে যায় না)
async function detectValidationBlock(nextAnchorSels) {
  const msgs = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('.text-danger, .invalid-feedback').forEach(e => {
      if (e.offsetParent === null) return;
      const t = (e.innerText || '').trim();
      if (!t || seen.has(t)) return;
      seen.add(t);
      // কোন ঘরের error — কাছের input/select-এর name বের করো (ডায়াগনস্টিক)
      let field = '';
      let p = e.parentElement;
      for (let i = 0; i < 4 && p && !field; i++, p = p.parentElement) {
        const inp = p.querySelector('input:not([type=hidden]), select, textarea');
        if (inp) field = inp.name || inp.id || '';
      }
      out.push(field ? `${t} [${field}]` : t);
    });
    return out.slice(0, 3);
  }).catch(() => []);
  let advanced = true;
  if (nextAnchorSels) advanced = !!(await waitVisible(nextAnchorSels, 5000));
  if (!advanced || msgs.length) {
    return {
      blocked: true,
      reason: msgs.length ? `সাইট এগোতে দিচ্ছে না — ${msgs.join(' | ')}` : 'ক্লিকের পর পরের ধাপ আসেনি',
    };
  }
  return { blocked: false };
}

// OTP পাঠানোর সাঁচা প্রমাণ (live bug 2026-10-11): সাইট কখনো চুপচাপ কিছু না করে —
// তাই success toast (.jq-toast-single/.jq-icon-success) বা #otpIntervalText-এর
// উপস্থিতিই "সত্যিই পাঠানো হয়েছে"-এর প্রমাণ; danger toast পেলে বার্তাসহ ব্যর্থতা।
async function waitOtpEvidence(ms) {
  const deadline = Date.now() + ms;
  let last = { toasts: [], interval: false };
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const toasts = [];
      document.querySelectorAll('.jq-toast-single').forEach((t) => {
        if (t.offsetParent === null) return;
        const txt = (t.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160);
        if (!txt) return;
        toasts.push({
          txt,
          err: !!t.querySelector('.jq-icon-error, .jq-icon-error-circle'),
          ok: !!t.querySelector('.jq-icon-success, .jq-icon-success-circle'),
        });
      });
      const it = document.querySelector('#otpIntervalText');
      const sb = document.querySelector('#sendOtp');
      return {
        toasts: toasts.slice(-3),
        interval: !!(it && it.offsetParent !== null),
        sendHidden: !!(sb && sb.offsetParent === null),
      };
    }).catch(() => ({ toasts: [], interval: false, sendHidden: false }));
    last = st;
    if (st.interval || st.toasts.some((t) => t.ok)) {
      const good = st.toasts.find((t) => t.ok);
      return { ok: true, note: good ? good.txt : '' };
    }
    const bad = st.toasts.find((t) => t.err);
    if (bad) return { ok: false, reason: `সাইটের বার্তা: ${bad.txt}` };
    await page.waitForTimeout(600);
  }
  console.log('OTP-EVIDENCE-TIMEOUT:', JSON.stringify(last).slice(0, 400));
  return {
    ok: false,
    reason: last.toasts[0] ? `সাইটের বার্তা: ${last.toasts[0].txt}` : 'সাইট কোড পাঠানোর নিশ্চিত প্রমাণ দেয়নি — নম্বর দেখে আবার চেষ্টা করুন',
  };
}
// ১-নামের গেট পাস: শেষের নাম ফাঁকা (বা ডট-শুধু) থাকলে সাইট "পরবর্তী"-তে
// লাল error দিয়ে আটকায় — মেইন সার্ভারেও আটকায় (user-reported 2026-10-10)।
// বট আটকানোর কারণ parse করে খালি ঘরে প্রথম নাম বসিয়ে নিজে গেট পার হবে —
// নাগরিক যেন কখনো আটকে না পড়ে।
async function gatePassEmptyLastName(socket, data) {
  const nm = 'personInfoForBirth.';
  const fields = [
    { sels: [`#personLastNameBn`, `input[name="${nm}personLastNameBn"]`], val: transitName(data.firstNameBn), label: 'নামের শেষ অংশ (বাংলা)' },
    { sels: [`#personLastNameEn`, `input[name="${nm}personLastNameEn"]`], val: transitName(data.firstNameEn), label: 'Last Name (English)' },
  ];
  let filled = 0;
  for (const f of fields) {
    if (!hasLetters(f.val)) continue;
    const cur = await page.evaluate((sels) => {
      for (const s of sels) { const el = document.querySelector(s); if (el) return el.value || ''; }
      return '';
    }, f.sels).catch(() => '');
    if (hasLetters(cur)) continue; // ঘরে অক্ষর আছে — গেট আটকানোর কারণ এটা নয়
    const r = await typeInto(f.sels, f.val, socket, f.label, {});
    if (r.ok) filled++;
  }
  return filled;
}

// ═══════════ আবেদনের কপি PDF — যাচাই + নিজস্ব অফিসিয়াল কপি তৈরি ═══════════
// সাইটের ডাউনলোড stub/অসম্পূর্ণ হলে (যেমন ৭৪-বাইট empty PDF) নিজেরা A4
// "আবেদন কপি" বানাই — ইউজার যেন ভাঙা ফাইল কখনো না পান
function isValidPdf(buf) {
  if (!buf || buf.length < 1200) return false;
  return buf.slice(0, 5).toString('latin1') === '%PDF-';
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtBnDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso);
  const months = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
    'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];
  const bn = { 0: '০', 1: '১', 2: '২', 3: '৩', 4: '৪', 5: '৫', 6: '৬', 7: '৭', 8: '৮', 9: '৯' };
  const toBn = (x) => String(x).replace(/\d/g, (d) => bn[d]);
  return toBn(String(parseInt(m[3], 10))) + ' ' + months[parseInt(m[2], 10) - 1] + ' ' + toBn(m[1]);
}

function addrLine(a) {
  if (!a) return '';
  return [a.houseBn, a.vilBn, a.postBn, a.paurasavaUnion, a.ward,
    a.cityCorpUpazila, a.district, a.division].filter(Boolean).join(', ');
}

function buildCopyHtml(num, d) {
  const s1 = d.s1 || {}, s2 = d.s2 || {}, s2b = d.s2b || {}, s3 = d.s3 || {}, s4 = d.s4prep || {};
  const f = s2.father || {}, m = s2.mother || {};
  const nameBn = [s1.firstNameBn, s1.lastNameBn].filter(Boolean).join(' ');
  const nameEn = [s1.firstNameEn, s1.lastNameEn].filter(Boolean).join(' ');
  const docs = (Array.isArray(s3.docs) ? s3.docs : []).map(x => x && x.name).filter(Boolean).join(', ');
  const permAddr = s2b.permCopy ? addrLine(s1) : addrLine(s2b.perm);
  const presAddr = s2b.presCopy ? permAddr : addrLine(s2b.pres);
  const rows = [
    ['আবেদনকারীর নাম (বাংলা)', nameBn],
    ['Name (English)', nameEn],
    ['জন্ম তারিখ', fmtBnDate(s1.dob)],
    ['জন্মস্থান', addrLine(s1)],
    ['পিতার নাম', f.nameBn || ''],
    ['পিতার জন্ম নিবন্ধন নম্বর', f.brn || ''],
    ['মাতার নাম', m.nameBn || ''],
    ['মাতার জন্ম নিবন্ধন নম্বর', m.brn || ''],
    ['স্থায়ী ঠিকানা', permAddr],
    ['বর্তমান ঠিকানা', presAddr],
    ['মোবাইল নম্বর', s4.phone || ''],
    ['ইমেইল', s4.email || ''],
    ['সংযুক্ত ডকুমেন্ট', docs],
  ].filter(r => r[1]);
  const trs = rows.map(r => `<tr><th>${escHtml(r[0])}</th><td>${escHtml(r[1])}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="bn"><head><meta charset="utf-8"><title>আবেদন কপি</title><style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Nirmala UI','Noto Sans Bengali','Vrinda','SolaimanLipi',sans-serif; color: #14301f; margin: 0; }
    .wrap { border: 2px solid #0a7d43; border-radius: 10px; overflow: hidden; }
    .head { background: #0a7d43; color: #fff; text-align: center; padding: 14px 10px 12px; }
    .head .bn { font-size: 21px; font-weight: 700; }
    .head .sub { font-size: 15px; margin-top: 3px; }
    .head .en { font-size: 11px; letter-spacing: 1.5px; opacity: .9; margin-top: 4px; }
    .tag { text-align: center; font-size: 13px; font-weight: 700; color: #0a7d43; padding: 10px 0 2px; }
    .num { margin: 8px 22px 4px; background: #f3faf5; border: 2px dashed #0a7d43; border-radius: 8px; text-align: center; padding: 10px; }
    .num .lbl { font-size: 11px; color: #4a6b58; }
    .num .val { font-size: 24px; font-weight: 800; letter-spacing: 2px; color: #0a5d33; margin-top: 2px; }
    .ok { text-align: center; margin: 6px 0 2px; font-size: 12px; color: #0a7d43; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-top: 1px solid #d7e4dc; padding: 7px 12px; font-size: 12.5px; text-align: left; vertical-align: top; }
    th { width: 38%; background: #f6faf7; color: #0a5d33; font-weight: 600; }
    .foot { margin-top: 12px; display: flex; justify-content: space-between; align-items: center; font-size: 10.5px; color: #55705f; padding: 0 4px; }
    .stamp { border: 2px solid #c23b2e; color: #c23b2e; font-size: 11px; font-weight: 700; padding: 5px 10px; border-radius: 6px; transform: rotate(-3deg); }
  </style></head><body><div class="wrap">
    <div class="head">
      <div class="bn">গণপ্রজাতন্ত্রী বাংলাদেশ সরকার</div>
      <div class="bn sub">জন্ম নিবন্ধন অনলাইন আবেদন — আবেদন কপি</div>
      <div class="en">BDRIS — BIRTH REGISTRATION APPLICATION COPY</div>
    </div>
    <div class="tag">✔ আবেদন সফলভাবে জমা হয়েছে</div>
    ${num ? `<div class="num"><div class="lbl">আবেদন নম্বর</div><div class="val">${escHtml(num)}</div></div>` : ''}
    <div class="ok">অনলাইন জন্ম নিবন্ধন আবেদনের (bdris.gov.bd) কপি — ভবিষ্যতের জন্য সংরক্ষণ করুন</div>
    <table>${trs}</table>
    <div class="foot"><span>তৈরি: ${escHtml(new Date().toLocaleString('bn-BD'))}</span>
      <span class="stamp">অনলাইন কপি</span></div>
  </div></body></html>`;
}

async function generateCopyPdf(num, d) {
  const p = await context.newPage();
  try {
    await p.setContent(buildCopyHtml(num, d), { waitUntil: 'load' });
    await p.waitForTimeout(400);
    return await p.pdf({ format: 'A4', printBackground: true });
  } finally { await p.close().catch(() => {}); }
}

// BDRIS ডুপ্লিকেট/possible-duplicate সতর্কতা — main server আটকায়,
// আমাদের বট আটকাবে না: সতর্কতা স্বীকার করে এগিয়ে যাবে।
async function dismissNotices(socket) {
  let bodyText = '';
  try { bodyText = await page.evaluate(() => document.body.innerText || ''); } catch { return false; }
  if (!/duplicate|ডুপ্লিকেট/i.test(bodyText)) return false;
  status(socket, 'PROGRESS', '⚠️ BDRIS ডুপ্লিকেট সতর্কতা দেখাচ্ছে — স্বীকার করে এগোনো হচ্ছে', 'warn');
  const btn = await waitVisible([
    'button:has-text("ঠিক আছে")', 'button:has-text("OK")', 'button:has-text("বুঝেছি")',
    'button:has-text("এগিয়ে যান")', 'button:has-text("হ্যাঁ")', 'button:has-text("Yes")',
    'button:has-text("Continue")', 'button:has-text("অবিরত রাখুন")',
  ], 6000);
  if (btn) {
    await robustClick(btn, 'ডুপ্লিকেট-সতর্কতা OK', 5000);
    await page.waitForTimeout(1200);
    status(socket, 'PROGRESS', '✔ ডুপ্লিকেট সতর্কতা স্বীকার করে এগোনো হলো', 'ok');
    return true;
  }
  status(socket, 'PROGRESS', '⚠️ ডুপ্লিকেট সতর্কতা সামলানো যায়নি — একটু পরে আবার চেষ্টা করুন', 'warn');
  return false;
}

// "অ্যাটাচমেন্ট অ্যাভেইলেবিলিটি চেক" modal (৪৫+ দিন বয়সে আসে)
async function handleAttachmentModal(socket, docsAvailable) {
  const modalText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  if (!/অ্যাটাচমেন্ট অ্যাভেইলেবিলিটি চেক/.test(modalText)) return { ok: true, shown: false };
  status(socket, 'PROGRESS', '📋 কাগজপত্র নিশ্চিতকরণের বার্তা এসেছে — সামলানো হচ্ছে', 'info');
  if (!docsAvailable) {
    return { ok: false, shown: true, reason: 'প্রয়োজনীয় ডকুমেন্ট হাতে নেই — BDRIS এগোতে দেবে না' };
  }
  const btn = await waitVisible(['button:has-text("আমার কাছে এই ডকুমেন্টগুলি আছে")'], 8000);
  if (!btn) return { ok: false, shown: true, reason: 'কাগজপত্র সংক্রান্ত বার্তার "আছে" বাটন পাওয়া যায়নি — আবার চেষ্টা করুন' };
  const clicked = await robustClick(btn, 'ডকুমেন্ট-আছে বাটন', 6000);
  if (!clicked) return { ok: false, shown: true, reason: 'কাগজপত্র সংক্রান্ত বার্তার বাটনে ক্লিক হয়নি — আবার চেষ্টা করুন' };
  await page.waitForTimeout(1200);
  status(socket, 'PROGRESS', '✔ ডকুমেন্ট আছে নিশ্চিত করা হয়েছে', 'ok');
  return { ok: true, shown: true };
}

// ═══════════ ধাপ-মিলকরণ (ensureAligned, 2026-10-11) ═══════════
// লকস্টেপ নিয়ম: ইউজার ফিরে গিয়ে সম্পাদনা করলে কেবল সেই এক ধাপই সাইটে যায়;
// কিন্তু সাইট তখন অন্য ধাপে থাকতে পারে (সামনে / পিছনে / নতুন সেশন)। এখানে সাইটকে
// ঠিক ধাপে ফেরাই — সামনে থাকলে "পূর্ববর্তী" ক্লিক, না পারলে ফর্ম রিলোড করে ctx
// থেকে ধাপে ধাপে আবার বসানো; পিছনে থাকলে একইভাবে ক্যাচ-আপ। নাগরিক আটকাবে না।
const OP_ALIGN = { SUBMIT_S0: 1, SUBMIT_S1: 2, SUBMIT_S2: 3, SUBMIT_S2B: 4, SUBMIT_S3_DOCS: 5 };

// সাইট এখন কোন ধাপে — একবার page.evaluate-তে সব anchor প্রোব (mock + আসল দুটোতেই চলে)
async function detectSiteStep() {
  return page.evaluate(() => {
    const vis = (sels) => {
      for (const s of sels) {
        try {
          const e = document.querySelector(s);
          if (e && e.offsetParent !== null && e.getClientRects().length) return true;
        } catch { /* next */ }
      }
      return false;
    };
    const steps = [
      [6, ['#email', 'input[name="email"]']],
      [5, ['input[name="relationWithApplicant"]', 'input[name="files"]', '#filesInput']],
      [4, ['select[name="permAddrDiv"]', 'input[name="copyBirthPlaceToPermAddr"]', '#permFields']],
      [3, ['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]']],
      [2, ['#personFirstNameBn', 'input[name="personInfoForBirth.personFirstNameBn"]', '#personBirthDate']],
      [1, ['#officeBirthplace', 'input[name="officeAddressType"]']],
    ];
    for (const [n, sels] of steps) if (vis(sels)) return n;
    return 0; // চেনা যায়নি (খালি/সাকসেস পেজ)
  }).catch(() => 0);
}

// ফর্ম নতুন করে লোড (SUBMIT_S0-র প্রমাণিত প্যাটার্ন — root দিয়ে ঢুকে referer ছাড়া 403 এড়ানো)
async function reloadForm() {
  if (!MOCK_MODE) await page.goto('https://bdris.gov.bd', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.goto(TARGET_URL(), {
    waitUntil: 'domcontentloaded', timeout: 45000,
    ...(MOCK_MODE ? {} : { referer: 'https://bdris.gov.bd/' }),
  }).catch(() => {});
  await page.waitForTimeout(1500);
}

// সাইট target-এর চেয়ে সামনে থাকলে "পূর্ববর্তী" ক্লিক করে পিছিয়ে আনি —
// প্রতিটি ক্লিকে ধাপ সত্যিই বদলেছে কি না যাচাই করি; না পারলে false (=> রিলোড-রিপ্লে)
async function clickPrevToStep(socket, target) {
  for (let tries = 0; tries < 6; tries++) {
    const at = await detectSiteStep();
    if (at <= target) return true;
    const found = [];
    for (const sel of ['button:has-text("পূর্ববর্তী")', 'button:has-text("Previous")']) {
      const n = await page.locator(sel).count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const cand = page.locator(sel).nth(i);
        try {
          if (await cand.isVisible()) {
            const bb = await cand.boundingBox();
            if (bb) found.push({ cand, y: bb.y });
          }
        } catch { /* next */ }
      }
      if (found.length) break;
    }
    if (!found.length) return false;
    found.sort((a, b) => a.y - b.y);
    const btn = found[found.length - 1].cand;
    await robustClick(btn, 'পূর্ববর্তী', 8000);
    status(socket, 'PROGRESS', '↩️ সাইট ঠিক ধাপে ফেরানো হচ্ছে…', 'info');
    let moved = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 7000) {
      await page.waitForTimeout(400);
      if ((await detectSiteStep()) < at) { moved = true; break; }
    }
    if (!moved) return false;
  }
  return (await detectSiteStep()) <= target;
}

// সাইট পিছনে (বা নতুন সেশন): ctx থেকে ধাপে ধাপে আবার বসাই — যেখানে আছি সেখান
// থেকে গন্তব্য ধাপের আগ পর্যন্ত অপগুলোই (প্রতিটি core ack ছাড়া, শুধু বসায়+এগোয়)
async function catchUpReplay(socket, at, need, ctx) {
  ctx = ctx || {};
  if (at < 1) { await reloadForm(); at = await detectSiteStep(); }
  if (at > need) return { ok: false, reason: 'সাইটকে ঠিক ধাপে ফেরানো যায়নি — ↺ রিসেট করে আবার চেষ্টা করুন' };
  const cores = [applyS0Core, applyS1Core, applyS2Core, applyS2BCore];
  const dataFor = (idx) => {
    if (idx === 0) return ctx.s0 || {};
    if (idx === 1) return Object.assign({ docsAvailable: true }, ctx.s1 || {});
    if (idx === 2) return Object.assign({}, ctx.s2 || {}, { applicantDob: (ctx.s1 || {}).dob });
    if (idx === 3) return Object.assign({}, ctx.s2b || {});
    return {};
  };
  for (let j = Math.max(0, at - 1); j <= need - 2; j++) {
    status(socket, 'PROGRESS', `↻ আগের ধাপ ${j + 1} আবার সাইটে বসানো হচ্ছে…`, 'info');
    let r;
    try { r = await withTimeout(cores[j](socket, dataFor(j)), STEP_TIMEOUT_MS, `মেরামত ধাপ ${j + 1}`); }
    catch (e) { console.error('CATCHUP:', j + 1, e && e.message); return { ok: false, reason: `আগের ধাপ ${j + 1} আবার বসানো যায়নি — “আবার চেষ্টা করুন” চাপুন` }; }
    if (r.blocked) return { ok: false, reason: r.reason || `আগের ধাপ ${j + 1}-এ সাইট আটকে গেছে` };
  }
  return { ok: true };
}

// op চালানোর আগে সাইটকে দরকারি ধাপে আনি — এটাই "fallback logic"
async function ensureAligned(socket, op, ctx) {
  const need = OP_ALIGN[op];
  if (!need || !page) return { ok: true };
  let at = await detectSiteStep();
  if (at === need) return { ok: true };
  if (at > need) {
    status(socket, 'PROGRESS', '↩️ সাইট দরকারি ধাপে ফেরানো হচ্ছে…', 'info');
    if (await clickPrevToStep(socket, need)) return { ok: true };
    status(socket, 'PROGRESS', '↻ ধাপ মিলাতে ফর্ম নতুন করে সাজানো হচ্ছে…', 'info');
    await reloadForm();
    at = await detectSiteStep();
    if (at === need) return { ok: true };
    if (at > need) return { ok: false, reason: 'সাইটকে ঠিক ধাপে ফেরানো যায়নি — ↺ রিসেট করে আবার চেষ্টা করুন' };
  }
  return await catchUpReplay(socket, at, need, ctx);
}

// parent Verify বাটন → রেজিস্ট্রি ফলাফল পড়া
// STALE-TEXT FIX: পুরো পেজে পড়ে-থাকা "not found" (আগের রান/অন্য person-এর) ভুল
// নেগেটিভ দিত — তাই শুধু Verify বাটনের আশপাশ পড়ি, আগে/পরে মিলিয়ে নিশ্চিত হই
async function clickVerify(socket, index, who, opts = {}) {
  // স্থির id প্রাইমারি (#father-check/#mother-check) — index-সমস্যা নয় (audit fix 2026-10-11)
  const idSel = index === 0 ? '#father-check' : (index === 1 ? '#mother-check' : null);
  const readNear = () => page.evaluate((a) => {
    let b = a.sel ? document.querySelector(a.sel) : null;
    if (!b) {
      const btns = Array.from(document.querySelectorAll('button'))
        .filter(x => /verify/i.test(x.innerText || ''));
      b = btns[a.idx];
    }
    if (!b) return '';
    let el = b;
    for (let i = 0; i < 3 && el.parentElement; i++) el = el.parentElement;
    return (el.innerText || '').replace(/\s+/g, ' ').trim();
  }, { sel: idSel, idx: index }).catch(() => '');
  let btn = null;
  if (idSel) {
    const l = page.locator(idSel).first();
    if ((await l.count().catch(() => 0)) && (await l.isVisible().catch(() => false))) btn = l;
  }
  if (!btn) {
    const btns = page.locator('button:has-text("Verify")');
    const n = await btns.count().catch(() => 0);
    if (n <= index) {
      if (!opts.quietMissing)
        status(socket, 'PROGRESS', `⚠ ${who}-এর Verify বাটন পাওয়া যায়নি`, 'warn');
      return { verified: null };
    }
    const cand = btns.nth(index);
    if (!(await cand.isVisible().catch(() => false))) {
      if (!opts.quietMissing)
        status(socket, 'PROGRESS', `⚠ ${who}-এর Verify বাটন দৃশ্যমান নয়`, 'warn');
      return { verified: null };
    }
    btn = cand;
  }
  const before = await readNear();
  await btn.click();
  status(socket, 'PROGRESS', `⏳ ${who}-এর BRN যাচাই হচ্ছে…`, 'info');
  let sawProgress = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const t = await readNear();
    if (/যাচাই হচ্ছে|যাচাই চলছে/.test(t)) { sawProgress = true; continue; }
    const failedTxt = /no birth record|not found|পাওয়া যায়নি/i.test(t);
    const okTxt = !failedTxt && !/নয়নি/.test(t)
      && /যাচাই সফল|সফলভাবে যাচাই|যাচাই সম্পন্ন|verified|সফল/i.test(t);
    if (okTxt) {
      status(socket, 'PROGRESS', `✔ ${who}-এর BRN যাচাই সফল`, 'ok');
      return { verified: true };
    }
    if (failedTxt) {
      // আগের ডেড বার্তা নাকি এই ক্লিকের ফল? — progress দেখা গেলে বা টেক্সট
      // বদলালেই বিশ্বাস করি; নইলে uncertain (সাইটের পরের ধাপই চূড়ান্ত বিচারক)
      if (sawProgress || t !== before) {
        status(socket, 'PROGRESS', `❌ ${who}-এর BRN রেজিস্ট্রিতে পাওয়া যায়নি`, 'err');
        return { verified: false };
      }
    }
  }
  status(socket, 'PROGRESS', `⚠ ${who}-এর যাচাই ফলাফল অস্পষ্ট — সাইটের পরের ধাপ দেখে সিদ্ধান্ত হবে`, 'warn');
  return { verified: null };
}

// mask-যুক্ত তারিখ ঘর (personBirthDate/fatherBirthDate/motherBirthDate): fill() মান
// খেয়ে ফেলে — ক্লিক করে অক্ষর ধরে টাইপ + EXACT read-back, ৩ বার পর্যন্ত।
// (2026-10-11 live: digits-only চেক ভুল মান "11/10/2026"-কে সঠিক ভেবে নিয়েছিল — race)
async function typeMaskedDate(selectors, dobF, socket, fieldName) {
  const el = await waitEl(selectors);
  if (!el) {
    status(socket, 'PROGRESS', `⚠ ${fieldName} ঘর পাওয়া যায়নি`, 'warn');
    return { ok: false, field: fieldName, reason: `${fieldName} ঘর পাওয়া যায়নি` };
  }
  const want = String(dobF).replace(/\s+/g, '');
  let got = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await el.click({ timeout: 4000 }).catch(() => {});
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await el.type(String(dobF), { delay: 80 });
      await page.keyboard.press('Tab').catch(() => {});
      await page.waitForTimeout(350);
      got = await page.evaluate((sels) => {
        for (const s of sels) { const e = document.querySelector(s); if (e) return e.value || ''; }
        return '';
      }, selectors).catch(() => '');
      if (String(got).replace(/\s+/g, '') === want) {
        status(socket, 'PROGRESS', `✔ ${fieldName}: "${got}"`, 'ok');
        return { ok: true };
      }
    } catch { /* পরের চেষ্টা */ }
  }
  status(socket, 'PROGRESS', `⚠ ${fieldName} ঠিকভাবে বসেনি (ঘরে আছে "${got}")`, 'warn');
  return { ok: false, field: fieldName, reason: `${fieldName} ঘরে সঠিক মান বসেনি` };
}

async function findBdrisSelectors() {
  try {
    const info = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input, select, textarea, button'));
      return els.slice(0, 80).map(e => ({
        tag: e.tagName.toLowerCase(), id: e.id || '', name: e.name || '',
        type: e.type || '', text: (e.innerText || e.placeholder || '').slice(0, 24),
      }));
    });
    console.log('📋 BDRIS elements:', JSON.stringify(info));
  } catch { /* ignore */ }
}

async function closeBrowser() {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  browser = null; context = null; page = null; isLaunching = false;
  sessionOwner = null; // C-1 fix: browser বন্ধ হলে লকও যাবে
  appData = {};
  applicantDobIso = null;
}

// ═══════════ HTTP routes ═══════════
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    bot: {
      browserOpen: !!browser, pageOpen: !!page, launching: isLaunching,
      idleSec: Math.round((Date.now() - lastActivity) / 1000),
    },
    target: MOCK_MODE ? 'mock-bdris (TEST MODE)' : BDRIS_URL,
    mockMode: MOCK_MODE,
    version: 'v3-realmap',
    time: new Date().toISOString(),
  });
});

if (MOCK_MODE) {
  app.get('/mock-bdris', (req, res) => res.sendFile(path.join(__dirname, 'mock-bdris.html')));
  // অবস্থা-দেখা ফ্লো-র মক (আসল /login ও /br/application/status-এর অনুকরণ)
  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'mock-login.html')));
  app.get('/br/application/status', (req, res) => res.sendFile(path.join(__dirname, 'mock-status.html')));
  app.post('/mock-report', (req, res) => {
    mockReports.push({ at: new Date().toISOString(), ...req.body });
    res.json({ ok: true, count: mockReports.length });
  });
  app.get('/mock-reports', (req, res) => res.json(mockReports));
  app.delete('/mock-reports', (req, res) => { mockReports.length = 0; res.json({ ok: true }); });
}

// ═══════════ Socket.IO ═══════════
io.on('connection', (socket) => {
  console.log(`[${ts()}] ⚡ UI connected: ${socket.id}`);
  touchSession();

  // ট্যাব খোলা থাকলেই সেশন জাগিয়ে রাখার নীরব হার্টবিট — UI-তে কিছুই দেখায় না।
  // এতে ইউজার কিছুক্ষণ দূরে গিয়ে ফিরে এলেও বট প্রস্তুত থাকে (“atke gelo” আর নয়)।
  socket.on('KEEPALIVE', () => touchSession());

  socket.on('GET_DOM_OPTIONS', async (selector, callback) => {
    touchSession();
    try {
      // সেশন চালু হতে দেরি হলে অপেক্ষা (নাগরিক দ্রুত ধাপ-২ খুললেও তালিকা হারাবে না)
      for (let i = 0; i < 20 && !page; i++) await new Promise((r) => setTimeout(r, 500));
      if (!page) return callback({ error: 'Bot not ready' });
      // সাইট এখনো ট্রানজিশনে থাকলে এলিমেন্টের জন্য অপেক্ষা — অকারণে text-fallback এড়াতে
      await page.waitForSelector(selector, { state: 'attached', timeout: 8000 }).catch(() => {});
      const scrape = () => page.evaluate((sel) => {
        const selectors = sel.includes(',') ? sel.split(',').map(s => s.trim()) : [sel];
        let el = null;
        for (const s of selectors) { el = document.querySelector(s); if (el) break; }
        if (!el) return [];
        return Array.from(el.options)
          .filter(o => o.value && o.value !== '-1' && o.value !== '' && o.text.trim() !== '' && !/নির্বাচন করুন/.test(o.text))
          .map(o => ({ id: o.value, name: o.text.trim() }));
      }, selector);
      let options = await scrape();
      // সাইটের cascade AJAX দেরিতে আসে (dist বসার পর cc/pu/ward লোড হয়) — খালি থাকলে কয়েক দফা অপেক্ষা
      for (let i = 0; i < 5 && !options.length; i++) {
        await page.waitForTimeout(1200);
        options = await scrape();
      }
      console.log('DOM-GET:', String(selector).slice(0, 80), '→', options.length);
      if (!options.length) console.log('DOM-GET-SNAP:', JSON.stringify(await domSnapshot(
        selector.includes(',') ? selector.split(',').map(s => s.trim()) : [selector])).slice(0, 900));
      callback(options);
    } catch (e) {
      console.error('Scrape Error:', e.message);
      callback({ error: 'Failed to read DOM' });
    }
  });

  socket.on('SELECT_DOM_OPTION', async (data, callback) => {
    touchSession();
    try {
      if (!page) return callback({ error: 'Bot not ready' });
      const { selector, label, childSelector, value } = data;
      const selectors = selector.includes(',') ? selector.split(',').map(s => s.trim()) : [selector];
      // দ্রুত খুঁজি: visible → attached (লুকানো native select-ও valid — সাইটের উইজেট-ধাঁচ;
      // দেরি করলে UI-র 14s mirror উইন্ডো শেষ হয়ে যায়)
      const visFind = async () => {
        for (const s of selectors) {
          let n = 0;
          try { n = await page.locator(s).count(); } catch { n = 0; }
          for (let i = 0; i < n; i++) {
            const cand = page.locator(s).nth(i);
            try { if (await cand.isVisible()) return cand; } catch { /* next */ }
          }
        }
        return null;
      };
      let el = await visFind();
      let hidden = false;
      if (!el) {
        for (const s of selectors) {
          const loc = page.locator(s).first();
          try { if (await loc.count()) { el = loc; hidden = true; break; } } catch { /* next */ }
        }
      }
      if (!el) {
        for (const s of selectors) { el = await waitVisible(s, 8000); if (el) break; }
      }
      if (el) {
        let done = false, usedCand = null;
        const scanned = await scanOptionValue(selectors, label).catch(() => null);
        // DOM-লেভেল সেটার (jQuery/select2 change ধরে নেয়)। দ্রষ্টব্য: locator.evaluate-এ একটাই
        // arg যায় — তাই val/lbl একসাথে অবজেক্টে পাঠাই (দুই-arg দিলে lbl চুপচাপ হারিয়ে যায়)
        const domSet = () => el.evaluate((node, a) => {
          const norm = (s) => String(s || '')
            .replace(/[\u09DC]/g, '\u09A1\u09BC').replace(/[\u09DD]/g, '\u09A2\u09BC')
            .replace(/[\u09DF]/g, '\u09AF\u09BC').replace(/[\u0981\u200C\u200D]/g, '')
            .replace(/\s+/g, ' ').trim();
          let opt = null;
          if (a.val) opt = Array.from(node.options).find(o => o.value === String(a.val));
          if (!opt && a.lbl) {
            const w = norm(a.lbl);
            opt = Array.from(node.options).find(o => norm(o.text) === w) ||
              Array.from(node.options).find(o => { const t = norm(o.text); return t && (t.includes(w) || w.includes(t)); });
          }
          if (!opt) return false;
          node.value = opt.value;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }, { val: value || null, lbl: String(label || '') }).catch(() => false);
        if (hidden) {
          // লুকানো native select — সাইটের উইজেট মাঝে মাঝে select পুনর্নির্মাণ করে
          // (live 2026-10-11: dist mirror-এর ঠিক আগে 6 → 1) — তাই কয়েকবার চেষ্টা;
          // locator প্রতিবার নতুন করে খোঁজে, তাই node বদলালেও ধরতে পারে
          for (let attempt = 0; attempt < 12 && !done; attempt++) {
            done = await domSet();
            if (!done) await page.waitForTimeout(600);
          }
          if (done) usedCand = value || 'dom';
        }
        if (!done && !hidden) {
          // সাইটের নিজের value সবার আগে (UI থেকে আসা) — লেবেল-মিলের ঝুঁকি নেই
          for (const cand of [...new Set([value, scanned, label].filter(Boolean))]) {
            try { await el.selectOption(cand, { timeout: 6000 }); done = true; usedCand = cand; break; } catch { /* পরের কৌশল */ }
          }
          if (!done) {
            try { await el.selectOption({ label }, { timeout: 5000 }); done = true; } catch { /* নিচে */ }
          }
        }
        if (!done && hidden) {
          for (const cand of [...new Set([value, scanned, label].filter(Boolean))]) {
            try { await el.selectOption(cand, { timeout: 4000 }); done = true; usedCand = cand; break; } catch { /* next */ }
          }
        }
        if (!done) {
          console.log('DOM-SEL:', String(selector).slice(0, 60), `"${label}"`, 'opt-not-found' + (hidden ? ' (hidden)' : ''), 'value=' + JSON.stringify(value || null));
          console.log('DOM-SNAP:', JSON.stringify(await domSnapshot(selectors)).slice(0, 900));
          return callback({ error: `Option not found: ${label}` });
        }
        await page.waitForTimeout(600);
        let childOk = null;
        if (childSelector) {
          const childSelectors = childSelector.includes(',')
            ? childSelector.split(',').map(s => s.trim()) : [childSelector];
          const childReady = async () => {
            for (const cSel of childSelectors) {
              const found = await page.waitForFunction((sel) => {
                const child = document.querySelector(sel);
                return child && child.options.length > 1;
              }, cSel, { timeout: 10000 }).catch(() => null);
              if (found) return true;
            }
            return false;
          };
          childOk = await childReady();
          if (!childOk && usedCand) {
            // সাইটের AJAX মাঝে মাঝে প্রথমবার আসে না — আবার সেট করে তালিকা আনাই
            if (hidden || value) { try { await domSet(); } catch { /* ignore */ } }
            else { try { await el.selectOption(usedCand, { timeout: 6000 }); } catch { /* ignore */ } }
            childOk = await childReady();
          }
        }
        console.log('DOM-SEL:', String(selector).slice(0, 60), `"${label}"`,
          'via=' + (usedCand === value && value ? 'value' : (usedCand === scanned && scanned ? 'scan' : 'label')) + (hidden ? '/hidden' : ''),
          childOk === null ? '' : (childOk ? 'child-ok' : 'child-empty'));
      } else {
        console.log('DOM-SEL:', String(selector).slice(0, 60), `"${label}"`, 'no-el');
      }
      callback({ success: true });
    } catch (e) {
      console.error('Select Error:', e.message);
      callback({ error: 'অপশন তালিকা আনা যায়নি — আবার চেষ্টা করুন' });
    }
  });

  // ── LIVE SYNC: UI-তে টাইপ করা মান real site-এ সঙ্গে সঙ্গে বসাও (নীরবে, status নেই) ──
  const LIVE_MAP = {
    's1.firstNameBn': { sel: ['#personFirstNameBn', 'input[name="personInfoForBirth.personFirstNameBn"]'], name: true },
    's1.lastNameBn': { sel: ['#personLastNameBn', 'input[name="personInfoForBirth.personLastNameBn"]'], name: true },
    's1.firstNameEn': { sel: ['#personFirstNameEn', 'input[name="personInfoForBirth.personFirstNameEn"]'], name: true },
    's1.lastNameEn': { sel: ['#personLastNameEn', 'input[name="personInfoForBirth.personLastNameEn"]'], name: true },
    's1.dob': { sel: ['#personBirthDate', 'input[name="personInfoForBirth.personBirthDate"]'], dob: true },
    's1.thChild': { sel: ['#thChild', 'select[name="personInfoForBirth.thChild"]'], select: true },
    's1.gender': { sel: ['#gender', 'select[name="personInfoForBirth.gender"]'], select: true },
    's1.country': { sel: ['#birthPlaceCountry', 'select[name="birthPlaceCountry"]'], select: true },
    's1.postBn': { sel: ['#birthPlacePostOfc', 'input[name="birthPlacePostOfc"]'] },
    's1.postEn': { sel: ['#birthPlacePostOfcEn', 'input[name="birthPlacePostOfcEn"]'] },
    's1.vilBn': { sel: ['#birthPlaceVilAreaTownBn', 'textarea[name="birthPlaceVilAreaTownBn"]'] },
    's1.vilEn': { sel: ['#birthPlaceVilAreaTownEn', 'textarea[name="birthPlaceVilAreaTownEn"]'] },
    's1.houseBn': { sel: ['#birthPlaceHouseRoadBn', 'textarea[name="birthPlaceHouseRoadBn"]'] },
    's1.houseEn': { sel: ['#birthPlaceHouseRoadEn', 'textarea[name="birthPlaceHouseRoadEn"]'] },
    's1.postCode': { sel: ['#birthPlacePostCode', 'input[name="birthPlacePostCode"]'], digits: true },
    's3.fatherBrn': { sel: ['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]'], digits: true },
    's3.fatherDob': { sel: ['#fatherBirthDate', 'input[name="personInfoForBirth.father.personBirthDate"]'], dob: true },
    's3.fatherBn': { sel: ['#fatherNameBn', 'input[name="personInfoForBirth.father.personNameBn"]'], name: true },
    's3.fatherEn': { sel: ['#fatherNameEn', 'input[name="personInfoForBirth.father.personNameEn"]'], name: true },
    's3.fatherNat': { sel: ['#fatherNationality', 'select[name="personInfoForBirth.father.personNationality"]'], select: true },
    's3.motherBrn': { sel: ['#motherBrn', 'input[name="personInfoForBirth.mother.ubrn"]'], digits: true },
    's3.motherDob': { sel: ['#motherBirthDate', 'input[name="personInfoForBirth.mother.personBirthDate"]'], dob: true },
    's3.motherBn': { sel: ['#motherNameBn', 'input[name="personInfoForBirth.mother.personNameBn"]'], name: true },
    's3.motherEn': { sel: ['#motherNameEn', 'input[name="personInfoForBirth.mother.personNameEn"]'], name: true },
    's3.motherNat': { sel: ['#motherNationality', 'select[name="personInfoForBirth.mother.personNationality"]'], select: true },
    's2b.perm.same': { check: '#copyBirthPlaceToPermAddr' },
    's2b.pres.same': { check: '#copyPermAddrToPrsntAddr' },
    's2b.perm.division': { sel: ['#permAddrDiv', 'select[name="permAddrDiv"]'], select: true },
    's2b.perm.district': { sel: ['#permAddrDist', 'select[name="permAddrDist"]'], select: true },
    's2b.perm.cityCorpUpazila': { sel: ['#permAddrCityCorpCantOrUpazila', 'select[name="permAddrCityCorpCantOrUpazila"]'], select: true },
    's2b.perm.paurasavaUnion': { sel: ['#permAddrPaurasavaOrUnion', 'select[name="permAddrPaurasavaOrUnion"]', '#permAddrWardInCityCorp', 'select[name="permAddrWardInCityCorp"]'], select: true },
    's2b.perm.ward': { sel: ['#permAddrWardInCityCorp', 'select[name="permAddrWardInCityCorp"]', '#permAddrWardInPaurasavaOrUnion', 'select[name="permAddrWardInPaurasavaOrUnion"]'], select: true },
    's2b.perm.postBn': { sel: ['#permAddrPostOfc', 'input[name="permAddrPostOfc"]'] },
    's2b.perm.postEn': { sel: ['#permAddrPostOfcEn', 'input[name="permAddrPostOfcEn"]'] },
    's2b.perm.vilBn': { sel: ['#permAddrVilAreaTownBn', 'textarea[name="permAddrVilAreaTownBn"]'] },
    's2b.perm.vilEn': { sel: ['#permAddrVilAreaTownEn', 'textarea[name="permAddrVilAreaTownEn"]'] },
    's2b.perm.houseBn': { sel: ['#permAddrHouseRoadBn', 'textarea[name="permAddrHouseRoadBn"]'] },
    's2b.perm.houseEn': { sel: ['#permAddrHouseRoadEn', 'textarea[name="permAddrHouseRoadEn"]'] },
    's2b.pres.division': { sel: ['#prsntAddrDiv', 'select[name="prsntAddrDiv"]'], select: true },
    's2b.pres.district': { sel: ['#prsntAddrDist', 'select[name="prsntAddrDist"]'], select: true },
    's2b.pres.cityCorpUpazila': { sel: ['#prsntAddrCityCorpCantOrUpazila', 'select[name="prsntAddrCityCorpCantOrUpazila"]'], select: true },
    's2b.pres.paurasavaUnion': { sel: ['#prsntAddrPaurasavaOrUnion', 'select[name="prsntAddrPaurasavaOrUnion"]', '#prsntAddrWardInCityCorp', 'select[name="prsntAddrWardInCityCorp"]'], select: true },
    's2b.pres.ward': { sel: ['#prsntAddrWardInCityCorp', 'select[name="prsntAddrWardInCityCorp"]', '#prsntAddrWardInPaurasavaOrUnion', 'select[name="prsntAddrWardInPaurasavaOrUnion"]'], select: true },
    's2b.pres.postBn': { sel: ['#prsntAddrPostOfc', 'input[name="prsntAddrPostOfc"]'] },
    's2b.pres.postEn': { sel: ['#prsntAddrPostOfcEn', 'input[name="prsntAddrPostOfcEn"]'] },
    's2b.pres.vilBn': { sel: ['#prsntAddrVilAreaTownBn', 'textarea[name="prsntAddrVilAreaTownBn"]'] },
    's2b.pres.vilEn': { sel: ['#prsntAddrVilAreaTownEn', 'textarea[name="prsntAddrVilAreaTownEn"]'] },
    's2b.pres.houseBn': { sel: ['#prsntAddrHouseRoadBn', 'textarea[name="prsntAddrHouseRoadBn"]'] },
    's2b.pres.houseEn': { sel: ['#prsntAddrHouseRoadEn', 'textarea[name="prsntAddrHouseRoadEn"]'] },
    's5.relation': { radio: 'relationWithApplicant' },
    's6.phone': { sel: ['#phone', 'input[name="phone"]'], digits: true },
    's6.email': { sel: ['#email', 'input[name="email"]'] },
    // ধাপ ১ (আবেদনের ভিত্তি) — radio+checkbox একসাথে, নইলে সাইটে দুটো আলাদা হয়ে
    // অসম্ভব অবস্থা তৈরি হয় (checkbox তুললে সাইট নিজেই BIRTHPLACE-এ ফেরে)
    's0': { s0: true },
  };
  socket.on('LIVE_FIELD', async (data = {}) => {
    touchSession();
    try {
      if (!page) return;
      const spec = LIVE_MAP[data.key];
      if (!spec) return;
      if (spec.s0) {
        const want = (data.value && typeof data.value === 'object') ? data.value : {};
        await page.evaluate((v) => {
          const cb = document.querySelector('#bdMissionCheckbox');
          const setRadio = (id) => { const el = document.querySelector(id); if (el && !el.checked) el.click(); };
          if (v.embassy) {
            if (cb && !cb.checked) cb.click(); // সাইট নিজেই MISSION রেডিও চালু করে
            setRadio('#officeBDMission');
          } else {
            if (cb && cb.checked) cb.click(); // সাইট নিজেই BIRTHPLACE-এ ফেরে
            setRadio(v.addressType === 'PERMANENT' ? '#officePermanent' : '#officeBirthplace');
          }
        }, { addressType: String(want.addressType || 'BIRTHPLACE'), embassy: !!want.embassy }).catch(() => {});
        return;
      }
      if (spec.check) {
        const el = await waitVisible([spec.check], 1500);
        if (!el) return;
        if (data.value) await el.check().catch(() => {});
        else await el.uncheck().catch(() => {});
        return;
      }
      if (spec.radio) {
        await page.evaluate(({ name, val }) => {
          const norm = (t) => String(t || '').normalize('NFKC')
            .replace(/ড়/g, 'ড়').replace(/[\u200C\u200D]/g, '').replace(/\s+/g, ' ').trim();
          const nv = norm(val);
          for (const el of document.querySelectorAll(`input[name="${name}"]`)) {
            const v = el.value || '';
            const lab = el.closest('label') ? el.closest('label').textContent.trim() : '';
            if (norm(v) === nv || norm(lab) === nv || (v && (norm(lab).includes(nv) || nv.includes(norm(v))))) { el.click(); return; }
          }
        }, { name: spec.radio, val: String(data.value || '') }).catch(() => {});
        return;
      }
      let value = data.value;
      if (spec.name) value = transitName(value);
      if (spec.digits) value = String(value || '').replace(/[^\d]/g, '');
      if (spec.dob && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) value = isoToBdFormat(value);
      if (value === undefined || value === null) return;
      if (spec.select) {
        if (!String(value).trim()) return;
        // একাধিক select থাকলে প্রত্যেকটাতে scan করে যেটাতে মেলে সেটাতেই বসাও
        // (live-verified 2026-10-11: সিটি কর্পোরেশনে অঞ্চল WardInCityCorp-এ, ওয়ার্ড
        // WardInPaurasavaOrUnion-এ — প্রথম select-এ না মিললেও পরেরটায় মিলতে পারে)
        for (const s of spec.sel) {
          const cand = await waitVisible([s], 1200);
          if (!cand) continue;
          const has = await page.evaluate((ss) => {
            try { const e = document.querySelector(ss); return !!(e && e.options && e.options.length > 1); } catch { return false; }
          }, s).catch(() => false);
          if (!has) continue;
          const scanned = await scanOptionValue([s], value);
          for (const c of [...new Set([scanned, String(value).trim()].filter(Boolean))]) {
            try { await cand.selectOption(c, { timeout: 2000 }); console.log(`[LIVE] ${data.key}`); return; } catch { /* পরের কৌশল */ }
          }
          try { await cand.selectOption({ label: String(value).trim() }, { timeout: 2000 }); console.log(`[LIVE] ${data.key}`); return; } catch { /* next select */ }
        }
        return;
      }
      const el = await waitVisible(spec.sel, 1500);
      if (!el) return;
      if (spec.dob) {
        // mask-যুক্ত তারিখ ঘর — fill() খেয়ে ফেলে; ক্লিক করে অক্ষর ধরে টাইপ
        await el.click({ timeout: 3000 }).catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Delete').catch(() => {});
        await el.type(String(value), { delay: 60 });
      } else {
        await el.fill(String(value));
      }
      await page.keyboard.press('Tab').catch(() => {});
      console.log(`[LIVE] ${data.key}`);
    } catch { /* live sync নীরব — ব্যাচ ফিল সবসময় আছেই */ }
  });

  // ── SESSION START ──
  socket.on('START_BDRIS_SESSION', async () => {
    console.log(`[${ts()}] [START_BDRIS_SESSION] received from ${socket.id}`);
    touchSession();
    // C-1 fix: অন্য user-এর সক্রিয় সেশন থাকলে নতুন user-কে ব্যস্ত জানাও —
    // একই page/appData শেয়ার করে data corrupt করা যাবে না।
    if (sessionOwner && sessionOwner !== socket.id && page && browser && browser.isConnected()
        && Date.now() - lastActivity < SESSION_TIMEOUT_MS) {
      status(socket, 'BUSY', '⏳ অন্য একজন এখন আবেদন করছেন। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।');
      return;
    }
    if (isLaunching) {
      status(socket, 'LOADING', '⏳ সংযোগ প্রস্তুত হচ্ছে... একটু অপেক্ষা করুন');
      // প্রস্তুত হওয়ামাত্র এই socket-কেও জানাও — নইলে ২য় ট্যাব/চাপ আটকে থাকে
      for (let i = 0; i < 90 && isLaunching; i++) await new Promise(r => setTimeout(r, 1000));
      if (page && browser && browser.isConnected()) {
        status(socket, 'READY', '✅ BDRIS সেশন ইতিমধ্যে চালু আছে। ধাপ ১-এর তথ্য দিন।');
      } else {
        status(socket, 'ERROR', '❌ সংযোগ তৈরি হয়নি — আবার চেষ্টা করুন।');
      }
      return;
    }
    if (page && browser && browser.isConnected()) {
      // C-1 fix: warm সেশন — মালিক না থাকলে বা একই socket হলে মালিকানা নাও।
      // (ভিন্ন socket + সক্রিয় সেশন কেস উপরের BUSY চেকে আটকেছে।)
      if (!sessionOwner || sessionOwner === socket.id) {
        if (sessionOwner !== socket.id) { appData = {}; applicantDobIso = null; }
        sessionOwner = socket.id;
      }
      status(socket, 'READY', '✅ BDRIS সেশন ইতিমধ্যে চালু আছে। ধাপ ১-এর তথ্য দিন।');
      return;
    }
    try {
      isLaunching = true;
      status(socket, 'LOADING', '⏳ সংযোগ প্রস্তুত হচ্ছে...');

      if (browser) await browser.close().catch(() => {});
      browser = await chromium.launch({
        headless: HEADLESS,
        slowMo: SLOWMO,
        args: [
          '--start-maximized',
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-web-security',
          '--ignore-certificate-errors'
        ]
      });
      context = await browser.newContext({
        viewport: null,
        locale: 'bn-BD',
        acceptDownloads: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ignoreHTTPSErrors: true,
      });
      page = await context.newPage();

      // ডায়াগনস্টিক (2026-10-11): সাইট OTP ক্লিকে চুপ থাকলে কারণ বের করা —
      // পেজ-কনসোল, JS এরর, নেটিভ ডায়ালগ, আর sendOtp/verifyOtp-এর সত্যিকারের রেসপন্স।
      page.on('console', (msg) => {
        const t = String(msg.text() || '');
        if (t) console.log('PAGE-CONSOLE[' + msg.type() + ']: ' + t.slice(0, 300));
      });
      page.on('pageerror', (err) => console.log('PAGE-ERROR: ' + String((err && err.message) || err).slice(0, 300)));
      page.on('dialog', async (d) => {
        console.log('PAGE-DIALOG[' + d.type() + ']: ' + String(d.message() || '').slice(0, 300));
        await d.dismiss().catch(() => {});
      });
      page.on('response', (res) => {
        try {
          const u = res.url();
          const st = res.status();
          if (/otp/i.test(u)) {
            res.text().then((body) => {
              lastOtpNet = { status: st, url: u.split('?')[0].slice(0, 110), body: String(body).replace(/\s+/g, ' ').slice(0, 400), at: Date.now() };
              // M-18: full OTP response body only in MOCK mode; redacted summary otherwise
              if (MOCK_MODE) console.log('NET[' + st + '] ' + lastOtpNet.url + ' :: ' + lastOtpNet.body.slice(0, 600));
              else console.log('NET[' + st + '] ' + lastOtpNet.url + ' :: ' + redactPII(lastOtpNet.body).slice(0, 120));
            }).catch(() => {
              lastOtpNet = { status: st, url: u.split('?')[0].slice(0, 110), body: '(body পড়া যায়নি)', at: Date.now() };
              console.log('NET[' + st + '] ' + lastOtpNet.url + ' (body পড়া যায়নি)');
            });
          } else if (st >= 400) {
            res.text().then((body) => {
              console.log('NET[' + st + '] ' + u.split('?')[0].slice(0, 110) + ' :: ' + String(body).replace(/\s+/g, ' ').slice(0, 400));
            }).catch(() => console.log('NET[' + st + '] ' + u.split('?')[0].slice(0, 110)));
          }
        } catch { /* নীরব */ }
      });
      page.on('request', (req) => {
        try {
          const u = req.url();
          if (req.method() === 'POST' && /otp/i.test(u)) {
            console.log('NET-REQ[] ' + u.split('?')[0].slice(0, 110) + ' :: ' + String(req.postData() || '').replace(/\s+/g, ' ').slice(0, 400));
          }
        } catch { /* নীরব */ }
      });

      await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot}', r => r.abort().catch(() => {}));
      await page.route('**/google-analytics**', r => r.abort().catch(() => {}));
      await page.route('**/googletagmanager**', r => r.abort().catch(() => {}));

      const target = TARGET_URL();

      let navOk = false, navErr = null;
      // live-verified 2026-10-10 (pran): bdris.gov.bd-তে সরাসরি /br/application
      // deep-link-এ gate page ("Please type on browser") আসে — আগে https root-এ
      // ঢুকে তারপর আবেদন পেজে যেতে হয়। mock-এ সরাসরি।
      const navTargets = MOCK_MODE ? [target] : ['https://bdris.gov.bd', target];
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          status(socket, 'LOADING', `🌐 BDRIS পোর্টালে যাচ্ছি... (চেষ্টা ${attempt}/3)`);
          for (const u of navTargets) {
            // live-verified 2026-10-10: referer ছাড়া সরাসরি /br/application-এ গেলে
            // WAF 403 gate ("Please type on browser") দেয় — রুট থেকে referer নিয়ে গেলে 200
            const isRoot = /^https?:\/\/bdris\.gov\.bd\/?$/.test(u.replace(/\/$/, '') + '');
            await page.goto(u, {
              waitUntil: 'domcontentloaded', timeout: 45000,
              ...(MOCK_MODE || isRoot ? {} : { referer: 'https://bdris.gov.bd/' }),
            });
            await page.waitForTimeout(1200);
          }
          navOk = true; break;
        } catch (e) {
          navErr = e;
          console.warn(`Nav attempt ${attempt} failed:`, e.message.slice(0, 120));
          if (attempt < 3) await page.waitForTimeout(3000);
        }
      }
      if (!navOk) throw navErr;

      status(socket, 'LOADING', '⏳ BDRIS ফর্ম লোড হচ্ছে...');
      // ধাপ ০: radio officeAddressType আসা পর্যন্ত অপেক্ষা
      const s0 = await waitVisible(['#officeBirthplace', 'input[name="officeAddressType"]'], 25000);
      await findBdrisSelectors();
      console.log('Page title:', await page.title().catch(() => ''));

      const readyMsg = s0
        ? '✅ BDRIS পোর্টাল লোড সম্পন্ন! ধাপ ১-এ আবেদনের ভিত্তি নির্বাচন করুন।'
        : '⚠️ BDRIS লোড হয়েছে (ধীর নেটওয়ার্ক)। ধাপ ১-এর তথ্য দিন।';
      console.log(`[${ts()}] [READY] ${readyMsg}`);
      // C-1 fix: এই socket এখন সেশনের মালিক। মালিক বদলালে appData রিসেট —
      // আগের user-এর তথ্য নতুন user-এর ফর্মে যাবে না।
      if (sessionOwner !== socket.id) {
        appData = {};
        applicantDobIso = null;
      }
      sessionOwner = socket.id;
      // fresh: true = নতুন সেশন (পেজ ধাপ ১-এ) — UI-এর ধাপগুলো রি-আর্ম করার সংকেত
      socket.emit('BOT_STATUS', { status: 'READY', level: 'ok', fresh: true, message: readyMsg });
    } catch (err) {
      console.error('Session Error:', err);
      const m = err.message || '';
      const isNetErr = m.includes('wsarecv') || m.includes('ERR_') || m.includes('net::') || m.includes('connect');
      status(socket, 'ERROR', isNetErr
        ? '❌ সংযোগ নেই — ইন্টারনেট চেক করে আবার চেষ্টা করুন।'
        : '❌ সাইটে সংযোগ নেই — আবার চেষ্টা করুন।');
      await closeBrowser();
    } finally {
      isLaunching = false;
    }
  });

  // ── S0: আবেদনের ভিত্তি (core — assure/মেরামতও এটাই ব্যবহার করে, ack ছাড়া) ──
  async function applyS0Core(socket, data) {
    appData.s0 = data;
    const failed = [];
    status(socket, 'PROGRESS', '🔄 ধাপ ১: আবেদনের ভিত্তি নির্বাচন করা হচ্ছে...');
    // আসল সাইটের radio: id #officeBirthplace/#officePermanent (value BIRTHPLACE/PERMANENT)
    const radioId = data.addressType === 'PERMANENT' ? '#officePermanent' : '#officeBirthplace';
    const radioVal = data.addressType === 'PERMANENT' ? 'PERMANENT' : 'BIRTHPLACE';
    let radio = await waitVisible([radioId, `input[name="officeAddressType"][value="${radioVal}"]`], 6000);
    if (!radio) {
      // পেজ পুরনো/পরের অবস্থায় (success স্ক্রিন বা সাইট সামনে) — fresh লোড (প্রমাণিত প্যাটার্ন)
      status(socket, 'PROGRESS', '↻ BDRIS ফর্ম নতুন করে লোড করা হচ্ছে...', 'info');
      await reloadForm();
      radio = await waitVisible([radioId, `input[name="officeAddressType"][value="${radioVal}"]`], 10000);
    }
    if (radio) {
      await radio.check().catch(async () => { await radio.click(); });
      status(socket, 'PROGRESS', `✔ আবেদনের ভিত্তি: ${data.addressType === 'PERMANENT' ? 'স্থায়ী ঠিকানা' : 'জন্মস্থান'}`, 'ok');
    } else {
      failed.push({ field: 'আবেদনের ভিত্তি', reason: 'radio বাটন পাওয়া যায়নি' });
    }
    if (data.embassy) {
      const cb = await waitVisible(['#bdMissionCheckbox'], 5000);
      if (cb) { await cb.check().catch(() => {}); status(socket, 'PROGRESS', '✔ দূতাবাস অপশন নির্বাচিত', 'ok'); }
    }
    const nxt = await clickNextAndWait(socket, 'পরবর্তী (ধাপ ১)', {
      nextAnchor: ['#personFirstNameBn', 'input[name="personInfoForBirth.personFirstNameBn"]'],
    });
    if (!nxt.ok) failed.push({ field: nxt.field, reason: nxt.reason });
    else await dismissNotices(socket);
    return {
      step: 2, failed, blocked: failed.length > 0,
      reason: failed.length ? failed[0].reason : '',
      message: failed.length ? `⚠️ ধাপ ১ শেষ — ${failed.length}টি সমস্যা।` : '✅ ধাপ ১ সম্পন্ন! ব্যক্তির পরিচিতি দিন।',
    };
  }
  // ── Idempotency (2026-10-13): প্রতিটি ক্লিকের নিজস্ব opId — নেট গ্লিচ, ডাবল-ইভেন্ট
  // বা ৭৫-সেকেন্ড guard-ছাড়ের পর একই ধাপ আবার এলে সাইটে ডুপ্লিকেট যাবে না;
  // আগের ack-টাই আবার ফেরত যায়। কোনো ব্যর্থতাকে সফল দেখানো হয় না — শুধু
  // সত্যিকারের ack-ই cache হয়।
  function deduped(opName, handler) {
    return async (data = {}) => {
      const oid = data && typeof data._opId === 'string' ? data._opId : null;
      socket._ackCache = socket._ackCache || new Map();
      if (oid && socket._ackCache.has(oid)) {
        return socket.emit('STEP_CHANGE_ACK', socket._ackCache.get(oid));
      }
      const origEmit = socket.emit.bind(socket);
      socket.emit = (ev, ...args) => {
        if (ev === 'STEP_CHANGE_ACK' && oid && args[0] && typeof args[0] === 'object') {
          socket._ackCache.set(oid, args[0]);
          while (socket._ackCache.size > 30) {
            const k = socket._ackCache.keys().next().value;
            socket._ackCache.delete(k);
          }
        }
        return origEmit(ev, ...args);
      };
      try { await handler(data); }
      finally { socket.emit = origEmit; }
    };
  }
  socket.on('SUBMIT_S0', deduped('SUBMIT_S0', async (data = {}) => {
    touchSession();
    if (!page) return status(socket, 'ERROR', '❌ সংযোগ নেই — আবার চেষ্টা করুন।');
    try {
      const r = await withTimeout(applyS0Core(socket, data), STEP_TIMEOUT_MS, 'ধাপ ১');
      socket.emit('STEP_CHANGE_ACK', { step: 2, message: r.message, failed: r.failed });
    } catch (e) { console.error('S0:', e); status(socket, 'ERROR', '❌ ধাপ ১ সম্পন্ন হয়নি — আবার চেষ্টা করুন।'); }
  }));

  // ── S1: ব্যক্তির পরিচিতি + জন্মস্থানের ঠিকানা (core — assure/মেরামতও এটাই ব্যবহার করে) ──
  async function applyS1Core(socket, data) {
    const failed = [];
    let gatePassed = false;
    { status(socket, 'PROGRESS', '🔄 ধাপ ২: ব্যক্তির পরিচিতি লেখা হচ্ছে...');
      const keep = (r) => { if (!r.ok && !r.skipped) failed.push({ field: r.field, reason: r.reason }); };
      const nm = 'personInfoForBirth.';
      const sel = (idPart) => [`#${idPart}`, `input[name="${nm}${idPart}"], input[name$="${idPart}"]`];
      // আবেদনকারীর DOB মনে রাখি — S2-তে ২০১৩-নিয়মে লাগবে
      if (data.dob) applicantDobIso = data.dob;
      appData.s1 = data;

      keep(await typeInto(sel('personFirstNameBn'), transitName(data.firstNameBn), socket, 'নামের প্রথম অংশ (বাংলা)', { required: true }));
      // ১-নামের লজিক (live-verified 2026-10-10): শেষের নাম ফাঁকা — বা শুধু `/`.
      // থাকলে — বট কিছু বসাবে না (ডাবল নাম নয়, চিহ্ন নয়)
      keep(await typeInto(sel('personLastNameBn'), transitName(data.lastNameBn), socket, 'নামের শেষ অংশ (বাংলা)', {}));
      keep(await typeInto(sel('personFirstNameEn'), transitName(data.firstNameEn), socket, 'First Name (English)', { required: true }));
      keep(await typeInto(sel('personLastNameEn'), transitName(data.lastNameEn), socket, 'Last Name (English)', {}));

      // জন্ম তারিখ — DD/MM/YYYY। mask-যুক্ত ঘরে fill() খেয়ে ফেলে (live-verified 2026-10-10)
      // → typeMaskedDate: টাইপ + EXACT read-back (2026-10-11: race-এ ভুল মান ধরা পড়েছিল)
      if (data.dob) {
        keep(await typeMaskedDate(
          ['#personBirthDate', `input[name="${nm}personBirthDate"]`],
          isoToBdFormat(data.dob), socket, 'জন্ম তারিখ'));
        // ৪৫+ দিন বয়সে modal আসে
        await page.waitForTimeout(1500);
        const modal = await handleAttachmentModal(socket, data.docsAvailable !== false);
        if (!modal.ok) failed.push({ field: 'কাগজপত্র', reason: modal.reason });
      }

      keep(await selectByLabel(['#thChild', `select[name="${nm}thChild"]`], thChildSite(data.thChild), socket, 'কততম সন্তান'));
      keep(await selectByLabel(['#gender', `select[name="${nm}gender"]`], data.gender, socket, 'লিঙ্গ'));
      keep(await selectByLabel(['#birthPlaceCountry', 'select[name="birthPlaceCountry"]'], data.country || 'বাংলাদেশ', socket, 'দেশ'));

      // ঠিকানা cascade — BDRIS logic (birthPlace section)
      await fillAddressSection('birthPlace', data, socket, failed);

      // ঠিকানা cascade সাইটের partial re-render ডাকতে পারে — ক্লিকের আগে নাম আবার যাচাই
      // (live 2026-10-11: En-প্রথম নাম ভরে দেওয়ার পরও সাইট খালি দেখাচ্ছিল)
      const nameVerify = [
        { sels: sel('personFirstNameBn'), val: data.firstNameBn, label: 'নামের প্রথম অংশ (বাংলা)' },
        { sels: sel('personFirstNameEn'), val: data.firstNameEn, label: 'First Name (English)' },
        { sels: sel('personLastNameBn'), val: data.lastNameBn, label: 'নামের শেষ অংশ (বাংলা)' },
        { sels: sel('personLastNameEn'), val: data.lastNameEn, label: 'Last Name (English)' },
      ];
      for (const c of nameVerify) {
        if (!hasLetters(transitName(c.val))) continue; // খালি থাকবে — নিচের clear/relax সামলাবে
        const has = await page.evaluate((sels) => {
          for (const s of sels) { const el = document.querySelector(s); if (el && String(el.value || '').trim()) return true; }
          return false;
        }, c.sels).catch(() => true);
        if (!has) keep(await typeInto(c.sels, transitName(c.val), socket, c.label + ' — আবার বসানো হলো', { required: true }));
      }

      // ১-নাম স্থায়ী নিয়ম (2026-10-11): শেষ-নাম ফাঁকা (বা ডট-শুধু) হলে ঘর খালিই
      // থাকবে — সাইটের required-রুল আগে শিথিল করি, যেন "পরবর্তী" ক্লিকেই এগিয়ে যায়
      const singleBn = !hasLetters(transitName(data.lastNameBn));
      const singleEn = !hasLetters(transitName(data.lastNameEn));
      appData.singleName = (singleBn || singleEn) ? { bn: singleBn, en: singleEn } : null;
      if (appData.singleName) {
        // আগের চেষ্টা থেকে সাইটে পড়ে থাকা শেষ-নাম মুছে ফেলি — ঘর খালি থাকবে খালিই
        // (গেট-পাসের পর অন্যদিকে আটকে আবার এলে ডাবল-নাম কখনো যাবে না)
        if (singleBn) { const el = await waitEl(sel('personLastNameBn')); if (el) await el.fill('').catch(() => {}); }
        if (singleEn) { const el = await waitEl(sel('personLastNameEn')); if (el) await el.fill('').catch(() => {}); }
        const rr = await relaxEmptyLast(page, appData.singleName);
        console.log('S1-SINGLE-RELAX:', JSON.stringify({ singleBn, singleEn, rr }));
      }

      // জন্মস্থান-সেকশন সত্যিই ভরা আছে কি না — partial re-render-এ খালি থাকলে আবার বসাই
      // (live bug 2026-10-11: fill "✔" লগ করেও validation-এ "[birthPlaceDiv]" বাধা দিয়ে বসেছিল)
      const bpFilled = async () => page.evaluate(() => {
        const val = (n) => { const e = document.querySelector(`select[name="${n}"]`); return e && e.offsetParent !== null ? String(e.value || '') : 'x'; };
        const txt = (n) => { const e = document.querySelector(`input[name="${n}"]`); return e && e.offsetParent !== null ? String(e.value || '').trim() : 'x'; };
        if (!val('birthPlaceDiv') || !val('birthPlaceDist') || !val('birthPlaceCityCorpCantOrUpazila')) return false;
        if (!txt('birthPlaceVilAreaTownBn') || !txt('birthPlacePostOfc')) return false;
        return true;
      }).catch(() => true);
      if (!(await bpFilled())) {
        status(socket, 'PROGRESS', '⏳ জন্মস্থানের কিছু ঘর খালি থেকে গেছে — আবার বসানো হচ্ছে…', 'warn');
        await fillAddressSection('birthPlace', data, socket, failed);
      }

      const anchorNext = ['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]'];
      const nxt = await clickNextAndWait(socket, 'পরবর্তী (ধাপ ২)', { nextAnchor: anchorNext });
      if (nxt.ok) {
        // modal "পরবর্তী" ক্লিকের পরেও আসতে পারে (mock/বাস্তব ভেদে)
        const modal2 = await handleAttachmentModal(socket, data.docsAvailable !== false);
        if (!modal2.ok) failed.push({ field: 'কাগজপত্র', reason: modal2.reason });
        if (modal2.shown) await waitVisible(anchorNext, 8000);
        await dismissNotices(socket);
      } else {
        failed.push({ field: nxt.field, reason: nxt.reason });
      }
      // validation-block detect — modal handle-এর পরে (নাগরিক কখনো আটকাবে না:
      // আটকালে কারণ parse করে নিজে গেট-পাস — শেষ-উপায়ে প্রথম নাম দিয়ে শেষ-নাম পূরণ)
      let chk = await detectValidationBlock(anchorNext);
      if (chk.blocked) {
        // গেট-পাস শুধু নাম-ঘরের বাধায় — অন্য ঘরের বাধায় ভুল করে শেষ-নাম ভরে ফেলা যাবে না
        const nameBlock = !/\[/.test(chk.reason) || /lastname/i.test(chk.reason);
        if (!nameBlock) status(socket, 'PROGRESS', `⚠ সাইটের বাধা — ${chk.reason.slice(0, 140)}`, 'warn');
        const filled = nameBlock ? await gatePassEmptyLastName(socket, data) : 0;
        if (filled > 0) {
          status(socket, 'PROGRESS', '🔁 নামের ঘরটি সাইটে গ্রহণ হচ্ছিল না — আবার পাঠানো হচ্ছে…', 'warn');
          const retry = await clickNextAndWait(socket, 'পরবর্তী (ধাপ ২)', { nextAnchor: anchorNext });
          if (!retry.ok) failed.push({ field: retry.field, reason: retry.reason });
          const modal3 = await handleAttachmentModal(socket, data.docsAvailable !== false);
          if (!modal3.ok) failed.push({ field: 'কাগজপত্র', reason: modal3.reason });
          if (modal3.shown) await waitVisible(anchorNext, 8000);
          await dismissNotices(socket);
          chk = await detectValidationBlock(anchorNext);
          if (!chk.blocked) {
            gatePassed = true;
            status(socket, 'PROGRESS', '✔ নামটি গ্রহণ করা হয়েছে — পরের ধাপে এগোনো হলো', 'ok');
          }
        }
      }
      console.log('S1-CHK:', JSON.stringify({ blocked: chk.blocked, gatePassed, reason: chk.blocked ? String(chk.reason || '').slice(0, 90) : '' }));
      if (chk.blocked) {
        const msg = '❌ ' + chk.reason;
        status(socket, 'ERROR', msg);
        return {
          step: 2, blocked: true, reason: chk.reason,
          message: msg + ' — ঘরটি পূরণ করে আবার চেষ্টা করুন।',
          failed: [...failed, { field: 'পরবর্তী (ধাপ ২)', reason: chk.reason }],
        };
      }
      // cinno-স্নিকের জন্য মনে রাখি — গেট-পাস হলে শেষের নামেও প্রথম নামের রূপ বসবে
      appData.gatePassedNames = gatePassed;

      const liveNames = await page.evaluate(() => {
        const g = (id) => { const e = document.getElementById(id); return e ? String(e.value || '') : null; };
        const vis = (id) => {
          const e = document.getElementById(id); if (!e) return null;
          const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
        };
        return {
          firstBn: g('personFirstNameBn'), lastBn: g('personLastNameBn'),
          firstEn: g('personFirstNameEn'), lastEn: g('personLastNameEn'),
          fatherVisible: vis('fatherBrn'),
        };
      }).catch(() => ({}));
      console.log('S1-DONE ack:', JSON.stringify({ step: 3, failed: failed.length, gatePassed, live: liveNames }));
      return {
        step: 3, failed, gatePassed, blocked: false,
        message: failed.length
          ? `⚠️ ধাপ ২ শেষ — ${failed.length}টি সমস্যা।`
          : '✅ ধাপ ২ সম্পন্ন! পিতামাতার তথ্য দিন।',
      };
    }
  }
  socket.on('SUBMIT_S1', deduped('SUBMIT_S1', async (data = {}) => {
    touchSession();
    if (!page) return status(socket, 'ERROR', '❌ সংযোগ নেই — আবার চেষ্টা করুন।');
    // সাইট অন্য ধাপে থাকলে আগে ঠিক ধাপে আনি (লকস্টেপ fallback)
    const aligned = await ensureAligned(socket, 'SUBMIT_S1', data.ctx);
    if (!aligned.ok) {
      status(socket, 'ERROR', '❌ ' + aligned.reason);
      return socket.emit('STEP_CHANGE_ACK', {
        step: 2, message: '❌ ' + aligned.reason,
        failed: [{ field: 'ধাপ মিলানো', reason: aligned.reason }], blocked: true,
      });
    }
    try {
      const r = await withTimeout(applyS1Core(socket, data), STEP_TIMEOUT_MS, 'ধাপ ২');
      socket.emit('STEP_CHANGE_ACK', { step: r.step, message: r.message, failed: r.failed, blocked: r.blocked || undefined });
    } catch (e) { console.error('S1:', e); status(socket, 'ERROR', '❌ ধাপ ২ সম্পন্ন হয়নি — আবার চেষ্টা করুন।'); }
  }));

  // ── S2: পিতামাতা (BRN verify gate) ──
  async function applyS2Core(socket, data) {
    appData.s2 = data;
    const failed = [];
    const verifyStatus = {};
    {
      status(socket, 'PROGRESS', '🔄 ধাপ ৩: পিতামাতার তথ্য লেখা হচ্ছে...');
      const keep = (r) => { if (!r.ok && !r.skipped) failed.push({ field: r.field, reason: r.reason }); };
      // ২০১৩-নিয়ম (live-verified 2026-10-11, সংশোধিত): সাইট applicant-DOB দেখে নিজেই ঠিক
      // করে পিতামাতার BRN চাইবে কি না — 2026-জন্ম ধরা পড়লে (ভুল DOB race) parents-BRN
      // বাধ্যতামূলক ধরে সাইট "not verified [father.ubrn]" দিয়ে আটকেছিল।
      // তাই: BRN থাকলে বসাই + Verify চেষ্টা (বাটন না থাকলে নীরব skip); না থাকলে site-ই শেষ কথা।
      const dobIso = data.applicantDob || applicantDobIso;
      const pre2013 = isPre2013(dobIso);
      appData.applicantDob = dobIso || null;

      const fillParent = async (p, who, verifyIndex) => {
        const base = `personInfoForBirth.${p}.`;
        const brnSel = [`#${p}Brn`, `input[name="${base}ubrn"]`];
        const dobSel = [`#${p}BirthDate`, `input[name="${base}personBirthDate"]`];
        const brn = String(data[p].brn || '').trim();
        if (pre2013) {
          // ২০১৩-এর আগের জন্মে পিতামাতার BRN ঐচ্ছিক (live-verified 2026-10-11) — আর BRN
          // বসালে সাইট রেজিস্ট্রি-লিংক ধরে ফ্যামিলি-ভ্যালিডেশন চালায় ("Difference of age
          // among children needs to be at least 180 days") → নাগরিক আটকে যায়।
          // তাই pre-২০১৩-তে BRN ঘর খালি রাখি — নাম + জাতীয়তাই যথেষ্ট।
          const brnEl = await waitVisible(brnSel, 2500);
          if (brnEl) await brnEl.fill('').catch(() => {});
          verifyStatus[p] = 'skipped-pre2013';
        } else {
          keep(await typeInto(brnSel, brn, socket, `${who}-এর BRN`, { required: true }));
        }
        if (data[p].dob) {
          keep(await typeMaskedDate(dobSel, isoToBdFormat(data[p].dob), socket, `${who}-এর জন্ম তারিখ`));
        }
        keep(await typeInto([`#${p}NameBn`, `input[name="${base}personNameBn"]`], transitName(data[p].nameBn), socket, `${who}-এর নাম (বাংলা)`, { required: true }));
        keep(await typeInto([`#${p}NameEn`, `input[name="${base}personNameEn"]`], transitName(data[p].nameEn), socket, `${who}-এর নাম (English)`, { required: true }));
        if (!pre2013 && brn) {
          // Verify (BRN+DOB+নাম পূরণের পর); বাটন না থাকলে নীরব skip
          const v = await clickVerify(socket, verifyIndex, who, { quietMissing: true });
          verifyStatus[p] = v.verified;
          if (v.verified === false) {
            failed.push({ field: `${who}-এর BRN যাচাই`, reason: 'রেজিস্ট্রিতে BRN পাওয়া যায়নি — সঠিক ১৭ ডিজিটের BRN ও জন্ম তারিখ দিন' });
          }
        }
        keep(await selectByLabel([`#${p}Nationality`, `select[name="${base}personNationality"]`],
          data[p].nationality || 'বাংলাদেশী', socket, `${who}-এর জাতীয়তা`));
      };

      await fillParent('father', 'পিতা', 0);
      await fillParent('mother', 'মাতা', 1);

      // ডায়াগনস্টিক (2026-10-11, স্থায়ী): নামে ফোটা/ডট/সিনো সাইটের ইনপুটে আসলে কী দাঁড়াল —
      // read-back করে শুধু লগে রাখি (UI-তে দেখা যায় না)।
      try {
        const rb = await page.evaluate(() => {
          const g = (s) => { const el = document.querySelector(s); return el ? el.value : '(missing)'; };
          return { fBn: g('#fatherNameBn'), fEn: g('#fatherNameEn'), mBn: g('#motherNameBn'), mEn: g('#motherNameEn') };
        });
        console.log('S3-FATHER-VALUES ' + JSON.stringify(rb));
      } catch { /* ঐচ্ছিক */ }

      // পরবর্তী — সাইট সত্যিই এগিয়েছে কিনা সেটাই চূড়ান্ত প্রমাণ
      // (পেজে পড়ে থাকা পুরনো "not verified" টেক্সটে আর বিভ্রান্ত হই না)
      const nxt = await clickNextAndWait(socket, 'পরবর্তী (ধাপ ৩)');
      if (!nxt.ok) {
        failed.push({ field: nxt.field, reason: nxt.reason });
      } else {
        const chk = await detectValidationBlock(null);
        if (chk.blocked) {
          const msg = '❌ ' + chk.reason;
          status(socket, 'ERROR', msg);
          return {
            step: 3, blocked: true, reason: chk.reason,
            message: msg + ' — ঘরটি পূরণ করে আবার চেষ্টা করুন।',
            failed: [...failed, { field: 'পরবর্তী (ধাপ ৩)', reason: chk.reason }], verifyStatus,
          };
        }
      }
      // parents ঘর আর নেই = সাইট নিশ্চিতভাবে পরের ধাপে → verify-নেগেটিভ মিথ্যা, বাদ
      let advanced = false;
      if (nxt.ok) {
        await page.waitForTimeout(2500);
        advanced = !(await waitVisible(
          ['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]'], 1500));
      }
      if (advanced) {
        await dismissNotices(socket);
        return {
          step: 4, blocked: false, message: '✅ ধাপ ৩ সম্পন্ন! স্থায়ী ও বর্তমান ঠিকানা দিন।',
          failed: [], verifyStatus,
        };
      }
      if (nxt.ok && !pre2013) {
        // এগোয়নি — verifyStatus থেকে নির্দিষ্ট কারণ বানাই
        const bad = Object.entries(verifyStatus).filter(([, v]) => v === false).map(([k]) => (k === 'father' ? 'পিতা' : 'মাতা'));
        const unclear = Object.entries(verifyStatus).filter(([, v]) => v === null).map(([k]) => (k === 'father' ? 'পিতা' : 'মাতা'));
        const reason = bad.length
          ? `BDRIS এগোতে দিচ্ছে না — ${bad.join('/')}-এর BRN verify হয়নি। সঠিক BRN ও জন্ম তারিখ দিয়ে Verify চাপুন।`
          : unclear.length
            ? `BDRIS এগোতে দিচ্ছে না — ${unclear.join('/')}-এর verify-ফল নিশ্চিত হয়নি। Verify চেপে আবার চেষ্টা করুন।`
            : 'BDRIS এগোতে দিচ্ছে না — পিতামাতার তথ্য/যাচাইয়ে সমস্যা। তথ্য মিলিয়ে আবার চেষ্টা করুন।';
        status(socket, 'ERROR', '❌ ' + reason);
        return { step: 3, blocked: true, reason, message: '❌ ' + reason, failed, verifyStatus };
      }

      return {
        step: 4, blocked: false,
        message: `⚠️ ধাপ ৩ শেষ — ${failed.length}টি সমস্যা।`,
        failed, verifyStatus,
      };
    }
  }
  socket.on('SUBMIT_S2', deduped('SUBMIT_S2', async (data = {}) => {
    touchSession();
    if (!page) return status(socket, 'ERROR', '❌ সংযোগ নেই — আবার চেষ্টা করুন।');
    // সাইট অন্য ধাপে থাকলে আগে ঠিক ধাপে আনি (লকস্টেপ fallback)
    const aligned = await ensureAligned(socket, 'SUBMIT_S2', data.ctx);
    if (!aligned.ok) {
      status(socket, 'ERROR', '❌ ' + aligned.reason);
      return socket.emit('STEP_CHANGE_ACK', {
        step: 3, message: '❌ ' + aligned.reason,
        failed: [{ field: 'ধাপ মিলানো', reason: aligned.reason }], blocked: true,
      });
    }
    try {
      const r = await withTimeout(applyS2Core(socket, data), STEP_TIMEOUT_MS, 'ধাপ ৩');
      socket.emit('STEP_CHANGE_ACK', {
        step: r.step, message: r.message, failed: r.failed,
        verifyStatus: r.verifyStatus, blocked: r.blocked || undefined,
      });
    } catch (e) { console.error('S2:', e); status(socket, 'ERROR', '❌ ধাপ ৩ সম্পন্ন হয়নি — আবার চেষ্টা করুন।'); }
  }));

  // ── S2B: ঠিকানার ধাপ (স্থায়ী ও বর্তমান) — live-verified 2026-10-10 ──
  // data: { permCopy: bool, presCopy: bool, perm: {...}|null, pres: {...}|null }
  // copy না চাইলে BDRIS cascade দিয়েই সরাসরি বসানো হয় (fillAddressSection)
  // লাইভ field নাম: permAddr* (স্থায়ী), prsntAddr* (বর্তমান)
  async function applyS2BCore(socket, data) {
    appData.s2b = data;
    const failed = [];
    // কপি-চেকবক্স: লেবেল-টেক্সট দিয়ে খোঁজা (live label), name দিয়ে fallback
    const findCopyBox = async (labelText, nameFallback) => {
      try {
        const byLabel = page.locator(`label:has-text("${labelText}") input[type="checkbox"]`).first();
        if (await byLabel.count() && await byLabel.isVisible()) return byLabel;
      } catch { /* fallback */ }
      return page.$(`input[name="${nameFallback}"]`);
    };
    {
      status(socket, 'PROGRESS', '🔄 ঠিকানার ধাপ: স্থায়ী ও বর্তমান ঠিকানা...', 'info');
      // স্থায়ী ঠিকানা
      // Permanent (2026-10-15): data থাকলে flag উপেক্ষা করে fill করি — ভুল
      // permCopy=true-তে copy-box চেক করলে ব্যবহারকারীর আলাদা ঠিকানা মুছে যায়।
      const permHasData = data.perm && (data.perm.division || data.perm.district || data.perm.vilBn);
      if (permHasData) {
        status(socket, 'PROGRESS', '🔄 স্থায়ী ঠিকানা বসানো হচ্ছে...', 'info');
        await fillAddressSection('permAddr', data.perm, socket, failed);
      } else {
        const cb1 = await findCopyBox('জন্মস্থানের ঠিকানা ও স্থায়ী ঠিকানা একই', 'copyBirthPlaceToPermAddr');
        if (cb1) {
          const checked = await cb1.isChecked().catch(() => false);
          if (!checked) await cb1.check().catch(async () => { await cb1.click(); });
          await page.waitForTimeout(1200);
          status(socket, 'PROGRESS', '✔ স্থায়ী ঠিকানা: জন্মস্থান থেকে কপি', 'ok');
        }
      }
      // বর্তমান ঠিকানা
      const presHasData = data.pres && (data.pres.division || data.pres.district || data.pres.vilBn);
      if (presHasData) {
        status(socket, 'PROGRESS', '🔄 বর্তমান ঠিকানা বসানো হচ্ছে...', 'info');
        await fillAddressSection('prsntAddr', data.pres, socket, failed);
      } else {
        const cb2 = await findCopyBox('স্থায়ী ঠিকানা ও বর্তমান ঠিকানা একই', 'copyPermAddrToPrsntAddr');
        if (cb2) {
          const checked = await cb2.isChecked().catch(() => false);
          if (!checked) await cb2.check().catch(async () => { await cb2.click(); });
          await page.waitForTimeout(800);
          status(socket, 'PROGRESS', '✔ বর্তমান ঠিকানা: স্থায়ী ঠিকানা থেকে কপি', 'ok');
        }
      }

      // ঠিকানা সত্যিই ভরা আছে কি না — partial re-render-এ খালি থাকলে আবার বসাই
      // (S1-এর bpFilled()-র মতোই: fill "✔" লগ করেও validation-এ বাধা দিতে পারে)
      const addrFilled = async (pre) => page.evaluate((p) => {
        const val = (n) => { const e = document.querySelector(`select[name="${n}"]`); return e && e.offsetParent !== null ? String(e.value || '') : 'x'; };
        const txt = (n) => { const e = document.querySelector(`input[name="${n}"]`); return e && e.offsetParent !== null ? String(e.value || '').trim() : 'x'; };
        if (!val(p + 'Div') || !val(p + 'Dist') || !val(p + 'CityCorpCantOrUpazila')) return false;
        if (!txt(p + 'VilAreaTownBn') || !txt(p + 'PostOfc')) return false;
        return true;
      }, pre).catch(() => true);
      for (const [pre, rec, cp] of [['permAddr', data.perm, data.permCopy], ['prsntAddr', data.pres, data.presCopy]]) {
        if (rec && !cp && !(await addrFilled(pre))) {
          status(socket, 'PROGRESS', '⏳ ঠিকানার কিছু ঘর খালি থেকে গেছে — আবার বসানো হচ্ছে…', 'warn');
          await fillAddressSection(pre, rec, socket, failed);
        }
      }

      await dismissNotices(socket);
      let nxtA = await clickNextAndWait(socket, 'পরবর্তী (ঠিকানার ধাপ)');
      if (!nxtA.ok) failed.push({ field: nxtA.field, reason: nxtA.reason });
      else {
        await dismissNotices(socket);
        // সত্যিই এগিয়েছে কি না — ঠিকানার সেকশন এখনো দৃশ্যমান থাকলে আটকে গেছে (2026-10-11)
        const addrStill = async () => waitVisible(['select[name="permAddrDiv"]', 'input[name="permAddrHouseRoadEn"]'], 4000);
        if (await addrStill()) {
          const b1 = await detectValidationBlock(null);
          console.log('S2B-BLOCK-1:', b1.reason);
          status(socket, 'PROGRESS', '⏳ ঠিকানার ধাপ এগোয়নি — আবার চেষ্টা করা হচ্ছে…', 'warn');
          await page.waitForTimeout(800);
          nxtA = await clickNextAndWait(socket, 'পরবর্তী (ঠিকানার ধাপ, পুনঃচেষ্টা)');
          if (!nxtA.ok || (await addrStill())) {
            const b2 = await detectValidationBlock(['input[name="files"]']);
            console.log('S2B-BLOCK-2:', b2.reason);
            failed.push({
              field: 'ঠিকানার ধাপ',
              reason: (b2.blocked && b2.reason) || (b1.blocked && b1.reason) || 'সাইট পরের ধাপে যায়নি — তথ্য একবার মিলিয়ে নিন',
            });
          } else {
            status(socket, 'PROGRESS', '✔ পুনঃচেষ্টায় ঠিকানার ধাপ সম্পন্ন', 'ok');
          }
        }
      }
      return {
        step: 5, blocked: failed.length > 0,
        message: failed.length ? `⚠️ ঠিকানার ধাপে ${failed.length}টি সমস্যা।` : '✅ ঠিকানার ধাপ সম্পন্ন! ডকুমেন্ট আপলোড করুন।',
        failed,
      };
    }
  }
  socket.on('SUBMIT_S2B', deduped('SUBMIT_S2B', async (data = {}) => {
    touchSession();
    if (!page) return status(socket, 'ERROR', '❌ সংযোগ নেই — আবার চেষ্টা করুন।');
    // সাইট অন্য ধাপে থাকলে আগে ঠিক ধাপে আনি (লকস্টেপ fallback)
    const aligned = await ensureAligned(socket, 'SUBMIT_S2B', data.ctx);
    if (!aligned.ok) {
      status(socket, 'ERROR', '❌ ' + aligned.reason);
      return socket.emit('STEP_CHANGE_ACK', {
        step: 4, message: '❌ ' + aligned.reason,
        failed: [{ field: 'ধাপ মিলানো', reason: aligned.reason }], blocked: true,
      });
    }
    try {
      const r = await withTimeout(applyS2BCore(socket, data), STEP_TIMEOUT_MS, 'ঠিকানার ধাপ');
      socket.emit('STEP_CHANGE_ACK', {
        step: r.step, message: r.message, failed: r.failed, blocked: r.blocked || undefined,
      });
    } catch (e) { console.error('S2B:', e); status(socket, 'ERROR', '❌ ঠিকানার তথ্য সেভ হয়নি — আবার চেষ্টা করুন।'); }
  }));

  // ── S3: আবেদনকারীর প্রত্যয়ন + ডকুমেন্ট (live-mapped 2026-10-09) ──
  // আসল গঠন: radio name=relationWithApplicant (পিতা/মাতা/...) → readonly
  // applicantName auto-fill; checkbox name=declaration; upload =
  // <input type=file name="files" multiple accept="image/*"> (শুধু image, ≤2MB, বাধ্যতামূলক)
  socket.on('SUBMIT_S3_DOCS', deduped('SUBMIT_S3_DOCS', async (data = {}) => {
    touchSession();
    if (!page) return status(socket, 'ERROR', '❌ সংযোগ নেই — আবার চেষ্টা করুন।');
    // সাইট অন্য ধাপে থাকলে আগে ঠিক ধাপে আনি (লকস্টেপ fallback)
    const aligned = await ensureAligned(socket, 'SUBMIT_S3_DOCS', data.ctx);
    if (!aligned.ok) {
      status(socket, 'ERROR', '❌ ' + aligned.reason);
      return socket.emit('STEP_CHANGE_ACK', {
        step: 4, message: '❌ ' + aligned.reason,
        failed: [{ field: 'ধাপ মিলানো', reason: aligned.reason }], blocked: true,
      });
    }
    appData.s3 = data;
    const failed = [];
    const run = (async () => {
      status(socket, 'PROGRESS', '🔄 ধাপ ৪: প্রত্যয়ন ও কাগজপত্র...', 'info');
      const anchor = await waitVisible(['input[name="relationWithApplicant"]', 'input[name="files"]'], 10000);
      if (!anchor) {
        status(socket, 'ERROR', '❌ প্রত্যয়ন/ডকুমেন্ট পেজ খোলা নেই — আগের ধাপ শেষ করে আবার চেষ্টা করুন।');
        socket.emit('STEP_CHANGE_ACK', { step: 4, message: '❌ ডকুমেন্ট পেজ পাওয়া যায়নি', failed, blocked: true });
        return;
      }

      // আবেদনকারী কে (relation radio) — ১৮+ বয়সী ব্যক্তির জন্য সাইট পিতা/মাতা-রেডিও
      // লুকিয়ে রাখে; লুকানো রেডিও চেক থাকলে jQuery-validate (ignore :hidden) ব্যর্থ
      // হয়ে OTP চুপচাপ আটকে যায় (live bug 2026-10-11 — user-reported)। তাই দৃশ্যমান
      // রেডিওর মধ্যেই বাছাই; UI-এর পছন্দ না মিললে নিজ(SELF) → পিতা(FATHER) fallback।
      let relBn = '';
      const REL_BN = { FATHER: 'পিতা', MOTHER: 'মাতা', SELF: 'নিজ', GRANDFATHER: 'পিতামহ', GRANDMOTHER: 'পিতামহী', MATERNALGRANDFATHER: 'মাতামহ', MATERNALGRANDMOTHER: 'মাতামহী', GUARDIAN: 'অভিভাবক', OTHERS: 'অন্যান্য' };
      if (data.relation) {
        const REL_VALUE = { 'পিতা': 'FATHER', 'মাতা': 'MOTHER', 'নিজ': 'SELF', 'পিতামহ': 'GRANDFATHER', 'পিতামহী': 'GRANDMOTHER', 'মাতামহ': 'MATERNALGRANDFATHER', 'মাতামহী': 'MATERNALGRANDMOTHER', 'অভিভাবক': 'GUARDIAN', 'অন্যান্য': 'OTHERS' };
        const pickRel = (want) => page.evaluate((w) => {
          const radios = Array.from(document.querySelectorAll('input[name="relationWithApplicant"]'));
          const vis = radios.filter((r) => r.offsetParent !== null && r.getClientRects().length);
          let t = vis.find((r) => (r.value || '') === w);
          if (!t) t = vis.find((r) => (r.value || '') === 'SELF') || vis.find((r) => (r.value || '') === 'FATHER') || vis[0];
          if (!t) return { ok: false };
          t.click();
          return { ok: true, value: t.value };
        }, want).catch(() => ({ ok: false }));
        const readRelState = () => page.evaluate(() => {
          const c = document.querySelector('input[name="relationWithApplicant"]:checked');
          return { value: c ? c.value : null, visible: !!(c && c.offsetParent !== null) };
        }).catch(() => ({ value: null, visible: false }));
        // ২০১৩-পূর্ব জন্ম → সাইট-বিধি: নিজ(SELF) দিয়েই OTP পাঠাতে হয় (user-confirmed
        // 2026-10-11); দৃশ্যমান না হলে (বয়স ১৮-র নিচে) তবে UI-এর পছন্দ।
        const dobYear = parseInt(String((appData.s1 || {}).dob || '').slice(0, 4), 10);
        const pre2013 = isFinite(dobYear) && dobYear > 1900 && dobYear < 2013;
        const wantVal = pre2013 ? 'SELF' : (REL_VALUE[data.relation] || String(data.relation).toUpperCase());
        let pick = await pickRel(wantVal);
        await page.waitForTimeout(700);
        let state = await readRelState();
        if (pick.ok && (!state.value || !state.visible)) { // কাঁচা প্রথম চেষ্টা — আরেকবার
          pick = await pickRel(wantVal);
          await page.waitForTimeout(600);
          state = await readRelState();
        }
        if (state.value && state.visible) {
          relBn = REL_BN[state.value] || data.relation;
          const ruleNote = state.value === 'SELF' ? (pre2013 ? ' (২০১৩-পূর্ব বিধি)' : ' (১৮+ বয়সী বিধি)') : '';
          status(socket, 'PROGRESS', `✔ আবেদনকারী: ${relBn}${ruleNote}`, 'ok');
          // applicantName (required, min ২ অক্ষর) — auto-fill খালি থাকলে নিজের নাম বসাই
          const nmNow = await page.evaluate(() => {
            const nm = document.querySelector('#applicantName');
            return nm ? String(nm.value || '').trim() : '';
          }).catch(() => '');
          if (nmNow.length < 2) {
            const s1 = appData.s1 || {};
            const fullEn = [s1.firstNameEn, s1.lastNameEn].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
            const fallback = fullEn.length >= 2 ? fullEn : 'Applicant';
            const okFill = await page.evaluate((v) => {
              const nm = document.querySelector('#applicantName');
              if (!nm) return false;
              nm.removeAttribute('readonly');
              nm.value = v;
              nm.dispatchEvent(new Event('input', { bubbles: true }));
              nm.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }, fallback).catch(() => false);
            if (okFill) status(socket, 'PROGRESS', `✔ আবেদনকারীর নাম: ${fallback}`, 'ok');
          }
        } else {
          failed.push({ field: 'আবেদনকারী', reason: 'সম্পর্কের রেডিও নির্বাচন হয়নি — সাইট OTP আটকে দেবে' });
        }
        await page.waitForTimeout(300);
      }
      // ঘোষণা checkbox
      const decl = await page.$('input[name="declaration"]');
      if (decl) { await decl.check().catch(async () => { await decl.click(); }); }

      // ডকুমেন্ট — শুধু image (jpg/jpeg/png), প্রতিটি ≤2MB, কমপক্ষে ১টি বাধ্যতামূলক
      const docs = (Array.isArray(data.docs) ? data.docs : []).filter(d => d && d.base64);
      const bad = [];
      const good = docs.filter(d => {
        const mt = (d.mimeType || '').toLowerCase();
        const isImg = mt.startsWith('image/') || /\.(jpe?g|png)$/i.test(d.name || '');
        const size = Math.round((d.base64.length * 3) / 4);
        if (!isImg) { bad.push(`${d.name || 'ফাইল'} — শুধু JPG/PNG চলবে`); return false; }
        if (size > 2 * 1024 * 1024) { bad.push(`${d.name || 'ফাইল'} — 2MB-এর বেশি`); return false; }
        return true;
      });
      bad.forEach(b => failed.push({ field: 'ডকুমেন্ট', reason: b }));
      if (good.length === 0) {
        failed.push({ field: 'ডকুমেন্ট', reason: 'কমপক্ষে ১টি JPG/PNG ছবি বাধ্যতামূলক — BDRIS ফাইল ছাড়া এগোতে দেয় না' });
        status(socket, 'ERROR', '❌ ডকুমেন্ট ছাড়া BDRIS এগোতে দেবে না। ছবি যোগ করে আবার চেষ্টা করুন।');
        socket.emit('STEP_CHANGE_ACK', { step: 4, message: '❌ ডকুমেন্ট বাধ্যতামূলক', failed, blocked: true });
        return;
      }
      const anyInput = await page.$('input[type="file"]');
      if (!anyInput) {
        failed.push({ field: 'ডকুমেন্ট', reason: 'ফাইল ইনপুট পাওয়া যায়নি' });
      } else {
        // প্রতি ফাইলে: row আসে → File Type (40/41) সিলেক্ট → Start চাপ → collapse
        // GATE: 40 ও 41 দুটোই না হলে BDRIS "পরবর্তী" আটকায় (live-mapped 2026-10-09)
        // 2026-10-11: প্রতিটি আপলোডের পর Angular input নোড নতুন করে বানায় — তাই
        // প্রতি ফাইলে ফ্রেশ হ্যান্ডেল নিতে হয়, নাহলে ২য় ফাইলে row-ই আসে না (stale node)।
        const uploadedTypes = new Set();
        const typeSel = 'select.attchment-type-upload, select.attachment-type-upload';
        const attemptUpload = async (d, wantType) => {
          const fi = await page.$('input[type="file"][name="files"], input[type="file"]');
          if (!fi) return 'no-input';
          await fi.setInputFiles([{
            name: d.name || 'document.jpg',
            mimeType: d.mimeType || 'image/jpeg',
            buffer: Buffer.from(d.base64, 'base64'),
          }]);
          const sel = await page.waitForSelector(typeSel, { state: 'visible', timeout: 12000 }).catch(() => null);
          if (!sel) return 'no-row';
          await sel.selectOption(wantType).catch(() => {});
          await page.waitForTimeout(500);
          const startBtn = await page.locator('button:has-text("Start")').first().elementHandle().catch(() => null);
          if (!startBtn) return 'no-start';
          await startBtn.click().catch(() => {});
          // আপলোড শেষে row collapse হয় (select চলে যায়)
          await page.waitForFunction(
            (s) => !document.querySelector(s),
            typeSel, { timeout: 20000 }
          ).catch(() => {});
          await page.waitForTimeout(800);
          return 'ok';
        };
        const reasonOf = (code) => code === 'no-input' ? 'আপলোড ঘর পাওয়া যায়নি'
          : code === 'no-row' ? 'File Type row আসেনি'
          : code === 'no-start' ? 'Start বাটন পাওয়া যায়নি'
          : 'আপলোড করা যায়নি';
        for (const d of good) {
          const wantType = d.docType === '41' ? '41' : '40';
          try {
            let r = await attemptUpload(d, wantType);
            if (r === 'no-row') { // রি-রেন্ডার টাইমিং — একবার পুনঃচেষ্টা
              await page.waitForTimeout(1200);
              r = await attemptUpload(d, wantType);
            }
            if (r === 'ok') {
              uploadedTypes.add(wantType);
              status(socket, 'PROGRESS', `✔ ডকুমেন্ট: ${d.name} (ধরন ${wantType})`, 'ok');
            } else {
              failed.push({ field: 'ডকুমেন্ট', reason: `${d.name} — ${reasonOf(r)}` });
            }
          } catch (e) {
            failed.push({ field: 'ডকুমেন্ট', reason: `${d.name}: আপলোড করা যায়নি — আবার চেষ্টা করুন` });
          }
        }
        if (!uploadedTypes.has('40') || !uploadedTypes.has('41')) {
          failed.push({ field: 'ডকুমেন্ট', reason: 'BDRIS দুই ধরনের কাগজ চায় — ডাক্তারি/শিক্ষা সনদ (৪০) ও ঠিকানার প্রমাণ (৪১); দুটোই আপলোড করুন' });
          status(socket, 'ERROR', '❌ দুই ধরনের ডকুমেন্ট (৪০ ও ৪১) ছাড়া BDRIS এগোতে দেবে না।');
          socket.emit('STEP_CHANGE_ACK', { step: 4, message: '❌ দুই ধরনের ডকুমেন্ট বাধ্যতামূলক', failed, blocked: true });
          return;
        }
      }
      const contactAnchors = ['#email', 'input[name="email"]', '#phone', 'input[name="phone"]'];
      const nxt = await clickNextAndWait(socket, 'পরবর্তী (ধাপ ৪)');
      if (!nxt.ok) failed.push({ field: nxt.field, reason: nxt.reason });
      else {
        await dismissNotices(socket);
        // সত্যিই যোগাযোগ-ধাপে গেল কি না — নাহলে চুপচাপ আটকে থাকা UI-তে ধরা পড়বে না
        if (!(await waitVisible(contactAnchors, 5000))) {
          const b = await detectValidationBlock(contactAnchors);
          console.log('S3-BLOCK:', b.reason);
          failed.push({ field: 'ডকুমেন্ট ধাপ', reason: (b.blocked && b.reason) || 'সাইট পরের ধাপে যায়নি — কাগজপত্র মিলিয়ে দেখুন' });
        }
      }
      socket.emit('STEP_CHANGE_ACK', {
        step: 6,
        message: failed.length ? `⚠️ ধাপ ৪ শেষ — ${failed.length}টি সমস্যা।` : `✅ প্রত্যয়ন ও ডকুমেন্ট সম্পন্ন (${good.length}টি)!`,
        failed,
        blocked: failed.length > 0,
        relationBn: relBn || undefined,
      });
    })();
    try { await withTimeout(run, STEP_TIMEOUT_MS, 'ধাপ ৪'); }
    catch (e) { console.error('S3:', e); status(socket, 'ERROR', '❌ কাগজপত্র সেভ হয়নি — আবার চেষ্টা করুন।'); }
  }));

  // ── S4a: যোগাযোগ + ওটিপি পাঠান (live-mapped 2026-10-09; hardened 2026-10-11) ──
  // email: input#email | phone: input#phone | button "ওটিপি পাঠান"
  // 2026-10-11 live bug: সাইটের validateForm() চুপচাপ আটকালে বাটন ক্লিক হলেও SMS যায় না →
  // এখন ক্লিকের আগে probe+autofix, পরে toast/#otpIntervalText-এর সত্যিকারের প্রমাণ।
  // সেশন নতুন হলে (সাইট ধাপ ১-এ) resumable ack — UI নিজেই চেইন রিপ্লে করে OTP-তে ফেরে।
  socket.on('SUBMIT_S4_PREP', deduped('SUBMIT_S4_PREP', async (data = {}) => {
    touchSession();
    if (!page) return status(socket, 'ERROR', '❌ সংযোগ নেই — আবার চেষ্টা করুন।');
    appData.s4prep = data;
    const failed = [];
    let resumable = false;
    let otpSent = false;
    const run = (async () => {
      status(socket, 'PROGRESS', '🔄 যোগাযোগের তথ্য বসানো হচ্ছে...', 'info');
      const anchor = await waitVisible(['#email', 'input[name="email"]', '#phone', 'input[name="phone"]'], 12000);
      if (!anchor) {
        // সেশন নতুন করে তৈরি হয়েছে কি না — সাইট ধাপ ১-এ থাকলে UI চেইন রিপ্লে করবে
        // (তথ্য UI-তে আছে; রিপ্লের পর appData আবার ভরে যায়)
        const atStart = await waitVisible(['#officeBirthplace', 'input[name="officeAddressType"]', 'select[name="officeAddrCountry"]'], 3000);
        if (atStart) {
          resumable = true;
          status(socket, 'PROGRESS', '🔄 নতুন সেশন — তথ্যগুলো আবার বসিয়ে ওটিপি পাঠানো হবে…', 'warn');
          socket.emit('STEP_CHANGE_ACK', {
            step: 6, otpSent: false, resumable: true, failed: [], blocked: false,
            message: '🔄 তথ্য আবার বসিয়ে ওটিপি পাঠানো হবে — একটু অপেক্ষা করুন।',
          });
          return;
        }
        failed.push({ field: 'যোগাযোগ ধাপ', reason: 'পেজ পাওয়া যায়নি' });
      }
      if (anchor && data.email) {
        const r = await typeInto(['#email', 'input[name="email"]'], data.email, socket, 'ইমেইল', {});
        if (!r.ok && !r.skipped) failed.push({ field: r.field, reason: r.reason });
      }
      if (anchor && data.phone) {
        const r = await typeInto(['#phone', 'input[name="phone"]', 'input[type="tel"]'],
          data.phone, socket, 'মোবাইল নম্বর', { required: true });
        if (!r.ok) failed.push({ field: r.field, reason: r.reason });
        // সাইটের getPhone() সরাসরি #phone.value পড়ে — intl-tel-input স্পেস/ড্যাশ বসালে
        // digitOrPlus/length রুল ফেল করে validateForm() চুপচাপ আটকায় (2026-10-11)।
        // তাই মান নরমালাইজ (শুধু ডিজিট/প্লাস) করে দিই, তারপর ফাঁকা হলে নতুন করে লিখি।
        const normPhone = await page.evaluate(() => {
          const el = document.querySelector('#phone');
          if (!el) return { raw: '', clean: '' };
          const raw = String(el.value || '');
          const clean = raw.replace(/[^\d+]/g, '');
          if (clean !== raw) {
            el.value = clean;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return { raw, clean };
        }).catch(() => ({ raw: '', clean: '' }));
        if (normPhone.raw !== normPhone.clean) console.log('S4-PHONE-NORM:', redactPII(JSON.stringify(normPhone)).slice(0, 120));
        if (!/\d{4,}/.test(String(normPhone.clean).replace(/[^\d]/g, ''))) {
          await typeInto(['#phone', 'input[name="phone"]'], String(data.phone).replace(/\D/g, ''),
            socket, 'মোবাইল নম্বর (পুনঃলিখন)', { typeCharByChar: true });
        }
      }
      // ── cinno-প্রথম (2026-10-11): ওটিপি পাঠানোর *আগেই* নামে cinno-সহ আসল রূপ
      // (hidden join সহ) + name-rule শিথিল — সার্ভারে যাওয়া তথ্যেই cinno থাকে।
      // আটকালে নিচের probe-ফলব্যাক সাথে সাথে cinno বাদ দেয় — নাগরিক আটকাবে না।
      let cinnosPre = [];
      if (anchor) {
        cinnosPre = buildCinnos(appData);
        if (cinnosPre.length) {
          const n = await applyCinnos(page, cinnosPre, true);
          const rx = await relaxNameRules(page);
          console.log('S4PREP-CINNO-SNEAK:', JSON.stringify({ applied: n + '/' + cinnosPre.length, relax: rx }));
        }
      }
      // ── সাবমিট-পূর্ব যাচাই (probe) + অটো-ফিক্স — সাইটের validateForm() কখনো
      // চুপচাপ আটকায় (না toast, না SMS); এখানেই ধরব ও নিজেরাই সারাব।
      if (anchor) {
        const probe = () => page.evaluate(() => {
          try {
            const ok = (typeof validateForm === 'function') ? validateForm() : null;
            const errs = [];
            document.querySelectorAll('.form-to-be-validated label.error, .form-to-be-validated .text-danger, .form-to-be-validated .invalid-feedback').forEach((e) => {
              if (e.offsetParent === null) return;
              const t = (e.innerText || '').trim();
              if (t && !errs.includes(t)) errs.push(t.slice(0, 100));
            });
            const g = (s) => { const el = document.querySelector(s); return el ? String(el.value || '').slice(0, 30) : ''; };
            return { valid: ok, errs: errs.slice(0, 5), phone: g('#phone'), email: g('#email') };
          } catch (e) { return { valid: null, errs: [], phone: '', email: '' }; }
        }).catch(() => ({ valid: null, errs: [], phone: '', email: '' }));
        if (appData.singleName) await relaxEmptyLast(page, appData.singleName).catch(() => {});
        let p = await probe();
        console.log('S4-PRE-PROBE:', JSON.stringify(p).slice(0, 300));
        if (p.valid === false) {
          console.log('S4-PROBE-BLOCKED:', JSON.stringify(p));
          const s1 = appData.s1 || {};
          const nmFallback = [s1.firstNameEn, s1.lastNameEn].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
          const fix = await page.evaluate((nmFb) => {
            const out = {};
            const radios = Array.from(document.querySelectorAll('input[name="relationWithApplicant"]'));
            if (radios.length) {
              const c = radios.find((r) => r.checked);
              if (!c || c.offsetParent === null) {
                const vis = radios.filter((r) => r.offsetParent !== null && r.getClientRects().length);
                const t = vis.find((r) => r.value === 'SELF') || vis.find((r) => r.value === 'FATHER') || vis[0];
                if (t) { t.click(); out.relation = t.value; }
              }
            }
            const d = document.querySelector('#declaration');
            if (d && !d.checked) { d.click(); out.decl = true; }
            const nm = document.querySelector('#applicantName');
            if (nm && nm.offsetParent !== null && String(nm.value || '').trim().length < 2 && nmFb) {
              nm.removeAttribute('readonly');
              nm.value = nmFb;
              nm.dispatchEvent(new Event('input', { bubbles: true }));
              nm.dispatchEvent(new Event('change', { bubbles: true }));
              out.name = true;
            }
            return out;
          }, nmFallback).catch(() => ({}));
          console.log('S4-AUTOFIX:', JSON.stringify(fix));
          await page.waitForTimeout(800);
          p = await probe();
        }
        if (p.valid === false && appData.singleName && !appData.gatePassedNames) {
          // ১-নাম: খালি শেষ-নামে সাইটের validateForm() আটকালে — OTP-ধাপ পার হতেই
          // বাধ্য-পূরণ; চূড়ান্ত সাবমিটে আবার খালি করে এক-নাম রেকর্ড রাখার চেষ্টা হবে
          const f = await fillDoubledLast(page, appData.s1 || {}, appData.singleName);
          console.log('S4PREP-SINGLE-FORCE-FILL:', f);
          await page.waitForTimeout(600);
          p = await probe();
          console.log('S4-PRE-PROBE(after fill):', JSON.stringify(p).slice(0, 200));
        }
        if (p.valid === false && cinnosPre.length) {
          // cinno-র কারণেই আটকেছে — নাগরিক আটকাবে না: cinno বাদ দিয়ে আবার যাচাই
          await applyCinnos(page, cinnosPre, false);
          console.log('S4PREP-CINNO-REVERT (validateForm blocked)');
          await page.waitForTimeout(400);
          p = await probe();
          console.log('S4-PRE-PROBE(clean):', JSON.stringify(p).slice(0, 300));
        }
        if (p.valid === false) {
          failed.push({ field: 'ফরম যাচাই', reason: `সাইটের নিজস্ব যাচাইয়ে বাকি: ${p.errs.join(' | ') || 'কিছু ঘর অসম্পূর্ণ'}` });
        }
      }
      // ── "ওটিপি পাঠান" ক্লিক + সত্যিকারের প্রমাণ ──
      if (anchor) {
        const sendBtn = await waitVisible(['button:has-text("ওটিপি পাঠান")'], 10000);
        if (!sendBtn) {
          failed.push({ field: 'ওটিপি পাঠান', reason: 'বাটন পাওয়া যায়নি' });
        } else {
          lastOtpNet = null;
          const clickedOk = await robustClick(sendBtn, 'ওটিপি পাঠান', 8000);
          console.log('S4-SENDOTP-CLICK:', clickedOk ? 'ok' : 'fail');
          const ev = await waitOtpEvidence(30000);
          if (ev.ok) {
            otpSent = true;
            // সাইট কী বলল (মোবাইল/ইমেইল কোথায় পাঠাল) — operator log-এর জন্য
            if (ev.note) console.log('OTP-SITE-MSG:', ev.note);
            status(socket, 'PROGRESS', '📲 কোড পাঠানো হয়েছে — হাতে আসা কোড নিচে বসান', 'ok');
          } else {
            let reason = ev.reason;
            if (lastOtpNet && lastOtpNet.status >= 400 && Date.now() - lastOtpNet.at < 120000) {
              reason = `সাইটের সার্ভার রিকোয়েস্ট নেয়নি (HTTP ${lastOtpNet.status})`
                + (lastOtpNet.body && lastOtpNet.body !== '(body পড়া যায়নি)' ? ': ' + lastOtpNet.body.slice(0, 140) : '');
            }
            failed.push({ field: 'ওটিপি পাঠান', reason });
          }
        }
      }
      await dismissNotices(socket);
      if (!resumable) {
        socket.emit('STEP_CHANGE_ACK', {
          step: 6, otpSent,
          message: otpSent ? '📲 ওটিপি পাঠানো হয়েছে! কোডটি বসিয়ে জমা দিন।'
            : `⚠️ ওটিপি পাঠানো যায়নি — ${failed.length}টি কারণে।`,
          failed,
          blocked: failed.length > 0,
        });
      }
    })();
    try { await withTimeout(run, STEP_TIMEOUT_MS, 'ওটিপি ধাপ'); }
    catch (e) { console.error('S4prep:', e); status(socket, 'ERROR', '❌ কোড পাঠানো যায়নি — আবার চেষ্টা করুন।'); }
  }));

  // ── S4b: OTP + সাবমিট (live-mapped 2026-10-09) ──
  // OTP = SINGLE input#otp (placeholder "OTP"); submit = button "সাবমিট" ("যাচাই" বাটন নেই)
  socket.on('SUBMIT_S4_OTP', deduped('SUBMIT_S4_OTP', async (data = {}) => {
    touchSession();
    // C-1 fix (2026-10-15): server-side charge enforcement — frontend-এর charge
    // ছাড়া সরাসরি emit করলেও টাকা না কেটে সাবমিট হবে না।
    if (ABC_JWT_SECRET) {
      const uid = (socket.abcUser && socket.abcUser.id) || null;
      if (!verifyChargeToken(data._chargeToken, uid, 'submit')) {
        return status(socket, 'ERROR', '❌ পেমেন্ট যাচাই হয়নি — পেজ রিফ্রেশ করে আবার চেষ্টা করুন।');
      }
    }
    if (!page) return status(socket, 'ERROR', '❌ সংযোগ নেই — আবার চেষ্টা করুন।');
    const run = (async () => {
      status(socket, 'PROGRESS', '🔄 কোড বসানো হচ্ছে...', 'info');
      const otp = String(data.otp || '').replace(/\D/g, '');
      if (otp.length < 6) { status(socket, 'ERROR', '❌ কোডটি ৬ ডিজিটের — মোবাইলে আসা পুরো কোডটি লিখুন।'); return; }
      const r = await typeInto([
        '#otp', 'input[name="otp"]', 'input[placeholder="OTP"]',
      ], otp, socket, 'OTP কোড', { required: true, typeCharByChar: true });
      if (!r.ok) { status(socket, 'ERROR', '❌ কোডের ঘর পাওয়া যায়নি — আবার চেষ্টা করুন।'); return; }
      const btn = await waitVisible([
        'button:has-text("সাবমিট")', 'button[type="submit"]',
      ], 12000);
      if (!btn) { status(socket, 'ERROR', '❌ জমা দেওয়ার বাটন পাওয়া যায়নি — আবার চেষ্টা করুন।'); return; }

      // ═══ cinno (`) নীতি — 2026-10-11 live-verified ═══
      // সাইট নামে ` একদমই নেয় না (English ঘরে validate ব্লক, Bangla ঘরে নিজেই মুছে দেয়)।
      // কিন্তু কাগজে cinno থাকলে নাম cinno-সহই যাবে: ধাপে ধাপে সাইট পায় cinno-ছাড়া রূপ,
      // আর ঠিক এই চূড়ান্ত সাবমিটের আগে আসল রূপ (cinno-সহ) নীরবে ফিল্ডে বসে (ইভেন্ট ছাড়া —
      // সাইটের sanitizer ট্রিগার হয় না)। সাইট আটকালে সাথে সাথে cinno তুলে নিয়ে আবার
      // সাবমিট — নাগরিক কোনোভাবেই আটকাবে না।
      // cinno-তালিকা ও shিথিল name-rule — S4prep-এর সাথে একই হেল্পার (2026-10-11)
      const cinnos = buildCinnos(appData);
      if (cinnos.length) {
        const rx = await relaxNameRules(page);
        console.log('S4OTP-CINNO-RELAX:', rx);
      }
      const applyCinnosLocal = async (withCinno) => applyCinnos(page, cinnos, withCinno);
      const clickSubmit = async (withCinno) => {
        const n = await applyCinnosLocal(withCinno);
        if (cinnos.length) console.log('CINNO-SNEAK: applied ' + n + '/' + cinnos.length + (withCinno ? ' (cinno-সহ)' : ' (cinno-বাদ)'));
        await robustClick(btn, withCinno ? 'চূড়ান্ত সাবমিট' : 'চূড়ান্ত সাবমিট (cinno-বাদ)', 8000);
        await page.waitForTimeout(2400);
        return await page.evaluate(() => {
          // দৃশ্যমান success-প্রমাণই গ্রহণযোগ্য — hidden template-এ ভুয়া সাফল্য নয়
          const vis = (el) => !!(el && (el.offsetParent !== null || el.getClientRects().length));
          let succ = false;
          document.querySelectorAll('.alert-success, .success-message, [id*="trackingId"], #applicationId, [class*="success"]').forEach((el) => {
            if (!succ && vis(el)) succ = true;
          });
          const errs = [];
          document.querySelectorAll('.text-danger, .invalid-feedback').forEach(e => {
            if (e.offsetParent === null) return;
            const t = (e.innerText || '').trim();
            if (t) errs.push(t.slice(0, 90));
          });
          // toast-ভুলও ধরো — সাবমিট আটকালে এখানেই ধরা পড়বে
          document.querySelectorAll('.jq-toast-single').forEach((t) => {
            if (t.offsetParent === null) return;
            if (!t.querySelector('.jq-icon-error, .jq-icon-error-circle')) return;
            const txt = (t.innerText || '').trim();
            if (txt) errs.push(txt.slice(0, 90));
          });
          return { succ, errs: errs.slice(0, 3) };
        }).catch(() => ({ succ: false, errs: [] }));
      };
      // ১-নাম স্থায়ী নিয়ম: সাবমিটের ঠিক আগে শেষ-নামের ঘর খালি + রুল শিথিল —
      // join-নামও ইতিমধ্যেই এক-নাম রূপে বসানো (buildCinnos)। সাইট তবু আটকালে
      // নিচের restore-শাখা বাধ্য-পূরণ করে আবার সাবমিট করে (নাগরিক আটকাবে না)।
      if (appData.singleName && !appData.gatePassedNames) {
        const rx2 = await relaxEmptyLast(page, appData.singleName);
        const em = await emptyLastVisible(page, appData.singleName);
        console.log('S4OTP-SINGLE:', JSON.stringify({ relax: rx2, emptied: em }));
      }
      let singleRestored = false;
      let post = await clickSubmit(true);
      if (post.succ) {
        status(socket, 'PROGRESS', '✔ চূড়ান্ত সাবমিট গৃহীত হয়েছে', 'ok');
      } else if (post.errs.some(t => /অক্ষর/.test(t)) && cinnos.length) {
        // সাইট cinno নামে নিচ্ছে না — নাগরিক আটকাবে না: cinno বাদ দিয়ে সাথে সাথে আবার
        status(socket, 'PROGRESS', '🔁 নামের cinno সাইট নিচ্ছে না — cinno ছাড়া আবার পাঠানো হচ্ছে…', 'warn');
        const otpNow = await page.evaluate(() => {
          const el = document.querySelector('#otp, input[name="otp"]');
          return el ? el.value : '';
        }).catch(() => '');
        if (!String(otpNow || '').replace(/\D/g, '')) {
          await typeInto(['#otp', 'input[name="otp"]', 'input[placeholder="OTP"]'], otp, socket, 'OTP কোড', { required: true, typeCharByChar: true });
        }
        post = await clickSubmit(false);
        status(socket, 'PROGRESS', post.succ ? '✔ সাবমিট গৃহীত হয়েছে (নাম সাইট-নিয়মে)' : '⚠ সাইটের উত্তর এখনো আসেনি — অপেক্ষা করা হচ্ছে…', post.succ ? 'ok' : 'warn');
      } else {
        status(socket, 'PROGRESS', '✔ চূড়ান্ত সাবমিট দেওয়া হয়েছে', 'ok');
      }
      // ১-নাম restore-ফলব্যাক: খালি শেষ-নামে সাইট সাবমিট আটকালে — বাধ্য-পূরণ + আবার
      // সাবমিট (join-নাম trim থাকায় রেকর্ডে নাম একবারই থাকবে)
      if (!post.succ && !singleRestored && appData.singleName && !appData.gatePassedNames
          && post.errs.some(t => /আবশ্য|পূরণ|নাম|required|last/i.test(t))) {
        singleRestored = true;
        const otpNow2 = await page.evaluate(() => {
          const el = document.querySelector('#otp, input[name="otp"]');
          return el ? el.value : '';
        }).catch(() => '');
        if (!String(otpNow2 || '').replace(/\D/g, '')) {
          await typeInto(['#otp', 'input[name="otp"]', 'input[placeholder="OTP"]'], otp, socket, 'OTP কোড', { required: true, typeCharByChar: true });
        }
        await fillDoubledLast(page, appData.s1 || {}, appData.singleName);
        await relaxEmptyLast(page, appData.singleName);
        console.log('S4OTP-SINGLE-RESTORE-RETRY');
        post = await clickSubmit(true);
        status(socket, 'PROGRESS', post.succ ? '✔ সাবমিট গৃহীত হয়েছে' : '⚠ সাইটের উত্তর এখনো আসেনি — অপেক্ষা করা হচ্ছে…', post.succ ? 'ok' : 'warn');
      }
      status(socket, 'PROGRESS', '⏳ সাইটের উত্তর আসার অপেক্ষায়...');

      let ackText = '';
      let sawSuccess = false;
      try {
        await page.waitForSelector(
          '.alert-success, .success-message, [class*="success"], #applicationId, [id*="ack"], [id*="trackingId"]',
          { state: 'visible', timeout: 25000 }
        );
        sawSuccess = true;
        ackText = await page.evaluate(() => {
          const sels = ['.alert-success', '.success-message', '#applicationId', '[id*="trackingId"]', '[id*="ack"]', '[class*="success"]'];
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (el && el.innerText.trim()) return el.innerText.trim();
          }
          return '';
        });
      } catch {
        // ২৫ সেকেন্ডে দৃশ্যমান সাফল্য আসেনি — শুধু ১৭-ডিজিট নম্বর থাকলে সেটাই প্রমাণ
        ackText = await page.evaluate(() => {
          const body = document.body.innerText || '';
          const m = body.match(/\b\d{17}\b/);
          if (m) return 'আবেদন নম্বর: ' + m[0];
          return '';
        }).catch(() => '');
        if (ackText) sawSuccess = true;
      }

      // লাইভ 2026-10-11: সাফল্যের banner-এ নম্বর থাকে না — নম্বর থাকে নিচের প্যানেলে
      // ("আবেদনপত্র নম্বর : 265370215")। তাই পুরো পাতার টেক্সট থেকেও নম্বর খোঁজা হয়।
      try {
        const liveNum = await page.evaluate(() => {
          const body = document.body.innerText || '';
          let m = body.match(/আবেদন(?:পত্র)?\s*নম্বর\s*[:：]?\s*([\d\u09E6-\u09EF]{4,20})/);
          if (!m) m = body.match(/\b\d{17}\b/);
          if (!m) m = body.match(/\b\d{7,12}\b/);
          return m ? (m[1] || m[0]) : '';
        }).catch(() => '');
        if (liveNum) {
          sawSuccess = true;
          if (!String(ackText).includes(liveNum)) {
            ackText = (ackText ? ackText + ' — ' : '') + 'আবেদন নম্বর: ' + liveNum;
          }
        }
      } catch { /* ঐচ্ছিক */ }

      // সাবমিট সত্যিই গৃহীত হয়েছে কি না — না হলে ভুয়া সাফল্য নয়, কারণ-সহ ERROR
      // (live 2026-10-11-এর ভুল-OTP পরিস্থিতি: সাইট জমা না নিয়ে চুপ থাকে)
      if (!sawSuccess && !/\d{4}/.test(String(ackText))) {
        const perr = await page.evaluate(() => {
          const msgs = [];
          document.querySelectorAll('.text-danger, .invalid-feedback, .jq-toast-single').forEach(e => {
            if (e.offsetParent === null) return;
            const t = (e.innerText || '').trim().replace(/\s+/g, ' ');
            if (t) msgs.push(t.slice(0, 110));
          });
          const hasOtp = !!(document.querySelector('#otp, input[name="otp"]'));
          return { msgs: msgs.slice(0, 3), hasOtp };
        }).catch(() => ({ msgs: [], hasOtp: false }));
        const why = (perr.msgs && perr.msgs[0])
          || (perr.hasOtp
            ? 'কোডটি মিলছে না বা মেয়াদ শেষ — মোবাইলে আসা সর্বশেষ কোডটি আবার বসান (না এলে “আবার কোড পাঠান”)'
            : 'সাইট জমাটি নেয়নি — আবার চেষ্টা করুন');
        status(socket, 'ERROR', '❌ ' + why);
        return;
      }

      let screenshot = null;
      try {
        const buf = await page.screenshot({ fullPage: false, timeout: 15000 });
        screenshot = 'data:image/png;base64,' + buf.toString('base64');
      } catch (e) { console.warn('Screenshot failed:', e.message.slice(0, 80)); }

      // one-click main-copy PDF: সাফল্যের পেজে PDF/ডাউনলোড বাটন খুঁজে ধরা
      // (main server-এর মতো আবেদন নং+DOB+মোবাইল দিয়ে খোঁজা লাগবে না)
      let pdf = null;
      try {
        const dlBtn = await waitVisible([
          'a:has-text("PDF")', 'button:has-text("PDF")',
          'a:has-text("ডাউনলোড")', 'button:has-text("ডাউনলোড")',
          'a:has-text("Download")', 'button:has-text("Download")',
          'a[href$=".pdf"]',
          // লাইভ 2026-10-11: সাফল্যের পাতায় "আবেদনপত্র প্রিন্ট" (=প্রিন্ট) বাটনই আসল
          // PDF-এর রাস্তা — download event আসে birth_application_print.pdf নামে
          'button:has-text("প্রিন্ট")', 'a:has-text("প্রিন্ট")',
        ], 10000);
        if (dlBtn) {
          status(socket, 'PROGRESS', '📥 আবেদনের PDF কপি ডাউনলোড হচ্ছে...', 'info');
          const dlPromise = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
          await dlBtn.click().catch(() => {});
          const dl = await dlPromise;
          if (dl) {
            const dp = await dl.path().catch(() => null);
            if (dp) {
              const buf = require('fs').readFileSync(dp);
              const pdfName = (dl.suggestedFilename() || 'bdris-application.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
              try {
                const ddir = path.join(__dirname, 'downloads');
                require('fs').mkdirSync(ddir, { recursive: true });
                require('fs').writeFileSync(path.join(ddir, Date.now() + '-' + pdfName), buf);
              } catch { /* সংরক্ষণ ঐচ্ছিক */ }
              pdf = { name: pdfName, base64: buf.toString('base64') };
              status(socket, 'PROGRESS', '✔ আবেদনের PDF কপি পাওয়া গেছে', 'ok');
            }
          }
        } else {
          status(socket, 'PROGRESS', '⊘ এই পেজে PDF ডাউনলোড বাটন পাওয়া যায়নি', 'warn');
        }
      } catch (e) { console.warn('PDF capture:', e.message.slice(0, 80)); }

      // যাচাই: ডাউনলোড আসল PDF কিনা — stub/ভাঙা ফাইল (৭৪-বাইট) হলে বাদ
      let ackNum = '';
      {
        const at = String(ackText || '');
        const labeled = at.match(/আবেদন(?:পত্র)?\s*নম্বর\s*[:：]?\s*([\d\u09E6-\u09EF]{4,20})/);
        const generic = labeled ? null : (at.match(/\b\d{17}\b/) || at.match(/\b\d{7,12}\b/));
        ackNum = (labeled ? labeled[1] : (generic ? generic[0] : ''))
          .replace(/[\u09E6-\u09EF]/g, (c) => String(c.charCodeAt(0) - 0x09E6));
      }
      appData.ackId = ackText || '';
      let originalUrl = null;
      if (pdf) {
        let ok = false;
        try { ok = isValidPdf(Buffer.from(pdf.base64, 'base64')); } catch { ok = false; }
        if (ok) {
          if (ackNum) {
            pdf.name = 'abedon-copy-' + ackNum + '.pdf';
            // সাইটের আসল PDF-এর কপি স্ট্যাটিক ফোল্ডারে — হিরোতে সরাসরি নামানো যায়
            try {
              const fdir = path.join(__dirname, '..', 'frontend');
              require('fs').writeFileSync(path.join(fdir, 'bdris-original-' + ackNum + '.pdf'), Buffer.from(pdf.base64, 'base64'));
              originalUrl = '/bdris-original-' + ackNum + '.pdf';
            } catch { /* ঐচ্ছিক */ }
          }
        } else {
          status(socket, 'PROGRESS', '⚠️ সাইটের ডাউনলোড ফাইলটি অসম্পূর্ণ — নিজস্ব আবেদন কপি তৈরি করা হচ্ছে', 'warn');
          pdf = null;
        }
      }
      // fallback: নিজস্ব অফিসিয়াল-স্টাইল "আবেদন কপি" PDF (A4)
      if (!pdf) {
        try {
          status(socket, 'PROGRESS', '📄 আবেদন কপি (PDF) তৈরি হচ্ছে...', 'info');
          const buf = await generateCopyPdf(ackNum, appData);
          const nm = 'abedon-copy' + (ackNum ? '-' + ackNum : '') + '.pdf';
          try {
            const ddir = path.join(__dirname, 'downloads');
            require('fs').mkdirSync(ddir, { recursive: true });
            require('fs').writeFileSync(path.join(ddir, Date.now() + '-' + nm), buf);
          } catch { /* সংরক্ষণ ঐচ্ছিক */ }
          pdf = { name: nm, base64: buf.toString('base64') };
          status(socket, 'PROGRESS', '✔ আবেদন কপি (PDF) তৈরি হয়েছে', 'ok');
        } catch (e) { console.warn('genCopyPdf:', e.message.slice(0, 100)); }
      }

      socket.emit('BOT_STATUS', {
        status: 'COMPLETED', message: '🎉 BDRIS আবেদন সফলভাবে জমা হয়েছে!',
        level: 'ok', ackId: ackText || 'BDRIS পোর্টালে সফলভাবে জমা হয়েছে।', screenshot, pdf, original: originalUrl,
      });

      // ── আসল PDF প্রস্তুতি (2026-10-11): সাইটের ডাউনলোড কপি না মিললে নীরবে
      // পাবলিক print-ফ্লো থেকে হুবহু আসল PDF আনা শুরু হয় — হিরোর পেন্ডিং বাটনে
      // ক্লিক করলেই (বা প্রস্তুত হলেই) সাথে সাথে নেমে যায়। UI-তে bot-ঝলক নেই।
      // (MOCK-এ কখনো নয় — নকল রেকর্ড নিয়ে আসল সাইটে যাওয়া নিষেধ)
      if (ackNum && !MOCK_MODE) {
        try {
          const rec = buildOriginalRec(ackNum);
          if (rec) {
            origIndexPut(ackNum, rec);
            if (!originalUrl) {
              ensureOriginal(rec, (r) => {
                if (!socket.connected) return;
                socket.emit('BOT_STATUS', {
                  status: 'ORIGINAL_PDF', ackId: ackNum,
                  original: (r && r.ok) ? r.url : null, ok: !!(r && r.ok),
                });
              });
            }
          }
        } catch (e) { console.warn('origPrefetch:', String(e.message || e).slice(0, 100)); }
      }
    })();
    try { await withTimeout(run, STEP_TIMEOUT_MS, 'OTP ধাপ'); }
    catch (e) { console.error('S4:', e); status(socket, 'ERROR', '❌ কোড যাচাই করা যায়নি — আবার চেষ্টা করুন।'); }
  }));

  // ── FETCH_ORIGINAL: হিরোর "আসল PDF" — ক্যাশ → চলমান job → নতুন job (2026-10-11) ──
  socket.on('FETCH_ORIGINAL', async (data = {}) => {
    touchSession();
    // C-1 fix (2026-10-15): PDF চার্জ server-side-এ যাচাই — টোকেন ছাড়া ডাউনলোড নয়।
    if (ABC_JWT_SECRET) {
      const uid = (socket.abcUser && socket.abcUser.id) || null;
      if (!verifyChargeToken(data._chargeToken, uid, 'pdf')) {
        socket.emit('BOT_STATUS', { status: 'ORIGINAL_PDF', ackId: '', original: null, ok: false, error: 'CHARGE_REQUIRED' });
        return;
      }
    }
    let ack = String(data.ack || data.ackId || '').replace(/\D/g, '');
    if (!ack) {
      // নম্বর পড়া না গেলেও সর্বশেষ সাবমিট-রেকর্ড থেকেই আনা যায় (নিজের সেশন)
      const keys = Object.keys(origIndexLoad());
      if (keys.length) ack = keys[keys.length - 1];
    }
    if (!ack) return;
    if (MOCK_MODE) {
      socket.emit('BOT_STATUS', { status: 'ORIGINAL_PDF', ackId: ack, original: null, ok: false });
      return;
    }
    const cached = cachedOriginal(ack);
    if (cached) {
      socket.emit('BOT_STATUS', { status: 'ORIGINAL_PDF', ackId: ack, original: cached.url, ok: true });
      return;
    }
    const rec = origIndexGet(ack);
    if (!rec) {
      socket.emit('BOT_STATUS', { status: 'ORIGINAL_PDF', ackId: ack, original: null, ok: false });
      return;
    }
    ensureOriginal(rec, (r) => {
      if (!socket.connected) return;
      socket.emit('BOT_STATUS', {
        status: 'ORIGINAL_PDF', ackId: ack,
        original: (r && r.ok) ? r.url : null, ok: !!(r && r.ok),
      });
    });
  });

  // ── STATUS: আবেদনের অবস্থা দেখা (লগইন-ভিত্তিক, 2026-10-11) ──
  // আলাদা নিঃশব্দ ব্রাউজারে লগইন হয় — চলমান আবেদন-সেশনে হাত পড়ে না।
  const statusBase = () => (MOCK_MODE ? `http://localhost:${PORT}` : 'https://bdris.gov.bd');
  socket.on('STATUS_OPEN', async (data = {}) => {
    touchSession();
    const username = String(data.username || '').trim();
    const password = String(data.password || '');
    const mobileEmail = String(data.mobileEmail || '').trim();
    const userType = String(data.userType || 'BANGLADESH').toUpperCase() === 'MISSION' ? 'MISSION' : 'BANGLADESH';
    if (!username || !password) {
      return socket.emit('BOT_STATUS', { status: 'STATUS_ERROR', message: '❌ ব্যবহারকারীর নাম ও পাসওয়ার্ড দুটোই দিন।' });
    }
    if (userType === 'BANGLADESH' && !/^01\d{9}$/.test(mobileEmail)) {
      return socket.emit('BOT_STATUS', { status: 'STATUS_ERROR', message: '❌ মোবাইল নম্বর (১১ ডিজিট, 01 দিয়ে শুরু) দিন।' });
    }
    if (userType === 'MISSION' && !/^\S+@\S+\.\S+$/.test(mobileEmail)) {
      return socket.emit('BOT_STATUS', { status: 'STATUS_ERROR', message: '❌ ইমেইল ঠিকানাটি ঠিক নেই।' });
    }
    const emit = (m) => status(socket, 'PROGRESS', '⏳ ' + m);
    try {
      const r = await STATUS_CHECK.statusOpen({ base: statusBase(), username, password, mobileEmail, userType }, emit);
      if (r.ok) {
        socket.emit('BOT_STATUS', { status: 'STATUS_OTP', message: '📲 কোড পাঠানো হয়েছে — মোবাইলে আসা কোডটি বসান।' });
      } else {
        socket.emit('BOT_STATUS', { status: 'STATUS_ERROR', message: '❌ ' + (r.message || 'লগইন করা যায়নি — আবার চেষ্টা করুন') });
      }
    } catch (e) {
      console.error('STATUS_OPEN:', String(e.message || e).slice(0, 200));
      socket.emit('BOT_STATUS', { status: 'STATUS_ERROR', message: '❌ সাইটে সংযোগ করা যায়নি — আবার চেষ্টা করুন' });
    }
  });
  socket.on('STATUS_OTP', async (data = {}) => {
    touchSession();
    const otp = String(data.otp || '').replace(/\D/g, '');
    if (otp.length < 6) {
      return socket.emit('BOT_STATUS', { status: 'STATUS_ERROR', message: '❌ ৬ ডিজিটের কোডটি সম্পূর্ণ লিখুন।' });
    }
    const emit = (m) => status(socket, 'PROGRESS', '⏳ ' + m);
    try {
      const r = await STATUS_CHECK.statusOtp(otp, { base: statusBase() }, emit);
      if (r.ok) {
        socket.emit('BOT_STATUS', {
          status: 'STATUS_RESULT', title: r.title || 'আবেদনের বর্তমান অবস্থা',
          tables: r.tables || [], text: r.text || '', url: r.url || '',
        });
      } else {
        socket.emit('BOT_STATUS', { status: 'STATUS_ERROR', message: '❌ ' + (r.message || 'কোড মেলেনি — আবার চেষ্টা করুন'), stage: 'otp' });
      }
    } catch (e) {
      console.error('STATUS_OTP:', String(e.message || e).slice(0, 200));
      socket.emit('BOT_STATUS', { status: 'STATUS_ERROR', message: '❌ যাচাই করা যায়নি — আবার চেষ্টা করুন', stage: 'otp' });
    }
  });
  socket.on('STATUS_REFRESH', async () => {
    touchSession();
    const emit = (m) => status(socket, 'PROGRESS', '⏳ ' + m);
    try {
      const r = await STATUS_CHECK.statusRefresh({ base: statusBase() }, emit);
      if (r.ok) {
        socket.emit('BOT_STATUS', {
          status: 'STATUS_RESULT', title: r.title || 'আবেদনের বর্তমান অবস্থা',
          tables: r.tables || [], text: r.text || '', url: r.url || '',
        });
      } else {
        socket.emit('BOT_STATUS', { status: 'STATUS_ERROR', message: '❌ ' + (r.message || 'আবার আনা যায়নি — আবার লগইন করুন'), stage: r.relogin ? 'relogin' : '' });
      }
    } catch (e) {
      console.error('STATUS_REFRESH:', String(e.message || e).slice(0, 200));
      socket.emit('BOT_STATUS', { status: 'STATUS_ERROR', message: '❌ আবার আনা যায়নি — আবার চেষ্টা করুন', stage: 'relogin' });
    }
  });
  socket.on('STATUS_CLOSE', () => {
    touchSession();
    STATUS_CHECK.statusClose().catch(() => {});
  });

  // ── DRAFTS (OTP-এর আগে সম্পূর্ণ আবেদন সংরক্ষণ) ──
  // C-1 fix (2026-10-15): per-user — socket.abcUser.id দিয়ে scope করা
  const abcUid = () => (socket.abcUser && socket.abcUser.id) || null;
  socket.on('SAVE_DRAFT', (data, callback) => {
    touchSession();
    try {
      const r = saveDraft(data || {}, abcUid());
      status(socket, 'PROGRESS', `💾 খসড়া সংরক্ষিত (${r.draftId}) — পরে যেকোনো সময় OTP দিয়ে সাবমিট করা যাবে`, 'ok');
      if (callback) callback({ ok: true, ...r });
    } catch (e) { console.error('saveDraft:', e.message); if (callback) callback({ ok: false, error: 'খসড়া সংরক্ষণ করা যায়নি — আবার চেষ্টা করুন' }); }
  });
  socket.on('LIST_DRAFTS', (callback) => {
    touchSession();
    if (callback) callback(listDrafts(abcUid()));
  });
  socket.on('LOAD_DRAFT', (draftId, callback) => {
    touchSession();
    try { if (callback) callback({ ok: true, draft: loadDraft(abcUid(), draftId) }); }
    catch (e) { if (callback) callback({ ok: false, error: 'খসড়া পাওয়া যায়নি' }); }
  });
  socket.on('DELETE_DRAFT', (draftId, callback) => {
    touchSession();
    try { deleteDraft(abcUid(), draftId); if (callback) callback({ ok: true }); }
    catch (e) { if (callback) callback({ ok: false }); }
  });

  // ── ঠিকানা বই ──
  socket.on('LIST_ADDRESSES', (callback) => {
    touchSession();
    if (callback) callback({ ok: true, addresses: loadAddresses(abcUid()) });
  });
  socket.on('SAVE_ADDRESS', (addr, callback) => {
    touchSession();
    try {
      if (!addr || !addr.name) { if (callback) callback({ ok: false, error: 'নাম দিন' }); return; }
      const list = upsertAddress(abcUid(), addr);
      if (callback) callback({ ok: true, addresses: list });
    } catch (e) { console.error('saveAddress:', e.message); if (callback) callback({ ok: false, error: 'সেভ করা যায়নি — আবার চেষ্টা করুন' }); }
  });
  socket.on('DELETE_ADDRESS', (id, callback) => {
    touchSession();
    try {
      saveAddresses(abcUid(), loadAddresses(abcUid()).filter(a => a.id !== id));
      if (callback) callback({ ok: true, addresses: loadAddresses(abcUid()) });
    } catch (e) { console.error('delAddress:', e.message); if (callback) callback({ ok: false, error: 'মুছে ফেলা যায়নি — আবার চেষ্টা করুন' }); }
  });

  socket.on('CLOSE_BROWSER', async () => {
    touchSession();
    await closeBrowser();
    status(socket, 'IDLE', '🔄 সংযোগ বন্ধ হয়েছে। নতুন আবেদনের জন্য পেজ রিফ্রেশ করুন।');
  });

  socket.on('RESTART_BOT', async () => {
    touchSession();
    await closeBrowser();
    status(socket, 'IDLE', '🔄 সংযোগ রিসেট হয়েছে।');
  });

  socket.on('disconnect', () => {
    console.log(`[${ts()}] 🔌 disconnected: ${socket.id}`);
    // C-1 fix: মালিক চলে গেলে লক ছাড়ো — পরের user নতুন appData নিয়ে শুরু করবে।
    if (sessionOwner === socket.id) {
      sessionOwner = null;
      appData = {};
      applicantDobIso = null;
    }
  });
});

setInterval(() => {
  if (browser && Date.now() - lastActivity > SESSION_TIMEOUT_MS) {
    console.log(`[${ts()}] ⏱ Session timeout — browser auto-closing`);
    sessionOwner = null; // C-1 fix: timeout-এ লক ছাড়ো
    appData = {};
    applicantDobIso = null;
    closeBrowser().then(() => {
      io.emit('BOT_STATUS', {
        status: 'SESSION_TIMEOUT', level: 'warn',
        message: `⏱ ${Math.round(SESSION_TIMEOUT_MS / 60000)} মিনিট নিষ্ক্রিয় থাকায় সংযোগ বন্ধ হয়েছে। পুনরায় শুরু করুন।`,
      });
    });
  }
}, 60000);

// M-16 fix (2026-10-15): bind loopback only (was: all interfaces).
server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('🚀 ════════════════════════════════════');
  console.log('   BDRIS Automation Server v3 চালু! (real-site mapping)');
  console.log(`   UI     → http://localhost:${PORT}`);
  console.log(`   Health → http://localhost:${PORT}/api/health`);
  console.log(`   Target → ${MOCK_MODE ? `http://localhost:${PORT}/mock-bdris (TEST)` : BDRIS_URL}`);
  console.log(`   Browser→ ${HEADLESS ? 'headless' : 'visible'} | slowMo ${SLOWMO}ms`);
  console.log('🚀 ════════════════════════════════════');
  console.log('');
});

// কোনো এক অপ্রত্যাশিত এরর সার্ভার নামাবে না — লগ রেখে বাঁচিয়ে রাখি (নাগরিক আটকাবে না)
process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED-REJECTION:', (e && e.stack) ? String(e.stack).slice(0, 500) : String(e).slice(0, 500));
});
process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT-EXCEPTION:', (e && e.stack) ? String(e.stack).slice(0, 500) : String(e).slice(0, 500));
});
