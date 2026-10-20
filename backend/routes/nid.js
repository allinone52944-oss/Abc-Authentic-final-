// ============================================================
// All In One (Abc Authentic) - NID Replica engine routes
// Mounted at /api/nid-engine (JWT auth + rate limit at mount).
//
// POST /api/nid-engine/extract  (multipart, field "pdf") → { jobId, fields, images }
// GET  /api/nid-engine/price    → { ok, allowed, price, balance }
// POST /api/nid-engine/build    (JSON { jobId, fields })   → application/pdf (atomic wallet debit)
// ============================================================
const express = require('express');
const { requireAuth } = require('../auth');
const { safeLog, uploadMiddleware } = require('../security');
const db = require('../db');
const nidAdapter = require('../../engines/nid-replica/adapter');

const router = express.Router();

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

async function getNidServicePrice(userId) {
  const r = await db.query(
    `SELECT id, price FROM services WHERE engine_id = 'nid-replica' AND status = 'active' LIMIT 1`
  );
  if (!r.rows.length) return { allowed: true, price: 0, serviceId: null };
  const service = r.rows[0];
  const serviceId = service.id;
  const basePrice = Number(service.price) || 0;

  const ov = await db.query(
    `SELECT custom_price, access_enabled FROM user_services WHERE user_id = $1 AND service_id = $2 LIMIT 1`,
    [userId, serviceId]
  );
  if (ov.rows.length) {
    if (ov.rows[0].access_enabled === false) {
      return { allowed: false, price: 0, serviceId };
    }
    const cp = ov.rows[0].custom_price;
    return {
      allowed: true,
      price: cp !== null && cp !== undefined ? Number(cp) : basePrice,
      serviceId
    };
  }
  return { allowed: true, price: basePrice, serviceId };
}

router.get('/price', requireAuth, async (req, res) => {
  try {
    const { allowed, price, serviceId } = await getNidServicePrice(req.user.id);
    const u = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const balance = u.rows[0] ? Number(u.rows[0].balance) : 0;
    res.json({ ok: true, allowed, price, balance, serviceId });
  } catch (e) {
    safeLog('[nid-engine] price error:', e.message);
    res.status(500).json({ error: 'PRICE_CHECK_FAILED' });
  }
});

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

router.post('/build', requireAuth, async (req, res) => {
  try {
    const { jobId, fields, images } = req.body || {};
    if (!jobId || !fields || typeof fields !== 'object') {
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    }

    const { allowed, price, serviceId } = await getNidServicePrice(req.user.id);
    if (!allowed) {
      return res.status(403).json({
        error: 'SERVICE_ACCESS_DISABLED',
        message: 'এই সেবায় আপনার প্রবেশাধিকার স্থগিত রয়েছে।'
      });
    }

    if (price > 0) {
      const u = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
      const balance = u.rows[0] ? Number(u.rows[0].balance) : 0;
      if (balance < price) {
        return res.status(402).json({
          error: 'INSUFFICIENT_BALANCE',
          message: `পর্যাপ্ত ব্যালেন্স নেই। কার্ড তৈরি করতে ৳${price} প্রয়োজন, বর্তমান ব্যালেন্স ৳${balance}।`,
          required: price,
          balance
        });
      }
    }

    const r = await nidAdapter.buildCard(jobId, fields, images, req.user.id);
    if (!r.ok) {
      const status = r.error === 'JOB_NOT_FOUND' ? 404 : r.error === 'NOT_YOUR_JOB' ? 403 : 422;
      return res.status(status).json({ error: r.error });
    }

    if (price > 0) {
      const ref = 'nid-card-' + jobId;
      const alreadyPaid = await db.query(
        `SELECT 1 FROM transactions WHERE user_id = $1 AND trxid = $2 AND status = 'approved' LIMIT 1`,
        [req.user.id, ref]
      );

      if (!alreadyPaid.rows.length) {
        try {
          await db.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
            req.user.id, -Math.abs(price), 'debit', ref
          ]);
          safeLog('[nid-engine] charged', price, 'for user', req.user.id, 'job', jobId);

                  } catch (e) {
          if (/INSUFFICIENT_BALANCE/.test(e.message)) {
            return res.status(402).json({
              error: "INSUFFICIENT_BALANCE",
              message: "পর্যাপ্ত ব্যালেন্স নেই। অনুগ্রহ করে ওয়ালেট রিচার্জ করুন।"
            });
          }
          if (!/DUPLICATE_TRANSACTION/.test(e.message)) {
            throw e;
          }
        }
      }
    }

    if (serviceId) {
      await db.query(
        `INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key)
         VALUES ($1, $2, 'completed', $3, $4, $5)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
        [req.user.id, serviceId, JSON.stringify(fields || {}), price, 'nid-' + jobId]
      ).catch(e => safeLog('[nid-engine] order record insert error:', e.message));
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
