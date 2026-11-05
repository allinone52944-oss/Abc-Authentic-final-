'use strict';
// Audit #10 — "সম্পাদিত" stamp on the NID card PDF.
//
// The card is built by engines/nid-replica/build_output.py. When the
// delivered fields differ from the portal-extracted originals, the
// Node caller writes work/edited.json {"edited": true, "fields": [...]}
// and the builder stamps a red "সম্পাদিত" line (with the edited
// field labels) just below the card, in the free page margin.
//
// This test runs the REAL Python pipeline in a temp job dir, so it
// needs the engine's Python deps (pymupdf + Pillow). Where they are
// absent it skips — the engine runs on the server, where they exist.
// Point NID_PY at a python that has them (e.g. a venv python).
// The stamp is asserted structurally, not by string search: Bengali
// conjuncts do not survive text extraction (pdftotext/PyMuPDF both
// mangle "সম্পাদিত"), so the test looks for the red 12pt spans at
// the stamp position carrying the (Latin) edited field labels.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PIPELINE_DIR = path.join(__dirname, '..');
const PY = process.env.NID_PY || 'python3';

function pythonHasDeps() {
  const r = spawnSync(PY, ['-c', 'import pymupdf, PIL'], { encoding: 'utf8' });
  return r.status === 0;
}

const SKIP = !pythonHasDeps();

function buildCard(t, edited) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nid-stamp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'work', 'fields.json'), '{}', 'utf8');
  if (edited !== undefined) {
    fs.writeFileSync(path.join(dir, 'work', 'edited.json'), JSON.stringify(edited), 'utf8');
  }
  const r = spawnSync(PY, [path.join(PIPELINE_DIR, 'build_output.py')], {
    cwd: dir, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(r.status, 0, 'build_output.py failed: ' + String(r.stderr || r.stdout || '').slice(-500));
  return path.join(dir, 'work', 'output.pdf');
}

// Red (#dc2626) 12pt spans on the page — the stamp's signature.
// Returns [{text, bbox}] for those spans only.
function redStampSpans(pdfPath) {
  const probe = `
import pymupdf, json
d = pymupdf.open(${JSON.stringify(pdfPath)})
spans = [s for b in d[0].get_text('dict')['blocks'] if b.get('type') == 0
         for l in b['lines'] for s in l['spans']]
out = [{'text': s['text'], 'bbox': s['bbox']} for s in spans
       if s['color'] == 0xdc2626 and abs(s['size'] - 12) < 0.5]
print(json.dumps(out, ensure_ascii=False))
`;
  const r = spawnSync(PY, ['-c', probe], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'span probe failed: ' + String(r.stderr || '').slice(-300));
  return JSON.parse(r.stdout);
}

test('edited.json -> red stamp below the card listing the edited labels', { skip: SKIP }, (t) => {
  const pdf = buildCard(t, { edited: true, fields: ['Name(English)', 'Date of Birth'] });
  const spans = redStampSpans(pdf);
  assert.ok(spans.length > 0, 'expected a red 12pt stamp, found none');
  const text = spans.map((s) => s.text).join('');
  assert.ok(text.includes('Name(English)'), 'stamp should list Name(English): ' + JSON.stringify(text));
  assert.ok(text.includes('Date of Birth'), 'stamp should list Date of Birth: ' + JSON.stringify(text));
  // Below the card (card content ends ~230pt from the top) and
  // left-aligned with the card's left edge (x 59.35).
  for (const s of spans) {
    assert.ok(s.bbox[1] >= 240 && s.bbox[1] <= 280, 'stamp span outside the margin band: ' + JSON.stringify(s.bbox));
    assert.ok(s.bbox[0] >= 55, 'stamp span left of the card edge: ' + JSON.stringify(s.bbox));
  }
});

test('no edited.json -> no red stamp', { skip: SKIP }, (t) => {
  const pdf = buildCard(t, undefined);
  assert.deepEqual(redStampSpans(pdf), []);
});

test('edited:false -> no red stamp', { skip: SKIP }, (t) => {
  const pdf = buildCard(t, { edited: false, fields: ['Name(English)'] });
  assert.deepEqual(redStampSpans(pdf), []);
});
