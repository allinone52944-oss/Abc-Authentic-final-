// Unit tests for the nid-replica core-data gate (blank-card fix,
// audit 2026-11-08 #1). The REAL adapter is required — no Python is
// run: hasCoreData is pure, and the buildCard rejection test stops
// at the gate, before any Python invocation. Fake fixture values
// only — no real PII anywhere in this file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const adapter = require('../../../engines/nid-replica/adapter');

const JOBS_DIR = path.join(__dirname, '../../../engines/nid-replica/work/jobs');

// Fake card fields (slot labels as produced by make_fields.py).
const VALID = {
  'নাম:': 'টেস্ট নাম',
  'Name:': 'TEST NAME',
  'ID NO:': '1234567890',
  'Date of Birth:': '01/01/1990',
  'ঠিকানা:': 'টেস্ট ঠিকানা',
  'প্রদানের তারিখ:': '০৮/১১/২০২৬',
};

describe('hasCoreData (blank-card gate)', () => {
  test('valid fields (name + ID + DOB) → true', () => {
    expect(adapter.hasCoreData(VALID)).toBe(true);
  });

  test('Bangla name only (no English name) → true', () => {
    expect(adapter.hasCoreData({ ...VALID, 'Name:': '' })).toBe(true);
  });

  test('English name only (no Bangla name) → true', () => {
    expect(adapter.hasCoreData({ ...VALID, 'নাম:': '' })).toBe(true);
  });

  test('Pin instead of ID NO → true', () => {
    const f = { ...VALID };
    delete f['ID NO:'];
    f.Pin = '12345678901234567';
    expect(adapter.hasCoreData(f)).toBe(true);
  });

  test('all core fields empty → false (blank extract)', () => {
    expect(adapter.hasCoreData({
      'নাম:': '', 'Name:': '', 'ID NO:': '', 'Date of Birth:': '',
      'ঠিকানা:': '', 'প্রদানের তারিখ:': '০৮/১১/২০২৬',
    })).toBe(false);
  });

  test('issue date alone must NOT pass the gate (it defaults to today)', () => {
    expect(adapter.hasCoreData({ 'প্রদানের তারিখ:': '০৮/১১/২০২৬', 'ঠিকানা:': 'x' })).toBe(false);
  });

  test('missing name → false', () => {
    expect(adapter.hasCoreData({ ...VALID, 'নাম:': '', 'Name:': '' })).toBe(false);
  });

  test('missing ID → false', () => {
    expect(adapter.hasCoreData({ ...VALID, 'ID NO:': '' })).toBe(false);
  });

  test('missing DOB → false', () => {
    expect(adapter.hasCoreData({ ...VALID, 'Date of Birth:': '' })).toBe(false);
  });

  test('whitespace-only values → false', () => {
    expect(adapter.hasCoreData({ 'নাম:': '   ', 'ID NO:': ' ', 'Date of Birth:': '\t' })).toBe(false);
  });

  test('null / non-object → false', () => {
    expect(adapter.hasCoreData(null)).toBe(false);
    expect(adapter.hasCoreData([])).toBe(false);
    expect(adapter.hasCoreData('x')).toBe(false);
  });
});

describe('missingCoreGroups', () => {
  test('blank fields → all three groups listed', () => {
    expect(adapter.missingCoreGroups({})).toEqual(['নাম', 'জাতীয় পরিচয়পত্র নম্বর', 'জন্মতারিখ']);
  });

  test('only DOB missing → just that group', () => {
    expect(adapter.missingCoreGroups({ ...VALID, 'Date of Birth:': '' })).toEqual(['জন্মতারিখ']);
  });
});

describe('buildCard gate (real adapter, no Python)', () => {
  // A temp job dir under the engine's work/jobs, cleaned up after.
  let jobId;
  let dir;
  beforeEach(() => {
    jobId = crypto.randomUUID();
    dir = path.join(JOBS_DIR, jobId);
    fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'work', 'input_data.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dir, '.owner'), 'u1', 'utf8');
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  test('blank fields → NO_CORE_DATA, no output.pdf, no build', async () => {
    const r = await adapter.buildCard(
      jobId,
      { 'নাম:': '', 'Name:': '', 'ID NO:': '', 'Date of Birth:': '' },
      [], 'u1',
    );
    expect(r).toEqual({ ok: false, error: 'NO_CORE_DATA' });
    expect(fs.existsSync(path.join(dir, 'work', 'output.pdf'))).toBe(false);
  });

  test('valid fields pass the gate (build proceeds, not NO_CORE_DATA)', async () => {
    const r = await adapter.buildCard(jobId, VALID, [], 'u1');
    // The gate passed, so the build ran: with system python3 lacking
    // the engine deps this fails as BUILD_FAILED; if deps exist it
    // may succeed. Either way it must NOT be a NO_CORE_DATA rejection.
    expect(r.error).not.toBe('NO_CORE_DATA');
  });
});
