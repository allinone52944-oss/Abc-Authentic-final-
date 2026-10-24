'use strict';
/**
 * engines/nid-server-copy/pdf-id.js
 *
 * Recover the holder's National ID / PIN from the OFFICIAL card
 * PDF the portal itself issued (the download the customer is
 * also offered). The profile page's identity section does not
 * always render its values into the DOM we scrape — but the
 * official PDF always carries the numbers in its text layer.
 *
 * pickIds() is pure and unit-tested; extractIdsFromPdf() dumps
 * the text with the same pymupdf the card pipeline already
 * uses in production.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BN_DIGITS = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };

function toLatinDigits(s) {
  return String(s || '').replace(/[০-৯]/g, (c) => BN_DIGITS[c] || c);
}

/**
 * Pick the National ID and PIN out of free text.
 * PINs are 17 digits; National IDs are 10 (new) or 13 (old).
 * Digit runs may be split by spaces in the PDF text layer.
 */
function pickIds(text) {
  const t = toLatinDigits(text);
  const runs = new Set();
  const re = /\d[\d ]{8,22}\d/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const digits = m[0].replace(/ /g, '');
    if ([10, 13, 17].includes(digits.length)) runs.add(digits);
  }
  const byLen = (n) => [...runs].filter((d) => d.length === n);
  const pin = byLen(17)[0] || null;
  const nid = byLen(10)[0] || byLen(13)[0] || null;
  return { nid, pin };
}

function extractIdsFromPdf(pdfBuffer) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 1000) {
    return { nid: null, pin: null };
  }
  const tmp = path.join(os.tmpdir(), 'nidsc-' + crypto.randomUUID() + '.pdf');
  try {
    fs.writeFileSync(tmp, pdfBuffer);
    const r = spawnSync('python3', [path.join(__dirname, 'extract_pdf_text.py'), tmp], {
      timeout: 30000,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout) return { nid: null, pin: null };
    return pickIds(r.stdout);
  } catch (_) {
    return { nid: null, pin: null };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

module.exports = { pickIds, extractIdsFromPdf, toLatinDigits };
