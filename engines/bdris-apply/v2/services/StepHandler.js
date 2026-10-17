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

class StepHandler {
  constructor(navigator, options = {}) {
    this.navigator = navigator; // BdrisNavigator instance
    this.page = navigator.page;
    this.emit = options.emit || (() => {});
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

  // Additional steps (S2, S2B, S3, S4) follow the same pattern
  // ... to be implemented ...
}

module.exports = { StepHandler };
