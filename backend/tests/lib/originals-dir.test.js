// PREIUM-PRIVATE (2026-11-13): the single rule for where an original
// Form-1 PDF is kept. A copy written inside the web root (frontend/) is
// downloadable by URL with no check at all — nginx serves that dir
// directly — so the store must live outside it, and both the engine
// (writer) and the backend (reader) must resolve the same directory.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { originalsDir, ensureOriginalsDir, isInsideWebRoot, WEB_ROOT, DEFAULT_DIR } = require('../../../shared/originalsDir');
const stored = require('../../lib/storedOriginal');

const saved = process.env.BDRIS_ORIGINALS_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.BDRIS_ORIGINALS_DIR;
  else process.env.BDRIS_ORIGINALS_DIR = saved;
});

describe('shared originalsDir — private store rule', () => {
  test('defaults outside the web root', () => {
    delete process.env.BDRIS_ORIGINALS_DIR;
    expect(originalsDir()).toBe(DEFAULT_DIR);
    expect(isInsideWebRoot(originalsDir())).toBe(false);
    expect(originalsDir()).not.toBe(WEB_ROOT);
    expect(originalsDir().startsWith(WEB_ROOT + path.sep)).toBe(false);
  });

  test('BDRIS_ORIGINALS_DIR moves the store, and the reader follows it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orig-rule-'));
    process.env.BDRIS_ORIGINALS_DIR = dir;
    expect(originalsDir()).toBe(path.resolve(dir));
    // the backend reader (lib/storedOriginal) resolves through the same rule
    expect(stored.originalsDir()).toBe(path.resolve(dir));
  });

  test('ensureOriginalsDir creates the directory', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orig-make-')), 'nested', 'store');
    process.env.BDRIS_ORIGINALS_DIR = dir;
    expect(fs.existsSync(dir)).toBe(false);
    expect(ensureOriginalsDir()).toBe(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('isInsideWebRoot flags the public dir and anything under it', () => {
    expect(isInsideWebRoot(WEB_ROOT)).toBe(true);
    expect(isInsideWebRoot(path.join(WEB_ROOT, 'sub'))).toBe(true);
    expect(isInsideWebRoot(DEFAULT_DIR)).toBe(false);
  });
});

describe('storedOriginal reads the private store, not the web root', () => {
  test('a copy in the private dir is retrievable; a look-alike in the web root is not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orig-read-'));
    process.env.BDRIS_ORIGINALS_DIR = dir;
    const KEY = '266392130';
    const PDF = '%PDF-1.4\n' + 'A'.repeat(8100);
    // a real copy in the private store
    fs.writeFileSync(path.join(dir, 'bdris-original-' + KEY + '.pdf'), PDF);
    expect(stored.storedOriginalAvailable(KEY)).toBe(true);
    expect(stored.storedOriginalPath(KEY)).toBe(path.join(dir, 'bdris-original-' + KEY + '.pdf'));
    // and the web root is never consulted, even if a file sits there
    const fake = path.join(WEB_ROOT, 'bdris-original-999999999.pdf');
    fs.writeFileSync(fake, PDF);
    try {
      expect(stored.storedOriginalAvailable('999999999')).toBe(false);
      expect(stored.bdrisOriginalDoc('999999999')).toBe(null);
    } finally {
      try { fs.unlinkSync(fake); } catch {}
    }
  });

  test('the History link points at the owner-only route, never a bare file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orig-doc-'));
    process.env.BDRIS_ORIGINALS_DIR = dir;
    const KEY = '265775264';
    fs.writeFileSync(path.join(dir, 'bdris-original-' + KEY + '.pdf'), '%PDF-1.4\n' + 'A'.repeat(8100));
    const doc = stored.bdrisOriginalDoc(KEY);
    expect(doc.url).toBe('/api/bdris-apply/applications/' + KEY + '/original');
    expect(doc.url).not.toContain('bdris-original-');
  });
});
