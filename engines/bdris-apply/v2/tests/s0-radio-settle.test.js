/**
 * S0-RADIO-SETTLE (2026-10-28) — the form's first step renders LATE:
 * probe 2026-10-28 found 0 controls right after the homepage link and the
 * full step only by 25s, so S0's basis-radio wait is 30s, not 6s. When the
 * radio is still not found, the failure logs the visible first-step
 * controls so the next diagnosis is evidence, not guessing. These tests
 * pin that diagnostic: only radio/checkbox inputs and buttons are
 * collected, hidden elements are skipped, and values/text are never read
 * (they could carry personal data). No live contact, no browser, no
 * personal data. Fixture values only.
 * Run: node --test engines/bdris-apply/v2/tests/s0-radio-settle.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { StepHandler } = require('../services/StepHandler');

// Fake page: evaluate runs against a stub document, like the
// s4prep-replay fixture. Elements are plain descriptors.
function fakePage(doc) {
  return {
    evaluate: async (fn) => {
      const prev = global.document;
      global.document = doc;
      try { return await fn(); } finally { global.document = prev; }
    },
  };
}

function el(tagName, attrs, offsetParent) {
  return {
    tagName,
    id: attrs.id || '',
    offsetParent: offsetParent === undefined ? {} : offsetParent,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
}

function stepDoc() {
  return {
    querySelectorAll: () => [
      el('INPUT', { type: 'radio', name: 'officeAddressType', id: 'officeBirthplace' }),
      el('INPUT', { type: 'radio', name: 'officeAddressType', id: 'officePermanent' }),
      el('INPUT', { type: 'checkbox', name: '', id: '' }),
      el('BUTTON', {}, {}),
      el('INPUT', { type: 'radio', name: 'officeAddressType', id: 'officeHidden' }, null),
      el('INPUT', { type: 'text', name: 'personName', id: 'personName', value: 'Secret Name' }),
    ],
  };
}

describe('S0-RADIO-SETTLE diagnostic', () => {
  it('collects only visible radio/checkbox inputs and buttons', async () => {
    const h = new StepHandler({ page: fakePage(stepDoc()) });
    assert.deepEqual(await h._visibleFirstStepControls(), [
      { tag: 'input', type: 'radio', id: 'officeBirthplace', name: 'officeAddressType' },
      { tag: 'input', type: 'radio', id: 'officePermanent', name: 'officeAddressType' },
      { tag: 'input', type: 'checkbox', id: '', name: '' },
      { tag: 'button', type: '', id: '', name: '' },
    ]);
  });

  it('never includes values or text in any descriptor', async () => {
    const h = new StepHandler({ page: fakePage(stepDoc()) });
    const seen = await h._visibleFirstStepControls();
    for (const d of seen) {
      assert.deepEqual(Object.keys(d).sort(), ['id', 'name', 'tag', 'type']);
      assert.ok(!JSON.stringify(d).includes('Secret'), 'personal data must never be read');
    }
  });

  it('returns [] when evaluate throws', async () => {
    const h = new StepHandler({ page: { evaluate: async () => { throw new Error('boom'); } } });
    assert.deepEqual(await h._visibleFirstStepControls(), []);
  });

  it('returns [] on pages without evaluate', async () => {
    const h = new StepHandler({ page: {} });
    assert.deepEqual(await h._visibleFirstStepControls(), []);
  });
});
