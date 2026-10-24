'use strict';
/**
 * profile-map label robustness — the live portal's wording for
 * the same field varies ('জাতীয় পরিচিতি নম্বর' vs
 * 'জাতীয় পরিচয়পত্র নম্বর', 'নাম (বাংলা)', 'ভোটার নং'…).
 * First live test (2026-10-24) failed PROFILE_INCOMPLETE because
 * the scraped labels matched none of the original exact keys.
 */
const path = require('path');
const { buildInputData, hasCoreData } = require(path.join(__dirname, '..', '..', '..', 'engines', 'nid-server-copy', 'profile-map'));

describe('nid-server-copy profile-map label variants', () => {
  test('নাম (বাংলা) + জাতীয় পরিচিতি নম্বর map to core fields', () => {
    const d = buildInputData([
      { label: 'নাম (বাংলা)', value: 'মোঃ করিম' },
      { label: 'জাতীয় পরিচিতি নম্বর', value: '1234567890' },
    ]);
    expect(d['Name(Bangla)']).toBe('মোঃ করিম');
    expect(d['National ID']).toBe('1234567890');
    expect(hasCoreData(d)).toBe(true);
  });

  test('এনআইডি নম্বর maps to National ID', () => {
    const d = buildInputData([
      { label: 'নাম', value: 'মোঃ করিম' },
      { label: 'এনআইডি নম্বর', value: '1234567890' },
    ]);
    expect(d['National ID']).toBe('1234567890');
    expect(hasCoreData(d)).toBe(true);
  });

  test("father's NID label does NOT become the holder's National ID", () => {
    const d = buildInputData([
      { label: 'পিতার জাতীয় পরিচয়পত্র নম্বর', value: '999' },
      { label: 'নাম (ইংরেজি)', value: 'Karim' },
      { label: 'জাতীয় পরিচয়পত্র নম্বর', value: '111' },
    ]);
    expect(d['National ID']).toBe('111');
    expect(d['NID Father']).toBe('999');
  });

  test('ভোটার নং + পিন satisfy core data with a name', () => {
    const d = buildInputData([
      { label: 'ভোটার নং', value: '555' },
      { label: 'নাম', value: 'করিম' },
      { label: 'পিন', value: '777' },
    ]);
    expect(d['Voter No']).toBe('555');
    expect(d['Pin']).toBe('777');
    expect(hasCoreData(d)).toBe(true);
  });

  test('missing core fields still fail hasCoreData', () => {
    const d = buildInputData([{ label: 'পেশা', value: 'কৃষক' }]);
    expect(hasCoreData(d)).toBe(false);
  });
});
