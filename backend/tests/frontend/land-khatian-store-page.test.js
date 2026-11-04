// Static checks on frontend/land-khatian.html for the
// LIVE-ONLY pivot (2026-11-04): no stored/stale UI, no
// coverage box, no storeEmpty wording on the 502 path.
// (Single-survey only since 2026-11-04: the "সব জরিপ"
// option is gone from the form; the API-level 'all' mode
// still exists but the form never sends it.)
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'frontend', 'land-khatian.html'), 'utf8');

describe('land-khatian page: live-only UI', () => {
  test('no stale banner, no surveysPresent, no stored-survey wording', () => {
    expect(PAGE).not.toContain('id="staleNote"');
    expect(PAGE).not.toContain('surveysPresent');
    expect(PAGE).not.toContain('সংরক্ষিত জরিপ:');
    expect(PAGE).not.toContain('এর বাইরের জরিপ সংরক্ষিত নয়');
  });
  test('no coverage box, no coverage fetch on load', () => {
    expect(PAGE).not.toContain('id="coverageBox"');
    expect(PAGE).not.toContain("apiCall('/api/land-khatian/coverage')");
    expect(PAGE).not.toContain('loadCoverage()');
    expect(PAGE).not.toContain('সংগ্রহের পর্যায়ে');
  });
  test('live-search behaviour: no "সব জরিপ" option anymore (single-survey only); 502 path has no storeEmpty wording', () => {
    expect(PAGE).not.toContain('>সব জরিপ</option>');
    expect(PAGE).not.toContain('storeEmpty');
    expect(PAGE).not.toContain('কোনো সংরক্ষিত তথ্যও এখনো সংগ্রহ হয়নি');
  });
  test('summary disclaimer still states the report is not a certified copy', () => {
    expect(PAGE).toContain('সরকারি সার্টিফাইড কপি নয়');
  });
});
