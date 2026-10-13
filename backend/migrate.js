// ============================================================
// All In One (Abc Authentic) - Database migration runner
// Usage: node migrate.js   (or: npm run migrate)
// - Applies database/schema.sql (idempotent: IF NOT EXISTS)
// - Applies database/migrations/*.sql in order, tracked in
//   schema_migrations so each runs exactly once.
// - Safe to re-run. Uses DATABASE_URL from .env
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(120) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

    // 1) Base schema (idempotent, in transaction)
    const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
    console.log('[migrate] applying base schema...');
    await client.query('BEGIN');
    try {
      await client.query(fs.readFileSync(schemaPath, 'utf8'));
      await client.query('COMMIT');
      console.log('[migrate] base schema OK');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }

    // 2) Ordered migrations
    const dir = path.join(__dirname, '..', 'database', 'migrations');
    let files = [];
    if (fs.existsSync(dir)) {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    }
    for (const file of files) {
      const done = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rows.length) {
        console.log('[migrate] skip (already applied):', file);
        continue;
      }
      console.log('[migrate] applying:', file);
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('[migrate] applied:', file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    console.log('[migrate] DONE');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[migrate] FAILED:', e.message);
  process.exit(1);
});
