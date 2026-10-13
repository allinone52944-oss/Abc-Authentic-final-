// Unit tests for backend/utils/mailer.js.
// nodemailer is mocked — no real SMTP. No SMTP env by default.
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
// NOTE: after jest.resetModules() the mock module identity is refreshed,
// so always re-require nodemailer AFTER freshMailer() (see nm()).
const nm = () => require('nodemailer');

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
let savedEnv;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  jest.resetModules();
  // mockReset() wipes implementations, so restore a truthy default transport
  // (real nodemailer.createTransport always returns an object).
  const ct = nm().createTransport;
  ct.mockReset();
  ct.mockReturnValue({ sendMail: jest.fn(async () => ({})) });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});
function freshMailer() { return require('../../utils/mailer'); }
function withSmtp() {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_USER = 'user@example.com';
  process.env.SMTP_PASS = 'pass';
}

describe('isConfigured', () => {
  test('false when SMTP env is absent', () => {
    expect(freshMailer().isConfigured()).toBe(false);
  });
  test('true when SMTP env is present', () => {
    withSmtp();
    expect(freshMailer().isConfigured()).toBe(true);
    expect(nm().createTransport).toHaveBeenCalled();
  });
});

describe('sendMail without SMTP', () => {
  test('returns SMTP_NOT_CONFIGURED, never throws', async () => {
    const mailer = freshMailer();
    const r = await mailer.sendMail({ to: 'a@b.co', subject: 's', html: '<p>h</p>' });
    expect(r).toEqual({ ok: false, error: 'SMTP_NOT_CONFIGURED' });
    expect(nm().createTransport).not.toHaveBeenCalled();
  });
});

describe('sendMail with SMTP (mocked transport)', () => {
  test('happy path → { ok:true } with from/to/subject', async () => {
    withSmtp();
    const sendMail = jest.fn(async () => ({}));
    nm().createTransport.mockReturnValue({ sendMail });
    const mailer = freshMailer();
    const r = await mailer.sendOtpEmail('u@x.co', '123456', 'Rahim');
    expect(r).toEqual({ ok: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const arg = sendMail.mock.calls[0][0];
    expect(arg.to).toBe('u@x.co');
    expect(arg.subject).toContain('OTP');
    expect(arg.html).toContain('123456');
  });

  test('transport failure → SEND_FAILED (never throws)', async () => {
    withSmtp();
    nm().createTransport.mockReturnValue({
      sendMail: jest.fn(async () => { throw new Error('smtp down'); }),
    });
    const mailer = freshMailer();
    const r = await mailer.sendVerificationEmail('u@x.co', 'http://l', 'R');
    expect(r).toEqual({ ok: false, error: 'SEND_FAILED' });
  });

  test('sendPasswordResetEmail happy path', async () => {
    withSmtp();
    const sendMail = jest.fn(async () => ({}));
    nm().createTransport.mockReturnValue({ sendMail });
    const r = await freshMailer().sendPasswordResetEmail('u@x.co', 'http://reset', 'R');
    expect(r).toEqual({ ok: true });
    expect(sendMail.mock.calls[0][0].subject).toContain('পাসওয়ার্ড');
  });
});

describe('HTML builders escape names (XSS safety)', () => {
  test('verificationEmailHtml strips HTML metachars from name', () => {
    const mailer = freshMailer();
    const html = mailer.verificationEmailHtml('http://x', '<script>alert("x")</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('http://x');
  });
  test('otpEmailHtml embeds the code', () => {
    expect(freshMailer().otpEmailHtml('654321', 'R')).toContain('654321');
  });
  test('passwordResetEmailHtml contains the link', () => {
    expect(freshMailer().passwordResetEmailHtml('http://r', 'R')).toContain('http://r');
  });
});
