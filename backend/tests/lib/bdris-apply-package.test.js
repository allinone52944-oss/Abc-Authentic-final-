// Bug-hunt F6 — bdris-apply's npm scripts pointed at the deleted v1
// server.js while "main" is v2/server.js. Nothing invokes npm start
// (the engine is spawned directly via engines/bdris-apply/index.js),
// so this was latent only — but a stale start script that launches
// nothing is exactly the kind of thing that wastes an hour during
// an incident. The scripts must point at a file that exists.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const PKG = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'engines/bdris-apply/package.json'), 'utf8'),
);

describe('bug-hunt F6 — bdris-apply npm scripts point at a real entry', () => {
  test('start and dev run the v2 server, and the file exists', () => {
    expect(PKG.main).toBe('v2/server.js');
    expect(PKG.scripts.start).toBe('node v2/server.js');
    expect(PKG.scripts.dev).toBe('node v2/server.js');
    expect(fs.existsSync(path.join(ROOT, 'engines/bdris-apply/v2/server.js'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'engines/bdris-apply/server.js'))).toBe(false);
  });
});
