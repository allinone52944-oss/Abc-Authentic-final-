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
// The gateway returns no identity. subject_ref is OPTIONAL
// (owner's decision, 2026-10-21 — the form is just QR + photo);
// when a client sends one it is recorded on the order + receipt,
// otherwise the result is bound to nothing but the receipt.
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
const push = require('../utils/push');
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
// Test hook: lets route tests keep the key cache hermetic between
// cases (never called in production).
router.__resetKeyCache = () => { _keyCache = { at: 0, key: '' }; };

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

// Bengali rendering of the gateway's failure message — the raw
// gateway text is English/system-flavoured and never shown to
// the customer as-is.
function failureReasonBn(gatewayMessage) {
  const m = String(gatewayMessage || '');
  if (/record not found/i.test(m)) return 'QR-এর সঙ্গে মিলিয়ে কোনো রেকর্ড পাওয়া যায়নি';
  if (/verification request failed/i.test(m)) return 'এই QRটি আগেই ব্যবহৃত হয়েছে বা এর মেয়াদ শেষ — নতুন QR লাগবে';
  return 'ছবির ব্যক্তির সঙ্গে QR-এর তথ্য মেলেনি';
}

// Premium receipt PDF (Bengali, pdfkit + bundled Noto Sans
// Bengali) — one card design for both outcomes: a drawn seal
// (green tick / red cross, vector-drawn so no glyph is missing
// from the Bengali font), a details table and, on failure, a
// bold "no charge taken" line. Approved sample design,
// 2026-10-22.
function buildReceiptPdf({ outcome, subjectRef, price, reason, ref, when }) {
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

      const ok = outcome !== 'failed';
      const accent = ok ? '#16a34a' : '#dc2626';
      const X = 48; const W = 499;

      // The bundled Noto Sans Bengali has NO Latin glyphs — any
      // Latin run drawn in it prints as boxes (the old receipt's
      // brand line + reference suffered exactly this). Latin-only
      // values therefore go in pdfkit's built-in Helvetica, and
      // mixed Bengali strings spell QR out in Bengali script.
      const bnTxt = (s) => String(s == null ? '' : s).replace(/QR/g, 'কিউআর');
      const valFont = (v, bold) => (/[A-Za-z]/.test(String(v))
        ? (bold ? 'Helvetica-Bold' : 'Helvetica')
        : (bold ? 'bn-bold' : 'bn'));
      const whenBn = bnTxt(when).replace('AM', 'পূর্বাহ্ন').replace('PM', 'অপরাহ্ন');

      // Header (brand name is Latin → Helvetica)
      doc.font('Helvetica-Bold').fontSize(19).fillColor('#6f4e2e').text('Abc Authentic', X, 46, { width: 300 });
      doc.font('bn').fontSize(10).fillColor('#6b7280')
        .text('ডিজিটাল রসিদ', X, 52, { width: W, align: 'right' });
      doc.strokeColor('#d6c9ae').lineWidth(1.4).moveTo(X, 82).lineTo(X + W, 82).stroke();

      // Card
      doc.roundedRect(X, 98, W, 272, 14).fillAndStroke('#fffdf8', '#d6c9ae');

      // Seal (vector-drawn tick / cross inside a filled circle)
      doc.circle(86, 148, 25).fill(accent);
      doc.strokeColor('#ffffff').lineWidth(4.5).lineCap('round');
      if (ok) {
        doc.moveTo(75, 148).lineTo(83, 156).lineTo(98, 139).stroke();
      } else {
        doc.moveTo(77, 139).lineTo(95, 157).stroke();
        doc.moveTo(95, 139).lineTo(77, 157).stroke();
      }

      // Title + subtitle
      doc.font('bn-bold').fontSize(16.5).fillColor(accent)
        .text(ok ? 'যাচাই সফল হয়েছে' : 'যাচাই সফল হয়নি', 126, 128, { width: 400 });
      doc.font('bn').fontSize(11.5).fillColor('#374151')
        .text(bnTxt(ok
          ? 'ছবির ব্যক্তির সঙ্গে QR-এর মালিকের মিল পাওয়া গেছে।'
          : ('কারণ: ' + (reason || 'ছবির ব্যক্তির সঙ্গে QR-এর তথ্য মেলেনি'))),
          126, 154, { width: 398 });

      // Divider inside the card
      doc.strokeColor('#eadfc8').lineWidth(1).moveTo(72, 198).lineTo(523, 198).stroke();

      // Details rows
      const rows = [
        ['বিষয় (আইডি)', subjectRef || '—', false],
        ['তারিখ ও সময়', whenBn, false],
        ['সেবা চার্জ', ok ? ('৳' + price) : '৳০ — কোনো টাকা কাটা হয়নি', true],
        ['রেফারেন্স', ref, false],
      ];
      rows.forEach(([label, value, bold], i) => {
        const y = 216 + i * 34;
        doc.font('bn').fontSize(11).fillColor('#6b7280').text(label, 72, y, { width: 138 });
        doc.font(valFont(value, bold)).fontSize(11.5)
          .fillColor(bold ? accent : '#111827')
          .text(String(value), 218, y, { width: 305 });
      });

      // Footer (all-Bengali wording — Latin would print as boxes)
      doc.font('bn').fontSize(9.5).fillColor('#6b7280')
        .text(bnTxt('এই রসিদটি স্বয়ংক্রিয়ভাবে তৈরি। যাচাইটি জাতীয় পরিচয়পত্র তথ্যভান্ডারের সঙ্গে মিলিয়ে সম্পন্ন হয়েছে। প্রতিটি QR শুধু একবারই ব্যবহারযোগ্য।'),
          X, 392, { width: W });
      if (!ok) {
        doc.text(bnTxt('ব্যর্থ যাচাইয়ে কোনো চার্জ কাটা হয়নি — নতুন QR কোড সংগ্রহ করে আবার চেষ্টা করুন।'),
          X, 424, { width: W });
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

// Store a receipt PDF as the order's delivery document, so it
// appears in the customer's History like every other delivery.
async function storeReceipt(orderId, fn, pdfArgs) {
  const pdf = await buildReceiptPdf(pdfArgs);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, fn), pdf);
  const ord = await db.query('SELECT documents FROM orders WHERE id = $1', [orderId]);
  const docs = safeJsonArray(ord.rows[0] && ord.rows[0].documents);
  if (!docs.some((d) => d && d.filename === fn)) {
    docs.push({
      type: 'delivery', filename: fn,
      originalname: pdfArgs.outcome === 'failed'
        ? 'qr-verification-failed-receipt.pdf' : 'qr-verification-receipt.pdf',
      uploaded_at: new Date().toISOString(), uploaded_by: 'admin',
    });
    await db.query('UPDATE orders SET documents = $1 WHERE id = $2', [JSON.stringify(docs), orderId]);
  }
  return '/api/orders/' + orderId + '/documents/' + fn;
}

router.post('/verify', requireAuth, verifyUpload, multerError, async (req, res) => {
  try {
    const photoFile = req.files && req.files.photo && req.files.photo[0];
    const qrFile = req.files && req.files.qr_image && req.files.qr_image[0];
    if (!photoFile || !qrFile) {
      return res.status(400).json({ error: 'MISSING_FILES', message: 'ছবি ও QR — দুটোই দিতে হবে।' });
    }
    // subject_ref is OPTIONAL (owner's decision, 2026-10-21: "শুধু
    // QR আর photo দিলেই হবে"). When a client still sends one it is
    // recorded on the order + receipt; when absent, the receipt
    // shows '—' and the verification proceeds on QR + photo alone.
    const subjectRef = String((req.body && req.body.subject_ref) || '').trim().slice(0, 64);
    let idem = String((req.body && req.body.idempotency_key) || '').trim().slice(0, 80);
    if (!idem) idem = 'qr-' + crypto.randomUUID();

    // Retry of an already-recorded verification → return the
    // stored outcome; never call (or pay) the gateway twice.
    // A FAILED attempt is recorded too (premium flow, 2026-10-22)
    // — its replay returns the stored failure + receipt.
    const prev = await db.query(
      'SELECT id, price, status, data, documents FROM orders WHERE user_id = $1 AND idempotency_key = $2',
      [req.user.id, idem]
    );
    if (prev.rows.length) {
      const docs = safeJsonArray(prev.rows[0].documents);
      const receipt = docs.find((d) => d && d.type === 'delivery');
      const receiptUrl = receipt ? '/api/orders/' + prev.rows[0].id + '/documents/' + receipt.filename : null;
      if (prev.rows[0].status === 'failed') {
        return res.status(422).json({
          error: 'NOT_VERIFIED', verified: false, duplicate: true,
          message: 'যাচাই সফল হয়নি — কোনো টাকা কাটা হয়নি।',
          charged: 0,
          orderId: prev.rows[0].id,
          receipt: receiptUrl,
        });
      }
      return res.json({
        ok: true, verified: true, duplicate: true,
        charged: Number(prev.rows[0].price) || 0,
        orderId: prev.rows[0].id,
        receipt: receiptUrl,
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
      // Gateway itself charged 0 for this — the customer pays 0
      // too. Premium flow (owner-approved sample, 2026-10-22):
      // the failure is still a recorded outcome — a 'failed'
      // order carrying a failure receipt (→ History), a
      // WhatsApp notice to the customer and a push to the
      // admins. Notifications fire only on the FIRST insert.
      const reasonBn = failureReasonBn(result.message);
      const idemSlug = idem.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48);
      let orderId = null;
      let receiptUrl = null;
      if (serviceId) {
        const ins = await db.query(
          `INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key)
           VALUES ($1, $2, 'failed', $3, 0, $4)
           ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING id`,
          [req.user.id, serviceId,
           JSON.stringify({ subject_ref: subjectRef || null, verified: false, reason: String(result.message || '').slice(0, 200), gateway_charged: 0 }),
           idem]
        ).catch((e) => { safeLog('[qr-verify] failed-order insert error:', e.message); return null; });
        if (ins && ins.rows.length) {
          orderId = ins.rows[0].id;
          wa.notifyServiceFailed(db, req.user.id, 'QR + ছবি যাচাই', reasonBn).catch(() => {});
          push.notifyAdmins(db, '❌ QR যাচাই ব্যর্থ',
            'একটি QR + ছবি যাচাই সফল হয়নি — কোনো চার্জ কাটা হয়নি।', '/admin.html').catch(() => {});
          try {
            receiptUrl = await storeReceipt(orderId, 'delivery-qr-failed-' + idemSlug + '.pdf', {
              outcome: 'failed', subjectRef, price: 0, reason: reasonBn, ref: idem,
              when: new Date().toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' }),
            });
          } catch (e) { safeLog('[qr-verify] failure receipt store error:', e.message); }
        } else {
          const again = await db.query(
            'SELECT id, documents FROM orders WHERE user_id = $1 AND idempotency_key = $2',
            [req.user.id, idem]
          ).catch(() => null);
          if (again && again.rows.length) {
            orderId = again.rows[0].id;
            const docs = safeJsonArray(again.rows[0].documents);
            const receipt = docs.find((d) => d && d.type === 'delivery');
            if (receipt) receiptUrl = '/api/orders/' + orderId + '/documents/' + receipt.filename;
          }
        }
      }
      return res.status(422).json({
        error: 'NOT_VERIFIED',
        verified: false,
        message: 'যাচাই সফল হয়নি: ' + reasonBn + ' — কোনো টাকা কাটা হয়নি।',
        charged: 0,
        gateway_charged: result.charged,
        orderId, receipt: receiptUrl,
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
         JSON.stringify({ subject_ref: subjectRef || null, verified: true, gateway_charged: result.charged, gateway_balance: result.remainingBalance }),
         price, idem]
      ).catch((e) => { safeLog('[qr-verify] order insert error:', e.message); return null; });
      if (ins && ins.rows.length) {
        orderId = ins.rows[0].id;
        wa.notifyServiceCompleted(db, req.user.id, 'QR + ছবি যাচাই').catch(() => {});
        push.notifyAdmins(db, '✅ QR যাচাই সফল',
          `একটি QR + ছবি যাচাই সফলভাবে সম্পন্ন হয়েছে — চার্জ ৳${price}।`, '/admin.html').catch(() => {});
      } else {
        const again = await db.query(
          'SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2',
          [req.user.id, idem]
        ).catch(() => null);
        if (again && again.rows.length) orderId = again.rows[0].id;
      }
    }

    // Delivery copy: the premium receipt PDF lives on the order,
    // so it appears in the customer's History like every other
    // delivery.
    let receiptUrl = null;
    if (orderId) {
      try {
        receiptUrl = await storeReceipt(orderId,
          'delivery-qr-' + idem.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48) + '.pdf', {
            outcome: 'success', subjectRef, price, ref: idem,
            when: new Date().toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' }),
          });
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
