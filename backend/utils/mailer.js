// ============================================================
// All In One (Abc Authentic) - Mailer (Phase 3)
// Existing nodemailer SMTP with shared branded Bengali account emails.
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

// Email-safe semantic palette shared by every account email.
const palette = {
  canvas: '#f1f5f3', paper: '#ffffff', brand: '#075e46', ink: '#172b24',
  muted: '#566b61', border: '#dce6e0', accent: '#e8bd57', soft: '#edf6f0',
};

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function emailShell(innerHtml, preheader) {
  const c = palette;
  return `<!DOCTYPE html><html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>All In One (Abc Authentic)</title></head>
<body style="margin:0;padding:0;background:${c.canvas};font-family:'Noto Sans Bengali','Nirmala UI',Arial,sans-serif;color:${c.ink};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${c.canvas};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:${c.paper};border:1px solid ${c.border};border-radius:8px;overflow:hidden;">
<tr><td style="padding:28px 24px;background:${c.brand};border-bottom:4px solid ${c.accent};"><div style="font-size:22px;line-height:1.4;font-weight:700;color:${c.paper};">All In One</div><div style="margin-top:4px;font-size:13px;line-height:1.6;color:${c.paper};">Abc Authentic · বিশ্বাস ও সেবার ঠিকানা</div></td></tr>
<tr><td style="padding:28px 24px;">${innerHtml}</td></tr>
<tr><td style="padding:20px 24px;border-top:1px solid ${c.border};font-size:12px;line-height:1.8;color:${c.muted};">নিরাপত্তার জন্য আপনার পাসওয়ার্ড বা যাচাই কোড কাউকে দেবেন না।<br>All In One (Abc Authentic)</td></tr>
</table>
<p style="margin:18px 0 0;font-size:11px;line-height:1.7;color:${c.muted};">এটি আপনার অ্যাকাউন্টের নিরাপত্তা-সংক্রান্ত ইমেইল।</p>
</td></tr></table></body></html>`;
}

function greeting(name) {
  return `<p style="margin:0 0 16px;font-size:14px;line-height:1.8;color:${palette.muted};">আসসালামু আলাইকুম, ${escapeHtml(name || 'প্রিয় গ্রাহক')}!</p>`;
}

function linkEmail({ link, name, title, description, button, expiry, safety, preheader }) {
  const c = palette;
  const safeLink = escapeHtml(link);
  return emailShell(`
    ${greeting(name)}
    <h1 style="margin:0 0 12px;font-size:24px;line-height:1.5;font-weight:700;color:${c.ink};">${title}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.9;color:${c.muted};">${description}</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="${c.brand}" style="border-radius:6px;text-align:center;"><a href="${safeLink}" style="display:inline-block;padding:15px 22px;font-size:15px;font-weight:700;line-height:1.5;color:${c.paper};text-decoration:none;">${button}</a></td></tr></table>
    <p style="margin:14px 0 24px;font-size:13px;line-height:1.8;color:${c.muted};">লিংকের মেয়াদ: <strong style="color:${c.ink};">${expiry}</strong></p>
    <div style="padding:16px;background:${c.soft};border-left:3px solid ${c.brand};font-size:13px;line-height:1.9;color:${c.ink};">${safety}</div>
    <p style="margin:24px 0 8px;font-size:12px;line-height:1.8;color:${c.muted};">বাটন কাজ না করলে নিচের লিংক কপি করে ব্রাউজারে খুলুন:</p>
    <p style="margin:0;font-size:12px;line-height:1.8;word-break:break-all;overflow-wrap:anywhere;"><a href="${safeLink}" style="color:${c.brand};text-decoration:underline;">${safeLink}</a></p>
  `, preheader);
}

function verificationEmailHtml(link, name) {
  return linkEmail({
    link, name, title: 'আপনার ইমেইল যাচাই করুন',
    description: 'All In One (Abc Authentic)-এ স্বাগতম। নিবন্ধন সম্পন্ন করতে আপনার ইমেইল ঠিকানাটি নিশ্চিত করুন।',
    button: 'ইমেইল যাচাই করুন', expiry: '২৪ ঘণ্টা',
    safety: 'আপনি নিবন্ধন না করে থাকলে এই ইমেইল উপেক্ষা করুন।',
    preheader: 'নিবন্ধন সম্পন্ন করুন — ইমেইল যাচাইয়ের লিংক ২৪ ঘণ্টা কার্যকর।',
  });
}

function passwordResetEmailHtml(link, name) {
  return linkEmail({
    link, name, title: 'নতুন পাসওয়ার্ড সেট করুন',
    description: 'আপনার অ্যাকাউন্টের পাসওয়ার্ড রিসেটের অনুরোধ পেয়েছি। নিচের বাটন থেকে নতুন পাসওয়ার্ড সেট করতে পারবেন।',
    button: 'পাসওয়ার্ড রিসেট করুন', expiry: '১ ঘণ্টা',
    safety: 'এই অনুরোধ আপনি না করলে কিছু করার দরকার নেই। আপনার পাসওয়ার্ড অপরিবর্তিত থাকবে। রিসেট লিংক কাউকে দেবেন না।',
    preheader: 'নিরাপদে নতুন পাসওয়ার্ড সেট করুন — লিংক ১ ঘণ্টা কার্যকর।',
  });
}

function otpEmailHtml(code, name) {
  const c = palette;
  return emailShell(`
    ${greeting(name)}
    <h1 style="margin:0 0 12px;font-size:24px;line-height:1.5;color:${c.ink};">ইমেইল যাচাইয়ের কোড</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.9;color:${c.muted};">আপনার ইমেইল যাচাই করতে নিচের একবার ব্যবহারযোগ্য কোডটি দিন।</p>
    <div style="padding:20px 12px;background:${c.soft};border:1px solid ${c.border};border-radius:6px;text-align:center;font-size:32px;font-weight:700;line-height:1.5;font-family:Consolas,monospace;color:${c.brand};">${escapeHtml(code)}</div>
    <p style="margin:14px 0 24px;font-size:13px;line-height:1.8;color:${c.muted};">কোডের মেয়াদ: <strong style="color:${c.ink};">৫ মিনিট</strong></p>
    <p style="margin:0;font-size:13px;line-height:1.9;color:${c.muted};">কোডটি কাউকে দেবেন না। আপনি এই অনুরোধ না করে থাকলে ইমেইলটি উপেক্ষা করুন।</p>
  `, 'আপনার ইমেইল যাচাইয়ের কোড — ৫ মিনিট কার্যকর।');
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
