// PREIUM-PRIVATE (2026-11-13): ONE rule for where an original Form-1
// PDF is kept.
//
// The engine used to write every fetched copy straight into the repo
// `frontend/` dir under a predictable name (`bdris-original-<ack>.pdf`).
// nginx serves that dir directly, so a stored copy downloaded for
// anyone who guessed the number — the backend charge/owner gate never
// even saw the request. Originals now live OUTSIDE the web root in this
// private dir; the only way to one is the authenticated route
// (GET /api/bdris-apply/applications/:ack/original) or the gate, both
// of which check entitlement before reading the file.
//
// Backend (lib/storedOriginal) and engine (v2/services/OriginalFetcher)
// both resolve the directory through this module, so the writer and the
// reader can never drift apart.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const WEB_ROOT = path.join(REPO_ROOT, 'frontend');
const DEFAULT_DIR = path.join(REPO_ROOT, 'private', 'bdris-originals');

// Resolved at call time so a deployment (or a test) can point the store
// elsewhere with BDRIS_ORIGINALS_DIR without a code change.
function originalsDir() {
  const env = String(process.env.BDRIS_ORIGINALS_DIR || '').trim();
  return env ? path.resolve(env) : DEFAULT_DIR;
}

function ensureOriginalsDir() {
  const dir = originalsDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

// True when a directory sits inside the public web root — a store there
// is downloadable by URL, which is exactly what this module prevents.
function isInsideWebRoot(dir) {
  const target = path.resolve(dir || '');
  const root = path.resolve(WEB_ROOT);
  return target === root || target.startsWith(root + path.sep);
}

module.exports = { REPO_ROOT, WEB_ROOT, DEFAULT_DIR, originalsDir, ensureOriginalsDir, isInsideWebRoot };
