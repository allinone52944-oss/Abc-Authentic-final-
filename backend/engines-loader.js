// ============================================================
// All In One (Abc Authentic) - Engine Loader
// Scans ../engines/ for engine manifests and loads them.
// Each engine is a folder with an engine.json manifest:
//
//   engines/<engine-id>/
//     engine.json   { "id": "...", "name": "...", "version": "...",
//                     "entry": "index.js", "description": "..." }
//     index.js      module exporting { run(payload) } etc.
//
// Engines are PERMANENT modules - no temporary hacks.
// Future engines: NID, BDRIS, Death Registration, ...
// ============================================================
const fs = require('fs');
const path = require('path');

const ENGINES_DIR = path.join(__dirname, '..', 'engines');

function loadEngines() {
  const loaded = {};
  if (!fs.existsSync(ENGINES_DIR)) {
    console.warn('[engines] directory not found:', ENGINES_DIR);
    return loaded;
  }
  const entries = fs.readdirSync(ENGINES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(ENGINES_DIR, entry.name, 'engine.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const entryFile = path.join(ENGINES_DIR, entry.name, manifest.entry || 'index.js');
      const mod = require(entryFile);
      loaded[manifest.id] = { manifest, module: mod };
      console.log(`[engines] loaded: ${manifest.id} v${manifest.version} - ${manifest.name}`);
    } catch (err) {
      console.error(`[engines] failed to load ${entry.name}:`, err.message);
    }
  }
  return loaded;
}

module.exports = { loadEngines, ENGINES_DIR };
