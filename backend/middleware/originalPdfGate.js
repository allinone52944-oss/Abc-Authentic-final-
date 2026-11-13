'use strict';

// MONEY/PDF (2026-11-03, cycle 4, B10): original Form-1 PDFs used to
// be anonymous static files under predictable names
// (/bdris-original-<digits>.pdf) — anyone guessing a number could
// download anyone's application copy, and the DONE direct button
// skipped the charge entirely. This gate runs BEFORE static serving:
// a PDF downloads only with (a) a fresh charge token minted for
// exactly this file, or (b) a logged-in user who owns a server
// record for this ack with the original flagged available (a
// legitimate re-download of one's own already-paid copy).
// It never invents entitlement: no token and no record → 403.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
// PREIUM-PRIVATE (2026-11-13): the copy is read from the private store
// (shared/originalsDir) — never from the web root.
const { storedOriginalPath, storedOriginalAvailable, originalFileName } = require('../lib/storedOriginal');

// Mirror of the engine's charge-token verifier, with the file-key
// binding added: backend mints ref
// 'bdris-apply-pdf-<clientKey>-<uid>' where the frontend's canonical
// clientKey is 'pdf-<digits>'.
function verifyPdfChargeToken(tok, userId, fileKey, secret) {
  try {
    if (!secret || !tok) return false;
    const p = String(tok).split('.');
    if (p.length !== 6 || p[0] !== 'v1') return false;
    const [, tUid, tKind, tRef, tTs, tMac] = p;
    if (tKind !== 'pdf') return false;
    if (String(tUid) !== String(userId)) return false;
    if (tRef !== 'bdris-apply-pdf-pdf-' + fileKey + '-' + userId) return false;
    const ts = parseInt(tTs, 10);
    if (!ts || Math.abs(Date.now() - ts) > 30 * 60 * 1000) return false; // 30 min window
    const mac = crypto.createHmac('sha256', secret).update(p.slice(0, 5).join('.')).digest('hex');
    if (mac.length !== tMac.length) return false;
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(tMac));
  } catch { return false; }
}

function bearerOrQueryToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

function originalPdfGate(db) {
  return async (req, res, next) => {
    const m = /^\/bdris-original-([A-Za-z0-9_-]+)\.pdf$/.exec(req.path);
    if (!m) return next();
    const fileKey = m[1].replace(/\D/g, '');
    const secret = process.env.JWT_SECRET || '';
    const rawJwt = bearerOrQueryToken(req);
    if (!rawJwt || !secret) return res.status(401).json({ error: 'NO_TOKEN' });
    let user;
    try { user = jwt.verify(rawJwt, secret); } catch { return res.status(401).json({ error: 'INVALID_TOKEN' }); }
    const ct = req.headers['x-charge-token'] || (req.query && req.query.ct) || null;
    let allowed = verifyPdfChargeToken(ct, user.id, fileKey, secret);
    if (!allowed) {
      // Re-download of one's own paid copy: the server record links
      // this user + ack and flags the original available.
      try {
        const r = await db.query(
          `SELECT 1 FROM bdris_applications WHERE user_id = $1 AND original_pdf_available = true
           AND (ack_no = $2 OR regexp_replace(ack_no, '\\D', '', 'g') = $2) LIMIT 1`,
          [user.id, fileKey]
        );
        allowed = !!(r.rows && r.rows.length);
      } catch { /* fall through to 403 */ }
    }
    if (!allowed) return res.status(403).json({ error: 'PDF_NOT_ENTITLED' });
    // PREIUM-PRIVATE: serve the entitled copy straight from the private
    // store. Handing the request to `next()` would let static serving
    // answer it from the web root — the exact hole this closes.
    const fp = storedOriginalPath(fileKey);
    if (!fp || !storedOriginalAvailable(fileKey)) return res.status(404).json({ error: 'FILE_MISSING' });
    return res.download(fp, originalFileName(fileKey));
  };
}

module.exports = { originalPdfGate, verifyPdfChargeToken };
