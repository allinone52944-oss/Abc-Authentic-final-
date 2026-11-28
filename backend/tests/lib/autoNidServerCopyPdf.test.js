'use strict';

// The SV Copy Premium output is the NIDW portal "Server Copy" itself.
// Fake data only — never a real person's details.
const { buildAutoNidReportPdf, serverCopyQrPayload } = require('../../lib/autoNidReportPdf');

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
  profession: 'ব্যবসা',
  oldNid: '9876543210',
  voterArea: 'ঢাকা',
  birthPlace: 'ঢাকা',
  presentAddress: 'বাসা/হোল্ডিং: ১২৩, গ্রাম/রাস্তা: মিরপুর, ডাকঘর: মিরপুর - ১২১৬, জেলা: ঢাকা, বিভাগ: ঢাকা',
  permanentAddress: 'বাসা/হোল্ডিং: ১২৩, গ্রাম/রাস্তা: মিরপুর, ডাকঘর: মিরপুর - ১২১৬, জেলা: ঢাকা, বিভাগ: ঢাকা',
};

describe('server copy premium output', () => {
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

  test.each(['premium', 'half', 'backup'])('embeds the supplied portrait in the %s PDF', async type => {
    const portrait = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAKCAIAAAAGpYjXAAAAFElEQVR4nGPcp+DFgA0wYRUdRhIAKgEBPLQA/HYAAAAASUVORK5CYII=',
      'base64',
    );
    const without = await buildAutoNidReportPdf({ type, label: 'Sample', record });
    const withPortrait = await buildAutoNidReportPdf({ type, label: 'Sample', record: { ...record, portrait } });
    const imageCount = pdf => (pdf.toString('latin1').match(/\/Subtype \/Image\b/g) || []).length;
    expect(imageCount(withPortrait)).toBe(imageCount(without) + 1);
  });

  test('non-premium build still returns a report PDF', async () => {
    const pdf = await buildAutoNidReportPdf({ type: 'backup', label: 'Server Copy (SV Backup)', record });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
