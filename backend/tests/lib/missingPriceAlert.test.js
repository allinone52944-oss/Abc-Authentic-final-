// Audit #17 — admin alert for an engine serving free because no
// active services row exists for its engine_id.
jest.mock('../../utils/push', () => ({
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
}));
const fs = require('fs');
const path = require('path');
const push = require('../../utils/push');
const { alertMissingPrice, _resetForTests } = require('../../lib/missingPriceAlert');

const db = {};

beforeEach(() => {
  push.notifyAdmins.mockClear();
  _resetForTests();
});

test('alerts the admins once per engine, naming the engine', () => {
  alertMissingPrice(db, 'land-search');
  expect(push.notifyAdmins).toHaveBeenCalledTimes(1);
  const [calledDb, title, body, url] = push.notifyAdmins.mock.calls[0];
  expect(calledDb).toBe(db);
  expect(title).toContain('land-search');
  expect(body).toContain('services টেবিলে');
  expect(url).toBe('/admin.html');
});

test('repeat alerts for the same engine within the hour are throttled', () => {
  alertMissingPrice(db, 'land-search');
  alertMissingPrice(db, 'land-search');
  alertMissingPrice(db, 'land-search');
  expect(push.notifyAdmins).toHaveBeenCalledTimes(1);
});

test('a different engine alerts separately', () => {
  alertMissingPrice(db, 'land-search');
  alertMissingPrice(db, 'nid-replica');
  expect(push.notifyAdmins).toHaveBeenCalledTimes(2);
});

test('no engine id → no alert', () => {
  alertMissingPrice(db);
  alertMissingPrice(db, '');
  expect(push.notifyAdmins).not.toHaveBeenCalled();
});

test('an alert failure never throws back to the caller', () => {
  push.notifyAdmins.mockImplementationOnce(() => { throw new Error('push down'); });
  expect(() => alertMissingPrice(db, 'land-search')).not.toThrow();
  push.notifyAdmins.mockImplementationOnce(() => undefined);
  expect(() => alertMissingPrice(db, 'nid-replica')).not.toThrow();
});

// Wiring: every price lookup with the missing-row branch must call
// the alert (price 0 itself stays — the design decision — the
// alert is the fix).
const WIRED = [
  ['lib/engineChargeGate.js', 'alertMissingPrice(db, engineId)'],
  ['routes/land.js', 'alertMissingPrice(db, engineId)'],
  ['routes/nid.js', "alertMissingPrice(db, 'nid-replica')"],
  ['routes/nid-server-copy.js', "alertMissingPrice(db, 'nid-server-copy')"],
  ['routes/qr-verify.js', 'alertMissingPrice(db, ENGINE_ID)'],
  ['routes/land-khatian.js', 'alertMissingPrice(db, ENGINE_ID)'],
  ['routes/land-mouza-map.js', 'alertMissingPrice(db, ENGINE_ID)'],
];
test.each(WIRED)('%s alerts on the missing-row branch', (file, call) => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  expect(src).toContain(call);
  // the alert sits in the missing-row branch, right before the
  // price-0 return — not somewhere unrelated
  const branch = src.slice(src.indexOf(call) - 400, src.indexOf(call));
  expect(branch).toContain('!r.rows.length');
});
