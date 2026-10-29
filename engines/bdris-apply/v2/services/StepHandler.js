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
const getJwtSecret = () => process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '';

function verifyChargeToken(tok, userId, kind, secretOverride) {
  try {
    const secret = secretOverride || getJwtSecret();
    if (!secret || !tok) return false;
    const p = String(tok).split('.');
    if (p.length !== 6 || p[0] !== 'v1') return false;
    const [, tUid, tKind, tRef, tTs, tMac] = p;
    if (tKind !== kind) return false;
    if (String(tUid) !== String(userId)) return false;
    const ts = parseInt(tTs, 10);
    if (!ts || Math.abs(Date.now() - ts) > 30 * 60 * 1000) return false; // 30 min window
    const mac = crypto.createHmac('sha256', secret).update(p.slice(0, 5).join('.')).digest('hex');
    if (mac.length !== tMac.length) return false;
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(tMac));
  } catch { return false; }
}

// ── Single-use submit tokens (2026-10-26, A-to-Z audit) ──
// A charge token is v1.<uid>.<kind>.<ref>.<ts>.<mac> with a 30-minute
// window, but nothing stopped the SAME token submitting a SECOND,
// different application within that window (backend idempotency only
// prevents a second CHARGE, not a second submit). Consumption is
// therefore recorded ONLY at the clean success point (submitS4's
// ok:true/completed return, HTTP chain's ok:true return) — never on
// attempt — so an OTP retry after a failed submit keeps its token.
// Store is process-local (the engine is one subprocess): an engine
// restart clears it, which is a documented residual, not a silent
// bypass — the 30-minute window still bounds any replay.
// PDF tokens are deliberately NOT consumed: re-downloading one's own
// already-paid PDF (e.g. from History) is legitimate, and the pdf
// token's ref is ack-bound via the frontend shim (pdf-<ack>).
const _consumedSubmitTokens = new Map(); // token -> expiry epoch ms
function _pruneConsumedSubmitTokens(now) {
  for (const [t, exp] of _consumedSubmitTokens) if (exp <= now) _consumedSubmitTokens.delete(t);
  while (_consumedSubmitTokens.size > 5000) {
    _consumedSubmitTokens.delete(_consumedSubmitTokens.keys().next().value);
  }
}
function isSubmitTokenConsumed(tok) {
  if (!tok) return false;
  _pruneConsumedSubmitTokens(Date.now());
  return _consumedSubmitTokens.has(String(tok));
}
// Returns false if the token was already consumed (caller must NOT
// treat that as a success-path failure — the gate already rejects
// consumed tokens before any attempt, so this only fires on a
// concurrent double-submit race, where the submission itself has
// already happened once).
function consumeSubmitToken(tok) {
  const p = String(tok || '').split('.');
  const ts = parseInt(p[4], 10);
  if (!ts) return false;
  const now = Date.now();
  _pruneConsumedSubmitTokens(now);
  if (_consumedSubmitTokens.has(String(tok))) return false;
  _consumedSubmitTokens.set(String(tok), ts + 30 * 60 * 1000);
  return true;
}

// কততম সন্তান — v1 thChildSite (live-verified): frontend "৩য়" → সাইট
// অপশন "৩" (বাংলা সংখ্যা, 1–11)। v2 এতদিন thChild আদৌ বসাত না।
function thChildSite(v) {
  const m = bnToArab(bnNorm(v)).match(/(\d{1,2})/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 11) return String(n).replace(/[0-9]/g, d => '০১২৩৪৫৬৭৮৯'[+d]);
  }
  return v;
}

// Application-number extraction for the SUBMIT success gate
// (2026-10-26, submit-debug): only a LABELLED number
// ("আবেদনপত্র নম্বর : ...") or a 17-digit number counts as success
// proof. The old generic 7–12-digit fallback could match any number
// on the page (a phone fragment, a year, a code) and falsely mark a
// failed submit as COMPLETED, so it is deliberately NOT here. The
// labelled form is the live-verified shape (2026-10-11: the number
// sits in the lower panel, not in the success banner).
function extractAckNumber(bodyText) {
  const body = String(bodyText || '');
  let m = body.match(/আবেদন(?:পত্র)?\s*নম্বর\s*[:：]?\s*([\d\u09E6-\u09EF]{4,20})/);
  if (m) return m[1];
  m = body.match(/\b\d{17}\b/);
  return m ? m[0] : '';
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
// Parent-BRN exemption (2026-10-29 rule): pre-2013 AND the whole
// 2013 year advance on the parents' ID cards only, WITHOUT a
// parent BRN — just as a single name advances. 2014+ still needs
// the BRN. No BRN is ever invented for an exempt year.
function isParentBrnExempt(iso) {
  if (!iso) return false;
  return String(iso).slice(0, 10) < '2014-01-01';
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
// Parent-BRN non-block helpers (2026-10-29, permanent):
// normalizeBrn — Bengali digits → Arabic, spaces/dashes stripped.
// The VALUE is never invented or replaced: normalisation only
// removes digit-script/spacing noise so a correct BRN cannot look
// wrong to the registry lookup. Names are never touched here.
function normalizeBrn(v) {
  return bnToArab(String(v || '')).replace(/[\s\-]/g, '');
}
// brnWarning — warning text, never a block: empty or 17 digits → ''.
function brnWarning(v) {
  const n = normalizeBrn(v);
  if (!n) return '';
  return /^\d{17}$/.test(n) ? '' : 'BRN ১৭ ডিজিটের হওয়া উচিত — দেওয়া নম্বরটি মিলিয়ে দেখুন';
}
// isFamilyErrorText — the site's family-validation wording only
// (180-days / age-difference). Used to pick the names-only branch,
// never to rewrite a name or a BRN.
function isFamilyErrorText(t) {
  return /180|difference of age/i.test(String(t || ''));
}
const PARENT_BRN_PRE2013_NOTE = '২০১৩-পূর্ব নিয়ম: পিতামাতার BRN সাইটে পাঠানো হয়নি — ড্রাফটে রাখা আছে।';
const PARENT_BRN_2013_NOTE = '২০১৩ সালের নিয়ম: পিতামাতার BRN ছাড়াই (শুধু মা-বাবার আইডি কার্ড দিয়ে) এগোনো হয়েছে।';
function parentBrnExemptNote(iso) {
  if (isPre2013(iso)) return PARENT_BRN_PRE2013_NOTE;
  if (isParentBrnExempt(iso)) return PARENT_BRN_2013_NOTE;
  return null;
}
const PARENT_BRN_FAMILY_NOTE = 'সাইটের পারিবারিক নিয়ম: পিতামাতার BRN ছাড়াই (নাম + জাতীয়তা দিয়ে) এগোনো হয়েছে — BRN ড্রাফটে রাখা আছে।';
// parentBrnSubmitAction — pure decision for the submit-time branch
// (point 8): 'brn-exempt-names-only' | 'family-names-only' |
// 'surface-only' | null (no parent-BRN error at all). Names are
// never altered by this decision; the names-only attempts only
// clear the BRN field, exactly like the pre-2013 site rule.
function parentBrnSubmitAction(errs, applicantDob) {
  const list = Array.isArray(errs) ? errs : [];
  // A family/180-days text IS a parent-BRN error by itself (the
  // family validation is triggered by the parent linkage), even
  // when the text names no ubrn field.
  const hit = list.some((t) => /ubrn|পিতা|মাতা/i.test(t) || (/verify/i.test(t) && /father|mother/i.test(t)) || isFamilyErrorText(t));
  if (!hit) return null;
  if (isParentBrnExempt(applicantDob)) return 'brn-exempt-names-only';
  if (list.some((t) => isFamilyErrorText(t))) return 'family-names-only';
  return 'surface-only';
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
// 2013-gate relax (2026-10-29, permanent) — mirrors relaxEmptyLast, but
// for the parents step, NOT for names, and it does NOT touch the
// single-name / cinno logic. RESEARCHED, not assumed (user correction
// 2026-10-29 ~17:17): when the child's DOB is given, the SERVER's own
// page knows the child's age and its parent-registration verify system
// activates keyed off that DOB as held on the site page. The engine's
// frontend exemption (Step 3: no BRN for 2013) is NOT the site's rule:
// the site page's own validator still marks father/mother ubrn and
// father/mother personBirthDate as required, which is exactly what the
// live fill on b2bd0cb2 showed ("please fill this field"
// [father.ubrn] + "Click to select your birth date"
// [father.personBirthDate]) while the frontend said 2013 needs no BRN.
// The pre-2013 clearing rule was live-verified 2026-10-11; the whole-
// 2013 exemption in this codebase is a USER rule (2026-10-29), never
// live-proven at the server. So this relax only passes the IN-PAGE
// gate, exactly like relaxEmptyLast passes the last-name gate: it
// removes the in-page required markers and validator rules for the
// four parent fields, leaves every field EMPTY (no BRN invented, no
// DOB invented or substituted — a gate-pass value may only ever be a
// true value already given by the user, and no such value exists for
// an ungiven parent BRN), and lets the site's advance (parents fields
// gone) be the proof. It cannot override a server-side POST rejection
// at final submit: if the server rejects ubrn/personBirthDate there,
// that rejection is surfaced verbatim by the existing capture and is
// never forced through.
const PARENT_GATE_FIELDS = [
  { id: 'fatherBrn', name: 'personInfoForBirth.father.ubrn' },
  { id: 'motherBrn', name: 'personInfoForBirth.mother.ubrn' },
  { id: 'fatherBirthDate', name: 'personInfoForBirth.father.personBirthDate' },
  { id: 'motherBirthDate', name: 'personInfoForBirth.mother.personBirthDate' },
];
async function relaxParentBrnGate(page) {
  if (!page || typeof page.evaluate !== 'function') return 'skip';
  return await page.evaluate((fields) => {
    try {
      const $ = window.jQuery;
      fields.forEach(({ id, name }) => {
        const el = document.querySelector('#' + id)
          || document.querySelector('input[name="' + name + '"]')
          || document.querySelector('input[name$="' + id + '"]');
        if (!el) return;
        try { el.required = false; el.removeAttribute('required'); } catch (e) {}
        if ($) $(el).removeClass('error').closest('.form-group, .mb-3, .col-md-6, .col-md-4').find('label.error, .text-danger, .invalid-feedback').remove();
      });
      if ($ && $.validator) {
        const v = $('.form-to-be-validated').data('validator');
        if (v && v.settings && v.settings.rules) {
          Object.keys(v.settings.rules).forEach((k) => {
            if (/(father|mother)\.(ubrn|personBirthDate)$/.test(k)) {
              const r = v.settings.rules[k];
              if (r && typeof r === 'object' && 'required' in r) delete r.required;
              else if (typeof r === 'string' && /required/.test(r)) delete v.settings.rules[k];
            }
          });
        }
      }
      return 'ok';
    } catch (e) { return 'ERR:' + String(e && e.message); }
  }, PARENT_GATE_FIELDS).catch(() => 'fail');
}
// Site-held applicant DOB (DD/MM/YYYY as typed on the BDRIS page, or
// ISO) → ISO YYYY-MM-DD, or null when absent/unparseable. The server
// keys its age/verify decision off the DOB as held on ITS page, so a
// mismatch against the draft DOB is a real decision error, not a
// cosmetic one — see _readSiteApplicantDob / submitS2's DOB guard.
function parseSiteDateToIso(v) {
  const t = String(v || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
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
    mobileNo: bnToArab(S4.phone).replace(/\D/g, ''),
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
    this.familyNamesOnly = options.familyNamesOnly || false; // family/180 advance already taken in this session
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
    // D1 (senior audit 2026-10-26): the old code clicked #aBirth/#aPerm,
    // which are OUR OWN frontend page cards (frontend/bdris-apply.html),
    // NOT site selectors, and clicked #brOfficeSelectionNextBtn, which
    // appears nowhere else in the repo. The site's real controls, ported
    // faithfully from v1 applyS0Core (engines/bdris-apply/server.js):
    // radios #officeBirthplace/#officePermanent, i.e.
    // input[name="officeAddressType"][value="BIRTHPLACE"|"PERMANENT"],
    // embassy checkbox #bdMissionCheckbox, and the generic "পরবর্তী"
    // button via _clickNextAndWait with the S1 anchor (v1's clickNextAndWait
    // uses exactly that anchor for S0 — no site Next-button id exists).
    // Value alignment: the frontend sends BIRTHPLACE and the HTTP layer
    // maps BIRTH->BIRTHPLACE, but the old S0 default was 'BIRTH' and it
    // used the raw value to pick a card id. Canonicalise here so any
    // legacy 'BIRTH' caller still selects the BIRTHPLACE radio.
    // Submit-debug: a ctx-only caller (resume/replay) carries the
    // basis inside data.s0, not as flat fields — read both, so a
    // PERMANENT basis in ctx cannot silently become BIRTHPLACE.
    const raw = String((data.s0 && data.s0.addressType) || data.addressType || 'BIRTHPLACE').toUpperCase();
    const addressType = raw === 'PERMANENT' ? 'PERMANENT' : 'BIRTHPLACE';
    const embassy = !!((data.embassy !== undefined && data.embassy !== null) ? data.embassy : (data.s0 && data.s0.embassy));
    this.progress('🔄 ধাপ ১: আবেদনের ভিত্তি নির্বাচন...');

    // Embassy off: clear the mission checkbox first (v1 LIVE_FIELD:
    // unchecking it makes the site itself return to BIRTHPLACE), so the
    // basis radio selected next is not overridden by a stale mission state.
    if (!embassy) {
      const cbOff = await this._waitVisible(['#bdMissionCheckbox'], 3000);
      if (cbOff) {
        const isChecked = await this.page.evaluate(() => {
          const cb = document.querySelector('#bdMissionCheckbox');
          return cb ? !!cb.checked : false;
        }).catch(() => false);
        if (isChecked) await cbOff.uncheck().catch(async () => {
          await this._robustClick(cbOff, 'embassy checkbox off');
        });
      }
    }

    // Select the basis radio (v1 applyS0Core, no reload here).
    // S0-RADIO-SETTLE (2026-10-28): the form's first step renders LATE —
    // probe 2026-10-28 found 0 controls right after the homepage link and
    // the full step only by 25s — so the wait is 30s, not 6s. A 6s wait on
    // a cold load expires before the radios render and fails with exactly
    // 'radio বাটন পাওয়া যায়নি'. 30s stays well inside the frontend's 90s
    // busy watchdog, and _waitVisible returns early when the radio appears,
    // so warm pages pay nothing extra.
    const radioId = addressType === 'PERMANENT' ? '#officePermanent' : '#officeBirthplace';
    const radio = await this._waitVisible(
      [radioId, `input[name="officeAddressType"][value="${addressType}"]`], 30000);
    if (!radio) {
      const seen = await this._visibleFirstStepControls();
      console.log('S0-NO-RADIO:', JSON.stringify(seen).slice(0, 400));
      return { ok: false, step: 1, failed: [{ field: 'আবেদনের ভিত্তি', reason: 'radio বাটন পাওয়া যায়নি' }] };
    }
    await radio.check().catch(async () => { await this._robustClick(radio, 'basis radio'); });
    const radioChecked = await this.page.evaluate(({ id, val }) => {
      const byId = document.querySelector(id);
      if (byId) return !!byId.checked;
      const byVal = document.querySelector(`input[name="officeAddressType"][value="${val}"]`);
      return byVal ? !!byVal.checked : true;
    }, { id: radioId, val: addressType }).catch(() => true);
    if (!radioChecked) {
      return { ok: false, step: 1, failed: [{ field: 'আবেদনের ভিত্তি', reason: 'radio বাটন নির্বাচন হয়নি' }] };
    }

    // Embassy on: check the mission checkbox after the basis radio
    // (v1 applyS0Core order). The site itself then switches the radio
    // to #officeBDMission (v1 LIVE_FIELD comment), so the basis radio
    // is NOT re-asserted after this point.
    if (embassy) {
      const cb = await this._waitVisible(['#bdMissionCheckbox'], 5000);
      if (!cb) {
        return { ok: false, step: 1, failed: [{ field: 'দূতাবাস অপশন', reason: 'দূতাবাস চেকবক্স পাওয়া যায়নি' }] };
      }
      await cb.check().catch(async () => { await this._robustClick(cb, 'embassy checkbox'); });
    }

    // Next via the shared pattern (v1: generic "পরবর্তী" + S1 anchor).
    // _clickNextAndWait returns ok:true even if the anchor never
    // appears, so the advance check below (ce2cd3c) is the honest gate.
    const nxt = await this._clickNextAndWait('পরবর্তী (ধাপ ১)', {
      nextAnchor: ['#personFirstNameBn', 'input[name="personInfoForBirth.personFirstNameBn"]'],
    });
    if (!nxt.ok) {
      return { ok: false, step: 1, failed: [{ field: nxt.field, reason: nxt.reason }] };
    }
    const advanced = await this._waitVisible(
      ['#personFirstNameBn', 'input[name="personInfoForBirth.personFirstNameBn"]'], 8000);
    if (!advanced) {
      return { ok: false, step: 1, failed: [{ field: 'আবেদনের ভিত্তি', reason: 'পরের ধাপ আসেনি — পাতা/সেশন যাচাই করুন' }] };
    }
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

    // Names — D2: parents already go through transitName (S2), but
    // the applicant went raw, violating the FINAL RULE (any name
    // form must proceed). Use transitName here too, and verify the
    // exact read-back (fillInput's own check passes on any
    // non-empty value, even a site-mangled one).
    keep(await this.fillInput('#personFirstNameBn, input[name*="personFirstNameBn"]',
      transitName(data.firstNameBn), 'নামের প্রথম অংশ (বাংলা)'));
    keep(await this.fillInput('#personLastNameBn, input[name*="personLastNameBn"]',
      transitName(data.lastNameBn), 'নামের শেষ অংশ (বাংলা)'));
    keep(await this.fillInput('#personFirstNameEn, input[name*="personFirstNameEn"]',
      transitName(data.firstNameEn), 'First Name (English)'));
    keep(await this.fillInput('#personLastNameEn, input[name*="personLastNameEn"]',
      transitName(data.lastNameEn), 'Last Name (English)'));
    // ১-নাম নিয়ম (v1 থেকে): শেষ-নামে অক্ষর না থাকলে single ফ্ল্যাগ,
    // ঘর খালি রাখি এবং required-রুল শিথিল করি।
    const singleBn = !hasLetters(transitName(data.lastNameBn));
    const singleEn = !hasLetters(transitName(data.lastNameEn));
    this.singleName = (singleBn || singleEn) ? { bn: singleBn, en: singleEn } : null;
    if (this.singleName) {
      await relaxEmptyLast(this.page, this.singleName).catch(() => {});
    }
    // Diagnostics (2026-10-27): the ack's failed[] carries only field+reason,
    // so a later panel can never say WHAT the site held. Record the first
    // read-back (want vs got) for exactly the checked fields; attached to
    // every S1 return below, ignored by the frontend panel logic.
    let nameCheck = [];
    try {
      const rb = await this.page.evaluate(() => {
        const g = (id, namePart) => {
          let el = document.querySelector(id);
          if (!el) el = document.querySelector(`input[name*="${namePart}"]`);
          return el ? String(el.value || '') : '';
        };
        return {
          fBn: g('#personFirstNameBn', 'personFirstNameBn'), lBn: g('#personLastNameBn', 'personLastNameBn'),
          fEn: g('#personFirstNameEn', 'personFirstNameEn'), lEn: g('#personLastNameEn', 'personLastNameEn'),
        };
      });
      const checks = [
        ['নামের প্রথম অংশ (বাংলা)', rb.fBn, transitName(data.firstNameBn)],
        ['First Name (English)', rb.fEn, transitName(data.firstNameEn)],
      ];
      if (!singleBn) checks.push(['নামের শেষ অংশ (বাংলা)', rb.lBn, transitName(data.lastNameBn)]);
      if (!singleEn) checks.push(['Last Name (English)', rb.lEn, transitName(data.lastNameEn)]);
      nameCheck = checks.map(([label, actual, want]) => ({ field: label, want, got: actual }));
      for (const [label, actual, want] of checks) {
        if (want && actual !== want) failed.push({ field: label, reason: 'সাইটে নাম ঠিকমতো বসেনি — আবার চেষ্টা করুন' });
      }
    } catch (e) { /* read-back is diagnostic; fill errors already counted */ }

    // DOB — v1 live-verified pattern (2026-10-10/11), NOT v2's old
    // '#personDob' + fillInput(raw ISO): 'personDob' appears NOWHERE
    // else in the repo (no v1, frontend, or site evidence), while the
    // site's masked date field is #personBirthDate /
    // personInfoForBirth.personBirthDate, typed DD/MM/YYYY char-by-char
    // with exact read-back (v1: fill() "মান খেয়ে ফেলে" on masked
    // fields). Parents already use this exact pattern in v2 (S2).
    if (data.dob) {
      keep(await this._typeMaskedDate(
        ['#personBirthDate', 'input[name="personInfoForBirth.personBirthDate"]'],
        isoToBdFormat(data.dob), 'জন্ম তারিখ'));
      // ৪৫+ দিন বয়সে সাইট "অ্যাটাচমেন্ট অ্যাভেইলেবিলিটি চেক" modal
      // দেখায় (v1 S1) — না সামলালে পরের ক্লিক আটকায়। Frontend
      // SUBMIT_S1-এ docsAvailable: true পাঠায় (manual + auto দুটোতেই)।
      const modal = await this._handleAttachmentModal(data.docsAvailable !== false);
      if (!modal.ok) failed.push({ field: 'কাগজপত্র', reason: modal.reason });
    }

    // Gender + child number — v1 live-verified selectors. v2's old
    // '#personGender' / name*="personGender" appears NOWHERE else in
    // the repo; the site field is #gender / personInfoForBirth.gender.
    // thChild was a required frontend field ('*' — ১ম..১১তম) that v2
    // S1 dropped entirely despite its own "child number" comment.
    if (data.thChild) {
      keep(await this.selectDropdown(
        ['#thChild', 'select[name="personInfoForBirth.thChild"]'].join(', '),
        'কততম সন্তান', thChildSite(data.thChild)));
    }
    if (data.gender) {
      keep(await this.selectDropdown('#gender, select[name="personInfoForBirth.gender"]',
        'লিঙ্গ', data.gender));
    }

    this.progress('🔄 ধাপ ২: জন্মস্থানের ঠিকানা...');
    // Submit-debug (2026-10-26): the old code skipped the whole
    // address block AND the Next click when no division/district/
    // village was supplied, yet still returned ok:true step 2 —
    // the UI then advanced while the site was still on the person
    // section, and the next step failed on the wrong page with a
    // misleading step. The frontend already validates division/
    // district/village before sending S1, so a real application
    // always carries them; a missing address is an honest failure
    // here, never a success. Names-only callers must not use
    // submitS1 as a step-completion probe.
    if (!(data.division || data.district || data.vilBn)) {
      failed.push({ field: 'জন্মস্থানের ঠিকানা', reason: 'জন্মস্থানের ঠিকানা (বিভাগ/জেলা/গ্রাম) দেওয়া হয়নি — ঠিকানা ছাড়া ধাপ ২ সম্পন্ন নয়' });
      return { ok: false, failed, message: `${failed.length}টি ফিল্ড পূরণ হয়নি`, nameCheck };
    }
    {
      await this._fillAddressSection('birthPlace', data, failed);
      const bpFilled = async () => this.page.evaluate(() => {
        const val = (n) => { const e = document.querySelector(`select[name="${n}"]`); return e && e.offsetParent !== null ? String(e.value || '') : 'x'; };
        const txt = (n) => { const e = document.querySelector(`input[name="${n}"]`); return e && e.offsetParent !== null ? String(e.value || '').trim() : 'x'; };
        if (!val('birthPlaceDiv') || !val('birthPlaceDist') || !val('birthPlaceCityCorpCantOrUpazila')) return false;
        if (!txt('birthPlaceVilAreaTownBn') || !txt('birthPlacePostOfc')) return false;
        return true;
      }).catch(() => false);
      if (data.division && !(await bpFilled())) {
        this.progress('⏳ জন্মস্থানের কিছু ঘর খালি থেকে গেছে — আবার বসানো হচ্ছে…');
        await this._fillAddressSection('birthPlace', data, failed);
      }
      // v1-proven (applyS1Core): the address cascade's partial
      // re-render can empty the names filled above (live 2026-10-11),
      // so re-verify them here and refill any letter-bearing name
      // that the cascade cleared, before clicking Next.
      try {
        const rbAfter = await this.page.evaluate(() => {
          const g = (id, namePart) => {
            let el = document.querySelector(id);
            if (!el) el = document.querySelector(`input[name*="${namePart}"]`);
            return el ? String(el.value || '') : '';
          };
          return {
            fBn: g('#personFirstNameBn', 'personFirstNameBn'), lBn: g('#personLastNameBn', 'personLastNameBn'),
            fEn: g('#personFirstNameEn', 'personFirstNameEn'), lEn: g('#personLastNameEn', 'personLastNameEn'),
          };
        });
        const recheck = [
          ['#personFirstNameBn, input[name*="personFirstNameBn"]', transitName(data.firstNameBn), 'নামের প্রথম অংশ (বাংলা)', rbAfter.fBn],
          ['#personLastNameBn, input[name*="personLastNameBn"]', transitName(data.lastNameBn), 'নামের শেষ অংশ (বাংলা)', rbAfter.lBn],
          ['#personFirstNameEn, input[name*="personFirstNameEn"]', transitName(data.firstNameEn), 'First Name (English)', rbAfter.fEn],
          ['#personLastNameEn, input[name*="personLastNameEn"]', transitName(data.lastNameEn), 'Last Name (English)', rbAfter.lEn],
        ];
        for (const [sel, want, label, actual] of recheck) {
          if (want && !actual) keep(await this.fillInput(sel, want, label + ' (আবার বসানো হলো)'));
        }
      } catch { /* re-verify is best-effort; Next validation is the gate */ }
      // Phase 2: first-read-back name misses re-validated HERE
      // (pre-Next) — after Next the person fields may be gone, so
      // a post-Next read-back would see '' and drop nothing.
      await this._dropStaleNameFailures(data, failed);
      const nxt1 = await this._clickNextAndWait('পরবর্তী (ধাপ ২)', {
        nextAnchor: ['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]'],
      });
      if (!nxt1.ok) failed.push({ field: nxt1.field, reason: nxt1.reason });
      else {
        // v1-proven (applyS1Core modal2): the attachment modal can
        // appear AFTER the Next click too, not only after DOB. If it
        // is covering the page, the parents anchor will never appear
        // — dismiss it first, then re-check the anchor.
        const modalAfter = await this._handleAttachmentModal(data.docsAvailable !== false);
        if (!modalAfter.ok) failed.push({ field: 'কাগজপত্র', reason: modalAfter.reason });
        const parentsHere = await this._waitVisible(
          ['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]'], 5000);
        if (!parentsHere) {
          const b = await this._detectValidationBlock(null);
          failed.push({ field: 'পরবর্তী (ধাপ ২)', reason: (b.blocked && b.reason) || 'সাইট পরের ধাপে যায়নি — তথ্য মিলিয়ে আবার চেষ্টা করুন' });
        } else {
          // Site নিশ্চিতভাবে পরের ধাপে — প্রথম fill-এর ক্ষণস্থায়ী
          // miss-গুলো stale; page থেকে আবার যাচাই করে বাদ দাও।
          await this._dropStaleAddressFailures('birthPlace', data, failed);
          // Phase 2: same re-validation for names — a no-op if the
          // person fields are gone from the page, a catch for late
          // settles if the form keeps its sections in the DOM.
          await this._dropStaleNameFailures(data, failed);
        }
      }
    }

    if (failed.length) {
      return { ok: false, failed, message: `${failed.length}টি ফিল্ড পূরণ হয়নি`, nameCheck };
    }

    this.progress('✔ ধাপ ২ সম্পন্ন');
    return { ok: true, step: 2, nameCheck };
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
    // 2013-rule (2026-10-29): pre-2013 + পুরো 2013 সাল — BRN
    // ছাড়াই, শুধু আইডি কার্ডে এগোবে। 2014+ আগের মতো।
    const brnExempt = isParentBrnExempt(dobIso);
    if (dobIso) this.applicantDob = dobIso; // v1: appData.applicantDob update — later steps use it
    // Parent-BRN non-block (2026-10-29, point 4): applicant DOB
    // missing হলে ২০১৩-নিয়ম অনুমান করা যাবে না — post-2013
    // ধরে BRN চাওয়া ভুল হবে। তাই স্পষ্ট কারণ-সহ থামি;
    // এটা BRN-অনুমানের ব্লক নয়, DOB-অনুপস্থিতির নির্ণয়।
    if (!dobIso) {
      const dobReason = 'আবেদনকারীর জন্ম তারিখ পাওয়া যায়নি — ২০১৩-পূর্ব/পর নিয়ম ঠিক করা যাচ্ছে না, তাই পিতামাতার BRN চাওয়া হচ্ছে না। জন্ম তারিখ ঠিক করে আবার চেষ্টা করুন।';
      this.progress('❌ ' + dobReason);
      return { ok: false, step: 3, blocked: true, reason: dobReason, message: '❌ ' + dobReason, failed: [{ field: 'আবেদনকারীর জন্ম তারিখ', reason: dobReason }], verifyStatus, applicantDobMissing: true };
    }
    // 2013-gate, researched (user correction 2026-10-29 ~17:17):
    // the server keys its parent-verify decision off the applicant
    // DOB AS HELD ON ITS PAGE. If that held DOB puts the child in a
    // different bracket than the draft DOB, the engine's exemption
    // decision is simply wrong for this page — proceeding would
    // relax (or demand) the wrong gate. Stop honestly instead of
    // guessing; a missing/unreadable held DOB cannot prove a
    // mismatch, so it does not block on its own.
    if (brnExempt) {
      const siteDob = await this._readSiteApplicantDob().catch(() => null);
      if (siteDob && isParentBrnExempt(siteDob) !== brnExempt) {
        const raceReason = 'সাইটে থাকা আবেদনকারীর জন্ম তারিখ ড্রাফটের সঙ্গে মিলছে না — ২০১৩-ছাড়ের সিদ্ধান্ত এই পেজে ভুল হবে, তাই পিতামাতার ধাপে এগোনো হচ্ছে না। জন্ম তারিখ সাইটে ঠিকভাবে বসেছে কিনা মিলিয়ে আবার চেষ্টা করুন।';
        this.progress('❌ ' + raceReason);
        return { ok: false, step: 3, blocked: true, reason: raceReason, message: '❌ ' + raceReason, failed: [{ field: 'আবেদনকারীর জন্ম তারিখ', reason: raceReason }], verifyStatus, applicantDobMismatch: true };
      }
      // Pre-fill relax: the site's required markers for ubrn /
      // personBirthDate are removed BEFORE Next is ever clicked,
      // mirroring relaxEmptyLast for a single name. Fields stay
      // empty — no BRN, no DOB is invented here.
      await this._relaxParentBrnGate().catch(() => {});
    }
    let brnNote = null;
    // Family advance persistence (2026-10-29 follow-up): the same
    // handler re-runs submitS2 during replay, and the session may
    // carry the flag across step commands (server.js). A second
    // run must NOT re-fill the BRN that already triggered the
    // family error — it starts names-only, exactly like the
    // advance that already succeeded once. Names/DOB/nationality
    // are still filled; only the BRN field is skipped.
    if (data.familyNamesOnly) this.familyNamesOnly = true;
    // Seeded run (replay / later step command): the family note
    // is attached only at the advanced-success return below, never
    // at fill time — a seeded run that then fails must not carry
    // an "এগোনো হয়েছে" note it never earned.
    const familySeeded = !!this.familyNamesOnly;
    this._familyAttempted = false;

    const fillParent = async (p, who, verifyIndex) => {
      const base = `personInfoForBirth.${p}.`;
      const brnSel = [`#${p}Brn`, `input[name="${base}ubrn"]`];
      const dobSel = [`#${p}BirthDate`, `input[name="${base}personBirthDate"]`];
      // Parent-BRN non-block (2026-10-29, point 1): বাংলা ডিজিট
      // → আরবি, স্পেস/ড্যাশ বাদ — নইলে সঠিক BRN-ও রেজিস্ট্রি-
      // লুকআপে ভুল দেখাতে পারে। নাম এখানে ছোঁয়া হয় না।
      const brn = normalizeBrn((data[p] || {}).brn);
      const familyAdvance = !!this.familyNamesOnly;
      if (brnExempt || familyAdvance) {
        // ছাড়প্রাপ্ত জন্মসালে (pre-২০১৩ live-verified 2026-10-11;
        // ২০১৩ সাল 2026-10-29 নিয়ম) পিতামাতার BRN ঐচ্ছিক — আর
        // BRN বসালে সাইট রেজিস্ট্রি-লিংক ধরে ফ্যামিলি-ভ্যালিডেশন
        // চালায় ("Difference of age among children needs to be
        // at least 180 days") → নাগরিক আটকে যায়। তাই ছাড়ের
        // সালে BRN ঘর খালি রাখি — নাম + আইডি কার্ডই যথেষ্ট,
        // কোনো BRN বানানো হয় না।
        const brnEl = await this._waitVisible(brnSel, 2500);
        if (brnEl) await brnEl.fill('').catch(() => {});
        verifyStatus[p] = brnExempt
          ? (isPre2013(dobIso) ? 'skipped-pre2013' : 'skipped-2013')
          : 'skipped-family';
        // ছাড়ের নিয়ম থাকল, নীরবতা গেল (point 4): সাইটে BRN
        // না পাঠানোর কথা progress + ack-এর brnNote-এ জানানো
        // হয়। ড্রাফটের BRN বদলায় না, শুধু সাইট-ফর্মে যায় না।
        if (!brnNote && brnExempt) { brnNote = parentBrnExemptNote(dobIso); this.progress('ℹ️ ' + brnNote); }
      } else {
        keep(await this._typeInto(brnSel, brn, `${who}-এর BRN`, { required: true }));
      }
      if (data[p] && data[p].dob) {
        keep(await this._typeMaskedDate(dobSel, isoToBdFormat(data[p].dob), `${who}-এর জন্ম তারিখ`));
      }
      keep(await this._typeInto([`#${p}NameBn`, `input[name="${base}personNameBn"]`], transitName((data[p] || {}).nameBn), `${who}-এর নাম (বাংলা)`, { required: true }));
      keep(await this._typeInto([`#${p}NameEn`, `input[name="${base}personNameEn"]`], transitName((data[p] || {}).nameEn), `${who}-এর নাম (English)`, { required: true }));
      if (!brnExempt && !familyAdvance && brn) {
        // Verify (BRN+DOB+নাম পূরণের পর); বাটন না থাকলে নীরব skip
        // Family advance-এ Verify নেই — BRN ছাড়া যাচাইয়ের কিছু নেই।
        const v = await this._clickVerify(verifyIndex, who, { quietMissing: true });
        verifyStatus[p] = v.verified;
        if (v.verified === false) {
          // Parent-BRN non-block (2026-10-29, points 2+3): Verify-ফল
          // একা কখনো failed-এ যাবে না — সাইটের পরের ধাপই চূড়ান্ত
          // বিচারক। আগে এখানকার failed-এন্ট্রিই না-এগোনো টেইলে
          // BRN-ব্লক বানাত। এখন landed মান একবার মিলিয়ে দেখি
          // (উপস্থিতি-মাত্র লগে, মান নয়): ঘর খালি থাকলে একবার
          // আবার বসাই, বসে থাকলে Verify-কে আর ঘাঁটাই না।
          const landed = await this._readParentLanded(p);
          console.log(`PARENT-BRN-LANDED ${p} brn=${landed.brn === null ? 'unknown' : (landed.brn ? 'present' : 'empty')} dob=${landed.dob === null ? 'unknown' : (landed.dob ? 'present' : 'empty')}`);
          if (landed.brn === '') keep(await this._typeInto(brnSel, brn, `${who}-এর BRN`, { required: true }));
          if (landed.dob === '' && data[p] && data[p].dob) keep(await this._typeMaskedDate(dobSel, isoToBdFormat(data[p].dob), `${who}-এর জন্ম তারিখ`));
          this.progress(`⚠ ${who}-এর BRN যাচাইয়ে রেজিস্ট্রিতে পাওয়া যায়নি — সাইটের পরের ধাপই চূড়ান্ত সিদ্ধান্ত নেবে, Verify-ফল একা আটকাবে না।`);
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
    let siteError = null;
    if (!nxt.ok) {
      failed.push({ field: nxt.field, reason: nxt.reason });
    } else {
      let chk = await this._detectValidationBlock(null);
      if (chk.blocked) {
        // Stale-text re-check (2026-10-29, point 2): আগের চেষ্টার
        // পড়ে থাকা ভুল-বার্তায় নতুন সঠিক তথ্য আটকাবে না — একটু
        // থিতিয়ে আবার দেখি; তবু blocked থাকলেই সেটা আসল ব্লক।
        try { await this.page.waitForTimeout(1200); } catch { /* no-op */ }
        chk = await this._detectValidationBlock(null);
      }
      if (chk.blocked && isFamilyErrorText(chk.reason)) {
        // পারিবারিক (180-days) ADVANCE শাখা (2026-10-29 follow-up):
        // আগের একবারের চেষ্টা এখনো আটকাতে পারত তিনভাবে —
        // (a) সাইট এগিয়ে গেলেও পড়ে থাকা family-বার্তা chk2-কে
        // blocked দেখাত, (b) names-only Next-এর wait ব্যর্থ হলেও
        // সাইট আসলে এগিয়ে যেত, (c) BRN ঘর আসলে খালি হয়েছিল
        // কিনা কেউ যাচাই করত না। তাই: এগোনোই চূড়ান্ত প্রমাণ —
        // পিতামাতার ঘর আর নেই মানেই advance, বার্তা যাই থাকুক।
        // নাম + জাতীয়তা ছাড়া কিছু বদলানো হয় না; এগোলে BRN
        // ড্রাফটেই থাকে, নোট-সহ জানানো হয়; না এগোলে সাইটের
        // আসল বার্তাই ফেরে — advance-এর মিথ্যা দাবি নয়।
        let familyAttempted = false;
        if (await this._parentsFieldsGone()) {
          // সাইট আগেই এগিয়ে গেছে — পড়ে থাকা বার্তায় আটকানো নয়।
          familyAttempted = true;
        } else {
          this.progress('ℹ️ সাইটের পারিবারিক নিয়ম দেখা যাচ্ছে — BRN ছাড়াই (নাম + জাতীয়তা দিয়ে) চেষ্টা করা হচ্ছে…');
          const cleared = await this._clearParentBrnFields();
          if (!cleared) this.progress('⚠ BRN ঘর পুরোপুরি খালি হয়নি — তবু পরবর্তী চেষ্টা করা হচ্ছে…');
          const nxt2 = await this._clickNextAndWait('পরবর্তী (ধাপ ৩ — পারিবারিক নিয়ম)');
          if (nxt2.ok) {
            // chk2-তেও stale re-check: পড়ে থাকা বার্তা যেন
            // names-only সাফল্যকে ব্লক বানাতে না পারে।
            try { await this.page.waitForTimeout(1200); } catch { /* no-op */ }
            const chk2 = await this._detectValidationBlock(null);
            if (!chk2.blocked || await this._parentsFieldsGone()) {
              familyAttempted = true;
            } else {
              siteError = chk2.reason;
            }
          } else if (await this._parentsFieldsGone()) {
            // Next-এর wait ব্যর্থ, কিন্তু সাইট এগিয়ে গেছে।
            familyAttempted = true;
          } else {
            siteError = nxt2.reason || chk.reason;
          }
        }
        if (familyAttempted) {
          // নোট এখানে নয়, নিচের advanced-প্রমাণে: ঘর সত্যিই
          // না গেলে success-এর ভান করা হবে না। শুধু চিহ্ন রাখি।
          this._familyAttempted = true;
        }
      } else if (chk.blocked && brnExempt && /ubrn|personBirthDate/i.test(chk.reason)) {
        // 2013-gate relax-and-retry: the site's in-page validator
        // re-asserted the ubrn/personBirthDate required rules
        // despite the exemption (this is the live b2bd0cb2 failure:
        // frontend says "no BRN for 2013", site page says "fill
        // [father.ubrn] / select [father.personBirthDate]"). Relax
        // the gate again and click Next once more — exactly the
        // single-name shape (relax, then gate). Advance is still
        // only claimed on the fields-gone proof below; if the site
        // still blocks after the relax, its exact text is returned
        // and no advance is claimed. No field is filled here: both
        // ubrn and any ungiven parent DOB stay empty.
        this.progress('ℹ️ সাইটের ২০১৩ গেট (পিতামাতার BRN/জন্ম তারিখের আবশ্যক নিয়ম) শিথিল করে আবার পরবর্তী চেষ্টা করা হচ্ছে…');
        await this._relaxParentBrnGate().catch(() => {});
        const nxtGate = await this._clickNextAndWait('পরবর্তী (ধাপ ৩ — ২০১৩ গেট)');
        if (nxtGate.ok) {
          try { await this.page.waitForTimeout(1200); } catch { /* no-op */ }
          const chkGate = await this._detectValidationBlock(null);
          if (!chkGate.blocked || await this._parentsFieldsGone()) {
            this._gateRelaxRetried = true;
            // No siteError: fall through to the advanced proof
            // below, which alone decides success.
          } else {
            siteError = chkGate.reason;
          }
        } else if (await this._parentsFieldsGone()) {
          this._gateRelaxRetried = true;
        } else {
          siteError = nxtGate.reason || chk.reason;
        }
      } else if (chk.blocked) {
        siteError = chk.reason;
      }
    }
    if (siteError) {
      const msg = '❌ ' + siteError;
      this.progress(msg);
      return {
        ok: false, step: 3, blocked: true, reason: siteError,
        message: msg + ' — ঘরটি পূরণ করে আবার চেষ্টা করুন।',
        failed: [...failed, { field: 'পরবর্তী (ধাপ ৩)', reason: siteError }], verifyStatus, brnNote,
      };
    }
    // parents ঘর আর নেই = সাইট নিশ্চিতভাবে পরের ধাপে → verify-নেগেটিভ মিথ্যা, বাদ
    let advanced = false;
    if (nxt.ok) {
      await this.page.waitForTimeout(2500);
      advanced = !(await this._waitVisible(
        ['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]'], 1500));
    }
    if (advanced) {
      // 2013-gate note, only after the fields-gone proof: the
      // in-page gate was relaxed and the site advanced. This is
      // NOT a claim about the server's final-submit decision —
      // that is still the server's, and a submit rejection there
      // is surfaced verbatim, never forced.
      if (this._gateRelaxRetried) {
        this.progress('ℹ️ ২০১৩ গেট শিথিল করে সাইট এগিয়েছে (পিতামাতার BRN/জন্ম তারিখ খালি রাখা হয়েছে, কোনো নম্বর/তারিখ বানানো হয়নি) — চূড়ান্ত সাবমিটে সার্ভারের সিদ্ধান্তই শেষ কথা।');
      }
      // Family advance-এর নোট শুধু এখানে, প্রমাণের পরে:
      // ঘর সত্যিই গেছে মানেই advance, তার আগে নয়।
      if (this._familyAttempted || familySeeded) {
        brnNote = PARENT_BRN_FAMILY_NOTE;
        this.familyNamesOnly = true;
        this.progress('ℹ️ ' + PARENT_BRN_FAMILY_NOTE);
      }
      await this._dismissNotices();
      return {
        ok: true, step: 4, blocked: false,
        message: '✅ ধাপ ৩ সম্পন্ন! স্থায়ী ও বর্তমান ঠিকানা দিন।',
        failed: [], verifyStatus, brnNote, familyNamesOnly: !!this.familyNamesOnly,
      };
    }
    // Submit-debug (2026-10-26): the old tail returned ok:true
    // for pre-2013 callers even when the site had NOT advanced
    // (the !pre2013 branch was the only not-advanced failure, and
    // the final fall-through returned ok on an empty failed list).
    // A slow transition gets one more 3s re-check, then not-advanced
    // is an honest failure for every caller — the UI must not
    // advance to the address step while the site is still on parents.
    if (nxt.ok && !advanced) {
      await this.page.waitForTimeout(3000);
      advanced = !(await this._waitVisible(
        ['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]'], 1500));
    }
    if (nxt.ok && !advanced) {
      // এগোয়নি — কারণ আর verifyStatus থেকে বানানো নয়
      // (2026-10-29, point 2): Verify-ফল একা ব্লকের কারণ হতে
      // পারে না। সাইটের তাজা ভুল-বার্তা আগেই siteError-এ ধরা
      // হয়েছে; এখানে এলে নতুন বার্তা আসেনি — সত্যিটাই বলি।
      // verifyUncertain শুধু রিপ্লে-র জন্য চিহ্ন (point 7)।
      const verifyUncertain = Object.values(verifyStatus).some((v) => v === false || v === null);
      const reason = 'BDRIS এগোতে দিচ্ছে না — সাইটের নতুন কোনো ভুল-বার্তা পাওয়া যায়নি। পিতামাতার তথ্য (BRN, জন্ম তারিখ, নাম) মিলিয়ে আবার চেষ্টা করুন।';
      this.progress('❌ ' + reason);
      return { ok: false, step: 3, blocked: true, reason, message: '❌ ' + reason, failed, verifyStatus, verifyUncertain, brnNote };
    }

    return {
      ok: failed.length === 0, step: 4, blocked: false,
      message: `⚠️ ধাপ ৩ শেষ — ${failed.length}টি সমস্যা।`,
      failed, verifyStatus, brnNote,
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
    // ঠিকানা সত্যিই ভরা আছে কি না — কপি-চেকবক্সের পরেও যাচাই করি।
    // আগে কপি-শাখায় কোনো যাচাই ছিল না: চেকবক্স না পাওয়া গেলে
    // চুপচাপ কিছুই হতো না, আর চেক করলেও সাইট কপি না করলে
    // বর্তমান ঠিকানা খালিই থেকে যেত — তারপর Next-এ সাইট
    // "খালি" বলত। এখন কপি না হলে সরাসরি বসানো হয়, তাতেও
    // না হলে failed-এ ধরা পড়ে, চুপচাপ Next-এ যাওয়া হয় না।
    const addrFilled = async (pre) => this.page.evaluate((p) => {
      const val = (n) => { const e = document.querySelector(`select[name="${n}"]`); return e && e.offsetParent !== null ? String(e.value || '') : 'x'; };
      const txt = (n) => { const e = document.querySelector(`input[name="${n}"]`); return e && e.offsetParent !== null ? String(e.value || '').trim() : 'x'; };
      if (!val(p + 'Div') || !val(p + 'Dist') || !val(p + 'CityCorpCantOrUpazila')) return false;
      if (!txt(p + 'VilAreaTownBn') || !txt(p + 'PostOfc')) return false;
      return true;
    }, pre).catch(() => false);
    // স্থায়ী ঠিকানা
    // Permanent (2026-10-15): data থাকলে flag উপেক্ষা করে fill করি — ভুল
    // permCopy=true-তে copy-box চেক করলে ব্যবহারকারীর আলাদা ঠিকানা মুছে যায়।
    const permHasData = data.perm && (data.perm.division || data.perm.district || data.perm.vilBn);
    if (permHasData) {
      this.progress('🔄 স্থায়ী ঠিকানা বসানো হচ্ছে...');
      await this._fillAddressSection('permAddr', data.perm, failed);
    } else {
      const cb1 = await findCopyBox('জন্মস্থানের ঠিকানা ও স্থায়ী ঠিকানা একই', 'copyBirthPlaceToPermAddr');
      if (!cb1) {
        failed.push({ field: 'স্থায়ী ঠিকানা', reason: 'জন্মস্থান থেকে কপির চেকবক্স সাইটে পাওয়া যায়নি' });
      } else {
        const checked = await cb1.isChecked().catch(() => false);
        if (!checked) await cb1.check().catch(async () => { await cb1.click(); });
        await this.page.waitForTimeout(1200);
        if (!(await addrFilled('permAddr'))) {
          const src = await this._readAddressFromPage('birthPlace');
          if (src.division || src.district || src.vilBn) {
            this.progress('⏳ কপি হয়নি — জন্মস্থান থেকে স্থায়ী ঠিকানা সরাসরি বসানো হচ্ছে…');
            await this._fillAddressSection('permAddr', src, failed);
          }
        }
        if (await addrFilled('permAddr')) this.progress('✔ স্থায়ী ঠিকানা: জন্মস্থান থেকে কপি');
        else failed.push({ field: 'স্থায়ী ঠিকানা', reason: 'জন্মস্থান থেকে কপি হয়নি — স্থায়ী ঠিকানা খালি আছে' });
      }
    }
    // বর্তমান ঠিকানা
    const presHasData = data.pres && (data.pres.division || data.pres.district || data.pres.vilBn);
    if (presHasData) {
      this.progress('🔄 বর্তমান ঠিকানা বসানো হচ্ছে...');
      await this._fillAddressSection('prsntAddr', data.pres, failed);
    } else {
      const cb2 = await findCopyBox('স্থায়ী ঠিকানা ও বর্তমান ঠিকানা একই', 'copyPermAddrToPrsntAddr');
      if (!cb2) {
        failed.push({ field: 'বর্তমান ঠিকানা', reason: 'স্থায়ী ঠিকানা থেকে কপির চেকবক্স সাইটে পাওয়া যায়নি' });
      } else {
        const checked = await cb2.isChecked().catch(() => false);
        if (!checked) await cb2.check().catch(async () => { await cb2.click(); });
        await this.page.waitForTimeout(800);
        if (!(await addrFilled('prsntAddr'))) {
          const src = (data.perm && (data.perm.division || data.perm.district || data.perm.vilBn))
            ? data.perm
            : await this._readAddressFromPage('permAddr');
          if (src.division || src.district || src.vilBn) {
            this.progress('⏳ কপি হয়নি — স্থায়ী ঠিকানা থেকে বর্তমান ঠিকানা সরাসরি বসানো হচ্ছে…');
            await this._fillAddressSection('prsntAddr', src, failed);
          }
        }
        if (await addrFilled('prsntAddr')) this.progress('✔ বর্তমান ঠিকানা: স্থায়ী ঠিকানা থেকে কপি');
        else failed.push({ field: 'বর্তমান ঠিকানা', reason: 'স্থায়ী ঠিকানা থেকে কপি হয়নি — বর্তমান ঠিকানা খালি আছে' });
      }
    }

    // partial re-render-এ খালি থাকলে আবার বসাই (যাচাই উপরে আছে)
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
    let anchor = await this._waitVisible(['input[name="relationWithApplicant"]', 'input[name="files"]'], 10000);
    if (!anchor) {
      // DOCPAGE FIX (2026-10-29): do NOT fail immediately like before.
      // The old code treated "anchors not visible in 10s" as "document
      // page not open", even when the site page was merely one step
      // behind (address step after an S2B timeout, slow cascade, or
      // socket-death replay) — while the engine UI already showed
      // the documents as present, because those are draft uploads,
      // not site uploads. S4Prep already solved the same problem for
      // the contact step (detect site step + replay at most once);
      // mirror that pattern here, but with pre-docs catch-up only:
      // calling _replayToContact would recurse into submitS3 itself
      // and, after the inner call's Next, leave this call with no
      // docs anchor to find. So catch up with S0/S1/S2/S2B only,
      // then continue with THIS call's upload below.
      console.log('S3-ANCHOR: missing');
      const det = await this._detectSiteStep().catch(() => ({ step: 0, probe: {} }));
      console.log('S3-DETECT: step=' + det.step);
      if (det.step === 6) {
        // Site already past docs: the documents are on the site in
        // this session. Failing here would block a preview whose
        // documents are genuinely present — recognise, don't invent.
        this.progress('✔ কাগজপত্রের ধাপ সাইটে ইতিমধ্যে পার হয়ে গেছে — আবার আপলোড নয়।');
        return { ok: true, step: 6, message: '✅ প্রত্যয়ন ও ডকুমেন্ট সাইটে ইতিমধ্যে সম্পন্ন', failed: [], docsAlreadyOnSite: true };
      }
      let replay = null;
      if (det.step === 5) {
        // Probe sees docs elements but they are not Playwright-
        // visible yet (Angular re-render settling): wait once more.
        anchor = await this._waitVisible(['input[name="relationWithApplicant"]', 'input[name="files"]'], 15000);
      } else {
        replay = await this._catchUpToDocs(det.step, data);
        console.log('S3-REPLAY:', replay.ok ? 'ok' : 'fail ' + (replay.reason || ''));
        anchor = await this._waitVisible(
          ['input[name="relationWithApplicant"]', 'input[name="files"]'],
          replay.ok ? 12000 : 3000,
        );
      }
      if (!anchor) {
        // Classify the actual page state (presence only, no values),
        // like S4Prep does — never again just "page not open".
        const probe = (await this._detectSiteStep().catch(() => null))?.probe || det.probe || {};
        const where = probe.docs ? 'কাগজপত্রের ধাপেই আছে কিন্তু ঘর দৃশ্যমান নয়'
          : det.step === 4 ? 'সাইট এখনো ঠিকানার ধাপে আছে'
          : det.step === 3 ? 'সাইট এখনো পিতামাতার ধাপে আছে'
          : det.step === 2 ? 'সাইট এখনো ব্যক্তির ধাপে আছে'
          : det.step === 1 ? 'সাইট এখনো শুরুর ধাপে আছে'
          : (!probe.form && probe.bodyLen >= 0 && probe.bodyLen < 100 ? 'খালি/স্টাব পাতা'
          : probe.form ? 'ফরম আছে কিন্তু ডকুমেন্ট ঘর দেখা যাচ্ছে না' : 'কোনো ধাপের ঘরই দেখা যাচ্ছে না');
        const failList = [{ field: 'ডকুমেন্ট পেজ', reason: `পেজ পাওয়া যায়নি (${where})`, code: 'DOCS_ANCHORS_MISSING' }];
        if (replay && !replay.ok && replay.reason) {
          failList.push({ field: 'পুনঃচেষ্টা', reason: replay.reason, code: 'S3_REPLAY_FAILED' });
        }
        this.progress('❌ ডকুমেন্ট পেজ পাওয়া যায়নি — ' + where + '।');
        return {
          ok: false, step: 4, blocked: true,
          message: '❌ ডকুমেন্ট পেজ পাওয়া যায়নি',
          failed: failList,
        };
      }
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

  /**
   * S4Prep replay (2026-10-26, permanent fix): detect the BDRIS site step
   * once, using v1-style anchors ported from engines/bdris-apply/server.js
   * detectSiteStep (6=contact, 5=docs, 4=perm-addr, 3=parents, 2=person,
   * 1=office, 0=unknown). Returns { step, probe } where probe is the
   * presence-only page state (no values) used for honest failure text.
   */
  async _detectSiteStep() {
    const probe = await this.page.evaluate(() => {
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
        [6, ['#email', 'input[name="email"]', '#phone', 'input[name="phone"]']],
        [5, ['input[name="relationWithApplicant"]', 'input[name="files"]', '#filesInput']],
        [4, ['select[name="permAddrDiv"]', 'input[name="copyBirthPlaceToPermAddr"]', '#permFields']],
        [3, ['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]']],
        [2, ['#personFirstNameBn', 'input[name="personInfoForBirth.personFirstNameBn"]', '#personBirthDate']],
        [1, ['#officeBirthplace', 'input[name="officeAddressType"]']],
      ];
      let step = 0;
      for (const [n, sels] of steps) if (vis(sels)) { step = n; break; }
      const any = (s) => {
        try { const e = document.querySelector(s); return !!(e && e.offsetParent !== null); }
        catch { return false; }
      };
      return {
        step, contact: any('#email') || any('#phone'),
        docs: any('input[name="relationWithApplicant"]') || any('input[name="files"]'),
        start: any('#officeBirthplace'), form: !!document.querySelector('form'),
        bodyLen: document.body ? (document.body.innerText || '').length : 0,
      };
    }).catch(() => ({ step: 0, contact: false, docs: false, start: false, form: false, bodyLen: -1 }));
    return { step: probe.step || 0, probe };
  }

  /**
   * DOCPAGE FIX (2026-10-29): pre-docs catch-up only, used by submitS3
   * when the docs anchors are missing. Unlike _replayToContact, this
   * NEVER calls submitS3 itself: the caller is submitS3, and after an
   * inner S3's Next the outer call would find no docs anchor left.
   * Runs at most the steps before docs, once, from the merged ctx
   * (data.s0/s1/s2/s2b, as mergeStepParams supplies). The submitS2
   * verify-uncertain exception mirrors _replayToContact point 7
   * (2026-10-29): if the parents fields are gone, the site advanced
   * and uncertainty alone must not stop the catch-up. No document
   * is invented, uploaded twice, or claimed present here — the
   * caller's upload below is still the only upload.
   * Returns { ok } or { ok:false, reason, failed }.
   */
  async _catchUpToDocs(siteStep, data = {}) {
    const plan = {
      0: ['submitS0', 'submitS1', 'submitS2', 'submitS2B'],
      1: ['submitS0', 'submitS1', 'submitS2', 'submitS2B'],
      2: ['submitS1', 'submitS2', 'submitS2B'],
      3: ['submitS2', 'submitS2B'],
      4: ['submitS2B'],
    }[siteStep];
    if (!plan) return { ok: false, reason: `চেনা যায়নি এমন সাইট ধাপ (${siteStep})` };
    const ctx = data || {};
    for (const method of plan) {
      let args;
      if (method === 'submitS0') args = ctx.s0 || {};
      else if (method === 'submitS1') args = { ...(ctx.s1 || {}), docsAvailable: true };
      else if (method === 'submitS2') args = { ...(ctx.s2 || {}), applicantDob: (ctx.s1 && ctx.s1.dob) || this.applicantDob };
      else args = ctx.s2b || {};
      this.progress(`🔄 ধাপ আবার বসানো হচ্ছে: ${method}…`);
      const r = await this[method](args);
      if (!r || r.ok === false) {
        if (method === 'submitS2' && r && r.verifyUncertain) {
          let stillThere = null;
          try { stillThere = await this._waitVisible(['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]'], 1500); } catch { stillThere = null; }
          if (!stillThere) {
            this.progress('⚠ ধাপ ৩ পুনরায় বসানোয় যাচাই-ফল অনিশ্চিত ছিল, কিন্তু সাইট এগিয়ে গেছে — এগোনো হচ্ছে।');
            continue;
          }
        }
        return { ok: false, reason: (r && r.message) || `${method} ব্যর্থ`, failed: r && r.failed };
      }
    }
    return { ok: true };
  }

  /**
   * S4Prep replay (2026-10-26, permanent fix): run AT MOST ONCE per
   * submitS4Prep call, and only to REACH the contact step — never to
   * click the OTP button, verify an OTP, or submit. Docs step (5):
   * press Next only; docs already on the site are NOT re-uploaded.
   * Unknown / steps 1-4: catch up from session formCtx (s0/s1/s2/s2b)
   * through S3, using the same step methods the normal chain uses.
   * Returns { ok, replayed } or { ok:false, reason, failed }.
   */
  async _replayToContact(siteStep, data = {}) {
    if (siteStep === 6) {
      return { ok: false, reason: 'যোগাযোগ ধাপ চেনা গেছে কিন্তু ঘর দৃশ্যমান নয় — পরবর্তী চাপলে ধাপ ছেড়ে যাবে' };
    }
    if (siteStep === 5) {
      this.progress('🔄 কাগজপত্রের ধাপে আছে — পরবর্তী চেপে যোগাযোগে যাওয়া হচ্ছে (কাগজ আবার আপলোড নয়)…');
      const nxt = await this._clickNextAndWait('পরবর্তী (ধাপ ৪)');
      if (!nxt.ok) return { ok: false, reason: nxt.reason || 'পরবর্তী বাটন পাওয়া যায়নি' };
      return { ok: true, replayed: 'docs-next' };
    }
    const plan = {
      0: ['submitS0', 'submitS1', 'submitS2', 'submitS2B', 'submitS3'],
      1: ['submitS0', 'submitS1', 'submitS2', 'submitS2B', 'submitS3'],
      2: ['submitS1', 'submitS2', 'submitS2B', 'submitS3'],
      3: ['submitS2', 'submitS2B', 'submitS3'],
      4: ['submitS2B', 'submitS3'],
    }[siteStep];
    if (!plan) return { ok: false, reason: `চেনা যায়নি এমন সাইট ধাপ (${siteStep})` };
    const ctx = data || {};
    for (const method of plan) {
      let args;
      if (method === 'submitS0') args = ctx.s0 || {};
      else if (method === 'submitS1') args = { ...(ctx.s1 || {}), docsAvailable: true };
      else if (method === 'submitS2') args = { ...(ctx.s2 || {}), applicantDob: (ctx.s1 && ctx.s1.dob) || this.applicantDob };
      else if (method === 'submitS2B') args = ctx.s2b || {};
      else args = {
        relation: data.relation, docs: data.docs || (data.s3 && data.s3.docs) || [],
        s1: ctx.s1 || {}, applicantDob: (ctx.s1 && ctx.s1.dob) || this.applicantDob,
      };
      this.progress(`🔄 ধাপ আবার বসানো হচ্ছে: ${method}…`);
      const r = await this[method](args);
      if (!r || r.ok === false) {
        // Replay non-block (2026-10-29, point 7): ধাপ ৩-এ
        // Verify-অনিশ্চয়তা একা রিপ্লে আটকাবে না — সাইট আসলেই
        // এগিয়ে গিয়ে থাকলে (পিতামাতার ঘর আর নেই) সেটাই
        // প্রমাণ, এগিয়ে যাই। ঘর এখনো থাকলে আসল ব্লক, থামি।
        if (method === 'submitS2' && r && r.verifyUncertain) {
          let stillThere = null;
          try { stillThere = await this._waitVisible(['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]'], 1500); } catch { stillThere = null; }
          if (!stillThere) {
            this.progress('⚠ ধাপ ৩ পুনরায় বসানোয় যাচাই-ফল অনিশ্চিত ছিল, কিন্তু সাইট এগিয়ে গেছে — এগোনো হচ্ছে।');
            continue;
          }
        }
        return { ok: false, reason: (r && r.message) || `${method} ব্যর্থ`, failed: r && r.failed };
      }
    }
    return { ok: true, replayed: 'catch-up' };
  }

  /**
   * Step 4-prep: Contact info (email/phone) + "ওটিপি পাঠান" button
   * Migrated from v1 SUBMIT_S4_PREP (server.js) — selectors/timing preserved.
   * v1 appData-equivalents come from data + constructor options.
   */
  async submitS4Prep(data = {}) {
    if (!this.page) {
      this.progress('❌ সংযোগ নেই — আবার চেষ্টা করুন।');
      return { ok: false, message: '❌ সংযোগ নেই — আবার চেষ্টা করুন।' };
    }
    // Debug-2 (2026-10-26): S4Prep is the ONLY step that ever sees
    // the contact (frontend sends {email, phone} flat here, and the
    // S4_OTP payload carries only {otp} + ctx {s0,s1,s2,s2b} — no
    // phone/email at all). Without carrying it, submitS4's
    // buildOriginalRec always got an empty s4prep, mobileNo was
    // empty, and originalRec was always null — so the post-submit
    // original-PDF path could never work. The server copies
    // this.contact onto the session (like singleName/applicantDob)
    // and merges it into S4's s4prep; the handler itself never
    // stores it anywhere else.
    this.contact = { email: String(data.email || '').trim(), phone: String(data.phone || '').trim() };
    // v1 appData-equivalent for cinno / probe-autofix
    const fd = {
      s1: data.s1 || {},
      singleName: data.singleName !== undefined ? data.singleName : this.singleName,
      gatePassedNames: data.gatePassedNames !== undefined ? data.gatePassedNames : this.gatePassedNames,
    };
    const failed = [];
    let resumable = false;
    let otpSent = false;

    this.progress('🔄 যোগাযোগের তথ্য বসানো হচ্ছে...');
    const CONTACT_ANCHORS = ['#email', 'input[name="email"]', '#phone', 'input[name="phone"]'];
    let anchor = await this._waitVisible(CONTACT_ANCHORS, 12000);
    // S4PREP silent-timeout fix (2026-10-28): journal stage lines.
    // progress() is socket-only, so a pre-send replay in progress
    // was journal-invisible — a hang left no trace at all. Every
    // stage below logs one line (step numbers / ok-fail only, never
    // form values, names, or phone numbers).
    console.log('S4PREP-ANCHOR:', anchor ? 'found' : 'missing');
    let s4prepReplay = null;
    if (!anchor) {
      // Permanent fix (2026-10-26): do NOT fail immediately. Detect
      // the site step once and replay AT MOST ONCE to reach contact.
      // Only when there is no formCtx at all do we keep the old
      // resumable path (fresh session, UI chain replay).
      const det = await this._detectSiteStep();
      console.log('S4PREP-DETECT: step=' + det.step);
      const hasCtx = !!(data.s0 || data.s1 || data.s2 || data.s2b);
      if (det.step === 1 && !hasCtx) {
        resumable = true;
        this.progress('🔄 নতুন সেশন — তথ্যগুলো আবার বসিয়ে ওটিপি পাঠানো হবে…');
        return {
          ok: true, step: 6, otpSent: false, resumable: true, failed: [], blocked: false,
          message: '🔄 তথ্য আবার বসিয়ে ওটিপি পাঠানো হবে — একটু অপেক্ষা করুন।',
        };
      }
      console.log('S4PREP-REPLAY: start step=' + det.step);
      const replay = await this._replayToContact(det.step, data);
      console.log('S4PREP-REPLAY:', replay.ok ? 'ok ' + (replay.replayed || '') : 'fail ' + (replay.reason || ''));
      s4prepReplay = { siteStep: det.step, ok: replay.ok, replayed: replay.replayed || null, reason: replay.reason || null };
      if (replay.ok) {
        anchor = await this._waitVisible(CONTACT_ANCHORS, 12000);
      } else {
        // A step failure can still leave the page on contact (flaky
        // advance check) — one short re-check before failing honestly.
        anchor = await this._waitVisible(CONTACT_ANCHORS, 3000);
      }
    }
    if (!anchor) {
      console.log('S4PREP-ANCHORS-MISSING');
      // "পেজ পাওয়া যায়নি" was a mislabel: it only meant neither
      // contact nor start anchors were visible in 15s. Classify the
      // actual page state (presence only, no values) so the next
      // failure names its cause: docs step, stub page, or hidden fields.
      // Machine-readable code for the frontend: branch on this, never
      // on the Bengali reason text.
      const probe = (s4prepReplay && (await this._detectSiteStep().catch(() => null))?.probe)
        || await this.page.evaluate(() => {
          const vis = (s) => { const e = document.querySelector(s); return !!(e && e.offsetParent !== null); };
          return {
            contact: vis('#email') || vis('#phone'),
            docs: vis('input[name="relationWithApplicant"]') || vis('input[name="files"]'),
            start: vis('#officeBirthplace'),
            form: !!document.querySelector('form'),
            bodyLen: (document.body ? (document.body.innerText || '').length : 0),
          };
        }).catch(() => ({ contact: false, docs: false, start: false, form: false, bodyLen: -1 }));
      const where = probe.docs ? 'কাগজপত্রের ধাপেই আছে (পরবর্তী চাপা হয়নি/আটকেছে)'
        : (!probe.form && probe.bodyLen >= 0 && probe.bodyLen < 100 ? 'খালি/স্টাব পাতা'
        : probe.form ? 'ফরম আছে কিন্তু যোগাযোগের ঘর দেখা যাচ্ছে না' : 'কোনো ধাপের ঘরই দেখা যাচ্ছে না');
      failed.push({ field: 'যোগাযোগ ধাপ', reason: `পেজ পাওয়া যায়নি (${where})`, code: 'CONTACT_ANCHORS_MISSING' });
      if (s4prepReplay && !s4prepReplay.ok && s4prepReplay.reason) {
        failed.push({ field: 'পুনঃচেষ্টা', reason: s4prepReplay.reason, code: 'S4PREP_REPLAY_FAILED' });
      }
    }
    if (anchor && data.email) {
      const r = await this._typeInto(['#email', 'input[name="email"]'], data.email, 'ইমেইল', {});
      if (!r.ok && !r.skipped) failed.push({ field: r.field, reason: r.reason });
    }
    if (anchor && data.phone) {
      const r = await this._typeInto(['#phone', 'input[name="phone"]', 'input[type="tel"]'],
        bnToArab(data.phone), 'মোবাইল নম্বর', { required: true });
      if (!r.ok) failed.push({ field: r.field, reason: r.reason });
      // সাইটের getPhone() সরাসরি #phone.value পড়ে — intl-tel-input স্পেস/ড্যাশ বসালে
      // digitOrPlus/length রুল ফেল করে validateForm() চুপচাপ আটকায় (2026-10-11)।
      // তাই মান নরমালাইজ (শুধু ডিজিট/প্লাস) করে দিই, তারপর ফাঁকা হলে নতুন করে লিখি।
      const normPhone = await this.page.evaluate(() => {
        const el = document.querySelector('#phone');
        if (!el) return { raw: '', clean: '' };
        const raw = String(el.value || '');
        const clean = raw.replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d)).replace(/[^\d+]/g, '');
        if (clean !== raw) {
          el.value = clean;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { raw, clean };
      }).catch(() => ({ raw: '', clean: '' }));
      if (!/\d{4,}/.test(String(normPhone.clean).replace(/[^\d]/g, ''))) {
        await this._typeInto(['#phone', 'input[name="phone"]'], bnToArab(data.phone).replace(/\D/g, ''),
          'মোবাইল নম্বর (পুনঃলিখন)', { typeCharByChar: true });
      }
    }
    // ── cinno-প্রথম (2026-10-11): ওটিপি পাঠানোর *আগেই* নামে cinno-সহ আসল রূপ
    // (hidden join সহ) + name-rule শিথিল — সার্ভারে যাওয়া তথ্যেই cinno থাকে।
    // আটকালে নিচের probe-ফলব্যাক সাথে সাথে cinno বাদ দেয় — নাগরিক আটকাবে না।
    let cinnosPre = [];
    if (anchor) {
      cinnosPre = buildCinnos(fd);
      if (cinnosPre.length) {
        const n = await applyCinnos(this.page, cinnosPre, true);
        const rx = await relaxNameRules(this.page);
        console.log('S4PREP-CINNO-SNEAK:', JSON.stringify({ applied: n + '/' + cinnosPre.length, relax: rx }));
      }
    }
    // ── সাবমিট-পূর্ব যাচাই (probe) + অটো-ফিক্স — সাইটের validateForm() কখনো
    // চুপচাপ আটকায় (না toast, না SMS); এখানেই ধরব ও নিজেরাই সারাব।
    if (anchor) {
      const probe = () => this.page.evaluate(() => {
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
      if (fd.singleName) await relaxEmptyLast(this.page, fd.singleName).catch(() => {});
      let p = await probe();
      console.log('S4-PRE-PROBE:', JSON.stringify(p).slice(0, 300));
      if (p.valid === false) {
        console.log('S4-PROBE-BLOCKED:', JSON.stringify(p));
        const s1 = fd.s1 || {};
        const nmFallback = [s1.firstNameEn, s1.lastNameEn].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
        const fix = await this.page.evaluate((nmFb) => {
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
        await this.page.waitForTimeout(800);
        p = await probe();
      }
      if (p.valid === false && fd.singleName && !fd.gatePassedNames) {
        // ১-নাম: খালি শেষ-নামে সাইটের validateForm() আটকালে — OTP-ধাপ পার হতেই
        // বাধ্য-পূরণ; চূড়ান্ত সাবমিটে আবার খালি করে এক-নাম রেকর্ড রাখার চেষ্টা হবে
        const f = await fillDoubledLast(this.page, fd.s1 || {}, fd.singleName);
        console.log('S4PREP-SINGLE-FORCE-FILL:', f);
        await this.page.waitForTimeout(600);
        p = await probe();
        console.log('S4-PRE-PROBE(after fill):', JSON.stringify(p).slice(0, 200));
      }
      if (p.valid === false && cinnosPre.length) {
        // cinno-র কারণেই আটকেছে — নাগরিক আটকাবে না: cinno বাদ দিয়ে আবার যাচাই
        await applyCinnos(this.page, cinnosPre, false);
        console.log('S4PREP-CINNO-REVERT (validateForm blocked)');
        await this.page.waitForTimeout(400);
        p = await probe();
        console.log('S4-PRE-PROBE(clean):', JSON.stringify(p).slice(0, 300));
      }
      if (p.valid === false) {
        failed.push({ field: 'ফরম যাচাই', reason: `সাইটের নিজস্ব যাচাইয়ে বাকি: ${p.errs.join(' | ') || 'কিছু ঘর অসম্পূর্ণ'}` });
      }
    }
    // ── "ওটিপি পাঠান" ক্লিক + সত্যিকারের প্রমাণ ──
    // OTP-SEND-NET (2026-10-28): the site can fail a send SILENTLY — click ok,
    // no toast, no countdown, button still visible (5× live 2026-10-28) — and
    // the engine previously had no visibility past the click. So the send is
    // now wrapped in a one-shot network tap: the send response (path + status,
    // plus — for a non-2xx ONLY — the site's own error code/message string,
    // truncated; the request query and the full body are never logged) is
    // recorded, and a non-2xx send, or no send request at all, is surfaced
    // in the failure reason.
    if (anchor) {
      const sendBtn = await this._waitVisible(['button:has-text("ওটিপি পাঠান")'], 10000);
      if (!sendBtn) {
        failed.push({ field: 'ওটিপি পাঠান', reason: 'বাটন পাওয়া যায়নি' });
      } else {
        const net = this._tapOtpSendNet();
        const clickedOk = await this._robustClick(sendBtn, 'ওটিপি পাঠান', 8000);
        console.log('S4-SENDOTP-CLICK:', clickedOk ? 'ok' : 'fail');
        let ev;
        try {
          ev = await this._waitOtpEvidence(30000);
        } finally {
          net.detach();
        }
        console.log('OTP-SEND-NET:', JSON.stringify(net.seen).slice(0, 400));
        if (ev.ok) {
          otpSent = true;
          // সাইট কী বলল (মোবাইল/ইমেইল কোথায় পাঠাল) — operator log-এর জন্য
          if (ev.note) console.log('OTP-SITE-MSG:', ev.note);
          this.progress('📲 কোড পাঠানো হয়েছে — হাতে আসা কোড নিচে বসান');
        } else {
          failed.push({ field: 'ওটিপি পাঠান', reason: this._otpSendFailReason(net.seen, ev.reason) });
        }
      }
    }
    await this._dismissNotices();
    return {
      ok: failed.length === 0,
      step: 6, otpSent, resumable,
      // Machine-readable failure code (frontend branches on this):
      // CONTACT_ANCHORS_MISSING = contact anchors still missing after
      // at most one replay; absent on success and on other failures.
      code: !anchor ? 'CONTACT_ANCHORS_MISSING' : undefined,
      s4prepReplay,
      message: otpSent ? '📲 ওটিপি পাঠানো হয়েছে! কোডটি বসিয়ে জমা দিন।'
        : `⚠️ ওটিপি পাঠানো যায়নি — ${failed.length}টি কারণে।`,
      failed,
      blocked: failed.length > 0,
    };
  }

  /**
   * OTP-SEND-NET (2026-10-28): one-shot network tap for the OTP send.
   * Records every otp-ish response seen while attached as { path, status }
   * — the URL path WITHOUT the query (the query carries the phone number
   * and must never be logged). For a non-2xx ONLY, the response body's
   * error message is also captured via _otpSendBodyMsg (the site's own
   * code/message string, truncated; the full body is never kept, and the
   * payload field — which could carry anything — is never read).
   * Detached by the caller after the evidence wait, so repeated resends
   * cannot accumulate taps. Safe on pages without on/off (returns an
   * empty, no-op tap). The body read is best-effort: a missing or
   * unreadable body leaves the entry as path + status alone.
   * OTP-SEND-BODY (2026-10-28): live 400s on /api/otp/sent carry the
   * site's reason only in the response body — status alone cannot name
   * it — so the tap now keeps that message for non-2xx responses.
   */
  _tapOtpSendNet() {
    const seen = [];
    const tap = async (res) => {
      try {
        const u = new URL(res.url());
        if (!/otp/i.test(u.pathname)) return;
        const entry = { path: u.pathname, status: res.status() };
        seen.push(entry);
        if (entry.status < 200 || entry.status >= 300) {
          try {
            const txt = typeof res.text === 'function' ? await res.text() : '';
            const msg = this._otpSendBodyMsg(txt);
            if (msg) entry.msg = msg;
          } catch (_) { /* body unreadable — status alone still stands */ }
        }
      } catch (_) { /* non-URL response — ignore */ }
    };
    if (this.page && typeof this.page.on === 'function') this.page.on('response', tap);
    return {
      seen,
      detach: () => {
        if (this.page && typeof this.page.off === 'function') this.page.off('response', tap);
      },
    };
  }

  /**
   * OTP-SEND-BODY (2026-10-28): extract ONLY the site's own error
   * wording from a non-2xx send response body. The known send shape is
   * { code, message, success, payload } — message (else code) is the
   * server's reason string and carries no OTP or phone number. The
   * payload field is never read. Plain-text bodies are kept as-is.
   * Everything is whitespace-collapsed and truncated to 200 chars.
   * Returns '' when nothing safe and usable is present.
   */
  _otpSendBodyMsg(txt) {
    if (!txt || typeof txt !== 'string') return '';
    const clean = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 200);
    try {
      const j = JSON.parse(txt);
      if (typeof j === 'string') return clean(j);
      if (j && typeof j === 'object') {
        const m = typeof j.message === 'string' ? j.message
          : (typeof j.code === 'string' ? j.code : '');
        return m.trim() ? clean(m) : '';
      }
      return '';
    } catch (_) { /* not JSON — plain text below */ }
    return clean(txt);
  }

  /**
   * OTP-SEND-NET (2026-10-28): map network evidence + the evidence-wait
   * reason to the user-facing failure reason. A non-2xx send names its
   * status — and, when the tap captured one, the site's own error
   * message instead of the generic evidence reason; no send request at
   * all says so plainly; otherwise the evidence-wait reason stands
   * unchanged.
   */
  _otpSendFailReason(netSeen, evReason) {
    const bad = (netSeen || []).find((r) => r.status < 200 || r.status >= 300);
    if (bad) {
      if (bad.msg) return `সাইটের সেন্ড-জবাব: ${bad.status} — ${bad.msg}`;
      return `সাইটের সেন্ড-জবাব: ${bad.status} — ${evReason}`;
    }
    if (!netSeen || netSeen.length === 0) return `ক্লিকের পর সাইট কোনো সেন্ড-রিকোয়েস্টই পাঠায়নি — ${evReason}`;
    return evReason;
  }

  /**
   * OTP পাঠানোর সত্যিকারের প্রমাণ — toast / #otpIntervalText পর্যবেক্ষণ।
   * v1 waitOtpEvidence(ms) থেকে faithful port (this.page ব্যবহার)।
   */
  async _waitOtpEvidence(ms) {
    const deadline = Date.now() + ms;
    let last = { toasts: [], interval: false };
    while (Date.now() < deadline) {
      const st = await this.page.evaluate(() => {
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
      await this.page.waitForTimeout(600);
    }
    console.log('OTP-EVIDENCE-TIMEOUT:', JSON.stringify(last).slice(0, 400));
    return {
      ok: false,
      reason: last.toasts[0] ? `সাইটের বার্তা: ${last.toasts[0].txt}` : 'সাইট কোড পাঠানোর নিশ্চিত প্রমাণ দেয়নি — নম্বর দেখে আবার চেষ্টা করুন',
    };
  }

  async submitS4(data = {}) {
    if (!this.page) {
      this.progress('❌ সংযোগ নেই — আবার চেষ্টা করুন।');
      return { ok: false, message: '❌ সংযোগ নেই — আবার চেষ্টা করুন।' };
    }
    // C-1 fix (2026-10-15): server-side charge enforcement — frontend-এর charge
    // ছাড়া সরাসরি emit করলেও টাকা না কেটে সাবমিট হবে না।
    // Fail-CLOSED (2026-10-26, A-to-Z audit): the old `if (secret)` made
    // a missing secret silently skip the gate. That cannot happen in
    // production — backend/auth.js refuses to start without JWT_SECRET,
    // the adapter spawns this engine with the backend's full env
    // (engines/bdris-apply/index.js), and backend mints with JWT_SECRET
    // while this checks ABC_JWT_SECRET || JWT_SECRET — and free services
    // still get a minted ('free') token, so fail-closed blocks nobody
    // legitimate. verifyChargeToken already returns false on empty
    // secret, so dropping the guard is the whole change here.
    const secret = getJwtSecret();
    if (!verifyChargeToken(data._chargeToken, this.userId, 'submit', secret)) {
      this.progress('❌ পেমেন্ট যাচাই হয়নি — পেজ রিফ্রেশ করে আবার চেষ্টা করুন।');
      return {
        ok: false, blocked: true,
        message: '❌ পেমেন্ট যাচাই হয়নি — পেজ রিফ্রেশ করে আবার চেষ্টা করুন।',
        failed: [{ field: 'পেমেন্ট', reason: 'চার্জ টোকেন যাচাই হয়নি' }],
      };
    }
    if (isSubmitTokenConsumed(data._chargeToken)) {
      this.progress('❌ এই পেমেন্টে ইতিমধ্যে একটি আবেদন জমা হয়েছে — নতুন করে চার্জ করে আবার চেষ্টা করুন।');
      return {
        ok: false, blocked: true,
        message: '❌ এই পেমেন্টে ইতিমধ্যে একটি আবেদন জমা হয়েছে — নতুন করে চার্জ করে আবার চেষ্টা করুন।',
        failed: [{ field: 'পেমেন্ট', reason: 'চার্জ টোকেন ইতিমধ্যে ব্যবহৃত' }],
      };
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
    // Submit-debug (2026-10-26): the old check accepted 7+ digit
    // input and typed it into the 6-digit masked OTP field, where
    // the site would truncate/reject it and fail with a generic
    // message. An OTP is exactly 6 digits — anything else is a
    // wrong user input and fails here, clearly, before any submit.
    if (otp.length !== 6) {
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
    // Parent-BRN parallel branch (2026-10-29, point 8) — cinno /
    // single-name রিট্রাইগুলো ছোঁয়া হয়নি; এটা তার পাশে
    // আলাদা শাখা। সাবমিট-ভুলে ubrn/পিতা/মাতা থাকলে landed
    // মান একবার মিলিয়ে দেখি (উপস্থিতি-মাত্র লগে)। শুধু
    // ২০১৩-পূর্ব বা পারিবারিক-ভুলের ক্ষেত্রে সাইট-নিয়মের
    // নাম-মাত্র চেষ্টা (BRN ঘর খালি করে, cinno-স্নিক-সহ আবার
    // সাবমিট — নাম বদলানো হয় না); অন্য ক্ষেত্রে BRN
    // বদলানো/আবার পাঠানো নয়, সাইটের আসল ভুল-বার্তাই
    // নিচের ব্যর্থতায় ফিরবে। একই rejected সাবমিট জোর করে
    // আবার পাঠানো হয় না।
    let s4BrnNote = null;
    const s4BrnAction = parentBrnSubmitAction(post.errs, fd.s1.dob || data.applicantDob || this.applicantDob);
    if (!post.succ && s4BrnAction && s4BrnAction !== 'surface-only') {
      const landedF = await this._readParentLanded('father');
      const landedM = await this._readParentLanded('mother');
      console.log(`S4-PARENT-BRN-LANDED father-brn=${landedF.brn === null ? 'unknown' : (landedF.brn ? 'present' : 'empty')} mother-brn=${landedM.brn === null ? 'unknown' : (landedM.brn ? 'present' : 'empty')}`);
      const noteS4 = s4BrnAction === 'brn-exempt-names-only' ? (parentBrnExemptNote(fd.s1.dob || data.applicantDob || this.applicantDob) || PARENT_BRN_PRE2013_NOTE) : PARENT_BRN_FAMILY_NOTE;
      this.progress('🔁 পিতামাতার BRN-ভুলে সাইট-নিয়মের চেষ্টা — BRN ছাড়াই (নাম দিয়ে) আবার সাবমিট করা হচ্ছে…');
      await this._clearParentBrnFields();
      const otpNow3 = await this.page.evaluate(() => {
        const el = document.querySelector('#otp, input[name="otp"]');
        return el ? el.value : '';
      }).catch(() => '');
      if (!String(otpNow3 || '').replace(/\D/g, '')) {
        await this._typeInto(otpSels, otp, 'OTP কোড', { required: true, typeCharByChar: true });
      }
      post = await clickSubmit(true);
      if (post.succ) {
        s4BrnNote = noteS4;
        this.progress('✔ সাবমিট গৃহীত হয়েছে (' + noteS4 + ')');
      } else {
        this.progress('⚠ সাইটের উত্তর এখনো আসেনি — অপেক্ষা করা হচ্ছে…');
      }
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
    // ("আবেদনপত্র নম্বর : 265370215")। তাই পুরো পাতার টেক্সট থেকেও নম্বর খোঁজা হয় —
    // কিন্তু শুধু লেবেল-যুক্ত বা ১৭-ডিজিট নম্বরই সাফল্যের প্রমাণ (extractAckNumber);
    // যেকোনো ৭–১২ ডিজিটের সংখ্যা আর প্রমাণ নয়।
    try {
      const liveNum = await this.page.evaluate(() => {
        const body = document.body.innerText || '';
        let m = body.match(/আবেদন(?:পত্র)?\s*নম্বর\s*[:：]?\s*([\d\u09E6-\u09EF]{4,20})/);
        if (!m) m = body.match(/\b\d{17}\b/);
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
      brnNote: s4BrnNote || undefined,
    });

    // আসল PDF prefetch-এর জন্য rec — fetch subsystem (FETCH_ORIGINAL migration)
    // এটিকে ব্যবহার করবে; v2 handler নিজে background fetcher চালায় না।
    let originalRec = null;
    try { originalRec = buildOriginalRec(fd, ackNum); } catch { /* ঐচ্ছিক */ }

    // Clean success point ONLY: the token is consumed here, after the
    // site accepted the submission (sawSuccess + ack above) — never on
    // attempt, so OTP retries after a failed submit keep their token.
    consumeSubmitToken(data._chargeToken);

    return {
      ok: true, completed: true, step: 7, blocked: false,
      message: '🎉 BDRIS আবেদন সফলভাবে জমা হয়েছে!',
      ackId: ackText, ackNum, screenshot,
      pdf: pdf ? { name: pdf.name, bytes: pdf.base64.length } : null,
      originalRec,
      failed: [],
      brnNote: s4BrnNote || undefined,
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

  /**
   * S0-RADIO-SETTLE (2026-10-28): visible first-step control descriptors
   * for the radio-not-found diagnostic — tag + type + id + name ONLY.
   * Values and text are never read (they could carry personal data), and
   * hidden elements are skipped. Never throws: any failure yields [].
   */
  async _visibleFirstStepControls() {
    try {
      const seen = await this.page.evaluate(() => {
        const out = [];
        document.querySelectorAll('input, button').forEach((el) => {
          if (el.offsetParent === null) return;
          const tag = (el.tagName || '').toLowerCase();
          const type = el.getAttribute('type') || '';
          if (tag === 'input' && type !== 'radio' && type !== 'checkbox') return;
          out.push({ tag, type, id: el.id || '', name: el.getAttribute('name') || '' });
        });
        return out.slice(0, 20);
      });
      return Array.isArray(seen) ? seen : [];
    } catch (_) {
      return [];
    }
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
  // Attachment-availability modal — ported from v1 handleAttachmentModal
  // (live-verified): the site shows it after DOB when the applicant is
  // 45+ days old (i.e. nearly every applicant). Shown + docs available
  // -> click "আমার কাছে এই ডকুমেন্টগুলি আছে"; shown + docs not
  // available -> fail honestly instead of stalling on Next. No modal
  // text -> no-op. v2 previously had no handling at all.
  async _handleAttachmentModal(docsAvailable = true) {
    let text = '';
    try {
      text = await this.page.evaluate(() => (document.body ? (document.body.innerText || '') : ''));
    } catch { return { ok: true, shown: false }; }
    if (!/অ্যাটাচমেন্ট অ্যাভেইলেবিলিটি চেক/.test(text)) return { ok: true, shown: false };
    if (!docsAvailable) {
      return { ok: false, shown: true, reason: 'প্রয়োজনীয় ডকুমেন্ট হাতে নেই — BDRIS এগোতে দেবে না' };
    }
    const btn = await this._waitVisible(['button:has-text("আমার কাছে এই ডকুমেন্টগুলি আছে")'], 8000);
    if (!btn) {
      return { ok: false, shown: true, reason: 'কাগজপত্র সংক্রান্ত বার্তার "আছে" বাটন পাওয়া যায়নি — আবার চেষ্টা করুন' };
    }
    const clicked = await btn.click({ timeout: 6000 }).then(() => true).catch(() => false);
    if (!clicked) {
      return { ok: false, shown: true, reason: 'কাগজপত্র সংক্রান্ত বার্তার বাটনে ক্লিক হয়নি — আবার চেষ্টা করুন' };
    }
    await this.page.waitForTimeout(1200).catch(() => {});
    return { ok: true, shown: true };
  }

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
  async _selectFirstMatch(selector, candidates, label, value) {
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
    // Phase 1 (2026-10-27): value-first (geo id) — spelling-proof.
    // Falls through to the text candidates below when absent.
    if (value != null && String(value) !== '') {
      const byVal = await this.navigator.selectOptionByValue(selector, String(value));
      if (byVal) {
        await this.page.waitForTimeout(1100);
        this.progress(`✔ ${label} (আইডি দিয়ে মিলেছে)`);
        return { ok: true };
      }
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

  // Parent-BRN landed re-read (2026-10-29, point 3): ঘরে কী
  // বসেছে শুধু উপস্থিতি-মাত্র জানি — মান কখনো লগে বা
  // রেজাল্টে যায় না (নাম/BRN-মান লগ করা নিষেধ)।
  async _readParentLanded(p) {
    const sels = {
      brn: [`#${p}Brn`, `input[name="personInfoForBirth.${p}.ubrn"]`],
      dob: [`#${p}BirthDate`, `input[name="personInfoForBirth.${p}.personBirthDate"]`],
    };
    try {
      const vals = await this.page.evaluate((s) => {
        const out = {};
        for (const [k, list] of Object.entries(s)) {
          let v = null;
          for (const sel of list) { const el = document.querySelector(sel); if (el) { v = el.value || ''; break; } }
          out[k] = v;
        }
        return out;
      }, sels);
      return {
        brn: vals && typeof vals.brn === 'string' ? vals.brn : null,
        dob: vals && typeof vals.dob === 'string' ? vals.dob : null,
      };
    } catch {
      return { brn: null, dob: null };
    }
  }

  // Parents fields gone = site advanced past parents (the same
  // proof the Step-3 tail uses). Used by the family advance branch
  // so a leftover error text cannot block an advanced page.
  async _parentsFieldsGone() {
    try {
      return !(await this._waitVisible(
        ['#fatherBrn', 'input[name="personInfoForBirth.father.ubrn"]'], 1500));
    } catch {
      return false;
    }
  }

  // Parent-BRN site-rule clear (2026-10-29, points 5+8; 2026-10-29
  // family-advance follow-up): শুধু BRN ঘর খালি করে — নাম/
  // জাতীয়তা/জন্ম তারিখ ছোঁয়া হয় না, ড্রাফটের BRN-ও বদলায় না
  // (সাইট-ফর্ম থেকেই শুধু সরে)। Returns true only when both BRN
  // fields are actually empty afterwards (or gone — the page
  // advanced); a silent failed fill no longer passes as cleared.
  // Presence only in logs, never values.
  async _clearParentBrnFields() {
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const pp of ['father', 'mother']) {
        const el = await this._waitVisible([`#${pp}Brn`, `input[name="personInfoForBirth.${pp}.ubrn"]`], 2500).catch(() => null);
        if (el) await el.fill('').catch(() => {});
      }
      const landedF = await this._readParentLanded('father');
      const landedM = await this._readParentLanded('mother');
      const fClear = landedF.brn === '' || landedF.brn === null;
      const mClear = landedM.brn === '' || landedM.brn === null;
      console.log(`FAMILY-BRN-CLEARED attempt=${attempt} father=${landedF.brn === null ? 'unknown' : (fClear ? 'empty' : 'present')} mother=${landedM.brn === null ? 'unknown' : (mClear ? 'empty' : 'present')}`);
      if (fClear && mClear) return true;
    }
    return false;
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

  // 2013-gate relax (see relaxParentBrnGate): only when the
  // applicant DOB held by THIS handler is in the exempt range.
  // A non-exempt applicant is never relaxed, and a missing DOB
  // never relaxes (isParentBrnExempt('') is false).
  async _relaxParentBrnGate() {
    if (!isParentBrnExempt(this.applicantDob)) return 'skip';
    return relaxParentBrnGate(this.page);
  }

  // Best-effort read of the applicant DOB AS HELD ON THE SITE PAGE
  // (the value the server's age/verify logic actually keys off).
  // Returns an ISO date, or null when the field is not in the DOM
  // (SPA sections may be hidden) or unparseable — null means
  // "cannot prove", never "assume the draft is right".
  async _readSiteApplicantDob() {
    try {
      const raw = await this.page.evaluate(() => {
        const el = document.querySelector('input[name="personInfoForBirth.personBirthDate"]');
        return el ? (el.value || '') : '';
      });
      return parseSiteDateToIso(raw);
    } catch { return null; }
  }

  // "পরবর্তী" — visible বাটন খুঁজে, enabled যাচাই করে ক্লিক
  async _clickNextAndWait(label, opts = {}) {
    // ১-নাম: প্রতিটি ধাপের "পরবর্তী"-র আগে required-রুল শিথিল রাখি
    if (this.singleName && (this.singleName.bn || this.singleName.en)) {
      await this._relaxEmptyLast().catch(() => {});
    }
    // 2013-gate: same shape — before EVERY Next click, re-relax the
    // parent ubrn/personBirthDate required rules for an exempt
    // applicant, in case the site re-applied them (a replay or a
    // later step command revisits the parents page). Non-exempt
    // applicants and missing DOB are never relaxed.
    if (isParentBrnExempt(this.applicantDob)) {
      await this._relaxParentBrnGate().catch(() => {});
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
  // সাইটের পেজ থেকে একটি ঠিকানা সেকশনের মান পড়া: সিলেক্টের
  // নির্বাচিত অপশনের লেখা + ইনপুটের মান। কপি-চেকবক্স কাজ না
  // করলে এই মান দিয়েই লক্ষ্য সেকশন সরাসরি বসানো হয়।
  async _readAddressFromPage(prefix) {
    return this.page.evaluate((pre) => {
      const selText = (n) => {
        const e = document.querySelector(`select[name="${pre}${n}"]`);
        if (!e || !e.options || e.selectedIndex < 0) return '';
        const t = String(e.options[e.selectedIndex].text || '').trim();
        return /^---/.test(t) ? '' : t;
      };
      const inp = (n) => {
        const e = document.querySelector(`input[name="${pre}${n}"]`);
        return e ? String(e.value || '').trim() : '';
      };
      const cityWard = selText('WardInCityCorp');
      const union = selText('PaurasavaOrUnion');
      return {
        country: selText('Country') || 'বাংলাদেশ',
        division: selText('Div'),
        district: selText('Dist'),
        cityCorpUpazila: selText('CityCorpCantOrUpazila'),
        paurasavaUnion: cityWard || union,
        ward: selText('WardInPaurasavaOrUnion'),
        postOfficeBn: inp('PostOfc'),
        postOfficeEn: inp('PostOfcEn'),
        postCode: inp('PostCode'),
        villageBn: inp('VilAreaTownBn'),
        villageEn: inp('VilAreaTownEn'),
        houseRoadBn: inp('HouseRoadBn'),
        houseRoadEn: inp('HouseRoadEn'),
      };
    }, prefix).catch(() => ({}));
  }

  // Phase 1 (2026-10-27): S1 stale-fail fix (S2-র advance-নিয়মের আদলে)।
  // Site পরের ধাপে গেছে (parents anchor দেখা গেছে) অথচ failed[]-এ
  // প্রথম _fillAddressSection-এর ক্ষণস্থায়ী miss রয়ে গেছে — UI
  // আগেই এগিয়ে গেছে বলে late ack-এ পুরনো ভুল প্যানেল দেখায়।
  // শুধু ঠিকানা-ফিল্ডগুলো page থেকে আবার পড়ে যাচাই করি: যেটা
  // এখন ঠিকমতো বসেছে সেটা বাদ, আসলেই ভুলটা থাকে।
  async _dropStaleAddressFailures(prefix, data, failed) {
    const FIELD_MAP = [
      ['দেশ', 'Country', null, data.country || 'বাংলাদেশ', false],
      ['বিভাগ', 'Div', null, data.division, false],
      ['জেলা', 'Dist', null, data.district, false],
      ['সিটি কর্পোরেশন/উপজেলা', 'CityCorpCantOrUpazila', null, data.cityCorpUpazila, false],
      ['অঞ্চল', 'WardInCityCorp', 'PaurasavaOrUnion', data.paurasavaUnion, false],
      ['পৌরসভা/ইউনিয়ন', 'PaurasavaOrUnion', null, data.paurasavaUnion, false],
      ['ওয়ার্ড', 'WardInPaurasavaOrUnion', 'WardInCityCorp', data.ward, false],
      ['ডাকঘর (বাংলা)', 'PostOfc', null, data.postOfficeBn || data.postBn, true],
      ['ডাকঘর (ইংরেজি)', 'PostOfcEn', null, data.postOfficeEn || data.postEn, true],
      ['পোস্ট কোড', 'PostCode', null, data.postCode, true],
      ['গ্রাম/পাড়া/মহল্লা', 'VilAreaTownBn', null, data.villageBn || data.vilBn, true],
      ['গ্রাম/পাড়া/মহল্লা (ইংরেজি)', 'VilAreaTownEn', null, data.villageEn || data.vilEn, true],
      ['বাসা ও সড়ক (বাংলা)', 'HouseRoadBn', null, data.houseRoadBn || data.houseBn, true],
      ['বাসা ও সড়ক (ইংরেজি)', 'HouseRoadEn', null, data.houseRoadEn || data.houseEn, true],
    ];
    const actual = await this.page.evaluate((pre) => {
      const out = {};
      const selText = (n) => {
        const e = document.querySelector(`select[name="${pre}${n}"]`);
        if (!e || !e.options || e.selectedIndex < 0) return '';
        const t = String(e.options[e.selectedIndex].text || '').trim();
        return /^---/.test(t) ? '' : t;
      };
      const inp = (n) => {
        const e = document.querySelector(`input[name="${pre}${n}"]`);
        return e ? String(e.value || '').trim() : '';
      };
      for (const n of ['Country', 'Div', 'Dist', 'CityCorpCantOrUpazila', 'WardInCityCorp', 'PaurasavaOrUnion', 'WardInPaurasavaOrUnion']) out['S:' + n] = selText(n);
      for (const n of ['PostOfc', 'PostOfcEn', 'PostCode', 'VilAreaTownBn', 'VilAreaTownEn', 'HouseRoadBn', 'HouseRoadEn']) out['I:' + n] = inp(n);
      return out;
    }, prefix).catch(() => null);
    if (!actual) return 0;
    // Strict loose equality only (dots/dashes/commas/danda/spaces
    // stripped) — includes-matching would wrongly drop real mismatches
    // (e.g. want "ওয়ার্ড - 7", got "ওয়ার্ড - 71").
    const loose = (s) => String(s || '').replace(/[\.\-\u2010-\u2015,\u0964]/g, '').replace(/\s+/g, '');
    const kept = [];
    let dropped = 0;
    for (const f of failed) {
      const m = FIELD_MAP.find(([lbl]) => lbl === f.field);
      if (!m) { kept.push(f); continue; }
      const [, primary, alt, want, isInput] = m;
      if (!want) { kept.push(f); continue; }
      const got = isInput ? (actual['I:' + primary] || '')
        : (actual['S:' + primary] || (alt ? actual['S:' + alt] || '' : ''));
      if (got && loose(got) === loose(want)) { dropped++; continue; }
      kept.push(f);
    }
    if (dropped) {
      failed.splice(0, failed.length, ...kept);
      this.progress(`↻ ধাপ ২: ${dropped}টি পুরনো ভুল বাদ দেওয়া হলো (সাইটে ঠিকমতো বসেছে)`);
    }
    return dropped;
  }

  // Phase 2 (2026-10-27): S1 stale name-fail fix — the name
  // counterpart of _dropStaleAddressFailures. The FIRST read-back
  // in submitS1 uses strict equality (actual !== want), while
  // fillInput's own check passes on ANY non-empty value — so a
  // site-mangled or cascade-cleared name that is later present in
  // equivalent form still leaves a 'সাইটে নাম ঠিকমতো বসেনি' entry
  // in the S1 ack, which the optimistic UI then paints as a late
  // panel on step 4. Names are re-validated BEFORE Next (unlike
  // addresses, which are re-checked after the parents anchor):
  // after Next the person fields may no longer be on the page, so
  // a post-Next read-back would see '' and drop nothing. Only the
  // exact read-back reason is dropped, and only on strict loose
  // equality (dots/dashes/commas/danda/spaces stripped, case-insensitive,
  // same key as addresses) — a genuine mismatch (wrong name, near-miss,
  // empty field) is KEPT, because that is a real data-quality
  // issue, not display staleness. A pure case difference is DROPPED:
  // live journal capture 2026-10-27 proved the site itself uppercases
  // English names (want Demo/Test, site holds DEMO/TEST), so case
  // alone is display form, not a different name.
  async _dropStaleNameFailures(data, failed) {
    const NAME_MAP = [
      ['নামের প্রথম অংশ (বাংলা)', 'personFirstNameBn', data.firstNameBn],
      ['নামের শেষ অংশ (বাংলা)', 'personLastNameBn', data.lastNameBn],
      ['First Name (English)', 'personFirstNameEn', data.firstNameEn],
      ['Last Name (English)', 'personLastNameEn', data.lastNameEn],
    ];
    const actual = await this.page.evaluate(() => {
      const g = (id, namePart) => {
        let el = document.querySelector(id);
        if (!el) el = document.querySelector(`input[name*="${namePart}"]`);
        return el ? String(el.value || '') : '';
      };
      return {
        personFirstNameBn: g('#personFirstNameBn', 'personFirstNameBn'),
        personLastNameBn: g('#personLastNameBn', 'personLastNameBn'),
        personFirstNameEn: g('#personFirstNameEn', 'personFirstNameEn'),
        personLastNameEn: g('#personLastNameEn', 'personLastNameEn'),
      };
    }).catch(() => null);
    if (!actual) return 0;
    const loose = (s) => String(s || '').replace(/[\.\-\u2010-\u2015,\u0964]/g, '').replace(/\s+/g, '').toLowerCase();
    const READBACK_REASON = 'সাইটে নাম ঠিকমতো বসেনি — আবার চেষ্টা করুন';
    const kept = [];
    let dropped = 0;
    for (const f of failed) {
      const m = NAME_MAP.find(([lbl]) => lbl === f.field);
      if (!m || f.reason !== READBACK_REASON) { kept.push(f); continue; }
      const [, key, rawWant] = m;
      const want = transitName(rawWant);
      const got = actual[key] || '';
      if (want && got && loose(got) === loose(want)) { dropped++; continue; }
      kept.push(f);
    }
    if (dropped) {
      failed.splice(0, failed.length, ...kept);
      this.progress(`↻ ধাপ ২: ${dropped}টি পুরনো নামের ভুল বাদ দেওয়া হলো (সাইটে ঠিকমতো বসেছে)`);
    }
    return dropped;
  }

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
    if (hasCountry) keep(await this._selectFirstMatch(countrySels, [d.country || 'বাংলাদেশ'], 'দেশ', d.countryId));
    keep(await this._selectFirstMatch([`#${prefix}Div`, `select[name="${prefix}Div"]`], [d.division], 'বিভাগ', d.divisionId));
    await this.navigator.waitForOptions(`select[name="${prefix}Dist"]`, 8000);
    keep(await this._selectFirstMatch([`#${prefix}Dist`, `select[name="${prefix}Dist"]`], [d.district], 'জেলা', d.districtId));
    await this.navigator.waitForOptions(`select[name="${prefix}CityCorpCantOrUpazila"]`, 8000);
    keep(await this._selectFirstMatch([`#${prefix}CityCorpCantOrUpazila`, `select[name="${prefix}CityCorpCantOrUpazila"]`],
      [d.cityCorpUpazila], 'সিটি কর্পোরেশন/উপজেলা', d.cityCorpUpazilaId));
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
        keep(await this._selectFirstMatch(cityWard, unionCandidates(d.paurasavaUnion), 'অঞ্চল', d.paurasavaUnionId));
      } else {
        if (!(await hasOpts(unionSlot))) await this.navigator.waitForOptions(`select[name="${prefix}PaurasavaOrUnion"]`, 8000);
        keep(await this._selectFirstMatch(unionSlot, unionCandidates(d.paurasavaUnion), 'পৌরসভা/ইউনিয়ন', d.paurasavaUnionId));
      }
    }
    if (d.ward) {
      if (cityCorp) {
        // অঞ্চল বাছার পর ওয়ার্ড-তালিকা অ্যাসিন্ক আসে — অপেক্ষা করে বসাই
        if (!(await hasOpts(unionWard))) await this.navigator.waitForOptions(`select[name="${prefix}WardInPaurasavaOrUnion"]`, 8000);
        if (await hasOpts(unionWard)) keep(await this._selectFirstMatch(unionWard, wardCandidates(d.ward), 'ওয়ার্ড', d.wardId));
        else if (await hasOpts(cityWard)) keep(await this._selectFirstMatch(cityWard, wardCandidates(d.ward), 'ওয়ার্ড', d.wardId));
        else keep({ ok: false, field: 'ওয়ার্ড', reason: `"${d.ward}" অপশনের তালিকা আসেনি` });
      } else {
        if (!(await hasOpts(unionWard))) await this.navigator.waitForOptions(`select[name="${prefix}WardInPaurasavaOrUnion"]`, 6000);
        if (await hasOpts(unionWard)) keep(await this._selectFirstMatch(unionWard, wardCandidates(d.ward), 'ওয়ার্ড', d.wardId));
        else if (await hasOpts(cityWard)) keep(await this._selectFirstMatch(cityWard, wardCandidates(d.ward), 'ওয়ার্ড', d.wardId));
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

module.exports = { StepHandler, verifyChargeToken, bnToArab, thChildSite, consumeSubmitToken, isSubmitTokenConsumed, extractAckNumber, normalizeBrn, brnWarning, isFamilyErrorText, parentBrnSubmitAction, isParentBrnExempt, parentBrnExemptNote, PARENT_BRN_PRE2013_NOTE, PARENT_BRN_2013_NOTE, PARENT_BRN_FAMILY_NOTE, relaxParentBrnGate, parseSiteDateToIso, PARENT_GATE_FIELDS };
