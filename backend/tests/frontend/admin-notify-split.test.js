// Audit #69 — admin.js split: the sound/notification chunk
// (VoiceAlert + PushNotify + admToast) lives in its own file
// admin-notify.js, loaded before admin.js; the admin check runs
// every 12s with a silent initial baseline.
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', '..', 'frontend');
const read = (p) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');

describe('admin notify split (audit #69)', () => {
  test('the notify chunk lives in admin-notify.js, not in admin.js', () => {
    const notify = read('js/admin-notify.js');
    expect(notify).toContain('const VoiceAlert = {');
    expect(notify).toContain('window.VoiceAlert = VoiceAlert;');
    expect(notify).toContain('const PushNotify = {');
    expect(notify).toContain('window.PushNotify = PushNotify;');
    expect(notify).toContain('window.admToast = ');

    const admin = read('js/admin.js');
    expect(admin).not.toContain('const VoiceAlert = {');
    expect(admin).not.toContain('const PushNotify = {');
    expect(admin).not.toContain('window.admToast = ');
    expect(admin).toContain('admin-notify.js');
  });

  test('admin.js is smaller and the chunk is a real file', () => {
    expect(fs.statSync(path.join(FRONTEND, 'js/admin.js')).size).toBeLessThan(361000);
    expect(fs.statSync(path.join(FRONTEND, 'js/admin-notify.js')).size).toBeGreaterThan(10000);
  });

  test('the admin check runs every 12s; first check still baselines at 3s', () => {
    const notify = read('js/admin-notify.js');
    expect(notify).toContain('setInterval(() => this.check(), 12000)');
    expect(notify).toContain('setTimeout(() => this.check(), 3000)');
    expect(read('js/admin.js')).not.toContain('setInterval(() => this.check()');
  });

  test('admin.html loads the notify chunk BEFORE admin.js (and bumps its version)', () => {
    const html = read('admin.html');
    expect(html).toContain('<script src="/js/admin-notify.js?v=20261111-1"></script>');
    expect(html).toContain('<script src="/js/admin.js?v=20261111-5"></script>');
    expect(html.indexOf('admin-notify.js')).toBeLessThan(html.indexOf('/js/admin.js?v=20261111-5'));
  });

  test('admin.js still drives the notify init and still calls admToast', () => {
    const admin = read('js/admin.js');
    expect(admin).toContain('VoiceAlert.init({ getUser: () => me');
    expect(admin).toContain('PushNotify.ensure()');
    expect(admin).toContain('admToast(');
  });
});
