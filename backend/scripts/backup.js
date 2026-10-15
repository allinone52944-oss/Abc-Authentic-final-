#!/usr/bin/env node
// ============================================================
// All In One (Abc Authentic) — database backup (H-7, 2026-10-15)
// pg_dump (custom format) + retention + status in settings.
// Usage:  node scripts/backup.js
// Env:    DATABASE_URL (required)
//         BACKUP_DIR       (default /opt/all-in-one-abc-authentic/backups)
//         BACKUP_RETENTION (default 7 newest files kept)
// Cron (Oracle server, daily 02:00):
//   0 2 * * * cd /opt/all-in-one-abc-authentic/backend && /usr/bin/node scripts/backup.js >> /opt/all-in-one-abc-authentic/backup.log 2>&1
// ============================================================
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
// Load .env from repo root (cron runs with a bare environment — without this
// DATABASE_URL is empty and the backup silently never happens).
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch {}

const BACKUP_DIR = process.env.BACKUP_DIR || '/opt/all-in-one-abc-authentic/backups';
const RETENTION = Math.max(1, parseInt(process.env.BACKUP_RETENTION || '7', 10));

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', (e) => resolve({ code: 127, err: e.message }));
    p.on('close', (code) => resolve({ code, err: err.slice(0, 2000) }));
  });
}

async function main() {
  const dbUrl = (process.env.DATABASE_URL || '').trim();
  if (!dbUrl) {
    console.error('[backup] DATABASE_URL not set');
    process.exit(2);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `abc-authentic-${ts}.dump`);

  console.log('[backup] dumping to', file);
  const r = await run('pg_dump', [dbUrl, '-F', 'c', '-f', file], process.env);
  let st = null;
  try { st = fs.statSync(file); } catch (e) {}
  if (r.code !== 0 || !st || st.size === 0) {
    try { if (st) fs.unlinkSync(file); } catch (e) {}
    console.error('[backup] pg_dump FAILED:', r.err || ('exit ' + r.code));
    process.exit(1);
  }
  console.log('[backup] OK:', (st.size / 1048576).toFixed(2), 'MB');

  // Retention: keep newest RETENTION dumps
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('abc-authentic-') && f.endsWith('.dump'))
      .map((f) => ({ f, m: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const old of files.slice(RETENTION)) {
      fs.unlinkSync(path.join(BACKUP_DIR, old.f));
      console.log('[backup] pruned', old.f);
    }
  } catch (e) { console.error('[backup] retention cleanup skipped:', e.message); }

  // Record status in settings (system-written; not in the admin-edit allowlist)
  try {
    const db = require('../db');
    const meta = JSON.stringify({
      at: new Date().toISOString(),
      file: path.basename(file),
      bytes: st.size,
      retention: RETENTION,
    });
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('backup.last', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [meta]
    );
    await db.pool.end();
    console.log('[backup] status recorded');
  } catch (e) {
    console.error('[backup] status record skipped:', e.message);
  }
}

main().catch((e) => { console.error('[backup] FAILED:', e.message); process.exit(1); });
