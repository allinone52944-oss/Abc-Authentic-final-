'use strict';
// Audit #10 — "সম্পাদিত" stamp on the NID server-copy PDF.
//
// When the customer edited profile fields, the delivered copy must
// say so (otherwise it reads as an exact official copy). The stamp
// is a red footer line listing the EDITED FIELD LABELS only.
// Unedited output must be byte-identical in spirit: no stamp at all.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildServerCopyPdf } = require('../../lib/serverCopyPdf');

const DATA = {
  'Name(Bangla)': 'মোঃ পরীক্ষা রহমান',
  'Name(English)': 'MD PORIKKHA RAHMAN',
  'Date of Birth': '12/03/1990',
  'National ID': '1234567890',
  'Present Address': 'ঢাকা',
  'Permanent Address': 'ঢাকা',
};

function pdftotextAvailable() {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function pdfText(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srvcopy-'));
  const p = path.join(dir, 'out.pdf');
  fs.writeFileSync(p, buf);
  try {
    return execFileSync('pdftotext', ['-layout', p, '-'], { encoding: 'utf8', timeout: 15000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// pdftotext reorders Bengali vowel signs around conjuncts
// ("সম্পাদিত" comes out as "সম্পািদত"); strip dependent vowel
// signs, the virama and whitespace before comparing Bengali words.
function normBn(s) {
  return String(s).replace(/[া-ৌ্\s]/g, '');
}

describe('buildServerCopyPdf edited stamp (audit #10)', () => {
  test('edited fields -> "সম্পাদিত" line listing the edited labels', async () => {
    if (!pdftotextAvailable()) {
      console.warn('pdftotext missing — skipping stamp assertion');
      return;
    }
    const buf = await buildServerCopyPdf(DATA, null, { editedFields: ['Name(English)', 'Date of Birth'] });
    expect(Buffer.isBuffer(buf)).toBe(true);
    const text = pdfText(buf);
    expect(normBn(text)).toContain(normBn('সম্পাদিত'));
    expect(text).toContain('Name(English)');
    expect(text).toContain('Date of Birth');
  });

  test('no opts / empty editedFields -> no stamp', async () => {
    if (!pdftotextAvailable()) {
      console.warn('pdftotext missing — skipping stamp assertion');
      return;
    }
    for (const opts of [undefined, {}, { editedFields: [] }]) {
      const buf = await buildServerCopyPdf(DATA, null, opts);
      expect(normBn(pdfText(buf))).not.toContain(normBn('সম্পাদিত'));
    }
  });

  test('many edited fields -> first three listed plus a count', async () => {
    if (!pdftotextAvailable()) {
      console.warn('pdftotext missing — skipping stamp assertion');
      return;
    }
    const buf = await buildServerCopyPdf(DATA, null, {
      editedFields: ['Name(English)', 'Date of Birth', 'Father Name', 'Mother Name', 'Blood Group'],
    });
    const text = pdfText(buf);
    expect(normBn(text)).toContain(normBn('সম্পাদিত'));
    expect(text).toContain('Name(English)');
    expect(normBn(text)).toContain(normBn('ও আরও'));
  });
});
