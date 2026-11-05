'use strict';
// Audit #15 — `maskBrn` was a no-op (returned the BRN unchanged)
// with no callers anywhere in the tree: a name that promised
// masking and delivered none. It is removed, not reimplemented —
// there is no masking use case in this engine, and a fresh
// implementation would be dead code with an invented format.
// This test pins the removal so the misleading export cannot
// come back, and pins the rest of the engine interface intact.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../index');

test('maskBrn is gone (no false-security export)', () => {
  assert.ok(!('maskBrn' in engine), 'maskBrn must not be exported');
  assert.equal(typeof engine.maskBrn, 'undefined');
});

test('the engine interface is otherwise intact', () => {
  for (const name of ['init', 'getInfo', 'getApp', 'generate', 'run']) {
    assert.equal(typeof engine[name], 'function', name + ' must still be exported');
  }
});
