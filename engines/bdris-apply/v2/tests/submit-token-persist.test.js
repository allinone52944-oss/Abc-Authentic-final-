/**
 * Audit #4: consumed submit tokens survive an engine restart.
 *
 * The token store used to live only in a process-local Map, so an
 * engine restart cleared it and the SAME token could submit a
 * SECOND, different application within its 30-minute window (one
 * payment, two filings). Consumption is now written through to a
 * JSON file (same pattern as OriginalFetcher's shared index); these
 * tests prove the record outlives the in-memory map.
 *
 * Run: node --test engines/bdris-apply/v2/tests/submit-token-persist.test.js
 */
'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  consumeSubmitToken, isSubmitTokenConsumed,
  _setConsumedTokensFile, _clearConsumedTokensMemory,
} = require('../services/StepHandler');

function mintToken(userId, secret, ref, ts = Date.now()) {
  const head = `v1.${userId}.submit.${ref}.${ts}`;
  const mac = nodeCrypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

let tmpDir = null;
function tmpFile() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit4-tokens-'));
  return path.join(tmpDir, 'consumed-submit-tokens.json');
}

afterEach(() => {
  _setConsumedTokensFile(null);
  _clearConsumedTokensMemory();
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* already gone */ }
    tmpDir = null;
  }
});

describe('submit token persistence across restarts (audit #4)', () => {
  it('a consumed token stays consumed after the in-memory store is cleared (restart)', () => {
    const file = tmpFile();
    _setConsumedTokensFile(file);
    const tok = mintToken('user-9', 'test-secret', 'ref-persist-' + Date.now());
    assert.strictEqual(consumeSubmitToken(tok), true);
    assert.strictEqual(isSubmitTokenConsumed(tok), true);
    // The file holds the token with a future expiry.
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(stored[tok] > Date.now(), 'file must record the token with a future expiry');
    // Simulate an engine restart: memory is gone, file is not.
    _clearConsumedTokensMemory();
    assert.strictEqual(isSubmitTokenConsumed(tok), true, 'restart must not resurrect a consumed token');
    assert.strictEqual(consumeSubmitToken(tok), false, 'a second consume after restart must still fail');
  });

  it('expired tokens prune from the file and stop blocking', () => {
    const file = tmpFile();
    _setConsumedTokensFile(file);
    const oldTok = mintToken('user-9', 'test-secret', 'ref-old', Date.now() - 31 * 60 * 1000);
    assert.strictEqual(consumeSubmitToken(oldTok), true);
    assert.strictEqual(isSubmitTokenConsumed(oldTok), false, 'expired entry must prune, not block');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(stored[oldTok], undefined, 'expired token must not linger in the file');
  });

  it('a corrupt store file is ignored, not fatal', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{not json');
    _setConsumedTokensFile(file); // must not throw
    const tok = mintToken('user-9', 'test-secret', 'ref-corrupt-' + Date.now());
    assert.strictEqual(consumeSubmitToken(tok), true);
    assert.strictEqual(isSubmitTokenConsumed(tok), true);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8'))[tok] > Date.now(), 'corrupt file is replaced by a valid store');
  });

  it('an unwritable store path never blocks a submit', () => {
    _setConsumedTokensFile(path.join(os.tmpdir(), 'no-such-dir-audit4', 'tokens.json'));
    const tok = mintToken('user-9', 'test-secret', 'ref-unwritable-' + Date.now());
    assert.strictEqual(consumeSubmitToken(tok), true, 'memory still records the consume');
    assert.strictEqual(isSubmitTokenConsumed(tok), true);
  });
});
