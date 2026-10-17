/**
 * StepHandler — Form step execution for BDRIS application
 *
 * Principles:
 * - Each step is an independent command
 * - Clear inputs, guaranteed outputs
 * - Progress events for UI feedback
 * - Idempotent where possible
 *
 * Migrated from v1 with clean architecture:
 * - No global state
 * - Explicit dependencies
 * - Testable in isolation
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ═══════════════════════════════════════════════════════════════
// Charge receipt verification — copied faithfully from v1
// (engines/bdris-apply/server.js :: verifyChargeToken)
// backend /charge/* endpoint দেয় — v1.<userId>.<kind>.<ref>.<ts>.<mac>
// ═══════════════════════════════════════════════════════════════
const ABC_JWT_SECRET = process.env.ABC_JWT_SECRET || '';
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

// ═══════════════════════════════════════════════════════════════
// Pure helpers — copied faithfully from v1 (engines/bdris-apply/server.js)
// ═══════════════════════════════════════════════════════════════

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
// 2026-10-11 (live-verified): BDRIS নামে ` (cinno) একদমই নেয় না — সাইটে টাইপ হয়
// cinno-ছাড়া রূপ (transitName)।
function transitName(s) {
  return cleanName(s).replace(/`/g, '').trim();
}
function isoToBdFormat(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}
// applicant DOB (ISO) → 2013-এর আগে কিনা (2013 সাল নিজে unverified)
function isPre2013(iso) {
  if (!iso) return false;
  return String(iso).slice(0, 10) < '2013-01-01';
}
// বাংলা লেবেল normalization (live-verified 2026-10-10):
// পেজে "রাজবাড়ী" (ড় = U+09DC) আসে, টাইপ করা মানে "রাজবাড়ী" (ড় = ড+়) হতে পারে।
// NFKC + ড়→ড় একরূপ + ZWJ/ZWNJ বাদ → select মিলিয়ে নেওয়া যায়।
function bnNorm(s) {
  return String(s || '').normalize('NFKC')
    .replace(/\u09DC/g, '\u09A1\u09BC')
    .replace(/[\u200C\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function bnToArab(s) {
  return String(s || '').replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d));
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

// ═══════════════════════════════════════════════════════════════
// cinno (`) helpers — copied faithfully from v1
// (engines/bdris-apply/server.js :: buildCinnos / applyCinnos /
//  relaxNameRules / relaxEmptyLast / emptyLastVisible / fillDoubledLast)
// v1-এ global appData পড়ত; v2-তে fd = {s1, s2, singleName, gatePassedNames}
// ═══════════════════════════════════════════════════════════════
function buildCinnos(fd) {
  const cinnos = [];
  const add = (sels, v) => {
    const tgt = cleanName(v);
    const clean = transitName(v);
    if (String(tgt).includes('`') && tgt !== clean) cinnos.push([sels, tgt, clean]);
  };
  const A = (fd && fd.s1) || {};
  add(['#personFirstNameBn', 'input[name$="personFirstNameBn"]'], A.firstNameBn);
  add(['#personLastNameBn', 'input[name$="personLastNameBn"]'], A.lastNameBn);
  add(['#personFirstNameEn', 'input[name$="personFirstNameEn"]'], A.firstNameEn);
  add(['#personLastNameEn', 'input[name$="personLastNameEn"]'], A.lastNameEn);
  // ১-নামের গেট-পাস হয়েছিল? শেষের নামে প্রথম নামের রূপই বসেছিল — cinno-সহ সংস্করণ
  if (fd && fd.gatePassedNames && !hasLetters(transitName(A.lastNameBn))) {
    const tgtBn = cleanName(A.firstNameBn);
    const tgtEn = cleanName(A.firstNameEn);
    if (String(tgtBn).includes('`')) cinnos.push([['#personLastNameBn', 'input[name$="personLastNameBn"]'], tgtBn, transitName(A.firstNameBn)]);
    if (String(tgtEn).includes('`')) cinnos.push([['#personLastNameEn', 'input[name$="personLastNameEn"]'], tgtEn, transitName(A.firstNameEn)]);
  }
  {
    // সাইটের join-নিয়ম হুবহু: প্রথম + " " + শেষ (খালি হলেও হুবহু)।
    // ১-নাম স্থায়ী নিয়ম (2026-10-11): single ফ্ল্যাগ থাকলে join-এও নাম একবারই —
    // শেষের নাম যাই থাকুক (খালি / গেট-পাসের ডাবল), চূড়ান্ত রেকর্ডে ডাবল কখনো নয়।
    const gate = !!(fd && fd.gatePassedNames);
    const singleBn = !!((fd && fd.singleName) && fd.singleName.bn);
    const singleEn = !!((fd && fd.singleName) && fd.singleName.en);
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
  const P = (fd && fd.s2) || {};
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

// ═══════════════════════════════════════════════════════════════
// Copy-PDF helpers — copied faithfully from v1
// (engines/bdris-apply/server.js :: isValidPdf / escHtml / fmtBnDate /
//  addrLine / buildCopyHtml)
// ═══════════════════════════════════════════════════════════════
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
  const y = toBn(m[1]), mo = months[parseInt(m[2], 10) - 1] || m[2], d = toBn(String(parseInt(m[3], 10)));
  return `${d} ${mo}, ${y}`;
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
// পাবলিক print-লুকআপে সাবমিট হওয়া হুবহু নাম/তারিখ/মোবাইল লাগে। cinno-সহ রূপ
// প্রাইমারি, cinno-ছাড়া রূপ বিকল্প; ১-নাম কখনো ডাবল করা হয় না — এক-নাম রূপই থাকে।
// v1-এ global appData পড়ত; v2-তে fd = {s1, s4prep, singleName, gatePassedNames}
function buildOriginalRec(fd, ackNum) {
  const A = (fd && fd.s1) || {};
  const S4 = (fd && fd.s4prep) || {};
  const singleEn = !!((fd && fd.singleName) && fd.singleName.en);
  const gate = !!((fd && fd.gatePassedNames));
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

class StepHandler {
  constructor(navigator, options = {}) {
    this.navigator = navigator; // BdrisNavigator instance
    this.page = navigator.page;
    this.emit = options.emit || (() => {});
    // v1 appData equivalents — explicit, no globals
    this.applicantDob = options.applicantDob || null; // applicant DOB ISO (2013-rule)
    this.singleName = options.singleName || null;     // 1-name relax data
    this.gatePassedNames = options.gatePassedNames || false; // 1-name gate passed (S1)
    this.userId = options.userId || null;             // charge-token verification (S4)
  }

  progress(message) {
    this.emit('PROGRESS', message);
  }

  /**
   * Step 0: Select application basis (জন্মস্থান / স্থায়ী ঠিকানা)
   */
  async submitS0(data = {}) {
    const { addressType = 'BIRTH' } = data;
    this.progress('🔄 ধাপ ১: আবেদনের ভিত্তি নির্বাচন...');

    // Select the basis radio/card
    const basisId = addressType === 'PERMANENT' ? '#aPerm' : '#aBirth';
    await this.page.click(basisId).catch(() => {});

    // Click next
    await this.page.click('#brOfficeSelectionNextBtn, button:has-text("পরবর্তী")')
      .catch(async () => {
        // Fallback: try by text
        await this.page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const next = btns.find(b => /পরবর্তী/.test(b.textContent));
          if (next) next.click();
        });
      });

    await this.page.waitForTimeout(2000);
    this.progress('✔ আবেদনের ভিত্তি নির্বাচন সম্পন্ন');
    return { ok: true, step: 1 };
  }

  /**
   * Helper: Fill a text input
   */
  async fillInput(selector, value, label = '') {
    if (!value && value !== '') return { ok: true, skipped: true };

    try {
      const selectors = selector.split(',').map(s => s.trim());
      for (const sel of selectors) {
        const el = await this.page.$(sel);
        if (!el) continue;

        await el.click({ clickCount: 3 }).catch(() => {});
        await el.fill('').catch(() => {});
        await el.type(String(value), { delay: 10 }).catch(async () => {
          // Fallback: set via JS
          await this.page.evaluate(({ s, v }) => {
            const node = document.querySelector(s);
            if (node) {
              node.value = v;
              node.dispatchEvent(new Event('input', { bubbles: true }));
              node.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, { s: sel, v: String(value) });
        });

        // Verify
        const actual = await this.page.evaluate((s) => {
          const node = document.querySelector(s);
          return node ? node.value : '';
        }, sel).catch(() => '');

        if (actual || !value) {
          return { ok: true, field: label };
        }
      }
      return { ok: false, field: label, reason: 'Element not found' };
    } catch (e) {
      return { ok: false, field: label, reason: e.message };
    }
  }

  /**
   * Helper: Select dropdown option
   */
  async selectDropdown(selector, label, valueLabel) {
    const done = await this.navigator.selectOption(selector, valueLabel);
    if (!done) {
      return { ok: false, field: label, reason: `Option "${valueLabel}" not found` };
    }
    // Wait for dependent fields to update
    await this.page.waitForTimeout(800);
    return { ok: true, field: label };
  }

  /**
   * Step 1: Person info + birth address
   */
  async submitS1(data = {}) {
    this.progress('🔄 ধাপ ২: ব্যক্তির পরিচিতি লেখা হচ্ছে...');
    const failed = [];

    const keep = (r) => {
      if (!r.ok && !r.skipped) failed.push({ field: r.field, reason: r.reason });
    };

    // Names
    keep(await this.fillInput('#personFirstNameBn, input[name*="personFirstNameBn"]',
      data.firstNameBn, 'নামের প্রথম অংশ (বাংলা)'));
    keep(await this.fillInput('#personLastNameBn, input[name*="personLastNameBn"]',
      data.lastNameBn, 'নামের শেষ অংশ (বাংলা)'));
    keep(await this.fillInput('#personFirstNameEn, input[name*="personFirstNameEn"]',
      data.firstNameEn, 'First Name (English)'));
    keep(await this.fillInput('#personLastNameEn, input[name*="personLastNameEn"]',
      data.lastNameEn, 'Last Name (English)'));

    // DOB
    if (data.dob) {
      keep(await this.fillInput('#personDob, input[name*="personDob"]',
        data.dob, 'জন্ম তারিখ'));
    }

    // Gender, child number
    if (data.gender) {
      keep(await this.selectDropdown('#personGender, select[name*="personGender"]',
        'লিঙ্গ', data.gender));
    }

    this.progress('🔄 ধাপ ২: জন্মস্থানের ঠিকানা...');
    // Birth address (using AddressService via navigator)
    // ... address fields ...

    if (failed.length) {
      return { ok: false, failed, message: `${failed.length}টি ফিল্ড পূরণ হয়নি` };
    }

    this.progress('✔ ধাপ ২ সম্পন্ন');
    return { ok: true, step: 2 };
  }

  /**
   * Step 2 (ধাপ ৩): Parents info — father/mother BRN, DOB, names, nationality
   *
   * Migrated faithfully from v1 applyS2Core:
   * - 2013-rule: pre-2013 DOB → BRN optional (site family-validation "180 days"
   *   live-verified 2026-10-11), BRN field cleared, verify skipped
   * - post-2013: BRN required + Verify attempt (silent skip if button missing)
   * - masked DOB fields: char-by-char type + exact read-back, 3 attempts
   * - next-click → validation-block detect → "advanced" check (parents fields gone)
   */
  async submitS2(data = {}) {
    this.progress('🔄 ধাপ ৩: পিতামাতার তথ্য লেখা হচ্ছে...');
    const failed = [];
    const verifyStatus = {};
    const keep = (r) => { if (!r.ok && !r.skipped) failed.push({ field: r.field, reason: r.reason }); };

    // ২০১৩-নিয়ম (live-verified 2026-10-11, সংশোধিত): সাইট applicant-DOB দেখে নিজেই ঠিক
    // করে পিতামাতার BRN চাইবে কি না — 2026-জন্ম ধরা পড়লে (ভুল DOB race) parents-BRN
    // বাধ্যতামূলক ধরে সাইট "not verified [father.ubrn]" দিয়ে আটকেছিল।
    // তাই: BRN থাকলে বসাই + Verify চেষ্টা (বাটন না থাকলে নীরব skip); না থাকলে site-ই শেষ কথা।
    const dobIso = data.applicantDob || this.applicantDob;
    const pre2013 = isPre2013(dobIso);
    if (dobIso) this.applicantDob = dobIso; // v1: appData.applicantDob update — later steps use it

    const fillParent = async (p, who, verifyIndex) => {
      const base = `personInfoForBirth.${p}.`;
      const brnSel = [`#${p}Brn`, `input[name="${base}ubrn"]`];
      const dobSel = [`#${p}BirthDate`, `input[name="${base}personBirthDate"]`];
      const brn = String((data[p] || {}).brn || '').trim();
      if (pre2013) {
        // ২০১৩-এর আগের জন্মে পিতামাতার BRN ঐচ্ছিক (live-verified 2026-10-11) — আর BRN
        // বসালে সাইট রেজিস্ট্রি-লিংক ধরে ফ্যামিলি-ভ্যালিডেশন চালায় ("Difference of age
        // among children needs to be at least 180 days") → নাগরিক আটকে যায়।
        // তাই pre-২০১৩-তে BRN ঘর খালি রাখি — নাম + জাতীয়তাই যথেষ্ট।
        const brnEl = await this._waitVisible(brnSel, 2500);
        if (brnEl) await brnEl.fill('').catch(() => {});
        verifyStatus[p] = 'skipped-pre2013';
      } else {
        keep(await this._typeInto(brnSel, brn, `${who}-এর BRN`, { required: true }));
      }
      if (data[p] && data[p].dob) {
        keep(await this._typeMaskedDate(dobSel, isoToBdFormat(data[p].dob), `${who}-এর জন্ম তারিখ`));
      }
      keep(await this._typeInto([`#${p}NameBn`, `input[name="${base}personNameBn"]`], transitName((data[p] || {}).nameBn), `${who}-এর নাম (বাংলা)`, { required: true }));
      keep(await this._typeInto([`#${p}NameEn`, `input[name="${base}personNameEn"]`], transitName((data[p] || {}).nameEn), `${who}-এর নাম (English)`, { required: true }));
      if (!pre2013 && brn) {
        // Verify (BRN+DOB+নাম পূরণের পর); বাটন না থাকলে নীরব skip
        const v = await this._clickVerify(verifyIndex, who, { quietMissing: true });
        verifyStatus[p] = v.verified;
        if (v.verified === false) {
          failed.push({ field: `${who}-এর BRN যাচাই`, reason: 'রেজিস্ট্রিতে BRN পাওয়া যায়নি — সঠিক ১৭ ডিজিটের BRN ও জন্ম তারিখ দিন' });
        }
      }
      keep(await this._selectFirstMatch([`#${p}Nationality`, `select[name="${base}personNationality"]`],
        [(data[p] || {}).nationality || 'বাংলাদেশী'], `${who}-এর জাতীয়তা`));
    };

    await fillParent('father', 'পিতা', 0);
    await fillParent('mother', 'মাতা', 1);

    // ডায়াগনস্টিক (2026-10-11, স্থায়ী): নামে ফোটা/ডট/সিনো সাইটের ইনপুটে আসলে কী দাঁড়াল —
    // read-back করে শুধু লগে রাখি (UI-তে দেখা যায় না)।
    try {
      const rb = await this.page.evaluate(() => {
        const g = (s) => { const el = document.querySelector(s); return el ? el.value : '(missing)'; };
        return { fBn: g('#fatherNameBn'), fEn: g('#fatherNameEn'), mBn: g('#motherNameBn'), mEn: g('#motherNameEn') };
      });
      console.log('S3-FATHER-VALUES ' + JSON.stringify(rb));
    } catch { /* ঐচ্ছিক */ }

    // পরবর্তী — সাইট সত্যিই এগিয়েছে কিনা সেটাই চূড়ান্ত প্রমাণ
    // (পেজে পড়ে থাকা পুরনো "not verified" টেক্সটে আর বিভ্রান্ত হই না)
    const nxt = await this._clickNextAndWait('পরবর্তী (ধাপ ৩)');
    if (!nxt.ok) {
      failed.push({ field: nxt.field, reason: nxt.reason });
    } else {
      const chk = await this._detectValidationBlock(null);
      if (chk.blocked) {
        const msg = '❌ ' + chk.reason;
        this.progress(msg);
        return {
          ok: false, step: 3, blocked: true, reason: chk.reason,
          message: msg + ' — ঘরটি পূরণ করে আবার চেষ্টা করুন।',
          failed: [...failed, { field: 'পরবর্তী (ধাপ ৩)', reason: chk.reason }], verifyStatus,
        };
      }
    }
    // parents ঘর আর নেই = সাইট নিশ্চিতভাবে পরের ধাপে → verify-নেগেটিভ মিথ্যা, বাদ
    let advanced = false;
    if (nxt.ok) {
      await this.page.waitForTimeout(2500);
      advanced = !(await this._waitVisible(
        ['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]'], 1500));
    }
    if (advanced) {
      await this._dismissNotices();
      return {
        ok: true, step: 4, blocked: false,
        message: '✅ ধাপ ৩ সম্পন্ন! স্থায়ী ও বর্তমান ঠিকানা দিন।',
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
      this.progress('❌ ' + reason);
      return { ok: false, step: 3, blocked: true, reason, message: '❌ ' + reason, failed, verifyStatus };
    }

    return {
      ok: failed.length === 0, step: 4, blocked: false,
      message: `⚠️ ধাপ ৩ শেষ — ${failed.length}টি সমস্যা।`,
      failed, verifyStatus,
    };
  }

  /**
   * Step 2B (ঠিকানার ধাপ): permanent + present address
   *
   * Migrated faithfully from v1 applyS2BCore:
   * - data থাকলে copy-flag উপেক্ষা করে fill (2026-10-15 permanent rule)
   * - না থাকলে copy-checkbox: "জন্মস্থানের ঠিকানা ও স্থায়ী ঠিকানা একই" /
   *   "স্থায়ী ঠিকানা ও বর্তমান ঠিকানা একই"
   * - fill-এর পর addrFilled re-check → খালি থাকলে আবার বসানো
   * - next → addrStill visible হলে ১ বার retry → validation-block detect
   */
  async submitS2B(data = {}) {
    const failed = [];
    // কপি-চেকবক্স: লেবেল-টেক্সট দিয়ে খোঁজা (live label), name দিয়ে fallback
    const findCopyBox = async (labelText, nameFallback) => {
      try {
        const byLabel = this.page.locator(`label:has-text("${labelText}") input[type="checkbox"]`).first();
        if (await byLabel.count() && await byLabel.isVisible()) return byLabel;
      } catch { /* fallback */ }
      return this.page.$(`input[name="${nameFallback}"]`);
    };

    this.progress('🔄 ঠিকানার ধাপ: স্থায়ী ও বর্তমান ঠিকানা...');
    // স্থায়ী ঠিকানা
    // Permanent (2026-10-15): data থাকলে flag উপেক্ষা করে fill করি — ভুল
    // permCopy=true-তে copy-box চেক করলে ব্যবহারকারীর আলাদা ঠিকানা মুছে যায়।
    const permHasData = data.perm && (data.perm.division || data.perm.district || data.perm.vilBn);
    if (permHasData) {
      this.progress('🔄 স্থায়ী ঠিকানা বসানো হচ্ছে...');
      await this._fillAddressSection('permAddr', data.perm, failed);
    } else {
      const cb1 = await findCopyBox('জন্মস্থানের ঠিকানা ও স্থায়ী ঠিকানা একই', 'copyBirthPlaceToPermAddr');
      if (cb1) {
        const checked = await cb1.isChecked().catch(() => false);
        if (!checked) await cb1.check().catch(async () => { await cb1.click(); });
        await this.page.waitForTimeout(1200);
        this.progress('✔ স্থায়ী ঠিকানা: জন্মস্থান থেকে কপি');
      }
    }
    // বর্তমান ঠিকানা
    const presHasData = data.pres && (data.pres.division || data.pres.district || data.pres.vilBn);
    if (presHasData) {
      this.progress('🔄 বর্তমান ঠিকানা বসানো হচ্ছে...');
      await this._fillAddressSection('prsntAddr', data.pres, failed);
    } else {
      const cb2 = await findCopyBox('স্থায়ী ঠিকানা ও বর্তমান ঠিকানা একই', 'copyPermAddrToPrsntAddr');
      if (cb2) {
        const checked = await cb2.isChecked().catch(() => false);
        if (!checked) await cb2.check().catch(async () => { await cb2.click(); });
        await this.page.waitForTimeout(800);
        this.progress('✔ বর্তমান ঠিকানা: স্থায়ী ঠিকানা থেকে কপি');
      }
    }

    // ঠিকানা সত্যিই ভরা আছে কি না — partial re-render-এ খালি থাকলে আবার বসাই
    const addrFilled = async (pre) => this.page.evaluate((p) => {
      const val = (n) => { const e = document.querySelector(`select[name="${n}"]`); return e && e.offsetParent !== null ? String(e.value || '') : 'x'; };
      const txt = (n) => { const e = document.querySelector(`input[name="${n}"]`); return e && e.offsetParent !== null ? String(e.value || '').trim() : 'x'; };
      if (!val(p + 'Div') || !val(p + 'Dist') || !val(p + 'CityCorpCantOrUpazila')) return false;
      if (!txt(p + 'VilAreaTownBn') || !txt(p + 'PostOfc')) return false;
      return true;
    }, pre).catch(() => true);
    for (const [pre, rec, cp] of [['permAddr', data.perm, data.permCopy], ['prsntAddr', data.pres, data.presCopy]]) {
      if (rec && !cp && !(await addrFilled(pre))) {
        this.progress('⏳ ঠিকানার কিছু ঘর খালি থেকে গেছে — আবার বসানো হচ্ছে…');
        await this._fillAddressSection(pre, rec, failed);
      }
    }

    await this._dismissNotices();
    let nxtA = await this._clickNextAndWait('পরবর্তী (ঠিকানার ধাপ)');
    if (!nxtA.ok) failed.push({ field: nxtA.field, reason: nxtA.reason });
    else {
      await this._dismissNotices();
      // সত্যিই এগিয়েছে কি না — ঠিকানার সেকশন এখনো দৃশ্যমান থাকলে আটকে গেছে (2026-10-11)
      const addrStill = async () => this._waitVisible(['select[name="permAddrDiv"]', 'input[name="permAddrHouseRoadEn"]'], 4000);
      if (await addrStill()) {
        const b1 = await this._detectValidationBlock(null);
        console.log('S2B-BLOCK-1:', b1.reason);
        this.progress('⏳ ঠিকানার ধাপ এগোয়নি — আবার চেষ্টা করা হচ্ছে…');
        await this.page.waitForTimeout(800);
        nxtA = await this._clickNextAndWait('পরবর্তী (ঠিকানার ধাপ, পুনঃচেষ্টা)');
        if (!nxtA.ok || (await addrStill())) {
          const b2 = await this._detectValidationBlock(['input[name="files"]']);
          console.log('S2B-BLOCK-2:', b2.reason);
          failed.push({
            field: 'ঠিকানার ধাপ',
            reason: (b2.blocked && b2.reason) || (b1.blocked && b1.reason) || 'সাইট পরের ধাপে যায়নি — তথ্য একবার মিলিয়ে নিন',
          });
        } else {
          this.progress('✔ পুনঃচেষ্টায় ঠিকানার ধাপ সম্পন্ন');
        }
      }
    }
    return {
      ok: failed.length === 0,
      step: 5, blocked: failed.length > 0,
      message: failed.length ? `⚠️ ঠিকানার ধাপে ${failed.length}টি সমস্যা।` : '✅ ঠিকানার ধাপ সম্পন্ন! ডকুমেন্ট আপলোড করুন।',
      failed,
    };
  }
  /**
   * Step 4 (OTP ধাপ): OTP যাচাই + চূড়ান্ত সাবমিট
   *
   * Migrated faithfully from v1 SUBMIT_S4_OTP (live-mapped 2026-10-09):
   * - server-side charge-token enforcement (C-1 fix 2026-10-15)
   * - OTP = SINGLE input#otp; submit = button "সাবমিট" ("যাচাই" বাটন নেই)
   * - cinno (`) নীতি (2026-10-11 live-verified): সাবমিটের ঠিক আগে আসল রূপ
   *   (cinno-সহ) নীরবে ফিল্ডে বসে; সাইট আটকালে cinno বাদ দিয়ে আবার সাবমিট
   * - ১-নাম স্থায়ী নিয়ম: শেষ-নামের ঘর খালি + রুল শিথিল; আটকালে বাধ্য-পূরণ
   *   + আবার সাবমিট (নাগরিক কোনোভাবেই আটকাবে না)
   * - দৃশ্যমান success-প্রমাণই গ্রহণযোগ্য (hidden template-এ ভুয়া সাফল্য নয়)
   * - সাফল্যের পেজে PDF/ডাউনলোড বাটন → download event (birth_application_print.pdf);
   *   stub/ভাঙা ফাইল হলে নিজস্ব "আবেদন কপি" PDF fallback
   *
   * data: { otp, _chargeToken, s1, s2, s2b, s3, s4prep,
   *         applicantDob, singleName, gatePassedNames }
   * Emits BOT_STATUS COMPLETED on success (v1 wire-compat).
   */


  /**
   * Step 3 (ধাপ ৪): প্রত্যয়ন + ডকুমেন্ট আপলোড
   *
   * Migrated faithfully from v1 SUBMIT_S3_DOCS:
   * - relation radio: দৃশ্যমান রেডিওর মধ্যেই বাছাই; ২০১৩-পূর্ব জন্মে SELF বাধ্য
   *   (user-confirmed 2026-10-11); UI-পছন্দ না মিললে নিজ → পিতা fallback
   * - applicantName খালি থাকলে s1-এর English নাম বসে
   * - docs: শুধু JPG/PNG, প্রতিটি ≤2MB, কমপক্ষে ১টি; ৪০ ও ৪১ দুটোই বাধ্যতামূলক
   * - প্রতি ফাইলে ফ্রেশ file-input হ্যান্ডেল (Angular re-render, 2026-10-11)
   * - typeSel-এ v1-এর "attchment" typo হুবহু রাখা (সাইটের আসল class)
   *
   * data: { relation, docs: [{name, mimeType, base64, docType}], applicantDob, s1 }
   */
  async submitS3(data = {}) {
    const failed = [];
    this.progress('🔄 ধাপ ৪: প্রত্যয়ন ও কাগজপত্র...');
    const anchor = await this._waitVisible(['input[name="relationWithApplicant"]', 'input[name="files"]'], 10000);
    if (!anchor) {
      this.progress('❌ প্রত্যয়ন/ডকুমেন্ট পেজ খোলা নেই — আগের ধাপ শেষ করে আবার চেষ্টা করুন।');
      return {
        ok: false, step: 4, blocked: true,
        message: '❌ ডকুমেন্ট পেজ পাওয়া যায়নি',
        failed: [{ field: 'ডকুমেন্ট পেজ', reason: 'প্রত্যয়ন/ডকুমেন্ট পেজ খোলা নেই' }],
      };
    }

    // আবেদনকারী কে (relation radio) — ১৮+ বয়সী ব্যক্তির জন্য সাইট পিতা/মাতা-রেডিও
    // লুকিয়ে রাখে; লুকানো রেডিও চেক থাকলে jQuery-validate (ignore :hidden) ব্যর্থ
    // হয়ে OTP চুপচাপ আটকে যায় (live bug 2026-10-11 — user-reported)। তাই দৃশ্যমান
    // রেডিওর মধ্যেই বাছাই; UI-এর পছন্দ না মিললে নিজ(SELF) → পিতা(FATHER) fallback।
    let relBn = '';
    const REL_BN = { FATHER: 'পিতা', MOTHER: 'মাতা', SELF: 'নিজ', GRANDFATHER: 'পিতামহ', GRANDMOTHER: 'পিতামহী', MATERNALGRANDFATHER: 'মাতামহ', MATERNALGRANDMOTHER: 'মাতামহী', GUARDIAN: 'অভিভাবক', OTHERS: 'অন্যান্য' };
    if (data.relation) {
      const REL_VALUE = { 'পিতা': 'FATHER', 'মাতা': 'MOTHER', 'নিজ': 'SELF', 'পিতামহ': 'GRANDFATHER', 'পিতামহী': 'GRANDMOTHER', 'মাতামহ': 'MATERNALGRANDFATHER', 'মাতামহী': 'MATERNALGRANDMOTHER', 'অভিভাবক': 'GUARDIAN', 'অন্যান্য': 'OTHERS' };
      const pickRel = (want) => this.page.evaluate((w) => {
        const radios = Array.from(document.querySelectorAll('input[name="relationWithApplicant"]'));
        const vis = radios.filter((r) => r.offsetParent !== null && r.getClientRects().length);
        let t = vis.find((r) => (r.value || '') === w);
        if (!t) t = vis.find((r) => (r.value || '') === 'SELF') || vis.find((r) => (r.value || '') === 'FATHER') || vis[0];
        if (!t) return { ok: false };
        t.click();
        return { ok: true, value: t.value };
      }, want).catch(() => ({ ok: false }));
      const readRelState = () => this.page.evaluate(() => {
        const c = document.querySelector('input[name="relationWithApplicant"]:checked');
        return { value: c ? c.value : null, visible: !!(c && c.offsetParent !== null) };
      }).catch(() => ({ value: null, visible: false }));
      // ২০১৩-পূর্ব জন্ম → সাইট-বিধি: নিজ(SELF) দিয়েই OTP পাঠাতে হয় (user-confirmed
      // 2026-10-11); দৃশ্যমান না হলে (বয়স ১৮-র নিচে) তবে UI-এর পছন্দ।
      const dobIso = data.applicantDob || this.applicantDob;
      const dobYear = parseInt(String(dobIso || '').slice(0, 4), 10);
      const pre2013 = isFinite(dobYear) && dobYear > 1900 && dobYear < 2013;
      const wantVal = pre2013 ? 'SELF' : (REL_VALUE[data.relation] || String(data.relation).toUpperCase());
      let pick = await pickRel(wantVal);
      await this.page.waitForTimeout(700);
      let state = await readRelState();
      if (pick.ok && (!state.value || !state.visible)) { // কাঁচা প্রথম চেষ্টা — আরেকবার
        pick = await pickRel(wantVal);
        await this.page.waitForTimeout(600);
        state = await readRelState();
      }
      if (state.value && state.visible) {
        relBn = REL_BN[state.value] || data.relation;
        const ruleNote = state.value === 'SELF' ? (pre2013 ? ' (২০১৩-পূর্ব বিধি)' : ' (১৮+ বয়সী বিধি)') : '';
        this.progress(`✔ আবেদনকারী: ${relBn}${ruleNote}`);
        // applicantName (required, min ২ অক্ষর) — auto-fill খালি থাকলে নিজের নাম বসাই
        const nmNow = await this.page.evaluate(() => {
          const nm = document.querySelector('#applicantName');
          return nm ? String(nm.value || '').trim() : '';
        }).catch(() => '');
        if (nmNow.length < 2) {
          const s1 = data.s1 || {};
          const fullEn = [s1.firstNameEn, s1.lastNameEn].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
          const fallback = fullEn.length >= 2 ? fullEn : 'Applicant';
          const okFill = await this.page.evaluate((v) => {
            const nm = document.querySelector('#applicantName');
            if (!nm) return false;
            nm.removeAttribute('readonly');
            nm.value = v;
            nm.dispatchEvent(new Event('input', { bubbles: true }));
            nm.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }, fallback).catch(() => false);
          if (okFill) this.progress(`✔ আবেদনকারীর নাম: ${fallback}`);
        }
      } else {
        failed.push({ field: 'আবেদনকারী', reason: 'সম্পর্কের রেডিও নির্বাচন হয়নি — সাইট OTP আটকে দেবে' });
      }
      await this.page.waitForTimeout(300);
    }
    // ঘোষণা checkbox
    const decl = await this.page.$('input[name="declaration"]');
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
      this.progress('❌ ডকুমেন্ট ছাড়া BDRIS এগোতে দেবে না। ছবি যোগ করে আবার চেষ্টা করুন।');
      failed.push({ field: 'ডকুমেন্ট', reason: 'কমপক্ষে ১টি JPG/PNG ছবি বাধ্যতামূলক — BDRIS ফাইল ছাড়া এগোতে দেয় না' });
      return { ok: false, step: 4, message: '❌ ডকুমেন্ট বাধ্যতামূলক', failed, blocked: true };
    }
    const anyInput = await this.page.$('input[type="file"]');
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
        const fi = await this.page.$('input[type="file"][name="files"], input[type="file"]');
        if (!fi) return 'no-input';
        await fi.setInputFiles([{
          name: d.name || 'document.jpg',
          mimeType: d.mimeType || 'image/jpeg',
          buffer: Buffer.from(d.base64, 'base64'),
        }]);
        const sel = await this.page.waitForSelector(typeSel, { state: 'visible', timeout: 12000 }).catch(() => null);
        if (!sel) return 'no-row';
        await sel.selectOption(wantType).catch(() => {});
        await this.page.waitForTimeout(500);
        const startBtn = await this.page.locator('button:has-text("Start")').first().elementHandle().catch(() => null);
        if (!startBtn) return 'no-start';
        await startBtn.click().catch(() => {});
        // আপলোড শেষে row collapse হয় (select চলে যায়)
        await this.page.waitForFunction(
          (s) => !document.querySelector(s),
          typeSel, { timeout: 20000 }
        ).catch(() => {});
        await this.page.waitForTimeout(800);
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
            await this.page.waitForTimeout(1200);
            r = await attemptUpload(d, wantType);
          }
          if (r === 'ok') {
            uploadedTypes.add(wantType);
            this.progress(`✔ ডকুমেন্ট: ${d.name} (ধরন ${wantType})`);
          } else {
            failed.push({ field: 'ডকুমেন্ট', reason: `${d.name} — ${reasonOf(r)}` });
          }
        } catch (e) {
          failed.push({ field: 'ডকুমেন্ট', reason: `${d.name}: আপলোড করা যায়নি — আবার চেষ্টা করুন` });
        }
      }
      if (!uploadedTypes.has('40') || !uploadedTypes.has('41')) {
        failed.push({ field: 'ডকুমেন্ট', reason: 'BDRIS দুই ধরনের কাগজ চায় — ডাক্তারি/শিক্ষা সনদ (৪০) ও ঠিকানার প্রমাণ (৪১); দুটোই আপলোড করুন' });
        this.progress('❌ দুই ধরনের ডকুমেন্ট (৪০ ও ৪১) ছাড়া BDRIS এগোতে দেবে না।');
        return { ok: false, step: 4, message: '❌ দুই ধরনের ডকুমেন্ট বাধ্যতামূলক', failed, blocked: true };
      }
    }
    const contactAnchors = ['#email', 'input[name="email"]', '#phone', 'input[name="phone"]'];
    const nxt = await this._clickNextAndWait('পরবর্তী (ধাপ ৪)');
    if (!nxt.ok) failed.push({ field: nxt.field, reason: nxt.reason });
    else {
      await this._dismissNotices();
      // সত্যিই যোগাযোগ-ধাপে গেল কি না — নাহলে চুপচাপ আটকে থাকা UI-তে ধরা পড়বে না
      if (!(await this._waitVisible(contactAnchors, 5000))) {
        const b = await this._detectValidationBlock(contactAnchors);
        console.log('S3-BLOCK:', b.reason);
        failed.push({ field: 'ডকুমেন্ট ধাপ', reason: (b.blocked && b.reason) || 'সাইট পরের ধাপে যায়নি — কাগজপত্র মিলিয়ে দেখুন' });
      }
    }
    return {
      ok: failed.length === 0,
      step: 6, blocked: failed.length > 0,
      message: failed.length ? `⚠️ ধাপ ৪ শেষ — ${failed.length}টি সমস্যা।` : `✅ প্রত্যয়ন ও ডকুমেন্ট সম্পন্ন (${good.length}টি)!`,
      failed,
      relationBn: relBn || undefined,
    };
  }

  async submitS4(data = {}) {
    if (!this.page) {
      this.progress('❌ সংযোগ নেই — আবার চেষ্টা করুন।');
      return { ok: false, message: '❌ সংযোগ নেই — আবার চেষ্টা করুন।' };
    }
    // C-1 fix (2026-10-15): server-side charge enforcement — frontend-এর charge
    // ছাড়া সরাসরি emit করলেও টাকা না কেটে সাবমিট হবে না।
    if (ABC_JWT_SECRET) {
      if (!verifyChargeToken(data._chargeToken, this.userId, 'submit')) {
        this.progress('❌ পেমেন্ট যাচাই হয়নি — পেজ রিফ্রেশ করে আবার চেষ্টা করুন।');
        return {
          ok: false, blocked: true,
          message: '❌ পেমেন্ট যাচাই হয়নি — পেজ রিফ্রেশ করে আবার চেষ্টা করুন।',
          failed: [{ field: 'পেমেন্ট', reason: 'চার্জ টোকেন যাচাই হয়নি' }],
        };
      }
    }
    // v1 appData-equivalent for cinno / copy-PDF / original-rec
    const fd = {
      s1: data.s1 || {}, s2: data.s2 || {}, s2b: data.s2b || {},
      s3: data.s3 || {}, s4prep: data.s4prep || {},
      singleName: data.singleName !== undefined ? data.singleName : this.singleName,
      gatePassedNames: data.gatePassedNames !== undefined ? data.gatePassedNames : this.gatePassedNames,
    };
    this.progress('🔄 কোড বসানো হচ্ছে...');
    const otp = String(data.otp || '').replace(/\D/g, '');
    if (otp.length < 6) {
      this.progress('❌ কোডটি ৬ ডিজিটের — মোবাইলে আসা পুরো কোডটি লিখুন।');
      return { ok: false, message: '❌ কোডটি ৬ ডিজিটের — মোবাইলে আসা পুরো কোডটি লিখুন।' };
    }
    const otpSels = ['#otp', 'input[name="otp"]', 'input[placeholder="OTP"]'];
    const r = await this._typeInto(otpSels, otp, 'OTP কোড', { required: true, typeCharByChar: true });
    if (!r.ok) {
      this.progress('❌ কোডের ঘর পাওয়া যায়নি — আবার চেষ্টা করুন।');
      return { ok: false, message: '❌ কোডের ঘর পাওয়া যায়নি — আবার চেষ্টা করুন।' };
    }
    const btn = await this._waitVisible([
      'button:has-text("সাবমিট")', 'button[type="submit"]',
    ], 12000);
    if (!btn) {
      this.progress('❌ জমা দেওয়ার বাটন পাওয়া যায়নি — আবার চেষ্টা করুন।');
      return { ok: false, message: '❌ জমা দেওয়ার বাটন পাওয়া যায়নি — আবার চেষ্টা করুন।' };
    }

    // ═══ cinno (`) নীতি — 2026-10-11 live-verified ═══
    const cinnos = buildCinnos(fd);
    if (cinnos.length) {
      const rx = await relaxNameRules(this.page);
      console.log('S4OTP-CINNO-RELAX:', rx);
    }
    const applyCinnosLocal = async (withCinno) => applyCinnos(this.page, cinnos, withCinno);
    const clickSubmit = async (withCinno) => {
      const n = await applyCinnosLocal(withCinno);
      if (cinnos.length) console.log('CINNO-SNEAK: applied ' + n + '/' + cinnos.length + (withCinno ? ' (cinno-সহ)' : ' (cinno-বাদ)'));
      await this._robustClick(btn, withCinno ? 'চূড়ান্ত সাবমিট' : 'চূড়ান্ত সাবমিট (cinno-বাদ)', 8000);
      await this.page.waitForTimeout(2400);
      return await this.page.evaluate(() => {
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
    if (fd.singleName && !fd.gatePassedNames) {
      const rx2 = await relaxEmptyLast(this.page, fd.singleName);
      const em = await emptyLastVisible(this.page, fd.singleName);
      console.log('S4OTP-SINGLE:', JSON.stringify({ relax: rx2, emptied: em }));
    }
    let singleRestored = false;
    let post = await clickSubmit(true);
    if (post.succ) {
      this.progress('✔ চূড়ান্ত সাবমিট গৃহীত হয়েছে');
    } else if (post.errs.some(t => /অক্ষর/.test(t)) && cinnos.length) {
      // সাইট cinno নামে নিচ্ছে না — নাগরিক আটকাবে না: cinno বাদ দিয়ে সাথে সাথে আবার
      this.progress('🔁 নামের cinno সাইট নিচ্ছে না — cinno ছাড়া আবার পাঠানো হচ্ছে…');
      const otpNow = await this.page.evaluate(() => {
        const el = document.querySelector('#otp, input[name="otp"]');
        return el ? el.value : '';
      }).catch(() => '');
      if (!String(otpNow || '').replace(/\D/g, '')) {
        await this._typeInto(otpSels, otp, 'OTP কোড', { required: true, typeCharByChar: true });
      }
      post = await clickSubmit(false);
      this.progress(post.succ ? '✔ সাবমিট গৃহীত হয়েছে (নাম সাইট-নিয়মে)' : '⚠ সাইটের উত্তর এখনো আসেনি — অপেক্ষা করা হচ্ছে…');
    } else {
      this.progress('✔ চূড়ান্ত সাবমিট দেওয়া হয়েছে');
    }
    // ১-নাম restore-ফলব্যাক: খালি শেষ-নামে সাইট সাবমিট আটকালে — বাধ্য-পূরণ + আবার
    // সাবমিট (join-নাম trim থাকায় রেকর্ডে নাম একবারই থাকবে)
    if (!post.succ && !singleRestored && fd.singleName && !fd.gatePassedNames
        && post.errs.some(t => /আবশ্য|পূরণ|নাম|required|last/i.test(t))) {
      singleRestored = true;
      const otpNow2 = await this.page.evaluate(() => {
        const el = document.querySelector('#otp, input[name="otp"]');
        return el ? el.value : '';
      }).catch(() => '');
      if (!String(otpNow2 || '').replace(/\D/g, '')) {
        await this._typeInto(otpSels, otp, 'OTP কোড', { required: true, typeCharByChar: true });
      }
      await fillDoubledLast(this.page, fd.s1, fd.singleName);
      await relaxEmptyLast(this.page, fd.singleName);
      console.log('S4OTP-SINGLE-RESTORE-RETRY');
      post = await clickSubmit(true);
      this.progress(post.succ ? '✔ সাবমিট গৃহীত হয়েছে' : '⚠ সাইটের উত্তর এখনো আসেনি — অপেক্ষা করা হচ্ছে…');
    }
    this.progress('⏳ সাইটের উত্তর আসার অপেক্ষায়...');

    let ackText = '';
    let sawSuccess = false;
    try {
      await this.page.waitForSelector(
        '.alert-success, .success-message, [class*="success"], #applicationId, [id*="ack"], [id*="trackingId"]',
        { state: 'visible', timeout: 25000 }
      );
      sawSuccess = true;
      ackText = await this.page.evaluate(() => {
        const sels = ['.alert-success', '.success-message', '#applicationId', '[id*="trackingId"]', '[id*="ack"]', '[class*="success"]'];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (el && el.innerText.trim()) return el.innerText.trim();
        }
        return '';
      });
    } catch {
      // ২৫ সেকেন্ডে দৃশ্যমান সাফল্য আসেনি — শুধু ১৭-ডিজিট নম্বর থাকলে সেটাই প্রমাণ
      ackText = await this.page.evaluate(() => {
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
      const liveNum = await this.page.evaluate(() => {
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
      const perr = await this.page.evaluate(() => {
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
      this.progress('❌ ' + why);
      return { ok: false, message: '❌ ' + why, failed: [{ field: 'চূড়ান্ত সাবমিট', reason: why }] };
    }

    let screenshot = null;
    try {
      const buf = await this.page.screenshot({ fullPage: false, timeout: 15000 });
      screenshot = 'data:image/png;base64,' + buf.toString('base64');
    } catch (e) { console.warn('Screenshot failed:', e.message.slice(0, 80)); }

    // one-click main-copy PDF: সাফল্যের পেজে PDF/ডাউনলোড বাটন খুঁজে ধরা
    let pdf = null;
    try {
      const dlBtn = await this._waitVisible([
        'a:has-text("PDF")', 'button:has-text("PDF")',
        'a:has-text("ডাউনলোড")', 'button:has-text("ডাউনলোড")',
        'a:has-text("Download")', 'button:has-text("Download")',
        'a[href$=".pdf"]',
        // লাইভ 2026-10-11: সাফল্যের পাতায় "আবেদনপত্র প্রিন্ট" (=প্রিন্ট) বাটনই আসল
        // PDF-এর রাস্তা — download event আসে birth_application_print.pdf নামে
        'button:has-text("প্রিন্ট")', 'a:has-text("প্রিন্ট")',
      ], 10000);
      if (dlBtn) {
        this.progress('📥 আবেদনের PDF কপি ডাউনলোড হচ্ছে...');
        const dlPromise = this.page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
        await dlBtn.click().catch(() => {});
        const dl = await dlPromise;
        if (dl) {
          const dp = await dl.path().catch(() => null);
          if (dp) {
            const buf = fs.readFileSync(dp);
            const pdfName = (dl.suggestedFilename() || 'bdris-application.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
            try {
              const ddir = path.join(__dirname, 'downloads');
              fs.mkdirSync(ddir, { recursive: true });
              fs.writeFileSync(path.join(ddir, Date.now() + '-' + pdfName), buf);
            } catch { /* সংরক্ষণ ঐচ্ছিক */ }
            pdf = { name: pdfName, base64: buf.toString('base64') };
            this.progress('✔ আবেদনের PDF কপি পাওয়া গেছে');
          }
        }
      } else {
        this.progress('⊘ এই পেজে PDF ডাউনলোড বাটন পাওয়া যায়নি');
      }
    } catch (e) { console.warn('PDF capture:', e.message.slice(0, 80)); }

    // যাচাই: ডাউনলোড আসল PDF কিনা — stub/ভাঙা ফাইল হলে বাদ
    let ackNum = '';
    {
      const at = String(ackText || '');
      const labeled = at.match(/আবেদন(?:পত্র)?\s*নম্বর\s*[:：]?\s*([\d\u09E6-\u09EF]{4,20})/);
      const generic = labeled ? null : (at.match(/\b\d{17}\b/) || at.match(/\b\d{7,12}\b/));
      ackNum = (labeled ? labeled[1] : (generic ? generic[0] : ''))
        .replace(/[\u09E6-\u09EF]/g, (c) => String(c.charCodeAt(0) - 0x09E6));
    }
    if (pdf) {
      let ok = false;
      try { ok = isValidPdf(Buffer.from(pdf.base64, 'base64')); } catch { ok = false; }
      if (ok) {
        if (ackNum) pdf.name = 'abedon-copy-' + ackNum + '.pdf';
      } else {
        this.progress('⚠️ সাইটের ডাউনলোড ফাইলটি অসম্পূর্ণ — নিজস্ব আবেদন কপি তৈরি করা হচ্ছে');
        pdf = null;
      }
    }
    // fallback: নিজস্ব অফিসিয়াল-স্টাইল "আবেদন কপি" PDF (A4)
    if (!pdf) {
      try {
        this.progress('📄 আবেদন কপি (PDF) তৈরি হচ্ছে...');
        const buf = await this._generateCopyPdf(ackNum, fd);
        const nm = 'abedon-copy' + (ackNum ? '-' + ackNum : '') + '.pdf';
        try {
          const ddir = path.join(__dirname, 'downloads');
          fs.mkdirSync(ddir, { recursive: true });
          fs.writeFileSync(path.join(ddir, Date.now() + '-' + nm), buf);
        } catch { /* সংরক্ষণ ঐচ্ছিক */ }
        pdf = { name: nm, base64: buf.toString('base64') };
        this.progress('✔ আবেদন কপি (PDF) তৈরি হয়েছে');
      } catch (e) { console.warn('genCopyPdf:', e.message.slice(0, 100)); }
    }

    // v1 wire-compat: সাফল্য BOT_STATUS COMPLETED-এই যায়
    this.emit('BOT_STATUS', {
      status: 'COMPLETED', message: '🎉 BDRIS আবেদন সফলভাবে জমা হয়েছে!',
      level: 'ok', ackId: ackText || 'BDRIS পোর্টালে সফলভাবে জমা হয়েছে.', screenshot, pdf, original: null,
    });

    // আসল PDF prefetch-এর জন্য rec — fetch subsystem (FETCH_ORIGINAL migration)
    // এটিকে ব্যবহার করবে; v2 handler নিজে background fetcher চালায় না।
    let originalRec = null;
    try { originalRec = buildOriginalRec(fd, ackNum); } catch { /* ঐচ্ছিক */ }

    return {
      ok: true, completed: true, step: 7, blocked: false,
      message: '🎉 BDRIS আবেদন সফলভাবে জমা হয়েছে!',
      ackId: ackText, ackNum, screenshot,
      pdf: pdf ? { name: pdf.name, bytes: pdf.base64.length } : null,
      originalRec,
      failed: [],
    };
  }
  // ═══════════════════════════════════════════════════════════════
  // v1 private helpers — copied faithfully from engines/bdris-apply/server.js
  // (selectors, timing, workarounds unchanged)
  // ═══════════════════════════════════════════════════════════════

  // v1 generateCopyPdf used a module-level browser context; v2 uses the
  // current page's context (no globals).
  async _generateCopyPdf(num, fd) {
    const p = await this.page.context().newPage();
    try {
      await p.setContent(buildCopyHtml(num, fd), { waitUntil: 'load' });
      await p.waitForTimeout(400);
      return await p.pdf({ format: 'A4', printBackground: true });
    } finally { await p.close().catch(() => {}); }
  }

  // union selector-এ সবসময় প্রথম VISIBLE element (hidden ডুপ্লিকেট এড়াতে)
  async _waitVisible(selectors, timeout = 12000) {
    const list = Array.isArray(selectors)
      ? selectors
      : selectors.split(/,(?![^(]*\))/).map(s => s.trim()).filter(Boolean);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const sel of list) {
        let n = 0;
        try { n = await this.page.locator(sel).count(); } catch { n = 0; }
        for (let i = 0; i < n; i++) {
          const el = this.page.locator(sel).nth(i);
          try { if (await el.isVisible()) return el; } catch { /* next */ }
        }
      }
      await this.page.waitForTimeout(350);
    }
    return null;
  }

  // Playwright-এর viewport-চেক মাঝে মাঝে modal-বাটনে "element is outside of the
  // viewport" retry-loop করে ৩০s নষ্ট করে ব্যর্থ হয় (live 2026-10-11)। তাই
  // লাগলে DOM-level ক্লিক ফলব্যাক — jQuery handler তাতেও ঠিকঠাক চলে।
  async _robustClick(target, label = '', timeout = 8000) {
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

  async _typeInto(selector, value, label, opts = {}) {
    if (value === undefined || value === null || String(value).trim() === '') {
      if (opts.required) {
        const reason = `${label} খালি — পূরণ আবশ্যক`;
        this.progress(`⚠ ${reason}`);
        return { ok: false, field: label, reason };
      }
      return { ok: true, skipped: true };
    }
    const el = await this._waitVisible(selector);
    if (!el) {
      const reason = `${label} ঘর পাওয়া যায়নি`;
      this.progress(`⚠ ${reason}`);
      return { ok: false, field: label, reason };
    }
    try {
      await el.fill('');
      if (opts.typeCharByChar) await el.type(String(value), { delay: 60 });
      else await el.fill(String(value));
      if (opts.pressTab !== false) { await this.page.keyboard.press('Tab').catch(() => {}); }
      this.progress(`✔ ${label} পূরণ হয়েছে`);
      return { ok: true };
    } catch (e) {
      console.error(`${label} fill:`, e.message);
      const reason = `${label} ঘরে লেখা যায়নি — আবার চেষ্টা করুন`;
      this.progress(`⚠ ${reason}`);
      return { ok: false, field: label, reason };
    }
  }

  // mask-যুক্ত তারিখ ঘর: fill() মান খেয়ে ফেলে — ক্লিক করে অক্ষর ধরে টাইপ +
  // EXACT read-back, ৩ বার পর্যন্ত। (2026-10-11 live)
  async _typeMaskedDate(selectors, dobF, label) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const el = await this._waitVisible(list);
    if (!el) {
      this.progress(`⚠ ${label} ঘর পাওয়া যায়নি`);
      return { ok: false, field: label, reason: `${label} ঘর পাওয়া যায়নি` };
    }
    const want = String(dobF).replace(/\s+/g, '');
    let got = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await el.click({ timeout: 4000 }).catch(() => {});
        await this.page.keyboard.press('Control+A').catch(() => {});
        await this.page.keyboard.press('Delete').catch(() => {});
        await el.type(String(dobF), { delay: 80 });
        await this.page.keyboard.press('Tab').catch(() => {});
        await this.page.waitForTimeout(350);
        got = await this.page.evaluate((sels) => {
          for (const s of sels) { const e = document.querySelector(s); if (e) return e.value || ''; }
          return '';
        }, list).catch(() => '');
        if (String(got).replace(/\s+/g, '') === want) {
          this.progress(`✔ ${label}: "${got}"`);
          return { ok: true };
        }
      } catch { /* পরের চেষ্টা */ }
    }
    this.progress(`⚠ ${label} ঠিকভাবে বসেনি (ঘরে আছে "${got}")`);
    return { ok: false, field: label, reason: `${label} ঘরে সঠিক মান বসেনি` };
  }

  // v1 selectByLabel-এর candidate-loop সেমান্টিক্স: candidates ক্রমানুসারে চেষ্টা,
  // প্রথম মিললেই থামো। সফল হলে 1100ms অপেক্ষা (cascade timing)।
  async _selectFirstMatch(selector, candidates, label) {
    const cands = (Array.isArray(candidates) ? candidates : [candidates]).filter(c => c && String(c).trim());
    if (!cands.length) {
      this.progress(`⊘ ${label}: মান দেওয়া হয়নি, এড়িয়ে যাওয়া হলো`);
      return { ok: true, skipped: true };
    }
    const el = await this._waitVisible(selector);
    if (!el) {
      const reason = `${label} ঘর পাওয়া যায়নি`;
      this.progress(`⚠ ${reason}`);
      return { ok: false, field: label, reason };
    }
    for (const cand of cands) {
      const done = await this.navigator.selectOption(selector, cand);
      if (done) {
        await this.page.waitForTimeout(1100);
        this.progress(`✔ ${label}: "${cand}"`);
        return { ok: true };
      }
    }
    const reason = `"${label}" অপশনের মান পাওয়া যায়নি`;
    this.progress(`⚠ ${reason}`);
    return { ok: false, field: label, reason };
  }

  async _clickVerify(index, who, opts = {}) {
    // স্থির id প্রাইমারি (#father-check/#mother-check) — index-সমস্যা নয় (audit fix 2026-10-11)
    const idSel = index === 0 ? '#father-check' : (index === 1 ? '#mother-check' : null);
    const readNear = () => this.page.evaluate((a) => {
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
      const l = this.page.locator(idSel).first();
      if ((await l.count().catch(() => 0)) && (await l.isVisible().catch(() => false))) btn = l;
    }
    if (!btn) {
      const btns = this.page.locator('button:has-text("Verify")');
      const n = await btns.count().catch(() => 0);
      if (n <= index) {
        if (!opts.quietMissing)
          this.progress(`⚠ ${who}-এর Verify বাটন পাওয়া যায়নি`);
        return { verified: null };
      }
      const cand = btns.nth(index);
      if (!(await cand.isVisible().catch(() => false))) {
        if (!opts.quietMissing)
          this.progress(`⚠ ${who}-এর Verify বাটন দৃশ্যমান নয়`);
        return { verified: null };
      }
      btn = cand;
    }
    const before = await readNear();
    await btn.click();
    this.progress(`⏳ ${who}-এর BRN যাচাই হচ্ছে…`);
    let sawProgress = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(500);
      const t = await readNear();
      if (/যাচাই হচ্ছে|যাচাই চলছে/.test(t)) { sawProgress = true; continue; }
      const failedTxt = /no birth record|not found|পাওয়া যায়নি/i.test(t);
      const okTxt = !failedTxt && !/নয়নি/.test(t)
        && /যাচাই সফল|সফলভাবে যাচাই|যাচাই সম্পন্ন|verified|সফল/i.test(t);
      if (okTxt) {
        this.progress(`✔ ${who}-এর BRN যাচাই সফল`);
        return { verified: true };
      }
      if (failedTxt) {
        // আগের ডেড বার্তা নাকি এই ক্লিকের ফল? — progress দেখা গেলে বা টেক্সট
        // বদলালেই বিশ্বাস করি; নইলে uncertain (সাইটের পরের ধাপই চূড়ান্ত বিচারক)
        if (sawProgress || t !== before) {
          this.progress(`❌ ${who}-এর BRN রেজিস্ট্রিতে পাওয়া যায়নি`);
          return { verified: false };
        }
      }
    }
    this.progress(`⚠ ${who}-এর যাচাই ফলাফল অস্পষ্ট — সাইটের পরের ধাপ দেখে সিদ্ধান্ত হবে`);
    return { verified: null };
  }

  // ১-নাম: প্রতিটি ধাপের "পরবর্তী"-র আগে required-রুল শিথিল রাখি (সাইট কোনো ধাপে
  // আবার রুল বসালেও যেন খালি শেষ-নামে আটকাতে না পারে)
  async _relaxEmptyLast() {
    const which = this.singleName;
    if (!which || (!which.bn && !which.en)) return 'skip';
    return await this.page.evaluate((w) => {
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

  // "পরবর্তী" — visible বাটন খুঁজে, enabled যাচাই করে ক্লিক
  async _clickNextAndWait(label, opts = {}) {
    // ১-নাম: প্রতিটি ধাপের "পরবর্তী"-র আগে required-রুল শিথিল রাখি
    if (this.singleName && (this.singleName.bn || this.singleName.en)) {
      await this._relaxEmptyLast().catch(() => {});
    }
    // একাধিক সেকশনের "পরবর্তী" একসাথে দৃশ্যমান থাকলে সবার নিচেরটি (চলমান সেকশনেরটিই)
    // বাছাই করি — নাহলে ভুল সেকশনের বাটনে ক্লিক পড়ে চুপচাপ আটকে থাকতে পারে (2026-10-11 live)
    const btnSels = ['button:has-text("পরবর্তী")', 'button:has-text("Next")'];
    let el = null;
    const deadline = Date.now() + 12000;
    while (!el && Date.now() < deadline) {
      const found = [];
      for (const sel of btnSels) {
        const n = await this.page.locator(sel).count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const cand = this.page.locator(sel).nth(i);
          try {
            if (await cand.isVisible()) {
              const bb = await cand.boundingBox();
              if (bb) found.push({ cand, y: bb.y });
            }
          } catch { /* next */ }
        }
      }
      if (found.length) { found.sort((a, b) => a.y - b.y); el = found[found.length - 1].cand; break; }
      await this.page.waitForTimeout(350);
    }
    if (!el) {
      const reason = `"${label}" বাটন পাওয়া যায়নি`;
      this.progress(`⚠ ${reason}`);
      return { ok: false, field: label, reason };
    }
    // BDRIS "পরবর্তী" required পূর্ণ না হলে disabled রাখে
    let enabled = await el.isEnabled().catch(() => true);
    if (!enabled) {
      this.progress(`⏳ "${label}" বাটন এখনো সক্রিয় হয়নি — ৩ সেকেন্ড অপেক্ষা…`);
      await this.page.waitForTimeout(3000);
      enabled = await el.isEnabled().catch(() => true);
    }
    if (!enabled) {
      const reason = `"${label}" বাটন সক্রিয় হয়নি — কোনো আবশ্যক (*) ঘর বাদ পড়েছে বা ভুল আছে`;
      this.progress(`⚠ ${reason}`);
      return { ok: false, field: label, reason };
    }
    const beforeUrl = this.page.url();
    try {
      const binfo = await el.evaluate((e) => {
        let p = e, sec = '';
        for (let i = 0; i < 10 && p; i++, p = p.parentElement) { if (p.id) { sec = p.id; break; } }
        return `"${(e.innerText || '').trim().slice(0, 22)}" @${sec || '?'}`;
      });
      console.log('CLICK-NEXT:', binfo);
    } catch { /* ডায়াগনস্টিক — ব্যর্থ হলেও চলবে */ }
    await this._robustClick(el, `next:${label}`, 10000);
    this.progress(`✔ "${label}" ক্লিক করা হয়েছে`);
    // এগোনোর লক্ষণ: URL বদল / বাটন লুকানো / পরের ধাপের anchor
    try {
      await this.page.waitForFunction(([u]) => location.href !== u, [beforeUrl], { timeout: 3000 }).catch(() => {});
      await el.waitFor({ state: 'hidden', timeout: 6000 }).catch(() => {});
      if (opts.nextAnchor) {
        await this._waitVisible(opts.nextAnchor, 8000);
      }
    } catch { /* fallback নিচে */ }
    await this.page.waitForTimeout(900);
    return { ok: true };
  }

  // "পরবর্তী" ক্লিকের পর সাইট validation-এ আটকালো কিনা — modal handle-এর পরে ডাকতে হবে
  async _detectValidationBlock(nextAnchorSels) {
    const msgs = await this.page.evaluate(() => {
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
    if (nextAnchorSels) advanced = !!(await this._waitVisible(nextAnchorSels, 5000));
    if (!advanced || msgs.length) {
      return {
        blocked: true,
        reason: msgs.length ? `সাইট এগোতে দিচ্ছে না — ${msgs.join(' | ')}` : 'ক্লিকের পর পরের ধাপ আসেনি',
      };
    }
    return { blocked: false };
  }

  async _dismissNotices() {
    let bodyText = '';
    try { bodyText = await this.page.evaluate(() => document.body.innerText || ''); } catch { return false; }
    if (!/duplicate|ডুপ্লিকেট/i.test(bodyText)) return false;
    this.progress('⚠️ BDRIS ডুপ্লিকেট সতর্কতা দেখাচ্ছে — স্বীকার করে এগোনো হচ্ছে');
    const btn = await this._waitVisible([
      'button:has-text("ঠিক আছে")', 'button:has-text("OK")', 'button:has-text("বুঝেছি")',
      'button:has-text("এগিয়ে যান")', 'button:has-text("হ্যাঁ")', 'button:has-text("Yes")',
      'button:has-text("Continue")', 'button:has-text("অবিরত রাখুন")',
    ], 6000);
    if (btn) {
      await this._robustClick(btn, 'ডুপ্লিকেট-সতর্কতা OK', 5000);
      await this.page.waitForTimeout(1200);
      this.progress('✔ ডুপ্লিকেট সতর্কতা স্বীকার করে এগোনো হলো');
      return true;
    }
    this.progress('⚠️ ডুপ্লিকেট সতর্কতা সামলানো যায়নি — একটু পরে আবার চেষ্টা করুন');
    return false;
  }

  // ── ঠিকানা cascade (BDRIS logic): যেকোনো section-এ বসানো যায় ──
  // prefix: 'birthPlace' | 'permAddr' | 'prsntAddr'  (live-verified 2026-10-10)
  // NOTE: BDRIS-এ পোস্ট কোডের ঘর নেই — d.postCode থাকলেও বসানো হয় না।
  async _fillAddressSection(prefix, d, failed) {
    const keep = (r) => { if (r && !r.ok && !r.skipped) failed.push({ field: r.field, reason: r.reason }); };
    // দেশ আগে বসাই — কোনো সেকশনে খালি থাকলে সাইট "পরবর্তী"-তে আটকায় (2026-10-11)
    const countrySels = [`#${prefix}Country`, `select[name="${prefix}Country"]`];
    const hasCountry = await this.page.evaluate((ss) => {
      for (const s of ss) {
        try { const e = document.querySelector(s); if (e && e.options && e.options.length > 1) return true; } catch { /* next */ }
      }
      return false;
    }, countrySels).catch(() => false);
    if (hasCountry) keep(await this._selectFirstMatch(countrySels, [d.country || 'বাংলাদেশ'], 'দেশ'));
    keep(await this._selectFirstMatch([`#${prefix}Div`, `select[name="${prefix}Div"]`], [d.division], 'বিভাগ'));
    await this.navigator.waitForOptions(`select[name="${prefix}Dist"]`, 8000);
    keep(await this._selectFirstMatch([`#${prefix}Dist`, `select[name="${prefix}Dist"]`], [d.district], 'জেলা'));
    await this.navigator.waitForOptions(`select[name="${prefix}CityCorpCantOrUpazila"]`, 8000);
    keep(await this._selectFirstMatch([`#${prefix}CityCorpCantOrUpazila`, `select[name="${prefix}CityCorpCantOrUpazila"]`],
      [d.cityCorpUpazila], 'সিটি কর্পোরেশন/উপজেলা'));
    // ── অঞ্চল/পৌরসভা-ইউনিয়ন + ওয়ার্ড (live-verified 2026-10-11, ঢাকা দক্ষিণ সিটি কর্পোরেশন) ──
    // সিটি কর্পোরেশন-ধাঁচ: PaurasavaOrUnion select খালি থাকে; "অঞ্চল - ৭" আসে WardInCityCorp
    // select-এ; অঞ্চল বাছলে ওয়ার্ড ("ওয়ার্ড - 71") লোড হয় WardInPaurasavaOrUnion select-এ।
    // ইউনিয়ন-ধাঁচ আগের মতোই: PaurasavaOrUnion → WardInPaurasavaOrUnion।
    const cityCorp = /সিটি কর্পোরেশন/.test(String(d.cityCorpUpazila || ''));
    const unionSlot = [`#${prefix}PaurasavaOrUnion`, `select[name="${prefix}PaurasavaOrUnion"]`];
    const cityWard = [`#${prefix}WardInCityCorp`, `select[name="${prefix}WardInCityCorp"]`];
    const unionWard = [`#${prefix}WardInPaurasavaOrUnion`, `select[name="${prefix}WardInPaurasavaOrUnion"]`];
    const hasOpts = (sels) => this.page.evaluate((ss) => {
      for (const s of ss) {
        try { const e = document.querySelector(s); if (e && e.options && e.options.length > 1) return true; } catch { /* next */ }
      }
      return false;
    }, sels).catch(() => false);
    if (d.paurasavaUnion) {
      let zonePath = cityCorp && (await hasOpts(cityWard));
      if (!zonePath && cityCorp) {
        // সিটি কর্পোরেশন বাছার পর অঞ্চল-তালিকা অ্যাসিন্ক লোড হয় — একটু অপেক্ষা করি
        zonePath = (await this.navigator.waitForOptions(`select[name="${prefix}WardInCityCorp"]`, 5000)) && (await hasOpts(cityWard));
      }
      if (zonePath) {
        keep(await this._selectFirstMatch(cityWard, unionCandidates(d.paurasavaUnion), 'অঞ্চল'));
      } else {
        if (!(await hasOpts(unionSlot))) await this.navigator.waitForOptions(`select[name="${prefix}PaurasavaOrUnion"]`, 8000);
        keep(await this._selectFirstMatch(unionSlot, unionCandidates(d.paurasavaUnion), 'পৌরসভা/ইউনিয়ন'));
      }
    }
    if (d.ward) {
      if (cityCorp) {
        // অঞ্চল বাছার পর ওয়ার্ড-তালিকা অ্যাসিন্ক আসে — অপেক্ষা করে বসাই
        if (!(await hasOpts(unionWard))) await this.navigator.waitForOptions(`select[name="${prefix}WardInPaurasavaOrUnion"]`, 8000);
        if (await hasOpts(unionWard)) keep(await this._selectFirstMatch(unionWard, wardCandidates(d.ward), 'ওয়ার্ড'));
        else if (await hasOpts(cityWard)) keep(await this._selectFirstMatch(cityWard, wardCandidates(d.ward), 'ওয়ার্ড'));
        else keep({ ok: false, field: 'ওয়ার্ড', reason: `"${d.ward}" অপশনের তালিকা আসেনি` });
      } else {
        if (!(await hasOpts(unionWard))) await this.navigator.waitForOptions(`select[name="${prefix}WardInPaurasavaOrUnion"]`, 6000);
        if (await hasOpts(unionWard)) keep(await this._selectFirstMatch(unionWard, wardCandidates(d.ward), 'ওয়ার্ড'));
        else if (await hasOpts(cityWard)) keep(await this._selectFirstMatch(cityWard, wardCandidates(d.ward), 'ওয়ার্ড'));
        else keep({ ok: false, field: 'ওয়ার্ড', reason: `"${d.ward}" অপশনের তালিকা আসেনি` });
      }
    }
    const addr = async (idPart, value, label, required) => {
      if (!value && !required) return;
      keep(await this._typeInto([`#${idPart}`, `input[name="${idPart}"]`], value, label, { required }));
    };
    await addr(prefix + 'PostOfc', d.postOfficeBn || d.postBn, 'ডাকঘর (বাংলা)', true);
    await addr(prefix + 'PostOfcEn', d.postOfficeEn || d.postEn, 'ডাকঘর (ইংরেজি)', true);
    // পোস্ট কোড — সাইটের দৃশ্যমান ফর্মে সাধারণত hidden থাকে (validation-এ কখনো দাবি করে না,
    // live-verified 2026-10-10); দৃশ্যমান থাকলে বসাই, নইলে চুপচাপ এড়াই
    if (d.postCode) {
      const pcEl = await this._waitVisible([`#${prefix}PostCode`, `input[name="${prefix}PostCode"]`], 3000);
      if (pcEl) keep(await this._typeInto([`#${prefix}PostCode`, `input[name="${prefix}PostCode"]`], d.postCode, 'পোস্ট কোড', {}));
    }
    await addr(prefix + 'VilAreaTownBn', d.villageBn || d.vilBn, 'গ্রাম/পাড়া/মহল্লা', true);
    await addr(prefix + 'VilAreaTownEn', d.villageEn || d.vilEn, 'গ্রাম/পাড়া/মহল্লা (ইংরেজি)', true);
    await addr(prefix + 'HouseRoadBn', d.houseRoadBn || d.houseBn, 'বাসা ও সড়ক (বাংলা)', false);
    await addr(prefix + 'HouseRoadEn', d.houseRoadEn || d.houseEn, 'বাসা ও সড়ক (ইংরেজি)', false);
  }
}

module.exports = { StepHandler };
