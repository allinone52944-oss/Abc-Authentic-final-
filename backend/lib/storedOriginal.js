// Stored original Form-1 PDFs (past-applications list, 2026-11-07).
//
// The engine's OriginalFetcher writes a submitted application's
// original PDF to the repo frontend dir as
//   frontend/bdris-original-<digits>.pdf
// where <digits> is the digits-only ack number (its keyOf rule).
// This module is the ONE place that knows that filename rule, so
// the download route and the History wiring can never drift apart.
//
// A re-download of one's own already-paid copy needs NO new
// charge: the originalPdfGate already allows exactly that
// (owner + server record + original_pdf_available flag). This
// module only answers "is the stored copy retrievable" — the
// entitlement check stays in the route / gate.
'use strict';

const fs = require('fs');
const path = require('path');

// Mirror of the engine OriginalFetcher MIN_PDF_BYTES (8000): a
// file at/below that is not a real fetched PDF (truncated write).
const MIN_ORIGINAL_BYTES = 8000;

function originalsDir() {
  return path.join(__dirname, '..', '..', 'frontend');
}

// Digits-only file key for an ack number (engine keyOf rule).
// Empty when the ack carries no digits — such an ack never had a
// stored original file.
function originalFileKey(ackNo) {
  return String(ackNo || '').replace(/\D/g, '');
}

function originalFileName(ackNo) {
  const key = originalFileKey(ackNo);
  return key ? 'bdris-original-' + key + '.pdf' : null;
}

// Absolute path of the stored copy, or null when the ack has no
// file key. The name is built from digits only, so a crafted ack
// can never escape the directory (no traversal).
function storedOriginalPath(ackNo) {
  const name = originalFileName(ackNo);
  return name ? path.join(originalsDir(), name) : null;
}

// True only when the stored copy is a real PDF on disk (exists,
// over the engine's minimum size, %PDF magic). Used by the
// download route (404 otherwise) and by GET /history (a link is
// only offered when the file is actually there — no fake link).
function storedOriginalAvailable(ackNo) {
  const fp = storedOriginalPath(ackNo);
  if (!fp) return false;
  try {
    const st = fs.statSync(fp);
    if (st.size <= MIN_ORIGINAL_BYTES) return false;
    const fd = fs.openSync(fp, 'r');
    const h = Buffer.alloc(4);
    fs.readSync(fd, h, 0, 4, 0);
    fs.closeSync(fd);
    return h[0] === 37 && h[1] === 80 && h[2] === 68 && h[3] === 70; // %PDF
  } catch { return false; }
}

// The History documents entry for a stored original, or null when
// the copy is not retrievable — the row then stays as text-only
// (R1 follow-up #2: no-output records stay, no fake link).
function bdrisOriginalDoc(ackNo) {
  if (!storedOriginalAvailable(ackNo)) return null;
  const key = originalFileKey(ackNo);
  return {
    filename: originalFileName(ackNo),
    originalname: 'আসল-PDF-' + key + '.pdf',
    url: '/api/bdris-apply/applications/' + encodeURIComponent(String(ackNo)) + '/original',
  };
}

module.exports = {
  MIN_ORIGINAL_BYTES,
  originalsDir,
  originalFileKey,
  originalFileName,
  storedOriginalPath,
  storedOriginalAvailable,
  bdrisOriginalDoc,
};
