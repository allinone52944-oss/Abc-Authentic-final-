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

  test('ভোটার এরিয়া maps to Voter Area (live-log variant)', () => {
    const d = buildInputData([
      { label: 'ভোটার এরিয়া', value: 'চট্টগ্রাম-১' },
      { label: 'নাম', value: 'করিম' },
    ]);
    expect(d['Voter Area']).toBe('চট্টগ্রাম-১');
  });

  test('compound slash address labels map to address parts', () => {
    const d = buildInputData([
      { label: 'বাসা/হোল্ডিং', value: 'বাড়ী' },
      { label: 'গ্রাম/রাস্তা', value: 'শ্রীপুর' },
      { label: 'মৌজা/মহল্লা', value: '-' },
      { label: 'ইউনিয়ন/ওয়ার্ড', value: 'শ্রীপুর-খরনদ্বীপ' },
      { label: 'ডাকঘর', value: 'শ্রীপুর - 4364' },
      { label: 'উপজেলা', value: 'বোয়ালখালী' },
    ]);
    const p = d['Present Address'];
    expect(p.holding).toBe('বাড়ী');
    expect(p.village).toBe('শ্রীপুর');
    expect(p.union_ward).toBe('শ্রীপুর-খরনদ্বীপ');
    expect(p.post_office).toBe('শ্রীপুর - 4364');
    expect(p.upozila).toBe('বোয়ালখালী');
  });

  test('a second address block without headings fills the permanent address', () => {
    const block = (post) => ([
      { label: 'ডাকঘর', value: post },
      { label: 'উপজেলা', value: 'বোয়ালখালী' },
      { label: 'জেলা', value: 'চট্টগ্রাম' },
    ]);
    const d = buildInputData([...block('ক - 1000'), ...block('খ - 2000')]);
    expect(d['Present Address'].post_office).toBe('ক - 1000');
    expect(d['Permanent Address'].post_office).toBe('খ - 2000');
    expect(d['Permanent Address'].district).toBe('চট্টগ্রাম');
  });

  test('portal placeholders (--, N/A) are dropped, not treated as data', () => {
    const d = buildInputData([
      { label: 'জাতীয় পরিচয়পত্র নম্বর', value: '--' },
      { label: 'নাম (বাংলা)', value: 'মোঃ করিম' },
      { label: 'জন্ম তারিখ', value: '1990-01-01' },
      { label: 'পিন নম্বর', value: 'N/A' },
      { label: 'স্বামী/স্ত্রীর নাম', value: '--' },
    ]);
    // A '--' National ID used to look "present", which silently
    // disabled every fallback (login name, official PDF) and
    // printed '--' with a 'NID:--' QR (2026-10-24 live case).
    expect(d['National ID']).toBeUndefined();
    expect(d['Pin']).toBeUndefined();
    expect(d['Spouse Name']).toBeUndefined();
    expect(hasCoreData(d)).toBe(true);
  });

  test('missing core fields still fail hasCoreData', () => {
    const d = buildInputData([{ label: 'পেশা', value: 'কৃষক' }]);
    expect(hasCoreData(d)).toBe(false);
  });
});
