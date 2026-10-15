// ============================================================
// All In One (Abc Authentic) - NID Replica engine routes
// Mounted at /api/nid-engine (JWT auth + rate limit at mount).
//
// POST /api/nid-engine/extract  (multipart, field "pdf") → { jobId, fields, images }
// POST /api/nid-engine/build    (JSON { jobId, fields })   → application/pdf
// ============================================================
const express = require('express');
const { requireAuth } = require('../auth');
const { safeLog, uploadMiddleware } = require('../security');
const nidAdapter = require('../../engines/nid-replica/adapter');

const router = express.Router();

// PDF-only upload, 20MB cap (NID form scans can be large)
const upload = uploadMiddleware(() => ({ allowed: ['pdf'], max_mb: 20 }));
const pdfOnly = upload.single('pdf');

function multerError(err, req, res, next) {
  if (err) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'PDF_TOO_LARGE'
      : err.message === 'FILE_TYPE_NOT_ALLOWED' ? 'NOT_A_PDF'
      : 'UPLOAD_FAILED';
    return res.status(400).json({ error: code });
  }
  next();
}

// POST /api/nid-engine/extract — upload NID form PDF, get editable fields + images
router.post('/extract', requireAuth, pdfOnly, multerError, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'NO_FILE' });
    }
    const r = await nidAdapter.extractFields(req.file.buffer, req.user.id);
    if (!r.ok) return res.status(422).json({ error: r.error });
    res.json({ ok: true, jobId: r.jobId, fields: r.fields, images: r.images });
  } catch (e) {
    safeLog('[nid-engine] extract route error:', e.message);
    res.status(500).json({ error: 'EXTRACT_FAILED' });
  }
});

// POST /api/nid-engine/build — { jobId, fields } → NID card PDF download
router.post('/build', requireAuth, async (req, res) => {
  try {
    const { jobId, fields, images } = req.body || {};
    if (!jobId || !fields || typeof fields !== 'object') {
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    }
    const r = await nidAdapter.buildCard(jobId, fields, images, req.user.id);
    if (!r.ok) {
      const status = r.error === 'JOB_NOT_FOUND' ? 404 : r.error === 'NOT_YOUR_JOB' ? 403 : 422;
      return res.status(status).json({ error: r.error });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="nid-card.pdf"');
    res.setHeader('Content-Length', r.pdfBuffer.length);
    res.send(r.pdfBuffer);
  } catch (e) {
    safeLog('[nid-engine] build route error:', e.message);
    res.status(500).json({ error: 'BUILD_FAILED' });
  }
});

module.exports = router;
