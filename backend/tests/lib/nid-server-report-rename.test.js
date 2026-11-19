// Rename guard for the Sign to Server Copy engine (migration 062):
// the 2026-11-19 user direction renamed the NID Server Copy Report
// service to "Sign to Server Copy" / "সাইন টু সার্ভার কপি".
// engine_id NEVER changes ('nid-server-report') — only the display
// name. Migration 060 already ran live, so the rename must be a
// new UPDATE migration, never an edit of 060. No live DB; the
// migration text is the contract.
const fs = require('fs');
const path = require('path');

const mig = fs.readFileSync(
  path.join(__dirname, '../../../database/migrations/062_rename_server_copy_service.sql'),
  'utf8',
);

describe('migration 062_rename_server_copy_service.sql', () => {
  test('renames the service to Sign to Server Copy (EN + BN)', () => {
    expect(mig).toContain("SET name = 'Sign to Server Copy', name_bn = 'সাইন টু সার্ভার কপি'");
    expect(mig).toContain("WHERE engine_id = 'nid-server-report'");
  });

  test('never touches engine_id (mapping + History stay intact)', () => {
    // The SET clause must assign only the two display names — the
    // WHERE guard is the only place engine_id may appear in SQL.
    const setClause = mig.split('SET')[1].split('WHERE')[0];
    expect(setClause).not.toContain('engine_id');
    expect(mig).not.toContain("engine_id = 'nid-server-copy'");
  });

  test('idempotent (only rows whose name still differs)', () => {
    expect(mig).toContain("name <> 'Sign to Server Copy'");
    expect(mig).toContain("name_bn <> 'সাইন টু সার্ভার কপি'");
  });
});
