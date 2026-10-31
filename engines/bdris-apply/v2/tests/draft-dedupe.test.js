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

const { saveDraftRecord, draftsDirFor } = require('../server');

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
