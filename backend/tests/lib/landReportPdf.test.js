'use strict';
// Audit #13 — the mouza-value report footers label the manual rate
// table (rates come from hand-entered rates.js; no portal schedule
// lookup exists, so no rate was ever checked against the portal).
const { buildLandReportPdf, mouzaFooters } = require('../../lib/landReportPdf');

describe('mouzaFooters', () => {
  test('names the manual rate table and the missing portal verification', () => {
    const f = mouzaFooters();
    const all = f.join('\n');
    expect(all).toContain('ম্যানুয়াল হার-টেবিল');
    expect(all).toContain('সরকারি পোর্টাল থেকে যাচাই করা হয়নি');
    // The original honesty limits are all still there.
    expect(all).toContain('সার্টিফাইড কপি নয়');
    expect(all).toContain('মালিকানা / স্বত্ব / দখলের প্রমাণ নয়');
    expect(all).toContain('বাজারমূল্য নয়');
    expect(all).toContain('চূড়ান্ত দলিল বিল নয়');
    expect(f).toHaveLength(4);
  });

  test('still tells the customer to verify at the sub-registrar office', () => {
    expect(mouzaFooters().join('\n')).toContain('সাব-রেজিস্ট্রার অফিসে মিলিয়ে নিন');
  });
});

describe('buildLandReportPdf (mouza)', () => {
  test('mouza report builds to a valid PDF buffer', async () => {
    const pdf = await buildLandReportPdf({
      kind: 'mouza', ref: 't-1', when: '৩১ অক্টোবর, ২০২৬',
      area: { division: 'Chattogram', district: 'Chattogram', upazila: 'Boalkhali', mouza: 'কধুরখীল', officeName: 'Boalkhali' },
      lines: [{ mouza: 'কধুরখীল', class: 'নাল', rate: 1000, amount: 5, unit: 'shatangsho', qtyShatangsho: 5, value: 5000, source: 'manual' }],
      totalMinimum: 5000, deedBasis: 5000, declaredPrice: null,
      breakdown: { 'নাল': 5000 }, scheduleVersion: '2025-2026',
      hasOldComparison: false, checks: ['যোগফল পুনরায় যোগ করে মিলিয়ে দেখা হয়েছে: 5000 = 5000'],
    });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');
  });
});
