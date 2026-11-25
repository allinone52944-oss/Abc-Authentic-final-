/**
 * DRAFTS/AUTH (A8) — server-side draft dedupe by filing identity.
 *
 * A save with no draftId (fresh tab, concurrent first saves, a
 * session restored without the persisted id) used to mint a NEW id
 * every time, so one filing became a pile of drafts. Now the server
 * reuses the existing draft for the same filing.
 *
 * Run: node --test engines/bdris-apply/v2/tests/draft-dedupe.test.js
 * (from engines/bdris-apply/)
 *
 * NOTE: uses a throwaway user dir under engines/bdris-apply/drafts/
 * and removes it afterwards, so no test residue survives.
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');

const { BdrisEngineV2, saveDraftRecord, deleteDraftRecord, draftsDirFor } = require('../server');

const UID = 'test-dedupe-' + Date.now().toString(36);

function cleanup() {
  try { fs.rmSync(draftsDirFor(UID), { recursive: true, force: true }); } catch {}
}

test('two id-less saves for the same filing reuse one draftId', () => {
  try {
    const first = saveDraftRecord(UID, {
      mode: 'manual', uiStep: 2,
      s1: { firstNameBn: 'Test', lastNameBn: 'User', dob: '2000-01-01' },
    });
    const second = saveDraftRecord(UID, {
      mode: 'manual', uiStep: 3,
      s1: { firstNameBn: 'Test', lastNameBn: 'User', dob: '2000-01-01' },
      phone: '01700000000', // contact added later must NOT fork the draft
    });
    assert.strictEqual(second.draftId, first.draftId);
    const files = fs.readdirSync(draftsDirFor(UID)).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 1);
    const rec = JSON.parse(fs.readFileSync(path.join(draftsDirFor(UID), files[0]), 'utf8'));
    assert.strictEqual(rec.uiStep, 3); // the second save overwrote, not forked
  } finally { cleanup(); }
});

test('a different filing mints a different draftId', () => {
  try {
    const a = saveDraftRecord(UID, {
      mode: 'manual', uiStep: 2,
      s1: { firstNameBn: 'Test', lastNameBn: 'User', dob: '2000-01-01' },
    });
    const b = saveDraftRecord(UID, {
      mode: 'manual', uiStep: 2,
      s1: { firstNameBn: 'Other', lastNameBn: 'Person', dob: '1999-05-05' },
    });
    assert.notStrictEqual(b.draftId, a.draftId);
  } finally { cleanup(); }
});

test('an unidentifiable save (no name+DOB) never merges blindly', () => {
  try {
    const a = saveDraftRecord(UID, { mode: 'manual', uiStep: 1, s1: {} });
    const b = saveDraftRecord(UID, { mode: 'manual', uiStep: 1, s1: {} });
    assert.notStrictEqual(b.draftId, a.draftId);
  } finally { cleanup(); }
});

test('an explicit draftId is always honoured', () => {
  try {
    const r = saveDraftRecord(UID, {
      draftId: 'draft-explicit-1', mode: 'manual', uiStep: 2,
      s1: { firstNameBn: 'Test', lastNameBn: 'User', dob: '2000-01-01' },
    });
    assert.strictEqual(r.draftId, 'draft-explicit-1');
  } finally { cleanup(); }
});

test('deleting a draft is repeatable and blocks a late save', () => {
  const draft = { draftId: 'draft-delayed-save', uiStep: 4 };
  try {
    saveDraftRecord(UID, draft);
    deleteDraftRecord(UID, draft.draftId);
    deleteDraftRecord(UID, draft.draftId);
    assert.throws(() => saveDraftRecord(UID, draft), /DRAFT_CLOSED/);
    assert.strictEqual(fs.existsSync(path.join(draftsDirFor(UID), draft.draftId + '.json')), false);
  } finally { cleanup(); }
});

test('a delayed fallback cannot replace a more recently saved draft', () => {
  const draftId = 'draft-delayed-fallback';
  try {
    saveDraftRecord(UID, { draftId, uiStep: 4, writeVersion: 20 });
    const stale = saveDraftRecord(UID, { draftId, uiStep: 3, writeVersion: 19 });
    assert.strictEqual(stale.obsolete, true);
    const data = JSON.parse(fs.readFileSync(path.join(draftsDirFor(UID), draftId + '.json'), 'utf8'));
    assert.strictEqual(data.uiStep, 4);
  } finally { cleanup(); }
});

test('HTTP draft reads keep files and require the original account', async () => {
  const secret = 'local-draft-read-fixture';
  const previous = process.env.ABC_JWT_SECRET;
  process.env.ABC_JWT_SECRET = secret;
  const token = uid => {
    const body = 'e30.' + Buffer.from(JSON.stringify({ id: uid })).toString('base64url');
    return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
  };
  const app = express();
  app.use(express.json());
  BdrisEngineV2.prototype.setupHttpRoutes.call({}, app);
  const server = app.listen(0, '127.0.0.1');
  const draftId = 'draft-with-file';
  const other = UID + '-other';
  try {
    await once(server, 'listening');
    const fixture = { draftId, uiStep: 6, docs: [{ docType: '40', base64: 'Zml4dHVyZQ==' }] };
    saveDraftRecord(UID, fixture);
    const read = body => fetch('http://127.0.0.1:' + server.address().port + '/draft-read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await read({ draftId })).status, 401);
    assert.equal((await read({ _authToken: token(other), draftId })).status, 404);
    const summaries = await read({ _authToken: token(UID) });
    assert.equal(summaries.headers.get('cache-control'), 'private, no-store');
    const list = (await summaries.json()).drafts;
    assert.equal(list[0].draftId, draftId);
    assert.equal(list[0].docs, undefined);
    const loaded = await read({ _authToken: token(UID), draftId });
    assert.deepEqual((await loaded.json()).draft.docs, fixture.docs);
  } finally {
    await new Promise(resolve => server.close(resolve));
    cleanup();
    fs.rmdirSync(draftsDirFor(other));
    if (previous === undefined) delete process.env.ABC_JWT_SECRET;
    else process.env.ABC_JWT_SECRET = previous;
  }
});
