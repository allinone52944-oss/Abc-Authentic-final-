'use strict';

// Telegram notifier tests — mocked fetch only, never a real network
// call. The bot token here is a fake test value, never a real one.

const telegramNotify = require('../../lib/telegramNotify');
const { notifyOrder, notifyRecharge, notifyVerify, notifySuccess, maskName, maskPhone, dhakaTime, DEFAULT_CHAT_ID } = telegramNotify;

const FAKE_TOKEN = 'TESTTOKEN';
const FAKE_STICKER = 'TEST-STICKER-FILE-ID';

function okFetch() {
  return jest.fn().mockResolvedValue({ ok: true });
}

describe('telegramNotify masking', () => {
  test('maskName shows only the first 2 characters + ***', () => {
    expect(maskName('জাগাতপ্রিয়া')).toBe('জা***');
    expect(maskName('Rahim')).toBe('Ra***');
    expect(maskName('A')).toBe('A***');
  });

  test('maskName never leaks a full name or HTML', () => {
    expect(maskName('')).toBe('***');
    expect(maskName(null)).toBe('***');
    expect(maskName('<b>Karim</b>')).not.toContain('<b>');
    expect(maskName('<b>Karim</b>')).toContain('***');
  });

  test('maskPhone shows first 2 + last 2, middle masked', () => {
    expect(maskPhone('01712345678')).toBe('01XXXXXXX78');
    expect(maskPhone('0123')).toBe('01XX');
    expect(maskPhone('')).toBe('***');
    expect(maskPhone(null)).toBe('***');
  });

  test('dhakaTime is "28 Nov 2026, 07:00 PM" shaped', () => {
    expect(dhakaTime(new Date('2026-11-28T13:00:00Z'))).toMatch(/^\d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} (AM|PM)$/);
    // 13:00 UTC = 19:00 Asia/Dhaka.
    expect(dhakaTime(new Date('2026-11-28T13:00:00Z'))).toContain('07:00 PM');
  });
});

describe('telegramNotify sending', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_ANIMATED_STICKER_ID;
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  test('no-op when TELEGRAM_BOT_TOKEN is missing (never throws, no fetch)', async () => {
    const fetchImpl = okFetch();
    await expect(notifyOrder({
      userName: 'জাগাতপ্রিয়া', userPhone: '01712345678',
      serviceLabel: 'NID Server Copy (Premium)', fee: 150, orderId: 'abc-123',
    }, fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('order posts masked HTML to the default group chat', async () => {
    process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
    const fetchImpl = okFetch();
    await expect(notifyOrder({
      userName: 'জাগাতপ্রিয়া', userPhone: '01712345678',
      serviceLabel: 'NID Server Copy (Premium)', fee: 150, orderId: 'abc-123',
    }, fetchImpl)).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe(DEFAULT_CHAT_ID);
    expect(body.chat_id).toBe('-1005862040443');
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('<b>নতুন অর্ডার</b>');
    expect(body.text).toContain('<b>জা***</b>');
    expect(body.text).toContain('01XXXXXXX78');
    expect(body.text).toContain('NID Server Copy (Premium)');
    expect(body.text).toContain('৳150');
    expect(body.text).toContain('#abc-123');
    // No full identifier ever leaves the server.
    expect(body.text).not.toContain('জাগাতপ্রিয়া');
    expect(body.text).not.toContain('01712345678');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  test('TELEGRAM_CHAT_ID wins over the default', async () => {
    process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
    process.env.TELEGRAM_CHAT_ID = '-999';
    const fetchImpl = okFetch();
    await notifyOrder({
      userName: 'Karim', userPhone: '01800000000',
      serviceLabel: 'TIN', fee: 0, orderId: 'x1',
    }, fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).chat_id).toBe('-999');
  });

  test('recharge posts the recharge format with a mapped method', async () => {
    process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
    const fetchImpl = okFetch();
    await notifyRecharge({
      userName: 'Rahim Uddin', userPhone: '01911112222',
      amount: 500, method: 'bkash_personal',
    }, fetchImpl);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.text).toContain('<b>রিচার্জ সফল</b>');
    expect(body.text).toContain('<b>Ra***</b>');
    expect(body.text).toContain('৳500');
    expect(body.text).toContain('bKash');
    expect(body.text).not.toContain('Rahim Uddin');
    expect(body.text).not.toContain('01911112222');
  });

  test('verify posts the verify format', async () => {
    process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
    const fetchImpl = okFetch();
    await notifyVerify({
      userName: 'Fatema', userPhone: '01633334444', type: 'TIN Certificate',
    }, fetchImpl);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.text).toContain('<b>ভেরিফাই সফল</b>');
    expect(body.text).toContain('<b>Fa***</b>');
    expect(body.text).toContain('TIN Certificate');
    expect(body.text).not.toContain('Fatema');
  });

  test('success posts the owner-approved headline, masked, with fee + order', async () => {
    process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
    const fetchImpl = okFetch();
    await expect(notifySuccess({
      userName: 'জাগাতপ্রিয়া', userPhone: '01712345678',
      serviceLabel: 'NID Server Copy (Premium)', fee: 150, orderId: 'ord-9',
    }, fetchImpl)).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    // Headline wording is owner-approved — exact, never reworded.
    expect(body.text).toContain('<b>অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে।</b>');
    expect(body.text).toContain('🎉');
    expect(body.text).toContain('<b>জা***</b>');
    expect(body.text).toContain('01XXXXXXX78');
    expect(body.text).toContain('NID Server Copy (Premium)');
    expect(body.text).toContain('৳150');
    expect(body.text).toContain('#ord-9');
    expect(body.text).not.toContain('জাগাতপ্রিয়া');
    expect(body.text).not.toContain('01712345678');
  });

  test('success is a no-op without a token and never throws on failure', async () => {
    const fetchImpl = okFetch();
    await expect(notifySuccess({
      userName: 'Karim', userPhone: '01700000000',
      serviceLabel: 'TIN', fee: 10, orderId: 'n1',
    }, fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
    const failingFetch = jest.fn().mockRejectedValue(new Error('network down'));
    await expect(notifySuccess({
      userName: 'Karim', userPhone: '01700000000',
      serviceLabel: 'TIN', fee: 10, orderId: 'n2',
    }, failingFetch)).resolves.toBe(true);
  });

  test('sticker is sent after the text only when configured', async () => {
    process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
    const fetchImpl = okFetch();
    await notifyOrder({
      userName: 'Karim', userPhone: '01700000000',
      serviceLabel: 'TIN', fee: 10, orderId: 's1',
    }, fetchImpl);
    // No sticker configured: text only.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    process.env.TELEGRAM_ANIMATED_STICKER_ID = FAKE_STICKER;
    fetchImpl.mockClear();
    await notifyOrder({
      userName: 'Karim', userPhone: '01700000000',
      serviceLabel: 'TIN', fee: 10, orderId: 's2',
    }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [stickerUrl, stickerOpts] = fetchImpl.mock.calls[1];
    expect(stickerUrl).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendSticker`);
    expect(JSON.parse(stickerOpts.body)).toMatchObject({
      chat_id: DEFAULT_CHAT_ID,
      sticker: FAKE_STICKER,
    });
  });

  test('a Telegram failure never throws and never blocks', async () => {
    process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
    const failingFetch = jest.fn().mockRejectedValue(new Error('network down'));
    await expect(notifyOrder({
      userName: 'Karim', userPhone: '01700000000',
      serviceLabel: 'TIN', fee: 10, orderId: 'f1',
    }, failingFetch)).resolves.toBe(true);

    const notOkFetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(notifyRecharge({
      userName: 'Karim', userPhone: '01700000000', amount: 100, method: 'nagad',
    }, notOkFetch)).resolves.toBe(true);

    // A failing sticker send must not fail the text send either.
    process.env.TELEGRAM_ANIMATED_STICKER_ID = FAKE_STICKER;
    const flakyFetch = jest.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('sticker boom'));
    await expect(notifyVerify({
      userName: 'Karim', userPhone: '01700000000', type: 'TIN',
    }, flakyFetch)).resolves.toBe(true);
    expect(flakyFetch).toHaveBeenCalledTimes(2);
  });
});
