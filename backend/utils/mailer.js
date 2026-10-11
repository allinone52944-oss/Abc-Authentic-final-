// ============================================================
// All In One (Abc Authentic) - Mailer (Phase 3)
// nodemailer + Gmail SMTP from .env. Coffee-themed Bengali HTML.
// Never throws to callers: returns { ok, error }.
// ============================================================
const nodemailer = require('nodemailer');
const { safeLog } = require('../security');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

function isConfigured() {
  return !!getTransporter();
}

function emailShell(innerHtml) {
  return `<!DOCTYPE html><html lang="bn"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#1a120b;font-family:'Noto Sans Bengali',Arial,sans-serif;">
<div style="max-width:480px;margin:0 auto;padding:32px 20px;">
  <div style="background:linear-gradient(135deg,#2b1d14,#3d2b1f);border:1px solid #d4af37;border-radius:16px;padding:32px 28px;text-align:center;box-shadow:0 8px 32px rgba(212,175,55,.15);">
    <div style="font-size:40px;margin-bottom:8px;">☕</div>
    <div style="color:#d4af37;font-size:20px;font-weight:bold;letter-spacing:2px;">ALL IN ONE</div>
    <div style="color:#c9a961;font-size:12px;letter-spacing:4px;margin-bottom:4px;">ABC AUTHENTIC</div>
    <div style="color:#8a7a5f;font-size:12px;margin-bottom:24px;">বিশ্বাস ও সেবার ঠিকানা</div>
    ${innerHtml}
  </div>
  <p style="text-align:center;color:#5a4f3d;font-size:11px;margin-top:16px;">© All In One (Abc Authentic)</p>
</div>
</body></html>`;
}

function verificationEmailHtml(link, name) {
  const safeName = String(name || 'প্রিয় গ্রাহক').replace(/[<>&"]/g, '');
  return emailShell(`
    <div style="color:#f5ead6;font-size:16px;margin-bottom:8px;">আসসালামু আলাইকুম, ${safeName}!</div>
    <p style="color:#c9bfa8;font-size:14px;line-height:1.7;">রেজিস্ট্রেশন সম্পন্ন করতে আপনার ইমেইল যাচাই করুন। নিচের বাটনে ক্লিক করুন — লিংকটি <b style="color:#d4af37;">২৪ ঘণ্টা</b> কার্যকর থাকবে।</p>
    <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#d4af37,#b8941f);color:#1a120b;font-weight:bold;font-size:16px;padding:14px 36px;border-radius:12px;text-decoration:none;margin:16px 0;">✅ ইমেইল যাচাই করুন</a>
    <p style="color:#8a7a5f;font-size:12px;line-height:1.6;">বাটনে ক্লিক না হলে এই লিংকটি ব্রাউজারে পেস্ট করুন:<br><span style="color:#c9a961;word-break:break-all;">${link}</span></p>
    <p style="color:#8a7a5f;font-size:12px;">আপনি রেজিস্টার না করে থাকলে এই ইমেইল উপেক্ষা করুন।</p>
  `);
}

function passwordResetEmailHtml(link, name) {
  const safeName = String(name || 'প্রিয় গ্রাহক').replace(/[<>&"]/g, '');
  return emailShell(`
    <div style="color:#f5ead6;font-size:16px;margin-bottom:8px;">আসসালামু আলাইকুম, ${safeName}!</div>
    <p style="color:#c9bfa8;font-size:14px;line-height:1.7;">পাসওয়ার্ড রিসেটের অনুরোধ পেয়েছি। নতুন পাসওয়ার্ড সেট করতে নিচের বাটনে ক্লিক করুন — লিংকটি <b style="color:#d4af37;">১ ঘণ্টা</b> কার্যকর থাকবে।</p>
    <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#d4af37,#b8941f);color:#1a120b;font-weight:bold;font-size:16px;padding:14px 36px;border-radius:12px;text-decoration:none;margin:16px 0;">🔑 পাসওয়ার্ড রিসেট করুন</a>
    <p style="color:#8a7a5f;font-size:12px;line-height:1.6;">বাটনে ক্লিক না হলে এই লিংকটি ব্রাউজারে পেস্ট করুন:<br><span style="color:#c9a961;word-break:break-all;">${link}</span></p>
    <p style="color:#8a7a5f;font-size:12px;">আপনি এই অনুরোধ না করে থাকলে এই ইমেইল উপেক্ষা করুন — আপনার পাসওয়ার্ড অপরিবর্তিত থাকবে।</p>
  `);
}
function otpEmailHtml(code, name) {
  const safeName = String(name || 'প্রিয় গ্রাহক').replace(/[<>&"]/g, '');
  return `<!DOCTYPE html><html lang="bn"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#1a120b;font-family:'Noto Sans Bengali',Arial,sans-serif;">
<div style="max-width:480px;margin:0 auto;padding:32px 20px;">
  <div style="background:linear-gradient(135deg,#2b1d14,#3d2b1f);border:1px solid #d4af37;border-radius:16px;padding:32px 28px;text-align:center;box-shadow:0 8px 32px rgba(212,175,55,.15);">
    <div style="font-size:40px;margin-bottom:8px;">☕</div>
    <div style="color:#d4af37;font-size:20px;font-weight:bold;letter-spacing:2px;">ALL IN ONE</div>
    <div style="color:#c9a961;font-size:12px;letter-spacing:4px;margin-bottom:4px;">ABC AUTHENTIC</div>
    <div style="color:#8a7a5f;font-size:12px;margin-bottom:24px;">বিশ্বাস ও সেবার ঠিকানা</div>
    <div style="color:#f5ead6;font-size:16px;margin-bottom:8px;">আসসালামু আলাইকুম, ${safeName}!</div>
    <p style="color:#c9bfa8;font-size:14px;line-height:1.7;">আপনার ইমেইল যাচাই করতে নিচের OTP কোডটি ব্যবহার করুন। এই কোডটি <b style="color:#d4af37;">৫ মিনিট</b> পর্যন্ত কার্যকর থাকবে।</p>
    <div style="background:#1a120b;border:2px dashed #d4af37;border-radius:12px;padding:18px;margin:20px 0;">
      <div style="color:#d4af37;font-size:38px;font-weight:bold;letter-spacing:10px;font-family:monospace;">${code}</div>
    </div>
    <p style="color:#8a7a5f;font-size:12px;">এই কোডটি কাউকে শেয়ার করবেন না।<br>আপনি এই অনুরোধ না করে থাকলে এই ইমেইল উপেক্ষা করুন।</p>
  </div>
  <p style="text-align:center;color:#5a4f3d;font-size:11px;margin-top:16px;">© All In One (Abc Authentic)</p>
</div>
</body></html>`;
}

async function sendMail({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) {
    safeLog('[mailer] SMTP not configured, skipping email to', to);
    return { ok: false, error: 'SMTP_NOT_CONFIGURED' };
  }
  try {
    await t.sendMail({
      from: `"${process.env.SMTP_FROM || 'All In One'}" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
      text: text || undefined,
    });
    return { ok: true };
  } catch (e) {
    safeLog('[mailer] send failed:', e.message);
    return { ok: false, error: 'SEND_FAILED' };
  }
}

async function sendOtpEmail(to, code, name) {
  return sendMail({
    to,
    subject: 'আপনার OTP কোড - All In One (Abc Authentic)',
    html: otpEmailHtml(code, name),
    text: `আপনার OTP কোড: ${code} (৫ মিনিট কার্যকর)`,
  });
}

async function sendVerificationEmail(to, link, name) {
  return sendMail({
    to,
    subject: 'ইমেইল যাচাই করুন - All In One (Abc Authentic)',
    html: verificationEmailHtml(link, name),
    text: `ইমেইল যাচাই করতে এই লিংকে যান (২৪ ঘণ্টা কার্যকর): ${link}`,
  });
}

async function sendPasswordResetEmail(to, link, name) {
  return sendMail({
    to,
    subject: 'পাসওয়ার্ড রিসেট - All In One (Abc Authentic)',
    html: passwordResetEmailHtml(link, name),
    text: `পাসওয়ার্ড রিসেট করতে এই লিংকে যান (১ ঘণ্টা কার্যকর): ${link}`,
  });
}

module.exports = {
  sendMail,
  sendOtpEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  isConfigured,
  otpEmailHtml,
  verificationEmailHtml,
  passwordResetEmailHtml,
};
