// PREIUM-PRIVATE (2026-11-13): the engine's writer must put an original
// Form-1 PDF outside the web root. A file under frontend/ is served by
// nginx with no check, so the fetched copy of one person's birth
// registration was downloadable by anyone who guessed the ack number.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OriginalFetcher } = require('../services/OriginalFetcher');
const { isInsideWebRoot, WEB_ROOT } = require('../../../../shared/originalsDir');

const fakeBM = { launch: async () => { throw new Error('no browser in unit test'); } };
const saved = process.env.BDRIS_ORIGINALS_DIR;

afterEach(() => {
  if (saved === undefined) delete process.env.BDRIS_ORIGINALS_DIR;
  else process.env.BDRIS_ORIGINALS_DIR = saved;
});

describe('OriginalFetcher private store', () => {
  it('defaults outside the web root', () => {
    delete process.env.BDRIS_ORIGINALS_DIR;
    const f = new OriginalFetcher({ browserManager: fakeBM, log: () => {} });
    assert.ok(f.originalsDir, 'originalsDir must be set');
    assert.strictEqual(isInsideWebRoot(f.originalsDir), false);
    assert.strictEqual(f.originalsDir.startsWith(WEB_ROOT + path.sep), false);
  });

  it('honours an explicit private dir and reads a cached copy from it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orig-private-'));
    const buf = Buffer.concat([Buffer.from('%PDF-1.4 test'), Buffer.alloc(9000)]);
    fs.writeFileSync(path.join(dir, 'bdris-original-445566.pdf'), buf);
    const f = new OriginalFetcher({ browserManager: fakeBM, originalsDir: dir, log: () => {} });
    const hit = f.cachedOriginal('445566');
    assert.strictEqual(hit.ok, true);
    assert.strictEqual(hit.path, path.join(dir, 'bdris-original-445566.pdf'));
  });

  it('a copy left in the web root is never treated as the stored original', () => {
    delete process.env.BDRIS_ORIGINALS_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orig-notweb-'));
    process.env.BDRIS_ORIGINALS_DIR = dir;
    const fake = path.join(WEB_ROOT, 'bdris-original-777888999.pdf');
    fs.writeFileSync(fake, Buffer.concat([Buffer.from('%PDF-1.4 test'), Buffer.alloc(9000)]));
    try {
      const f = new OriginalFetcher({ browserManager: fakeBM, log: () => {} });
      assert.strictEqual(f.cachedOriginal('777888999'), null);
    } finally {
      try { fs.unlinkSync(fake); } catch {}
    }
  });
});
