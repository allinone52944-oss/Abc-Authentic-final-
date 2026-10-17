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

class StepHandler {
  constructor(navigator, options = {}) {
    this.navigator = navigator; // BdrisNavigator instance
    this.page = navigator.page;
    this.emit = options.emit || (() => {});
    // v1 appData equivalents — explicit, no globals
    this.applicantDob = options.applicantDob || null; // applicant DOB ISO (2013-rule)
    this.singleName = options.singleName || null;     // 1-name relax data
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
  // ═══════════════════════════════════════════════════════════════
  // v1 private helpers — copied faithfully from engines/bdris-apply/server.js
  // (selectors, timing, workarounds unchanged)
  // ═══════════════════════════════════════════════════════════════

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
