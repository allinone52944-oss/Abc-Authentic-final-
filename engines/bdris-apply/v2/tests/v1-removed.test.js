/**
 * Audit #8: the bdris-apply v1 engine is gone — v2 only.
 *
 * v1 (engines/bdris-apply/server.js, 3335 lines, its own charge
 * gate + submit logic) was dead weight next to v2: a fix landing
 * in v1 never reached live, and two charge gates side by side were
 * a maintenance risk. The file is archived in git history
 * (recover with: git show <base>:engines/bdris-apply/server.js).
 * These tests pin the removal so v1 cannot silently come back:
 * the files must not exist, the adapter must not fall back to v1,
 * and package.json must point at v2.
 *
 * Run: node --test engines/bdris-apply/v2/tests/v1-removed.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const engineDir = path.join(__dirname, '..', '..');

describe('v1 engine removed (audit #8)', () => {
  it('v1 server.js and its v1-only helpers do not exist', () => {
    assert.strictEqual(fs.existsSync(path.join(engineDir, 'server.js')), false, 'v1 server.js must stay deleted');
    assert.strictEqual(fs.existsSync(path.join(engineDir, 'original-fetcher.js')), false, 'v1-only helper (only required by v1 server.js)');
    assert.strictEqual(fs.existsSync(path.join(engineDir, 'status-checker.js')), false, 'v1-only helper (only required by v1 server.js)');
  });

  it('v2 server.js exists and package.json points at it', () => {
    assert.strictEqual(fs.existsSync(path.join(engineDir, 'v2', 'server.js')), true);
    const pkg = JSON.parse(fs.readFileSync(path.join(engineDir, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.main, 'v2/server.js');
  });

  it('the adapter has no v1 fallback', () => {
    const src = fs.readFileSync(path.join(engineDir, 'index.js'), 'utf8');
    assert.ok(!src.includes('v1ServerJs'), 'adapter must not reference a v1 fallback path');
    assert.ok(src.includes("path.join(engineDir(), 'v2', 'server.js')"), 'adapter must spawn v2');
  });

  it('v2-only helpers that v1 used to own still exist (not collateral)', () => {
    // captcha-solve2 + captcha-core are used by v2's OriginalFetcher;
    // the drafts dir is where v2 stores drafts. None of these is v1-only.
    assert.strictEqual(fs.existsSync(path.join(engineDir, 'captcha-solve2.js')), true);
    assert.strictEqual(fs.existsSync(path.join(engineDir, 'captcha-core.js')), true);
    assert.strictEqual(fs.existsSync(path.join(engineDir, 'drafts')), true);
  });
});
