// Node tests for engines/nid-smart-card/adapter.js — pure
// helpers only (no Python spawned here; the Python pipeline is
// covered by tests/test_smart_card.py).
// Run: node --test engines/nid-smart-card/tests/adapter.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const adapter = require('../adapter');

test('hasCoreData: name + ID + DOB all required', () => {
  const full = { 'নাম:': 'পরীক্ষা নাম', 'ID NO:': '1010101010', 'Date of Birth:': '01/01/1990' };
  assert.equal(adapter.hasCoreData(full), true);
  assert.equal(adapter.hasCoreData({ 'Name:': 'Test Name', Pin: '10101010101010101', 'Date of Birth:': '01/01/1990' }), true);
  assert.equal(adapter.hasCoreData({ 'ID NO:': '1010101010', 'Date of Birth:': '01/01/1990' }), false);
  assert.equal(adapter.hasCoreData({ 'নাম:': 'পরীক্ষা নাম', 'Date of Birth:': '01/01/1990' }), false);
  assert.equal(adapter.hasCoreData({ 'নাম:': 'পরীক্ষা নাম', 'ID NO:': '1010101010' }), false);
  assert.equal(adapter.hasCoreData({ 'নাম:': '   ', 'ID NO:': '1010101010', 'Date of Birth:': '01/01/1990' }), false);
  assert.equal(adapter.hasCoreData(null), false);
  assert.equal(adapter.hasCoreData([]), false);
});

test('missingCoreGroups names the missing groups in Bengali', () => {
  assert.deepEqual(adapter.missingCoreGroups({}), ['নাম', 'জাতীয় পরিচয়পত্র নম্বর', 'জন্মতারিখ']);
  assert.deepEqual(adapter.missingCoreGroups({ 'নাম:': 'x' }), ['জাতীয় পরিচয়পত্র নম্বর', 'জন্মতারিখ']);
  assert.deepEqual(
    adapter.missingCoreGroups({ 'নাম:': 'x', 'ID NO:': '1', 'Date of Birth:': 'd' }),
    []
  );
});

test('outputBase: Bengali digits map to ASCII, junk stripped, empty -> smart-card', () => {
  assert.equal(adapter.outputBase({ 'ID NO:': '১০১০১০১০১০' }), '1010101010');
  assert.equal(adapter.outputBase({ 'ID NO:': '1010-101010' }), '1010101010');
  assert.equal(adapter.outputBase({ Pin: '10101010101010101' }), '10101010101010101');
  assert.equal(adapter.outputBase({ 'ID NO:': ' 1010101010 ' }), '1010101010');
  assert.equal(adapter.outputBase({ 'ID NO:': '' }), 'smart-card');
  assert.equal(adapter.outputBase({}), 'smart-card');
  assert.equal(adapter.outputBase(null), 'smart-card');
});

test('NO_CORE_DATA_MESSAGE is a Bengali no-charge message', () => {
  assert.match(adapter.NO_CORE_DATA_MESSAGE, /তথ্য অসম্পূর্ণ/);
  assert.match(adapter.NO_CORE_DATA_MESSAGE, /কোনো টাকা কাটা হয়নি/);
});

test('parseBuildJson: last JSON with an ok key wins, log lines ignored', () => {
  const out = '[address] size 7.50 | lines 1/3\n'
    + 'photo matte: flat-bg (1774 px bg)\n'
    + '{"ok": true, "output": "work/output.pdf"}\n';
  assert.deepEqual(adapter.parseBuildJson(out), { ok: true, output: 'work/output.pdf' });

  const fail = 'photo replace fail: boom\n'
    + '{"ok": false, "error": "ছবি বসানো যায়নি: boom"}\n';
  assert.deepEqual(adapter.parseBuildJson(fail), { ok: false, error: 'ছবি বসানো যায়নি: boom' });

  assert.equal(adapter.parseBuildJson('no json here\n'), null);
  assert.equal(adapter.parseBuildJson(''), null);
  // A JSON object without an ok key is not a build result.
  assert.equal(adapter.parseBuildJson('{"output": "x"}\n'), null);
});
