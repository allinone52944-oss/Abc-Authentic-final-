// ============================================================
// All In One (Abc Authentic) - QR + Photo verification routes
// Mounted at /api/qr-verify (JWT auth + rate limit at mount).
//
// GET  /api/qr-verify/price  → { ok, allowed, price, balance }
// POST /api/qr-verify/verify (multipart: photo, qr_image,
//        subject_ref, idempotency_key)
//        → gateway verification; the wallet is charged ONLY
//          when the gateway verifies (the gateway itself also
//          charges only on success). A completed order + a
//          receipt PDF (delivery document) are recorded, so
//          the work shows up in the customer's History.
//
// The gateway returns no identity — subject_ref (the NID/ID of
// the person being verified, typed by the customer) is the
// identity the result is bound to. Without it the gateway is
// never called, so no money is spent on an unbound check.
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireAuth } = require('../auth');
const { safeLog, uploadMiddleware, safeJsonArray } = require('../security');
const db = require('../db');
const serviceCredits = require('../lib/serviceCredits');
const wa = require('../utils/whatsapp');
const adapter = require('../../engines/qr-photo-verify/adapter');

const router = express.Router();
const ENGINE_ID = 'qr-photo-verify';
const UPLOAD_DIR = '/opt/all-in-one-abc-authentic/uploads/orders';

const upload = uploadMiddleware(() => ({ allowed: ['jpg', 'jpeg', 'png'], max_mb: 10 }));
const verifyUpload = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'qr_image', maxCount: 1 },
]);

function multerError(err, req, res, next) {
  if (err) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'IMAGE_TOO_LARGE'
      : err.message === 'FILE_TYPE_NOT_ALLOWED' ? 'NOT_AN_IMAGE'
      : 'UPLOAD_FAILED';
    return res.status(400).json({ error: code });
  }
  next();
}

async function getServicePrice(userId) {
  const r = await db.query(
    `SELECT id, price FROM services WHERE engine_id = $1 AND status = 'active' LIMIT 1`, [ENGINE_ID]
  );
  if (!r.rows.length) return { allowed: true, price: 0, serviceId: null };
  const serviceId = r.rows[0].id;
  const basePrice = Number(r.rows[0].price) || 0;
  const ov = await db.query(
    `SELECT custom_price, access_enabled FROM user_services WHERE user_id = $1 AND service_id = $2 LIMIT 1`,
    [userId, serviceId]
  );
  if (ov.rows.length) {
    if (ov.rows[0].access_enabled === false) return { allowed: false, price: 0, serviceId };
    const cp = ov.rows[0].custom_price;
    return { allowed: true, price: cp !== null && cp !== undefined ? Number(cp) : basePrice, serviceId };
  }
  return { allowed: true, price: basePrice, serviceId };
}

// Gateway API key: Admin → Settings (qr_verify.api_key) first,
// env QR_GATEWAY_API_KEY as fallback. Short cache — the key is
// read on almost every verify call otherwise.
let _keyCache = { at: 0, key: '' };
async function getGatewayKey() {
  if (Date.now() - _keyCache.at < 60 * 1000) return _keyCache.key;
  let key = '';
  try {
    const r = await db.query("SELECT value FROM settings WHERE key = 'qr_verify' LIMIT 1");
    const v = r.rows[0] && r.rows[0].value;
    const val = typeof v === 'string' ? JSON.parse(v) : v;
    if (val && typeof val.api_key === 'string') key = val.api_key.trim();
  } catch (e) { /* fall through to env */ }
  if (!key && process.env.QR_GATEWAY_API_KEY) key = String(process.env.QR_GATEWAY_API_KEY).trim();
  // Only cache a found key — caching "not configured" would keep
  // the service dark for a minute after the admin sets the key.
  if (key) _keyCache = { at: Date.now(), key };
  return key;
}

router.get('/price', requireAuth, async (req, res) => {
  try {
    const { allowed, price, serviceId } = await getServicePrice(req.user.id);
    const u = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const balance = u.rows[0] ? Number(u.rows[0].balance) : 0;
    res.json({ ok: true, allowed, price, balance, serviceId });
  } catch (e) {
    safeLog('[qr-verify] price error:', e.message);
    res.status(500).json({ error: 'PRICE_CHECK_FAILED' });
  }
});

// Receipt PDF (Bengali, pdfkit + bundled Noto Sans Bengali).
function buildReceiptPdf({ subjectRef, price, ref, when }) {
  return new Promise((resolve, reject) => {
    try {
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const fontReg = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansBengali-Regular.ttf');
      const fontBold = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansBengali-Bold.ttf');
      doc.registerFont('bn', fontReg);
      doc.registerFont('bn-bold', fontBold);

      doc.font('bn-bold').fontSize(20).fillColor('#6f4e2e').text('Abc Authentic');
      doc.moveDown(0.3);
      doc.font('bn-bold').fontSize(15).fillColor('#111827').text('QR + ছবি যাচাই — রসিদ');
      doc.moveDown(0.6);
      doc.strokeColor('#d6c9ae').lineWidth(1)
        .moveTo(48, doc.y).lineTo(547, doc.y).stroke();
      doc.moveDown(0.8);

      doc.font('bn').fontSize(12).fillColor('#111827');
      doc.text('ফলাফল: ✅ যাচাই সফল — ছবির ব্যক্তির সঙ্গে QR-এর মালিক মিলেছে');
      doc.moveDown(0.4);
      doc.text('বিষয় (NID/আইডি): ' + subjectRef);
      doc.moveDown(0.4);
      doc.text('তারিখ ও সময়: ' + when);
      doc.moveDown(0.4);
      doc.text('সেবা চার্জ: ৳' + price);
      doc.moveDown(0.4);
      doc.text('রেফারেন্স: ' + ref);
      doc.moveDown(1.2);
      doc.fontSize(10).fillColor('#6b7280')
        .text('এই রসিদটি Abc Authentic থেকে স্বয়ংক্রিয়ভাবে তৈরি। যাচাইটি NID Secure Gateway দিয়ে সম্পন্ন হয়েছে। প্রতিটি QR শুধু একবারই ব্যবহারযোগ্য।');
      doc.end();
    } catch (e) { reject(e); }
  });
}

router.post('/verify', requireAuth, verifyUpload, multerError, async (req, res) => {
  try {
    const photoFile = req.files && req.files.photo && req.files.photo[0];
    const qrFile = req.files && req.files.qr_image && req.files.qr_image[0];
    if (!photoFile || !qrFile) {
      return res.status(400).json({ error: 'MISSING_FILES', message: 'ছবি ও QR — দুটোই দিতে হবে।' });
    }
    const subjectRef = String((req.body && req.body.subject_ref) || '').trim().slice(0, 64);
    if (!subjectRef) {
      return res.status(400).json({
        error: 'SUBJECT_REF_REQUIRED',
        message: 'যার যাচাই করছেন তার NID নম্বর/আইডি দিন — পরিচয় ছাড়া যাচাই করা হবে না।',
      });
    }
    let idem = String((req.body && req.body.idempotency_key) || '').trim().slice(0, 80);
    if (!idem) idem = 'qr-' + crypto.randomUUID();

    // Retry of an already-completed verification → return the
    // stored outcome; never call (or pay) the gateway twice.
    const prev = await db.query(
      'SELECT id, price, data, documents FROM orders WHERE user_id = $1 AND idempotency_key = $2',
      [req.user.id, idem]
    );
    if (prev.rows.length) {
      const docs = safeJsonArray(prev.rows[0].documents);
      const receipt = docs.find((d) => d && d.type === 'delivery');
      return res.json({
        ok: true, verified: true, duplicate: true,
        charged: Number(prev.rows[0].price) || 0,
        orderId: prev.rows[0].id,
        receipt: receipt ? '/api/orders/' + prev.rows[0].id + '/documents/' + receipt.filename : null,
      });
    }

    const { allowed, price, serviceId } = await getServicePrice(req.user.id);
    if (!allowed) {
      return res.status(403).json({
        error: 'SERVICE_ACCESS_DISABLED',
        message: 'এই সেবায় আপনার প্রবেশাধিকার স্থগিত রয়েছে।',
      });
    }
    if (price > 0) {
      const u = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
      const balance = u.rows[0] ? Number(u.rows[0].balance) : 0;
      const lockedCredit = await serviceCredits.availableFor(db, req.user.id, serviceId);
      if (balance + lockedCredit < price) {
        return res.status(402).json({
          error: 'INSUFFICIENT_BALANCE',
          message: `পর্যাপ্ত ব্যালেন্স নেই। যাচাই করতে ৳${price} প্রয়োজন, বর্তমান ব্যালেন্স ৳${balance}।`,
          required: price, balance,
        });
      }
    }

    const apiKey = await getGatewayKey();
    if (!apiKey) {
      return res.status(503).json({
        error: 'GATEWAY_NOT_CONFIGURED',
        message: 'সেবাটি এখনো প্রস্তুত নয় — অ্যাডমিনকে জানান।',
      });
    }

    const result = await adapter.verify({
      apiKey,
      photo: { buffer: photoFile.buffer, name: photoFile.originalname, mime: photoFile.mimetype },
      qr: { buffer: qrFile.buffer, name: qrFile.originalname, mime: qrFile.mimetype },
    });
    if (!result.ok) {
      safeLog('[qr-verify] gateway error for user', req.user.id, ':', result.error);
      return res.status(502).json({
        error: 'GATEWAY_ERROR',
        message: 'যাচাই সার্ভারে সমস্যা হয়েছে — কোনো টাকা কাটা হয়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।',
      });
    }
    if (!result.verified) {
      // Gateway itself charged 0 for this — the customer pays 0 too.
      return res.status(422).json({
        error: 'NOT_VERIFIED',
        message: 'যাচাই সফল হয়নি: ' + result.message + ' — কোনো টাকা কাটা হয়নি।',
        gateway_charged: result.charged,
      });
    }

    // Verified → charge (once), record the order, store the receipt.
    const ref = 'qr-verify-' + idem;
    if (price > 0) {
      const alreadyPaid = await db.query(
        `SELECT 1 FROM transactions WHERE user_id = $1 AND trxid IN ($2, $3) AND status = 'approved' LIMIT 1`,
        [req.user.id, ref, ref + ':svc']
      );
      if (!alreadyPaid.rows.length) {
        try {
          await db.withTransaction((client) => serviceCredits.payForService(client, {
            userId: req.user.id, serviceId, amount: Math.abs(price), ref,
          }));
        } catch (e) {
          if (/INSUFFICIENT_BALANCE/.test(e.message)) {
            // The gateway already took its fee for this success —
            // log it loudly; the customer is not charged.
            safeLog('[qr-verify] CHARGE FAILED after gateway success (gateway charged', result.charged, ') user', req.user.id, 'ref', ref);
            return res.status(402).json({
              error: 'INSUFFICIENT_BALANCE',
              message: 'পর্যাপ্ত ব্যালেন্স নেই। অনুগ্রহ করে ওয়ালেট রিচার্জ করুন।',
            });
          }
          if (!/DUPLICATE_TRANSACTION/.test(e.message)) throw e;
        }
      }
    }

    let orderId = null;
    if (serviceId) {
      // PARTIAL idempotency index (migration 019) — the conflict
      // target must repeat its predicate (see routes/nid.js).
      const ins = await db.query(
        `INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key)
         VALUES ($1, $2, 'completed', $3, $4, $5)
         ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [req.user.id, serviceId,
         JSON.stringify({ subject_ref: subjectRef, verified: true, gateway_charged: result.charged, gateway_balance: result.remainingBalance }),
         price, idem]
      ).catch((e) => { safeLog('[qr-verify] order insert error:', e.message); return null; });
      if (ins && ins.rows.length) {
        orderId = ins.rows[0].id;
        wa.notifyServiceCompleted(db, req.user.id, 'QR + ছবি যাচাই').catch(() => {});
      } else {
        const again = await db.query(
          'SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2',
          [req.user.id, idem]
        ).catch(() => null);
        if (again && again.rows.length) orderId = again.rows[0].id;
      }
    }

    // Delivery copy: the receipt PDF lives on the order, so it
    // appears in the customer's History like every other delivery.
    let receiptUrl = null;
    if (orderId) {
      try {
        const pdf = await buildReceiptPdf({
          subjectRef, price, ref: idem,
          when: new Date().toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' }),
        });
        const fn = 'delivery-qr-' + idem.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48) + '.pdf';
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        fs.writeFileSync(path.join(UPLOAD_DIR, fn), pdf);
        const ord = await db.query('SELECT documents FROM orders WHERE id = $1', [orderId]);
        const docs = safeJsonArray(ord.rows[0] && ord.rows[0].documents);
        if (!docs.some((d) => d && d.filename === fn)) {
          docs.push({
            type: 'delivery', filename: fn, originalname: 'qr-verification-receipt.pdf',
            uploaded_at: new Date().toISOString(), uploaded_by: 'admin',
          });
          await db.query('UPDATE orders SET documents = $1 WHERE id = $2', [JSON.stringify(docs), orderId]);
        }
        receiptUrl = '/api/orders/' + orderId + '/documents/' + fn;
      } catch (e) { safeLog('[qr-verify] receipt store error:', e.message); }
    }

    const u2 = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    res.json({
      ok: true, verified: true,
      message: 'যাচাই সফল হয়েছে — ছবির ব্যক্তির সঙ্গে QR-এর মালিক মিলেছে।',
      charged: price,
      balance: u2.rows[0] ? Number(u2.rows[0].balance) : null,
      orderId, receipt: receiptUrl,
    });
  } catch (e) {
    safeLog('[qr-verify] verify route error:', e.message);
    res.status(500).json({ error: 'VERIFY_FAILED' });
  }
});

module.exports = router;
