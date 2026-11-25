'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function addressBookPath(userId) {
  const id = String(userId || 'anon').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || 'anon';
  return path.join(__dirname, '..', 'engines', 'bdris-apply', 'addresses_u_' + id + '.json');
}

function loadAddresses(userId) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(addressBookPath(userId), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  if (!Array.isArray(list)) throw new Error('Invalid address book');
  return list;
}

function saveAddresses(userId, list) {
  const target = addressBookPath(userId);
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(list, null, 1), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

module.exports = { loadAddresses, saveAddresses };
