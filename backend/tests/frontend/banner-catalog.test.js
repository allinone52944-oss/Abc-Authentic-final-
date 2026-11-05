/**
 * Regression guard — audit #84 banner catalog curation.
 *
 * The admin banner picker listed 25 designs flat, which made premium
 * selection hard. The fix curates instead of gutting the set:
 *  - all 6 festival designs (ids 10-15) stay — each serves a distinct day;
 *  - only #25 "Blue Wave" is removed: it had NO category (every other
 *    design has one) and its default text "স্বাগতম" duplicates #20
 *    Welcome Bloom ("স্বাগতম!");
 *  - the admin picker groups designs by the catalog's existing categories
 *    (promo / offer / announcement / festival / welcome / maintenance).
 *
 * Safety: no repo reference to design 25 exists (DB rows store design_id,
 * and render.js falls back to designs[0] for an unknown id, so even a
 * stale live row renders instead of breaking). The live DB itself cannot
 * be checked from this environment — before merge, run on the server:
 *   SELECT id, title, active FROM banners WHERE design_id = 25;
 * and expect zero rows.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const CATALOG_PATH = path.join(ROOT, 'frontend', 'banners', 'catalog.json');
const SAMPLES_DIR = path.join(ROOT, 'frontend', 'banners', 'samples');
const ADMIN_JS = path.join(ROOT, 'frontend', 'js', 'admin.js');
const RENDER_JS = path.join(ROOT, 'frontend', 'banners', 'render.js');

const EXPECTED_CATEGORIES = ['promo', 'offer', 'announcement', 'festival', 'welcome', 'maintenance'];
const FESTIVAL_IDS = [10, 11, 12, 13, 14, 15];

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

function walkFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (/\.(js|json|sql|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('audit #84 — banner catalog curated to 24 designs', () => {
  test('catalog has 24 designs, ids exactly 1..24, no id 25', () => {
    const cat = loadCatalog();
    expect(cat.designs).toHaveLength(24);
    expect(cat.designs.map((d) => d.id).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(cat.designs.some((d) => d.id === 25)).toBe(false);
  });

  test('every remaining design has a category from the known set', () => {
    const cat = loadCatalog();
    for (const d of cat.designs) {
      expect(typeof d.category).toBe('string');
      expect(d.category.length).toBeGreaterThan(0);
      expect(EXPECTED_CATEGORIES).toContain(d.category);
    }
    expect([...new Set(cat.designs.map((d) => d.category))].sort())
      .toEqual([...EXPECTED_CATEGORIES].sort());
  });

  test('all 6 festival designs (10-15) are kept', () => {
    const cat = loadCatalog();
    for (const id of FESTIVAL_IDS) {
      const d = cat.designs.find((x) => x.id === id);
      expect(d).toBeDefined();
      expect(d.category).toBe('festival');
    }
  });

  test('no design is named Blue Wave and every design file exists on disk', () => {
    const cat = loadCatalog();
    expect(cat.designs.some((d) => /blue wave/i.test(d.name || ''))).toBe(false);
    expect(cat.designs.some((d) => /25-blue-wave/.test(d.file || ''))).toBe(false);
    expect(fs.existsSync(path.join(SAMPLES_DIR, '25-blue-wave.html'))).toBe(false);
    const ids = new Set();
    const files = new Set();
    for (const d of cat.designs) {
      expect(ids.has(d.id)).toBe(false);
      ids.add(d.id);
      expect(files.has(d.file)).toBe(false);
      files.add(d.file);
      expect(fs.existsSync(path.join(SAMPLES_DIR, d.file))).toBe(true);
    }
  });
});

describe('audit #84 — admin picker groups designs by category', () => {
  const src = fs.readFileSync(ADMIN_JS, 'utf8');

  test('AdmBn has a designGridHtml grouping helper with the six categories in order', () => {
    expect(src).toMatch(/designGridHtml\(designs, selId\)/);
    expect(src).toMatch(/_catOrder:\s*\['promo', 'offer', 'announcement', 'festival', 'welcome', 'maintenance'\]/);
    expect(src).toMatch(/class="bn-design-group"/);
  });

  test('create and edit forms both render the grouped grid (no flat map left)', () => {
    expect(src).toMatch(/this\.designGridHtml\(cat\.designs, 1\)/);
    expect(src).toMatch(/this\.designGridHtml\(cat\.designs, b\.design_id\)/);
    expect(src).not.toMatch(/cat\.designs\.map\(\(d\)/);
    expect(src).not.toMatch(/cat\.designs\.map\(\(x\)/);
  });

  test('grouped options keep the picker contract (data-id, pick(), sel class)', () => {
    expect(src).toMatch(/class="bn-design-opt'/);
    expect(src).toMatch(/onclick="AdmBn\.pick\('/);
    expect(src).toMatch(/data-id="' \+ d\.id \+/);
  });
});

describe('audit #84 — no banner can reference the removed design', () => {
  test('render.js falls back to the first design for an unknown design_id', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    expect(src).toMatch(/cat\.designs\.find\(\(x\) => x\.id === id\) \|\| cat\.designs\[0\]/);
  });

  test('nothing in the repo references 25-blue-wave / Blue Wave', () => {
    const files = []
      .concat(walkFiles(path.join(ROOT, 'frontend'), []))
      .concat(walkFiles(path.join(ROOT, 'backend', 'tests'), []))
      .concat(walkFiles(path.join(ROOT, 'database'), []));
    const hits = [];
    for (const f of files) {
      if (path.basename(f) === 'banner-catalog.test.js') continue;
      const text = fs.readFileSync(f, 'utf8');
      if (/25-blue-wave|Blue Wave|ব্লু ওয়েভ/.test(text)) hits.push(path.relative(ROOT, f));
    }
    expect(hits).toEqual([]);
  });
});
