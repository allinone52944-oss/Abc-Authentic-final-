// Audit #50 — profile name/phone are prefilled in the order form
// (editable), instead of being typed again on every order.
// (The old manual-submit form had the same prefill; audit #51
// unified that page into the order flow, so the order form is now
// the only prefill surface and is pinned by the describe below.)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('order-create.html — profile prefill (audit #50)', () => {
  const html = read('frontend/order-create.html');

  test('the profile (u.name / u.phone) is used to prefill fields', () => {
    expect(html).toContain('u.name');
    expect(html).toContain('u.phone');
    expect(html).toContain('Profile prefill');
  });

  test('prefill runs after the draft restore, and only fills empty fields (draft wins)', () => {
    const prefill = html.indexOf('Audit #50');
    const draft = html.indexOf('Restore draft safely');
    expect(draft).toBeGreaterThan(-1);
    expect(prefill).toBeGreaterThan(draft);
    expect(html).toContain('if (el.value) return; // draft (or anything typed) wins');
  });

  test('the match is a closed exact-match list — parent names never get the user\'s own name', () => {
    expect(html).toContain("'পিতার নাম'");
    expect(html).toContain("'মাতার নাম'");
    expect(html).toContain('must never receive the user');
    expect(html).toContain('NAME_KEYS');
    expect(html).toContain('PHONE_KEYS');
    expect(html).toContain("'আবেদনকারীর নাম'");
    expect(html).toContain("'মোবাইল নম্বর'");
    // no substring matching anywhere in the prefill block
    const block = html.slice(html.indexOf('Audit #50'), html.indexOf('Auto-save draft on input'));
    expect(block).not.toMatch(/\.includes\(k\)|indexOf\(k\)/);
    expect(block).toContain('keys.includes(k.toLowerCase())');
  });
});

