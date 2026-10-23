'use strict';
/**
 * engines/nid-server-copy/index.js — loader entry for the NID
 * Server Copy Engine.
 *
 * A COMPLETELY SEPARATE engine from nid-replica: the customer
 * gives their own NID portal (services.nidw.gov.bd/nid-pub) ID +
 * password, the engine logs in with a captcha relay, collects the
 * profile + photo (and the official download when the account has
 * one), and produces the NID card PDF with the same output logic
 * as the NID card engine. Interactive flow — run() points at the
 * API, like the other interactive engines.
 */
const portal = require('./portal');
const render = require('./render');
const profileMap = require('./profile-map');

async function run() {
  return {
    ok: false,
    error: 'Interactive flow: use the engine API — POST /api/nid-server-copy/start {username, password} → { sessionId, captcha } → POST /api/nid-server-copy/captcha { sessionId, captcha } → application/pdf.',
    code: 'NEEDS_LOGIN',
    apiBase: '/api/nid-server-copy',
  };
}

module.exports = Object.assign({ run }, portal, render, { profileMap });
