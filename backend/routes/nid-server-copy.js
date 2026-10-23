// ============================================================
// All In One (Abc Authentic) - NID Server Copy engine routes
// Mounted at /api/nid-server-copy (JWT auth + rate limit at mount).
//
// A completely separate engine from nid-replica: the customer
// logs in with their OWN NID portal (services.nidw.gov.bd/nid-pub)
// ID + password; the portal's image captcha is relayed to the
// customer; after login the engine collects profile + photo (and
// the official download when the account has one) and produces
// the NID card PDF with the same output logic as the NID card
// engine. The portal password is never stored or logged, and the
// wallet is charged ONLY after the card PDF has been built.
//
// GET  /api/nid-server-copy/price   → { ok, allowed, price, balance }
// POST /api/nid-server-copy/start   { username, password }
//                                   → { ok, sessionId, captcha }
// POST /api/nid-server-copy/captcha { sessionId, captcha }
//                                   → { ok, jobId, hasDownload,
//                                       holderName }
//                                   | { error, captcha? } on retry
// POST /api/nid-server-copy/deliver { jobId, kind: 'card'|'server' }
//                                   → application/pdf (charged per
//                                     kind, once per job+kind)
//
// After login the customer gets TWO options (owner's flow,
// 2026-10-23): the NID card and the server copy. Each "create"
// click builds that document and charges for it. Card rule:
// directly downloadable accounts get the official portal PDF
// as-is; non-downloadable ones are rendered with the NID card
// engine's output logic. The server copy is generated from the
// profile data in the EC report layout (all fields filled).
// ============================================================
const express = require('express');
const { requireAuth } = require('../auth');
const { safeLog, safeJsonArray } = require('../security');
const db = require('../db');
const serviceCredits = require('../lib/serviceCredits');
const wa = require('../utils/whatsapp');
const push = require('../utils/push');
const engine = require('../../engines/nid-server-copy/index');
const { buildServerCopyPdf } = require('../lib/serverCopyPdf');

const router = express.Router();
const LABEL = 'এনআইডি সার্ভার কপি';
const PAGE = '/nid-server-copy.html';

async function getServicePrice(userId) {
  const r = await db.query(
    `SELECT id, price FROM services WHERE engine_id = 'nid-server-copy' AND status = 'active' LIMIT 1`
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
      serviceId,
    };
  }
  return { allowed: true, price: basePrice, serviceId };
}

async function balanceOf(userId) {
  const u = await db.query('SELECT balance FROM users WHERE id = $1', [userId]);
  return u.rows[0] ? Number(u.rows[0].balance) : 0;
}

router.get('/price', requireAuth, async (req, res) => {
  try {
    const { allowed, price, serviceId } = await getServicePrice(req.user.id);
    const balance = await balanceOf(req.user.id);
    res.json({ ok: true, allowed, price, balance, serviceId });
  } catch (e) {
    safeLog('[nid-server-copy] price error:', e.message);
    res.status(500).json({ error: 'PRICE_CHECK_FAILED' });
  }
});

router.post('/start', requireAuth, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'MISSING_CREDENTIALS' });
    }

    const { allowed, price, serviceId } = await getServicePrice(req.user.id);
    if (!allowed) {
      return res.status(403).json({
        error: 'SERVICE_ACCESS_DISABLED',
        message: 'এই সেবায় আপনার প্রবেশাধিকার স্থগিত রয়েছে।',
      });
    }
    if (price > 0) {
      const balance = await balanceOf(req.user.id);
      const lockedCredit = await serviceCredits.availableFor(db, req.user.id, serviceId);
      if (balance + lockedCredit < price) {
        return res.status(402).json({
          error: 'INSUFFICIENT_BALANCE',
          message: `পর্যাপ্ত ব্যালেন্স নেই। কার্ড তৈরি করতে ৳${price} প্রয়োজন, বর্তমান ব্যালেন্স ৳${balance}।`,
          required: price,
          balance,
        });
      }
    }

    const r = await engine.startSession(req.user.id, username, password);
    if (!r.ok) {
      if (r.error === 'PORTAL_CHANGED' || r.error === 'CAPTCHA_NOT_FOUND' || r.error === 'PORTAL_UNREACHABLE') {
        push.notifyAdmins(db, '⚠️ NID সার্ভার কপি পোর্টাল সমস্যা',
          'NID পোর্টাল লগইন ধাপে সমস্যা (' + String(r.error) + ')।', '/admin.html').catch(() => {});
      }
      return res.status(422).json({ error: r.error });
    }
    res.json({ ok: true, sessionId: r.sessionId, captcha: r.captcha });
  } catch (e) {
    safeLog('[nid-server-copy] start error:', e.message);
    res.status(500).json({ error: 'START_FAILED' });
  }
});

router.post('/captcha', requireAuth, async (req, res) => {
  try {
    const { sessionId, captcha } = req.body || {};
    if (!sessionId || !captcha) {
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    }

    const r = await engine.submitCaptcha(sessionId, req.user.id, captcha);
    if (!r.ok) {
      if (r.error === 'LOGIN_FAILED' && r.retry) {
        return res.status(422).json({ error: 'LOGIN_FAILED', message: r.message || '', captcha: r.captcha, retry: true });
      }
      if (r.error === 'LOGIN_FAILED') {
        return res.status(422).json({ error: 'LOGIN_FAILED', message: r.message || '', final: true });
      }
      if (r.error === 'PORTAL_ERROR' || r.error === 'PORTAL_CHANGED') {
        push.notifyAdmins(db, '⚠️ NID সার্ভার কপি পোর্টাল সমস্যা',
          'NID পোর্টাল লগইনের পর ধাপে সমস্যা (' + String(r.error) + ')।', '/admin.html').catch(() => {});
      }
      return res.status(r.error === 'SESSION_EXPIRED' ? 410 : 422).json({ error: r.error });
    }

    // Login done, data collected as a job. NO charge yet — the
    // customer now chooses: NID card, server copy, or both.
    res.json({ ok: true, jobId: r.jobId, hasDownload: !!r.hasDownload, holderName: r.holderName || '' });
  } catch (e) {
    safeLog('[nid-server-copy] captcha route error:', e.message);
    push.notifyAdmins(db, '⚠️ ' + LABEL + ' সার্ভার ত্রুটি',
      'NID সার্ভার কপি রাউটে সার্ভার ত্রুটি: ' + String(e.message || '').slice(0, 120), '/admin.html').catch(() => {});
    res.status(500).json({ error: 'BUILD_FAILED' });
  }
});

/** Build one document ('card' | 'server') from a collected job. */
async function buildDocument(job, kind) {
  if (kind === 'card') {
    // Owner's rule: directly downloadable -> the official portal
    // PDF as-is. Not downloadable -> the NID card engine's output
    // logic renders profile data + photo through its pipeline.
    if (job.downloadPdf) {
      return { ok: true, pdfBuffer: job.downloadPdf, fields: {}, via: 'download' };
    }
    const inputData = engine.profileMap.buildInputData(job.pairs || []);
    if (!engine.profileMap.hasCoreData(inputData)) {
      return { ok: false, error: 'PROFILE_INCOMPLETE' };
    }
    const r = await engine.renderFromProfile(inputData, job.photo ? job.photo.buffer : null);
    if (!r.ok) return { ok: false, error: r.error || 'RENDER_FAILED' };
    return { ok: true, pdfBuffer: r.pdfBuffer, fields: r.fields, via: 'profile' };
  }
  // Server copy: EC report layout, all profile fields filled.
  const inputData = engine.profileMap.buildInputData(job.pairs || []);
  if (!engine.profileMap.hasCoreData(inputData)) {
    return { ok: false, error: 'PROFILE_INCOMPLETE' };
  }
  try {
    const pdfBuffer = await buildServerCopyPdf(inputData, job.photo ? job.photo.buffer : null);
    if (!pdfBuffer || pdfBuffer.length < 500) return { ok: false, error: 'RENDER_FAILED' };
    return { ok: true, pdfBuffer, fields: inputData, via: 'server-copy' };
  } catch (e) {
    safeLog('[nid-server-copy] server copy build error:', e.message);
    return { ok: false, error: 'RENDER_FAILED' };
  }
}

router.post('/deliver', requireAuth, async (req, res) => {
  try {
    const { jobId, kind } = req.body || {};
    if (!jobId || (kind !== 'card' && kind !== 'server')) {
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    }
    const job = engine.getJob(jobId, req.user.id);
    if (!job) {
      return res.status(410).json({ error: 'JOB_EXPIRED' });
    }

    const kindLabel = kind === 'card' ? 'এনআইডি কার্ড' : 'এনআইডি সার্ভার কপি';
    const built = await buildDocument(job, kind);
    if (!built.ok) {
      wa.notifyServiceFailed(db, req.user.id, kindLabel,
        'তৈরি করা যায়নি',
        'কিছুক্ষণ পর আবার চেষ্টা করুন। সহায়তা লাগলে আমাদের সাপোর্টে যোগাযোগ করুন।').catch(() => {});
      push.notifyUser(db, req.user.id, '❌ ' + kindLabel + ' তৈরি ব্যর্থ',
        'আপনার ডকুমেন্টটি তৈরি করা যায়নি — কোনো টাকা কাটা হয়নি।', PAGE).catch(() => {});
      push.notifyAdmins(db, '❌ ' + kindLabel + ' তৈরি ব্যর্থ',
        'একটি ডকুমেন্ট তৈরি করা যায়নি (' + String(built.error || 'BUILD_ERROR') + ') — কোনো চার্জ কাটা হয়নি।', '/admin.html').catch(() => {});
      return res.status(422).json({ error: built.error });
    }

    const { price, serviceId } = await getServicePrice(req.user.id);
    const ref = 'nidsc-' + jobId + '-' + kind;

    if (price > 0 && serviceId) {
      const alreadyPaid = await db.query(
        `SELECT 1 FROM transactions WHERE user_id = $1 AND trxid IN ($2, $3) AND status = 'approved' LIMIT 1`,
        [req.user.id, ref, ref + ':svc']
      );
      if (!alreadyPaid.rows.length) {
        try {
          await db.withTransaction((client) => serviceCredits.payForService(client, {
            userId: req.user.id, serviceId, amount: Math.abs(price), ref,
          }));
          safeLog('[nid-server-copy] charged', price, 'for user', req.user.id, 'kind', kind);
        } catch (e) {
          if (/INSUFFICIENT_BALANCE/.test(e.message)) {
            return res.status(402).json({
              error: 'INSUFFICIENT_BALANCE',
              message: 'পর্যাপ্ত ব্যালেন্স নেই। অনুগ্রহ করে ওয়ালেট রিচার্জ করুন।',
            });
          }
          if (!/DUPLICATE_TRANSACTION/.test(e.message)) throw e;
        }
      }
    }

    if (serviceId) {
      // Partial idempotency index (migration 019) — the ON CONFLICT
      // target must repeat its predicate (same lesson as nid.js).
      const ins = await db.query(
        `INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key)
         VALUES ($1, $2, 'completed', $3, $4, $5)
         ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [req.user.id, serviceId, JSON.stringify(built.fields || {}), price, ref]
      ).catch((e) => { safeLog('[nid-server-copy] order insert error:', e.message); return null; });

      if (ins && ins.rows.length) {
        wa.notifyServiceCompleted(db, req.user.id, kindLabel).catch(() => {});
        push.notifyUser(db, req.user.id, '✅ ' + kindLabel + ' তৈরি হয়েছে',
          'আপনার ডকুমেন্টটি তৈরি হয়েছে — ইতিহাস থেকে যেকোনো সময় ডাউনলোড করতে পারবেন।', '/history.html').catch(() => {});
        push.notifyAdmins(db, '✅ ' + kindLabel + ' তৈরি হয়েছে',
          `একটি ${kindLabel} সফলভাবে তৈরি হয়েছে — চার্জ ৳${price}।`, '/admin.html').catch(() => {});
      }

      // Delivery copy for History (same pattern as nid.js).
      try {
        const ord = await db.query(
          'SELECT id, documents FROM orders WHERE user_id = $1 AND idempotency_key = $2',
          [req.user.id, ref]
        );
        if (ord.rows.length) {
          const fn = 'delivery-nidsc-' + String(jobId).replace(/[^a-zA-Z0-9-]/g, '') + '-' + kind + '.pdf';
          const docs = safeJsonArray(ord.rows[0].documents);
          if (!docs.some((d) => d && d.filename === fn)) {
            const fsx = require('fs');
            const pathx = require('path');
            const dir = '/opt/all-in-one-abc-authentic/uploads/orders';
            fsx.mkdirSync(dir, { recursive: true });
            fsx.writeFileSync(pathx.join(dir, fn), built.pdfBuffer);
            docs.push({
              type: 'delivery', filename: fn, originalname: kind === 'card' ? 'nid-card.pdf' : 'nid-server-copy.pdf',
              uploaded_at: new Date().toISOString(), uploaded_by: 'admin',
            });
            await db.query('UPDATE orders SET documents = $1 WHERE id = $2', [JSON.stringify(docs), ord.rows[0].id]);
          }
        } else {
          safeLog('[nid-server-copy] delivery copy skipped: order row missing for job', jobId, kind);
        }
      } catch (e) { safeLog('[nid-server-copy] delivery copy store error:', e.message); }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + (kind === 'card' ? 'nid-card.pdf' : 'nid-server-copy.pdf') + '"');
    res.setHeader('Content-Length', built.pdfBuffer.length);
    res.send(built.pdfBuffer);
  } catch (e) {
    safeLog('[nid-server-copy] deliver route error:', e.message);
    push.notifyAdmins(db, '⚠️ ' + LABEL + ' সার্ভার ত্রুটি',
      'NID সার্ভার কপি রাউটে সার্ভার ত্রুটি: ' + String(e.message || '').slice(0, 120), '/admin.html').catch(() => {});
    res.status(500).json({ error: 'BUILD_FAILED' });
  }
});

module.exports = router;
