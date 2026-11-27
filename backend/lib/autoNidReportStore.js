'use strict';

const crypto = require('node:crypto');

function storageKey() {
  const hex = process.env.BDX_NID_STORAGE_KEY || '';
  return /^[a-f0-9]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
}

function fingerprint(key, userId, { type, nid, dob, price }) {
  const hmacKey = crypto.createHmac('sha256', key).update('auto-nid-request-v1').digest();
  return crypto.createHmac('sha256', hmacKey)
    .update(JSON.stringify([userId, type, nid, dob, price]))
    .digest('hex');
}

function encryptReport(key, orderId, pdf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(orderId));
  const ciphertext = Buffer.concat([cipher.update(pdf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decryptReport(key, orderId, encrypted) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
  decipher.setAAD(Buffer.from(orderId));
  decipher.setAuthTag(encrypted.subarray(12, 28));
  return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
}

module.exports = { storageKey, fingerprint, encryptReport, decryptReport };
