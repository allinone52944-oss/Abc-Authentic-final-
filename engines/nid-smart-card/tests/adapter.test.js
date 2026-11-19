// Node tests for engines/nid-smart-card/adapter.js — pure
// helpers, plus buildCard image handling (photo.png + sign.png)
// against a hand-built job dir. The image tests assert on the
// job-dir file state only — the Python build itself is covered by
// tests/test_smart_card.py, and its outcome here is NOT asserted
// (it fails on a VM without pymupdf, which is fine: the images
// are written before the Python call runs).
// Run: node --test engines/nid-smart-card/tests/adapter.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

test('outputBase: replica filename rule — 10/13/17 digits, else smart-card', () => {
  assert.equal(adapter.outputBase({ 'ID NO:': '১০১০১০১০১০' }), '1010101010');
  assert.equal(adapter.outputBase({ 'ID NO:': '1010-101010' }), '1010101010');
  assert.equal(adapter.outputBase({ 'ID NO:': '1010101010101' }), '1010101010101');
  assert.equal(adapter.outputBase({ Pin: '10101010101010101' }), '10101010101010101');
  assert.equal(adapter.outputBase({ 'ID NO:': ' 1010101010 ' }), '1010101010');
  // Not 10/13/17 digits → fallback (replica rule).
  assert.equal(adapter.outputBase({ 'ID NO:': '12345' }), 'smart-card');
  assert.equal(adapter.outputBase({ 'ID NO:': '123456789012' }), 'smart-card');
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

// --- buildCard image handling (photo.png + sign.png, like nid-replica) ---
// Tiny 1x1 PNGs (distinct bytes so replacement is observable).
const PNG_OLD = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_PHOTO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PNG_SIGN = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADgAGYAKw2h4AAAAASUVORK5CYII=', 'base64');
const FIELDS = { 'নাম:': 'পরীক্ষা নাম', 'ID NO:': '1010101010', 'Date of Birth:': '01/01/1990' };

function makeJobDir() {
  const id = crypto.randomUUID();
  const dir = path.join(__dirname, '..', 'work', 'jobs', id);
  fs.mkdirSync(path.join(dir, 'work', 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'work', 'input_data.json'), '{}');
  fs.writeFileSync(path.join(dir, '.owner'), 'u1');
  fs.writeFileSync(path.join(dir, 'work', 'images', 'photo.png'), PNG_OLD);
  fs.writeFileSync(path.join(dir, 'work', 'images', 'sign.png'), PNG_OLD);
  return { id, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('buildCard stores uploaded photo.png + sign.png in the job dir', async () => {
  const { id, dir } = makeJobDir();
  try {
    await adapter.buildCard(id, FIELDS, [
      { name: 'photo.png', dataUrl: 'data:image/png;base64,' + PNG_PHOTO.toString('base64') },
      { name: 'sign.png', dataUrl: 'data:image/png;base64,' + PNG_SIGN.toString('base64') },
    ], 'u1');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'work', 'images', 'photo.png')), PNG_PHOTO);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'work', 'images', 'sign.png')), PNG_SIGN);
  } finally {
    cleanup(dir);
  }
});

test('buildCard deletes extracted photo/sign not re-passed', async () => {
  const { id, dir } = makeJobDir();
  try {
    await adapter.buildCard(id, FIELDS, [], 'u1');
    assert.equal(fs.existsSync(path.join(dir, 'work', 'images', 'photo.png')), false);
    assert.equal(fs.existsSync(path.join(dir, 'work', 'images', 'sign.png')), false);
  } finally {
    cleanup(dir);
  }
});

test('buildCard ignores non-photo/sign image names', async () => {
  const { id, dir } = makeJobDir();
  try {
    await adapter.buildCard(id, FIELDS, [
      { name: 'other.png', dataUrl: 'data:image/png;base64,' + PNG_PHOTO.toString('base64') },
    ], 'u1');
    assert.equal(fs.existsSync(path.join(dir, 'work', 'images', 'other.png')), false);
    assert.equal(fs.existsSync(path.join(dir, 'work', 'images', 'photo.png')), false);
    assert.equal(fs.existsSync(path.join(dir, 'work', 'images', 'sign.png')), false);
  } finally {
    cleanup(dir);
  }
});
