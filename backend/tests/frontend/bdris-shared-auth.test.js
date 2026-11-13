const fs = require('fs');
const vm = require('vm');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../../frontend/bdris-apply.html'), 'utf8');
function source(name) {
  const start = html.indexOf('function ' + name + '(');
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
}
test('submission record uses the current session token outside the wallet closure', async () => {
  const fetch = jest.fn().mockResolvedValue({ ok: true });
  const c = { LS_ACCESS_T: 'abc_access_token', sessionStorage: { getItem: () => 'current-session' },
    localStorage: { getItem: () => 'older-session' }, fetch,
    isSentinelAck: () => false, canonicalAck: String, submitChargeKeyForRecord: () => 'existing-submit-key',
    clearAckPending: jest.fn(), markAckPending: jest.fn() };
  vm.createContext(c);
  vm.runInContext(source('getToken') + source('reportAckToServer'), c);
  c.reportAckToServer({ no: '266392130', name: 'Test' });
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe('/api/bdris-apply/applications');
  expect(options.headers.Authorization).toBe('Bearer current-session');
  expect(JSON.parse(options.body).ack_no).toBe('266392130');
  expect(c.clearAckPending).toHaveBeenCalledTimes(1);
});
test('shared token reader reflects token refresh and supports existing storage fallback', () => {
  let token = 'first-session';
  const c = { LS_ACCESS_T: 'abc_access_token', sessionStorage: { getItem: () => token },
    localStorage: { getItem: () => 'fallback-session' } };
  vm.createContext(c); vm.runInContext(source('getToken'), c);
  expect(c.getToken()).toBe('first-session');
  token = 'refreshed-session'; expect(c.getToken()).toBe('refreshed-session');
  token = ''; expect(c.getToken()).toBe('fallback-session');
});