// One-tap original-PDF download link (2026-11-13).
//
// A browser download that starts from a plain link navigation is the
// only kind every phone/WebView honours; a blob built after long
// awaits was silently dropped ("message shown, nothing downloaded").
// A plain link cannot carry the Authorization header, so after the
// normal owner/receipt check the server mints a short-lived signed
// URL bound to ONE user and ONE file. The link itself grants nothing
// beyond that file for a few minutes.
'use strict';

const crypto = require('crypto');

const LINK_TTL_MS = 5 * 60 * 1000;

function secret() {
  const s = process.env.JWT_SECRET || '';
  return s ? 'bdris-original-link:' + s : '';
}

function sign(key, uid, exp) {
  return crypto.createHmac('sha256', secret()).update([key, uid, exp].join('.')).digest('hex');
}

function mintOriginalLink(fileKey, userId, now = Date.now()) {
  const key = String(fileKey || '').replace(/\D/g, '');
  if (!key || !secret() || userId === undefined || userId === null) return null;
  const uid = String(userId);
  const exp = String(now + LINK_TTL_MS);
  return '/api/bdris-original-dl/' + key + '?u=' + encodeURIComponent(uid) + '&e=' + exp + '&s=' + sign(key, uid, exp);
}

function verifyOriginalLink(fileKey, uid, exp, sig, now = Date.now()) {
  try {
    const key = String(fileKey || '');
    if (!/^\d+$/.test(key) || !uid || !/^\d+$/.test(String(exp || '')) || !sig || !secret()) return false;
    if (Number(exp) < now || Number(exp) > now + LINK_TTL_MS + 1000) return false;
    const mac = sign(key, String(uid), String(exp));
    if (mac.length !== String(sig).length) return false;
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(String(sig)));
  } catch { return false; }
}

module.exports = { LINK_TTL_MS, mintOriginalLink, verifyOriginalLink };
