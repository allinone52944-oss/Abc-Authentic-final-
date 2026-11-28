'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.join(__dirname, '../../../frontend');
const dashboard = fs.readFileSync(path.join(frontend, 'dashboard.html'), 'utf8');
const app = fs.readFileSync(path.join(frontend, 'js/app.js'), 'utf8');

function fixture(reply = { ok: true, json: async () => ({ joined: false }) }) {
  const preferences = new Map();
  const slots = Array.from({ length: 2 }, () => ({
    firstElementChild: null,
    replaceChildren(card) { this.firstElementChild = card || null; },
  }));
  const template = {
    content: {
      cloneNode() {
        const controls = {};
        return {
          controls,
          querySelector(selector) {
            return { addEventListener(name, handler) { controls[selector] = handler; } };
          },
        };
      },
    },
  };
  const context = {
    document: { querySelectorAll: () => slots, getElementById: () => template },
    ABC: { api: jest.fn().mockResolvedValue(reply) },
    localStorage: {
      getItem: key => preferences.get(key),
      setItem: (key, value) => preferences.set(key, value),
    },
    setTimeout: callback => callback(),
  };
  const start = dashboard.indexOf('async function loadTelegramInvite(');
  const end = dashboard.indexOf('let dashboardLoading', start);
  vm.runInNewContext(dashboard.slice(start, end), context);
  return { ...context, slots, preferences };
}

test('the dashboard has a regular-flow invite with an explicit opt-out', () => {
  expect(dashboard.match(/<div data-telegram-invite-slot>/g)).toHaveLength(2);
  expect(dashboard).toContain('আর দেখাবেন না');
  expect(dashboard).toContain('target="_blank" rel="noopener noreferrer"');
  expect(app).not.toContain('abc-telegram-banner');
});

test('opening the group hides both cards without recording membership', async () => {
  const { loadTelegramInvite, slots, ABC, preferences } = fixture();
  await loadTelegramInvite('preview');
  slots[0].firstElementChild.controls['.dashboard-telegram-join']();
  expect(slots.map(slot => slot.firstElementChild)).toEqual([null, null]);
  expect(preferences.get('abc_telegram_invite_hidden:preview')).toBe('1');
  expect(ABC.api).toHaveBeenCalledTimes(1);
  expect(ABC.api).toHaveBeenCalledWith('/user/telegram-joined', expect.not.objectContaining({ method: 'POST' }));
});

test('opt-out survives reloads for this account and leaves other accounts eligible', async () => {
  const { loadTelegramInvite, slots, ABC } = fixture();
  await loadTelegramInvite('customer-a');
  slots[1].firstElementChild.controls['.dashboard-telegram-dismiss']();
  await loadTelegramInvite('customer-a');
  expect(slots.map(slot => slot.firstElementChild)).toEqual([null, null]);
  expect(ABC.api).toHaveBeenCalledTimes(1);
  await loadTelegramInvite('customer-b');
  expect(slots.every(slot => slot.firstElementChild)).toBe(true);
});

test.each([
  { ok: true, json: async () => ({ joined: true }) },
  { ok: false, status: 503 },
])('keeps the invite hidden when appropriate (%p)', async reply => {
  const { loadTelegramInvite, slots } = fixture(reply);
  await loadTelegramInvite('preview');
  expect(slots.map(slot => slot.firstElementChild)).toEqual([null, null]);
});
