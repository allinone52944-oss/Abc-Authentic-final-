// Static checks on frontend/land-khatian.html for the
// collection-store UI: stale banner, public coverage box,
// surveysPresent honesty, and the launch-gate wording.
// (Live-search behaviour — including the "সব জরিপ" survey
// option — must stay untouched; the box only clarifies
// that it means survey TYPES, not all-BD coverage.)
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'frontend', 'land-khatian.html'), 'utf8');

describe('land-khatian page: store UI', () => {
  test('stale banner element + surveysPresent handling exist', () => {
    expect(PAGE).toContain('id="staleNote"');
    expect(PAGE).toContain('surveysPresent');
    expect(PAGE).toContain('সংরক্ষিত জরিপ:');
    expect(PAGE).toContain('এর বাইরের জরিপ সংরক্ষিত নয়');
  });
  test('coverage box exists, calls the public endpoint on load, states collection phase + NOT all-BD', () => {
    expect(PAGE).toContain('id="coverageBox"');
    expect(PAGE).toContain("apiCall('/api/land-khatian/coverage')");
    expect(PAGE).toContain('loadCoverage()');
    expect(PAGE).toContain('সংগ্রহের পর্যায়ে');
    expect(PAGE).toContain('সারা-বাংলাদেশ সেবা নয়');
    expect(PAGE).toContain('এখনো কোনো জেলার তথ্য সংগ্রহ হয়নি');
  });
  test('box clarifies live search runs separately and "সব জরিপ" means survey types, not coverage', () => {
    expect(PAGE).toContain('লাইভ অনুসন্ধান এর বাইরে আলাদাভাবে চলে');
    expect(PAGE).toContain('সব ধরনের জরিপ, সারা-বাংলাদেশ সংগ্রহ নয়');
  });
  test('live-search behaviour untouched: "সব জরিপ" option still present; storeEmpty wording on the 502 path', () => {
    expect(PAGE).toContain('>সব জরিপ</option>');
    expect(PAGE).toContain('storeEmpty');
    expect(PAGE).toContain('কোনো সংরক্ষিত তথ্যও এখনো সংগ্রহ হয়নি');
  });
  test('no all-BD claim: the only all-BD phrasing is the negation', () => {
    expect(PAGE).toContain('সারা-বাংলাদেশ সেবা নয়');
    expect(PAGE).not.toContain('সারা-বাংলাদেশ সেবা।');
    expect(PAGE).not.toContain('সারা বাংলাদেশে পাওয়া যাবে');
  });
});
