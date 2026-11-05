// PDF stale-line tests: the exact line rendered in a
// store-served PDF (mirrored in the response + banner).
// Full PDF bytes are not text-searchable (embedded Bengali
// font glyphs), so the line helper is tested directly and
// the builder is tested for a valid PDF in both modes.
const { buildKhatianSummaryPdf, staleLine, halSabekRow } = require('../../lib/khatianSummaryPdf');

// Audit #11 — a populated hal-sabek response is UNPROVEN, so the
// row is labelled as unverified, never as confirmed history.
describe('halSabekRow', () => {
  test('label carries the unproven marker; value counts the rows in Bengali digits', () => {
    const r = halSabekRow(3);
    expect(r.label).toContain('হাল-সাবেক');
    expect(r.label).toContain('অপ্রমাণিত');
    expect(r.value).toContain('৩টি রেকর্ড');
  });
  test('zero rows still labels the row (the builder only calls it when rows exist)', () => {
    expect(halSabekRow(0).label).toContain('অপ্রমাণিত');
  });
});

describe('staleLine', () => {
  test('store + date → Bengali stale line with the not-verified wording', () => {
    const line = staleLine('store', '2026-11-02T10:00:00.000Z');
    expect(line).toContain('সংরক্ষিত তথ্য');
    expect(line).toContain('লাইভ পোর্টাল থেকে যাচাই করা হয়নি');
    expect(line).toContain('শেষ আপডেট');
  });
  test('live → null (live PDFs unchanged)', () => {
    expect(staleLine('live', '2026-11-02T10:00:00.000Z')).toBeNull();
  });
  test('store without a date → null', () => {
    expect(staleLine('store', null)).toBeNull();
  });
});

describe('buildKhatianSummaryPdf', () => {
  const base = {
    ref: 't-1', when: '2026-11-03', area: { division: 'Dhaka', district: 'Dhaka', upazila: 'Test', mouza: 'Test Mouza', jl: '33' },
    items: [{ khatianNo: '8', owners: 'Test One', dags: '1237', totalLand: '0.0544', surveyName: 'RS', halSabek: [] }],
    totalLand: 0.0544, totalMatches: 1, capped: false,
  };
  test('live PDF builds to a valid PDF buffer', async () => {
    const pdf = await buildKhatianSummaryPdf(base);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');
  });
  test('store PDF builds to a valid PDF buffer', async () => {
    const pdf = await buildKhatianSummaryPdf({ ...base, source: 'store', collectedAt: '2026-11-02T10:00:00.000Z' });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');
  });
  test('PDF with hal-sabek rows builds (unproven row path)', async () => {
    const pdf = await buildKhatianSummaryPdf({
      ...base,
      items: [{ ...base.items[0], halSabek: [{ id: 1 }, { id: 2 }] }],
    });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');
  });
});
