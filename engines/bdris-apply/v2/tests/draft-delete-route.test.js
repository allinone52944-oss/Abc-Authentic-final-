/**
 * ALL-BUGS (i) — draft delete must not depend on the live socket.
 *
 * DONE via direct HTTP with a dead socket used to leave the
 * submitted draft in the list (the socket DELETE_DRAFT never
 * arrived), because no HTTP draft-delete endpoint existed — only
 * /draft-save. This test pins the endpoint: same JWT-body auth +
 * id sanitisation as /draft-save, and deleting a missing draft
 * is still ok (idempotent).
 *
 * Run: node --test engines/bdris-apply/v2/tests/draft-delete-route.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server.js'),
  'utf8'
);

test('POST /draft-delete route exists with JWT-body auth', () => {
  assert.match(SRC, /app\.post\('\/draft-delete'/);
  assert.match(SRC, /draft-delete[\s\S]{0,1200}?verifyJwtHS256\(body\._authToken, secret\)/);
});

test('draft-delete sanitises the id exactly like draft-save', () => {
  assert.match(
    SRC,
    /draft-delete[\s\S]{0,1600}?String\(body\.draftId \|\| ''\)\.replace\(\/\[\^a-zA-Z0-9-\]\/g, ''\)/
  );
});

test('deleting a missing draft is ok (idempotent, not an error)', () => {
  assert.match(
    SRC,
    /draft-delete[\s\S]{0,2000}?try \{ fs\.unlinkSync\(f\); \} catch \{ \/\* already gone — idempotent \*\/ \}/
  );
});
