// FIX-8 + FIX-11 regression: upload limits & MIME validation.
// FIX-8: uploadMiddleware reads max_mb from getLimits() (admin-configurable),
// defaulting to 5MB — the NID route passes max_mb: 20 (was a stale 20MB
// comment over a hardcoded 5MB).
// FIX-11: fileFilter checks the MIME map, not just the extension, so a
// .pdf with an image/png mimetype is rejected.
// multer is mocked so we can inspect the options uploadMiddleware builds
// and drive fileFilter directly.
jest.mock('multer', () => {
  const mw = (req, res, next) => next();
  const factory = jest.fn(() => ({
    single: jest.fn(() => mw),
    array: jest.fn(() => mw),
    fields: jest.fn(() => mw),
    any: jest.fn(() => mw),
    none: jest.fn(() => mw),
  }));
  factory.memoryStorage = jest.fn(() => 'mock-storage');
  return factory;
});

const multer = require('multer');
const { uploadMiddleware } = require('../../security');
// requiring nid.js wires ITS uploadMiddleware call through the mocked multer
require('../../routes/nid');

function lastMulterOptions() {
  const calls = multer.mock.calls;
  return calls[calls.length - 1][0];
}
function runFileFilter(fileFilter, originalname, mimetype) {
  return new Promise((resolve) => {
    fileFilter({}, { originalname, mimetype }, (err, ok) => resolve({ err, ok }));
  });
}

describe('FIX-8 upload size limits come from getLimits()', () => {
  test('max_mb: 20 → fileSize = 20MB', () => {
    uploadMiddleware(() => ({ allowed: ['pdf'], max_mb: 20 }));
    expect(lastMulterOptions().limits.fileSize).toBe(20 * 1024 * 1024);
  });

  test('missing/zero max_mb → default 5MB', () => {
    uploadMiddleware(() => ({}));
    expect(lastMulterOptions().limits.fileSize).toBe(5 * 1024 * 1024);
    uploadMiddleware();
    expect(lastMulterOptions().limits.fileSize).toBe(5 * 1024 * 1024);
  });

  test('nid.js route wires max_mb: 20 into multer (not the old 5MB default)', () => {
    const nidCall = multer.mock.calls.find(
      (c) => c[0].limits && c[0].limits.fileSize === 20 * 1024 * 1024
    );
    expect(nidCall).toBeDefined();
    expect(nidCall[0].limits.files).toBe(5);
  });
});

describe('FIX-11 MIME-map check (extension alone is not enough)', () => {
  function pdfFilter() {
    uploadMiddleware(() => ({ allowed: ['pdf'], max_mb: 20 }));
    return lastMulterOptions().fileFilter;
  }

  test('.pdf with image/png mimetype → FILE_TYPE_NOT_ALLOWED', async () => {
    const { err } = await runFileFilter(pdfFilter(), 'doc.pdf', 'image/png');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  test('valid extension+mime pairs are accepted', async () => {
    uploadMiddleware(() => ({ allowed: ['pdf', 'jpg', 'png'], max_mb: 20 }));
    const ff = lastMulterOptions().fileFilter;
    for (const [name, mime] of [
      ['a.pdf', 'application/pdf'],
      ['b.jpg', 'image/jpeg'],
      ['c.png', 'image/png'],
    ]) {
      const { err, ok } = await runFileFilter(ff, name, mime);
      expect(err).toBeNull();
      expect(ok).toBe(true);
    }
  });

  test('disallowed extension rejected even with an allowed mimetype', async () => {
    const { err } = await runFileFilter(pdfFilter(), 'evil.exe', 'application/pdf');
    expect(err && err.message).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  test('extension match is case-insensitive (DOC.PDF + application/pdf)', async () => {
    const { err, ok } = await runFileFilter(pdfFilter(), 'DOC.PDF', 'application/pdf');
    expect(err).toBeNull();
    expect(ok).toBe(true);
  });
});
