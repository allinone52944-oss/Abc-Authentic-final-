// Audit #70 — the certificate assets (fonts.css, logo.png, seal.jpg)
// were byte-identical in both engines; one shared copy in
// engines/shared/assets/ replaces both. Both engines read from here.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHARED = path.join(__dirname, '..');
const ROOT = path.join(__dirname, '..', '..', '..');

function md5(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

// md5s of the files as they were in both engines before the move.
const EXPECTED = {
  'fonts.css': '16f0763ec224f1e7c4922ff784351934',
  'logo.png': '8e493d04064479747e01e0b11300f9e1',
  'seal.jpg': 'abd321234695bd40d0aec60e87e33de3',
};

describe('shared certificate assets (audit #70)', () => {
  it('one shared copy exists, byte-identical to the old duplicates', () => {
    for (const [file, hash] of Object.entries(EXPECTED)) {
      const p = path.join(SHARED, 'assets', file);
      assert.ok(fs.existsSync(p), 'missing shared asset ' + file);
      assert.equal(md5(p), hash, file + ' md5 changed');
    }
  });

  it('neither engine keeps a local assets/ copy', () => {
    for (const eng of ['birth-final', 'death-final']) {
      assert.equal(fs.existsSync(path.join(ROOT, 'engines', eng, 'assets')), false, eng + ' still has assets/');
    }
  });

  it('both engines read all three assets from the shared dir', () => {
    for (const [eng, server] of [['birth-final', 'server.js'], ['death-final', 'death-verify-server.js']]) {
      const src = fs.readFileSync(path.join(ROOT, 'engines', eng, server), 'utf8');
      for (const file of Object.keys(EXPECTED)) {
        assert.ok(src.includes(`'shared', 'assets', '${file}'`), eng + ' does not read shared ' + file);
      }
      assert.ok(!src.includes(`__dirname, 'assets'`), eng + ' still reads a local assets/ dir');
    }
  });
});
