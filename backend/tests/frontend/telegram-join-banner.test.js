'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.join(__dirname, '../../../frontend');
const dashboard = fs.readFileSync(path.join(frontend, 'dashboard.html'), 'utf8');
const login = fs.readFileSync(path.join(frontend, 'login.html'), 'utf8');

function fixture({ joined = false, loggedIn = 'preview', overlay = false } = {}) {
  const preferences = new Map();
  const pending = new Map([['abc_telegram_invite_login', loggedIn]]);
  const controls = {};
  const dialog = {
    querySelector: selector => ({ addEventListener: (_, listener) => { controls[selector] = listener; } }),
    addEventListener: jest.fn(),
    showModal: jest.fn(),
    close: jest.fn(),
  };
  const context = {
    document: { getElementById: () => dialog, querySelector: () => overlay ? {} : null },
    localStorage: { getItem: key => preferences.get(key), setItem: (key, value) => preferences.set(key, value) },
    sessionStorage: { getItem: key => pending.get(key), removeItem: key => pending.delete(key) },
    setTimeout: callback => callback(),
  };
  const start = dashboard.indexOf('function showTelegramInvite(');
  const end = dashboard.indexOf('let dashboardLoading', start);
  vm.runInNewContext(dashboard.slice(start, end), context);
  return { show: (id = 'preview') => context.showTelegramInvite({ id, telegram_joined: joined }), preferences, pending, dialog, controls };
}

test('successful customer login prepares the accessible dashboard popup', () => {
  expect(login).toContain("sessionStorage.setItem('abc_telegram_invite_login', String(d.user.id))");
  expect(dashboard).toContain('<dialog id="telegramInviteDialog" aria-labelledby="telegramInviteTitle"');
  expect(dashboard).toContain('@media (prefers-reduced-motion: reduce)');
  expect(dashboard).toContain('আর দেখাবেন না');
  expect(dashboard).not.toContain('data-telegram-invite-slot');
  expect(dashboard).toContain('if (!telegramInviteShown) BannerRender.showPopup');
});

test('the login marker is consumed once per dashboard entry', () => {
  const { show, dialog } = fixture();
  expect(show()).toBe(true);
  expect(show()).toBe(false);
  expect(dialog.showModal).toHaveBeenCalledTimes(1);
});

test('close is temporary and opening the group hides future invites without recording membership', () => {
  const { show, dialog, controls, pending, preferences } = fixture();
  show();
  controls['.dashboard-telegram-close']();
  expect(dialog.close).toHaveBeenCalledTimes(1);
  expect(preferences.size).toBe(0);
  pending.set('abc_telegram_invite_login', 'preview');
  show();
  controls['.dashboard-telegram-join']();
  expect(preferences.get('abc_telegram_invite_hidden:preview')).toBe('1');
  expect(dashboard).not.toContain('/user/telegram-joined');
});

test('opt-out applies to the same account and leaves other accounts eligible', () => {
  const { show, controls, dialog, pending } = fixture();
  show();
  controls['.dashboard-telegram-dismiss']();
  pending.set('abc_telegram_invite_login', 'preview');
  expect(show()).toBe(false);
  pending.set('abc_telegram_invite_login', 'other');
  expect(show('other')).toBe(true);
  expect(dialog.showModal).toHaveBeenCalledTimes(2);
});

test.each([{ joined: true }, { loggedIn: 'other' }, { overlay: true }])(
  'keeps the popup hidden when appropriate (%p)', settings => {
    const { show, dialog } = fixture(settings);
    expect(show()).toBe(false);
    expect(dialog.showModal).not.toHaveBeenCalled();
  }
);
