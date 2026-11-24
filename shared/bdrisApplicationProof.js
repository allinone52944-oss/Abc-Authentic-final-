'use strict';

const crypto = require('node:crypto');

function signApplication(userId, ackNo) {
  const secret = process.env.JWT_SECRET || process.env.ABC_JWT_SECRET;
  if (!secret || !userId || !/^\d{4,20}$/.test(String(ackNo))) return null;
  return crypto.createHmac('sha256', secret)
    .update(JSON.stringify(['bdris-submission', String(userId), String(ackNo)]))
    .digest('hex');
}

function verifyApplication(proof, userId, ackNo) {
  if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return false;
  const expected = signApplication(userId, ackNo);
  return !!expected && crypto.timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(expected, 'hex'));
}

module.exports = { signApplication, verifyApplication };
