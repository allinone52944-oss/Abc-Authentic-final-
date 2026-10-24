'use strict';
/**
 * backend/lib/serverCopyPdf.js — NID "server copy" report PDF.
 *
 * The page skeleton comes from the owner's reference sample
 * itself (2026-10-23, on the owner's instruction): the sample
 * PDF's full-page template image — EC banner artwork with logo,
 * the portal search block, the empty five-section table and the
 * page frame — is extracted to assets/server-copy-template.jpg
 * and drawn as the page background at its exact original
 * placement (x26 y0 w561 h786 on a Letter page). Only the
 * citizen's own data is drawn on top, at the exact geometry
 * measured from the sample's text layer:
 *   photo 132/202 65x73, name centred under it (7.5pt bold),
 *   QR 57x57 at (133,304), section titles on the blue bars,
 *   labels x237, values x334 (Latin 8pt / Bengali 9pt),
 *   addresses x232 w268 (lines capped so they can never
 *   overprint the next section), footer lines at the bottom.
 * Fields the profile does not carry show as N/A, exactly like
 * the reference.
 *
 * Fonts follow the receiptPdf lesson: the bundled Noto Sans
 * Bengali has NO Latin glyphs, so a run containing Bengali goes
 * to the Bengali font (digits converted to Bengali digits) and
 * pure Latin runs go to Helvetica.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'assets', 'server-copy-template.jpg');
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toBnDigits = (s) => String(s == null ? '' : s).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);
const hasBn = (s) => /[\u0980-\u09FF]/.test(String(s || ''));

function setFont(doc, text, bold) {
  if (hasBn(text)) {
    try { doc.font(bold ? 'bn-bold' : 'bn'); } catch (_) { doc.font(bold ? 'Times-Bold' : 'Times-Roman'); }
    return toBnDigits(text);
  }
  doc.font(bold ? 'Times-Bold' : 'Times-Roman');
  return String(text == null ? '' : text);
}

function composeAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr.trim();
  const v = (k) => String(addr[k] || '').trim();
  const parts = [];
  if (v('holding')) parts.push('বাসা/হোল্ডিং: ' + v('holding'));
  const villages = [...new Set([v('village'), v('additional_village')].filter(Boolean))];
  if (villages.length) parts.push('গ্রাম/রাস্তা: ' + villages.join(', '));
  const mouzas = [...new Set([v('mouza'), v('additional_mouza')].filter(Boolean))];
  if (mouzas.length) parts.push('মৌজা/মহল্লা: ' + mouzas.join(', '));
  if (v('union_ward')) parts.push('ইউনিয়ন/ওয়ার্ড: ' + v('union_ward'));
  if (v('city_corp')) parts.push('সিটি কর্পোরেশন/পৌরসভা: ' + v('city_corp'));
  const po = v('post_office');
  const pc = v('postal_code');
  if (po && pc) parts.push('ডাকঘর: ' + po + ' - ' + pc);
  else if (po) parts.push('ডাকঘর: ' + po);
  else if (pc) parts.push('ডাকঘর: ' + pc);
  if (v('upozila')) parts.push('উপজেলা: ' + v('upozila'));
  if (v('district')) parts.push('জেলা: ' + v('district'));
  if (v('division')) parts.push('বিভাগ: ' + v('division'));
  return parts.join(', ');
}

function fmtDob(s) {
  const t = String(s || '').trim();
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return t;
}

/** Pixel size of a PNG or JPEG buffer (null when unknown). */
function imageSize(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
        const len = buf.readUInt16BE(i + 2);
        if (!len || len < 2) break;
        i += 2 + len;
      }
    }
  } catch (_) { /* fall through */ }
  return null;
}

const NA = 'N/A';
const val = (data, key) => {
  const x = String((data && data[key]) || '').trim();
  return x || NA;
};

/**
 * @param {object} data  make_fields-compatible input data
 * @param {Buffer|null} photoBuffer
 * @returns {Promise<Buffer>} PDF buffer
 */
async function buildServerCopyPdf(data, photoBuffer) {
  data = data || {};
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, autoFirstPage: true });
  try {
    doc.registerFont('bn', path.join(FONT_DIR, 'NotoSansBengali-Regular.ttf'));
    doc.registerFont('bn-bold', path.join(FONT_DIR, 'NotoSansBengali-Bold.ttf'));
  } catch (_) { /* Bengali runs fall back to Helvetica */ }

  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // ---- Page background: the reference sample's own template -----
  try {
    const tpl = fs.readFileSync(TEMPLATE_PATH);
    doc.image(tpl, 26, 0, { width: 561, height: 786 });
  } catch (_) { /* template missing — text still renders */ }

  // Banner subtitle (overlay text in the reference, yellow serif bold)
  doc.fillColor('#ffdf00').font('Times-Bold').fontSize(10)
    .text('National Identity Registration Wing (NIDW)', 59, 65, { width: 494, align: 'center' });

  // ---- Search-block texts (the template carries only the boxes,
  // buttons and radios; the texts are overlaid, measured from the
  // reference render: pink serif title, green/blue radio labels,
  // red field label, grey placeholder, white button captions) ----
  doc.fillColor('#ff2fa1').font('Times-Bold').fontSize(8)
    .text('Select Your Search Category', 59, 88, { width: 494, align: 'center' });
  doc.fillColor('#007000').font('Times-Roman').fontSize(7)
    .text('Search By NID / Voter No.', 279, 100.5, { width: 200 });
  doc.fillColor('#1a7fb7').font('Times-Roman').fontSize(7)
    .text('Search By Form No.', 279, 117, { width: 200 });
  doc.fillColor('#f00000').font('Times-Bold').fontSize(7)
    .text('NID or Voter No*', 190, 133.5, { width: 85 });
  doc.fillColor('#909090').font('Times-Roman').fontSize(8.5)
    .text('NID', 278, 134.5, { width: 60 });
  doc.fillColor('#ffffff').font('Times-Bold').fontSize(7)
    .text('Home', 522, 92, { width: 27, align: 'center' });
  doc.fillColor('#ffffff').font('Times-Roman').fontSize(8.5)
    .text('Submit', 376, 135.5, { width: 31, align: 'center' });

  // ---- Left column: photo, name, QR (sample placements) ----------
  // Photo box in the reference: x131.8..197.2, y202.4..275.7 —
  // the photo always fills that exact box (cover-crop, centred),
  // whatever the source photo's aspect ratio is.
  if (photoBuffer && Buffer.isBuffer(photoBuffer) && photoBuffer.length > 500) {
    try {
      const box = { x: 132, y: 202, w: 65, h: 73 };
      const sz = imageSize(photoBuffer);
      if (sz && sz.w > 0 && sz.h > 0) {
        const scale = Math.max(box.w / sz.w, box.h / sz.h);
        const dw = sz.w * scale;
        const dh = sz.h * scale;
        doc.save();
        doc.rect(box.x, box.y, box.w, box.h);
        doc.clip();
        doc.image(photoBuffer, box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, { width: dw, height: dh });
        doc.restore();
      } else {
        doc.image(photoBuffer, box.x, box.y, { width: box.w, height: box.h });
      }
    } catch (_) { /* photo slot stays blank */ }
  }
  const nameEn = String(data['Name(English)'] || '').trim();
  if (nameEn) {
    doc.fillColor('#000000').font('Times-Bold').fontSize(7.5)
      .text(nameEn, 94, 286, { width: 141, align: 'center' });
  }
  const nidNo = String(data['National ID'] || '').trim();
  if (nidNo) {
    try {
      const payload = ['NID:' + nidNo, nameEn ? 'Name:' + nameEn : '', data['Date of Birth'] ? 'DOB:' + fmtDob(data['Date of Birth']) : '']
        .filter(Boolean).join('\n');
      // margin 0: in the reference the QR modules fill the whole
      // 57pt box edge to edge (measured x133.2..189.8).
      const qr = await QRCode.toBuffer(payload, { width: 456, margin: 0 });
      doc.image(qr, 133, 304, { width: 57, height: 57 });
    } catch (_) { /* QR is decorative here */ }
  }

  // ---- Right column text over the skeleton (bars at fixed tops) --
  const RX = 232;          // bar left edge (measured)
  const LABEL_X = 237;     // label text x
  const VALUE_X = 334;     // value text x (from the sample text layer)
  const VALUE_W = 167;
  let y = 208;             // first bar top (measured)

  function sectionHeader(title) {
    const t = setFont(doc, title, true);
    doc.fillColor('#000000').fontSize(9).text(t, RX + 5, y + 5, { width: 260 });
    y += 22;
  }
  function row(label, value, boldValue) {
    const lt = setFont(doc, label, false);
    doc.fillColor('#000000').fontSize(9.5).text(lt, LABEL_X, y + 5.5, { width: 94 });
    const vt = setFont(doc, value, !!boldValue);
    doc.fillColor('#000000').fontSize(hasBn(value) ? 9 : 9)
      .text(vt, VALUE_X, y + 6, { width: VALUE_W });
    y += 21;
  }
  function wrapAllLines(text, width) {
    // Word-wrap with the currently-set font/size; returns every
    // line (no cap).
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const trial = cur ? cur + ' ' + w : w;
      if (doc.widthOfString(trial) <= width || !cur) cur = trial;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function ellipsise(line, width) {
    let last = line;
    while (last.length && doc.widthOfString(last + '…') > width) last = last.slice(0, -1);
    return last + '…';
  }
  function addressBlock(title, addrText, maxLines) {
    sectionHeader(title);
    const text = addrText || NA;
    const drawn = setFont(doc, text, false);
    doc.fillColor('#000000');
    // Reference sample: address lines are 8pt (measured from its
    // text layer) — a fixed small size rendered visibly smaller
    // than the sample. Size logic: start at the sample's 8pt and
    // step down only as far as needed for the whole address to
    // fit its fixed box without truncation; ellipsis only as the
    // last resort at the smallest size.
    let lines = null;
    for (const s of [8, 7.5, 7]) {
      doc.fontSize(s);
      const all = wrapAllLines(drawn, 268);
      if (all.length <= maxLines) { lines = all; break; }
    }
    if (!lines) {
      doc.fontSize(7);
      lines = wrapAllLines(drawn, 268).slice(0, maxLines);
      lines[maxLines - 1] = ellipsise(lines[maxLines - 1], 268);
    }
    doc.text(lines.join('\n'), RX, y + 1, { width: 268, lineGap: 1.4 });
    // The skeleton's next bar sits at a fixed position — the
    // caller resets y to that bar's measured top.
  }

  sectionHeader('জাতীয় পরিচিতি তথ্য');
  row('জাতীয় পরিচয় পত্র নম্বর', val(data, 'National ID'));
  row('পিন নম্বর', val(data, 'Pin'));
  row('ভোটার নম্বর', val(data, 'Voter No'));
  row('সিরিয়াল নম্বর', val(data, 'Sl No'));
  row('ভোটার অঞ্চল', val(data, 'Voter Area'));

  y = 335;
  sectionHeader('ব্যক্তিগত তথ্য');
  row('নাম (বাংলা)', val(data, 'Name(Bangla)'), true); // reference: only the holder's own Bengali name is bold (stroke-measured); parents are regular
  row('নাম (ইংরেজি)', val(data, 'Name(English)'));
  row('জন্ম তারিখ', fmtDob(val(data, 'Date of Birth')));
  row('পিতার নাম', val(data, 'Father Name'));
  row('মাতার নাম', val(data, 'Mother Name'));
  row('স্বামী/স্ত্রীর নাম', val(data, 'Spouse Name'));

  y = 483;
  sectionHeader('অন্যান্য তথ্য');
  row('লিঙ্গ', val(data, 'Gender'));
  row('পেশা', val(data, 'Occupation'));
  row('রক্তের গ্রুপ', val(data, 'Blood Group'));
  row('জন্মস্থান', val(data, 'Birth Place'));

  y = 590;
  addressBlock('বর্তমান ঠিকানা', composeAddress(data['Present Address']), 4);
  y = 660;
  addressBlock('স্থায়ী ঠিকানা', composeAddress(data['Permanent Address']), 3);

  // ---- Footer -----------------------------------------------------
  doc.fillColor('#000000').font('Times-Roman').fontSize(10)
    .text("This is Software Generated Report From Bangladesh Election Commission, Signature & Seal Aren't Required.",
      36, 730, { width: 540, align: 'center' });
  const footBn = setFont(doc, 'উপরে প্রদর্শিত তথ্যসমূহ জাতীয় পরিচয়পত্র সংশ্লিষ্ট, ভোটার তালিকার সাথে সরাসরি সম্পর্কযুক্ত নয়।', false);
  doc.fillColor('#f00000').fontSize(8.5)
    .text(footBn, 36, 739, { width: 540, align: 'center' });

  doc.end();
  return done;
}

module.exports = { buildServerCopyPdf, composeAddress };
