// Node tests for engines/nid-server-report/adapter.js — pure
// helpers only (no Python spawned here; the Python pipeline is
// covered by tests/test_server_report.py).
// Run: node --test engines/nid-server-report/tests/adapter.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const adapter = require('../adapter');

test('hasCoreData: name + ID + DOB all required', () => {
  const full = { 'Name(Bangla)': 'পরীক্ষা নাম', 'National ID': '1010101010', 'Date of Birth': '01/01/1990' };
  assert.equal(adapter.hasCoreData(full), true);
  assert.equal(adapter.hasCoreData({ 'Name(English)': 'Test Name', Pin: '10101010101010101', 'Date of Birth': '01/01/1990' }), true);
  assert.equal(adapter.hasCoreData({ 'National ID': '1010101010', 'Date of Birth': '01/01/1990' }), false);
  assert.equal(adapter.hasCoreData({ 'Name(Bangla)': 'পরীক্ষা নাম', 'Date of Birth': '01/01/1990' }), false);
  assert.equal(adapter.hasCoreData({ 'Name(Bangla)': 'পরীক্ষা নাম', 'National ID': '1010101010' }), false);
  assert.equal(adapter.hasCoreData({ 'Name(Bangla)': '   ', 'National ID': '1010101010', 'Date of Birth': '01/01/1990' }), false);
  assert.equal(adapter.hasCoreData(null), false);
  assert.equal(adapter.hasCoreData([]), false);
});

test('missingCoreGroups names the missing groups in Bengali', () => {
  assert.deepEqual(adapter.missingCoreGroups({}), ['নাম', 'জাতীয় পরিচয়পত্র নম্বর', 'জন্মতারিখ']);
  assert.deepEqual(adapter.missingCoreGroups({ 'Name(Bangla)': 'x' }), ['জাতীয় পরিচয়পত্র নম্বর', 'জন্মতারিখ']);
  assert.deepEqual(
    adapter.missingCoreGroups({ 'Name(Bangla)': 'x', 'National ID': '1', 'Date of Birth': 'd' }),
    []
  );
});

test('outputBase: Bengali digits map to ASCII, junk stripped, empty -> report', () => {
  assert.equal(adapter.outputBase({ 'National ID': '১০১০১০১০১০' }), '1010101010');
  assert.equal(adapter.outputBase({ 'National ID': '1010-101010' }), '1010101010');
  assert.equal(adapter.outputBase({ 'National ID': ' 1010101010 ' }), '1010101010');
  assert.equal(adapter.outputBase({ 'National ID': '' }), 'report');
  assert.equal(adapter.outputBase({}), 'report');
  assert.equal(adapter.outputBase(null), 'report');
});

test('NO_CORE_DATA_MESSAGE is a Bengali no-charge message', () => {
  assert.match(adapter.NO_CORE_DATA_MESSAGE, /তথ্য অসম্পূর্ণ/);
  assert.match(adapter.NO_CORE_DATA_MESSAGE, /কোনো টাকা কাটা হয়নি/);
});
