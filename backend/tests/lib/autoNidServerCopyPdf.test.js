'use strict';

// The SV Copy Premium output is the NIDW portal "Server Copy" itself.
// Fake data only — never a real person's details.
const { buildAutoNidReportPdf, birthDayBn, ageBn, serverCopyQrPayload } = require('../../lib/autoNidReportPdf');

const record = {
  nationalId: '1234567890',
  pin: '12345678901234567',
  dateOfBirth: '1990-05-15',
  nameBn: 'আব্দুল করিম',
  nameEn: 'Abdul Karim',
  fatherName: 'মোঃ রহিম উদ্দিন',
  motherName: 'ফাতেমা বেগম',
  gender: 'Male',
  religion: 'Islam',
  oldNid: '9876543210',
  voterArea: 'ঢাকা',
  birthPlace: 'ঢাকা',
  presentAddress: 'বাসা/হোল্ডিং: ১২৩, গ্রাম/রাস্তা: মিরপুর, ডাকঘর: মিরপুর - ১২১৬, জেলা: ঢাকা, বিভাগ: ঢাকা',
  permanentAddress: 'বাসা/হোল্ডিং: ১২৩, গ্রাম/রাস্তা: মিরপুর, ডাকঘর: মিরপুর - ১২১৬, জেলা: ঢাকা, বিভাগ: ঢাকা',
};

describe('server copy premium output', () => {
  test('weekday of the date of birth, in Bengali', () => {
    expect(birthDayBn('1952-01-01')).toBe('মঙ্গলবার');
    expect(birthDayBn('1990-05-15')).toBe('মঙ্গলবার');
    expect(birthDayBn('not-a-date')).toBe('');
    expect(birthDayBn('')).toBe('');
  });

  test('age at generation time, in Bengali digits', () => {
    expect(ageBn('1952-01-01', new Date('2026-11-25T00:00:00Z'))).toBe('৭৪ বছর, ১০ মাস, ২৪ দিন');
    expect(ageBn('1990-05-15', new Date('2026-11-28T00:00:00Z'))).toBe('৩৬ বছর, ৬ মাস, ১৩ দিন');
    expect(ageBn('')).toBe('');
  });

  test('QR payload is name, PIN and date of birth joined by ⇋', () => {
    expect(serverCopyQrPayload(record)).toBe('Abdul Karim⇋12345678901234567⇋1990-05-15');
    expect(serverCopyQrPayload({ ...record, pin: '' })).toBe('Abdul Karim⇋1234567890⇋1990-05-15');
  });

  test('premium build returns a one-page server-copy PDF', async () => {
    const pdf = await buildAutoNidReportPdf({ type: 'premium', label: 'SV Copy Premium', record });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // Text content is verified by the side-by-side render against the
    // template and by decoding the embedded QR (see the branch notes).
    expect(pdf.length).toBeGreaterThan(100_000);
  });

  test('non-premium build still returns a report PDF', async () => {
    const pdf = await buildAutoNidReportPdf({ type: 'backup', label: 'Server Copy (SV Backup)', record });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
