const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/js/admin-notify.js'), 'utf8');

function harness() {
  let stats = { orders_new: 0, pending_recharge: 0, auto_matched_recharge: 0 };
  let sms = 0;
  const played = [];
  const listeners = {};
  const player = { volume: 1, pause: jest.fn(), play: jest.fn(() => { played.push(player.src); return Promise.resolve(); }) };
  const context = vm.createContext({
    window: {}, localStorage: { getItem: () => null, setItem: jest.fn() },
    Audio: function (src) { player.src = src; return player; },
    document: { getElementById: () => null, addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: jest.fn() },
    me: { role: 'admin' }, setTimeout: jest.fn(), setInterval: jest.fn(),
    esc: String, bn: String, console,
    ABC: { api: jest.fn(async url => ({ ok: true, json: async () => url === '/admin/stats' ? stats : url === '/admin/stats/sms' ? { unmatched_sms: sms } : { list: [{ id: 1 }] } })) }
  });
  vm.runInContext(source, context);
  const voice = context.window.VoiceAlert;
  voice._deps = { getUser: () => ({role: 'admin'}) };
  voice.playChime = jest.fn(); voice.speak = jest.fn(); voice.showToast = jest.fn();
  return { voice, player, played, context, setStats: next => { stats = { ...stats, ...next }; }, setSms: next => { sms = next; } };
}

test.each([
  ['orders_new', 'order'], ['pending_recharge', 'recharge'], ['auto_matched_recharge', 'recharge'], ['sms', 'message']
])('first %s event after a zero baseline alerts exactly once', async (field, sound) => {
  const h = harness();
  await h.voice.check();
  expect(h.voice.playChime).not.toHaveBeenCalled();
  if (field === 'sms') h.setSms(1); else h.setStats({ [field]: 1 });
  await h.voice.check();
  expect(h.voice.playChime).toHaveBeenCalledTimes(1);
  expect(h.voice.playChime).toHaveBeenCalledWith(sound);
  await h.voice.check();
  expect(h.voice.playChime).toHaveBeenCalledTimes(1);
});

test('audio is serialized instead of speaking two MP3 alerts together', async () => {
  const h = harness();
  h.voice.playSound('new-order.mp3');
  h.voice.playSound('new-recharge.mp3');
  await Promise.resolve();
  expect(h.played).toEqual(['/audio/new-order.mp3']);
  h.player.onended();
  await Promise.resolve();
  expect(h.played).toEqual(['/audio/new-order.mp3', '/audio/new-recharge.mp3']);
});

test('test sound enables a muted device before playing', () => {
  const h = harness(); h.voice.enabled = false;
  h.voice.testAlert();
  expect(h.voice.enabled).toBe(true);
  expect(h.voice.playChime).toHaveBeenCalledWith('order');
});

test('muting cancels active and pending voice playback', () => {
  const h = harness();
  h.voice.playSound('new-order.mp3'); h.voice.playSound('new-recharge.mp3');
  h.voice.toggleSound();
  expect(h.player.pause).toHaveBeenCalled();
  expect(h.voice._soundQueue).toEqual([]);
});