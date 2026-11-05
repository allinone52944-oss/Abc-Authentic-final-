'use strict';
// Audit #10 — the edited-fields diff for the nid-replica card build
// (which submitted fields differ from the extracted originals).
// Pure logic, no Python deps: always runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { editedFieldsOf } = require('../adapter');

test('changed value -> listed; same value -> not listed', () => {
  const base = { 'Name:': 'RAHMAN', 'Date of Birth:': '12/03/1990' };
  assert.deepEqual(
    editedFieldsOf({ 'Name:': 'KARIM', 'Date of Birth:': '12/03/1990' }, base),
    ['Name:']);
});

test('whitespace-only difference is not an edit', () => {
  assert.deepEqual(editedFieldsOf({ 'Name:': '  RAHMAN  ' }, { 'Name:': 'RAHMAN' }), []);
});

test('a field the extraction does not have counts as edited', () => {
  assert.deepEqual(editedFieldsOf({ 'Blood Group:': 'O+' }, { 'Name:': 'RAHMAN' }), ['Blood Group:']);
});

test('missing / non-object baseline -> no fields (cannot prove an edit)', () => {
  assert.deepEqual(editedFieldsOf({ 'Name:': 'KARIM' }, null), []);
  assert.deepEqual(editedFieldsOf({ 'Name:': 'KARIM' }, 'nope'), []);
  assert.deepEqual(editedFieldsOf(null, { 'Name:': 'RAHMAN' }), []);
});
