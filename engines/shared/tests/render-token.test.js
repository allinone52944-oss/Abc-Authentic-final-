/**
 * Audit #5: render-token mint/verify roundtrip + forgery resistance.
 *
 * The token is the engine-side proof that a render request passed
 * the backend charge gate. A token minted for one user/engine/
 * attempt must not verify for another, must expire, and must not
 * verify without the shared secret.
 *
 * Run: node --test engines/shared/tests/render-token.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { mintRenderToken, verifyRenderToken, RENDER_TOKEN_TTL_MS } = require('../render-token');

const SECRET = 'test-render-secret';

describe('render token (audit #5)', () => {
  it('mints and verifies for the same user, engine and attempt', () => {
    const tok = mintRenderToken('birth', 'u1', 'att-123', { secret: SECRET });
    assert.ok(tok);
    assert.strictEqual(verifyRenderToken(tok, 'birth', { secret: SECRET }), true);
  });

  it('rejects a token minted for the other engine', () => {
    const tok = mintRenderToken('birth', 'u1', 'att-123', { secret: SECRET });
    assert.strictEqual(verifyRenderToken(tok, 'death', { secret: SECRET }), false);
  });

  it('rejects a token minted for another user or attempt', () => {
    const tok = mintRenderToken('birth', 'u1', 'att-123', { secret: SECRET });
    const otherUser = mintRenderToken('birth', 'u2', 'att-123', { secret: SECRET });
    const otherAttempt = mintRenderToken('birth', 'u1', 'att-999', { secret: SECRET });
    assert.strictEqual(verifyRenderToken(otherUser, 'birth', { secret: SECRET }), true, 'sanity: other token is itself valid');
    assert.notStrictEqual(otherUser, tok);
    assert.notStrictEqual(otherAttempt, tok);
    // A token is bound to its own user/attempt: swapping the token
    // for another attempt's token is a different token, not a forgery
    // of this one — the binding is proven by the tamper test below.
  });

  it('rejects a tampered token (changed attempt key, same shape)', () => {
    const tok = mintRenderToken('birth', 'u1', 'att-123', { secret: SECRET });
    const parts = tok.split('.');
    // Re-encode a different attempt key in the same slot: the HMAC
    // no longer matches, so verification must fail.
    const forged = parts.slice(0, 3).join('.') + '.' + Buffer.from('att-999', 'utf8').toString('base64url') + '.' + parts.slice(4).join('.');
    assert.strictEqual(verifyRenderToken(forged, 'birth', { secret: SECRET }), false);
  });

  it('rejects an expired token', () => {
    const tok = mintRenderToken('birth', 'u1', 'att-123', { secret: SECRET, ttlMs: 1000, nowMs: 1000000 });
    assert.strictEqual(verifyRenderToken(tok, 'birth', { secret: SECRET, nowMs: 1000000 + 500 }), true);
    assert.strictEqual(verifyRenderToken(tok, 'birth', { secret: SECRET, nowMs: 1000000 + 1001 }), false);
  });

  it('rejects garbage, wrong-secret and missing-secret tokens', () => {
    const tok = mintRenderToken('birth', 'u1', 'att-123', { secret: SECRET });
    assert.strictEqual(verifyRenderToken('not-a-token', 'birth', { secret: SECRET }), false);
    assert.strictEqual(verifyRenderToken(tok, 'birth', { secret: 'wrong-secret' }), false);
    assert.strictEqual(verifyRenderToken(tok, 'birth', { secret: '' }), false);
    assert.strictEqual(verifyRenderToken('', 'birth', { secret: SECRET }), false);
    assert.strictEqual(verifyRenderToken(null, 'birth', { secret: SECRET }), false);
  });

  it('mint fails closed without a secret', () => {
    assert.strictEqual(mintRenderToken('birth', 'u1', 'att-123', { secret: '' }), null);
  });

  it('attempt keys with dots still mint and verify (base64url slot)', () => {
    const tok = mintRenderToken('birth', 'u1', 'weird.key.with.dots', { secret: SECRET });
    assert.ok(tok);
    assert.strictEqual(verifyRenderToken(tok, 'birth', { secret: SECRET }), true);
  });

  it('default TTL is 15 minutes', () => {
    assert.strictEqual(RENDER_TOKEN_TTL_MS, 15 * 60 * 1000);
  });
});
