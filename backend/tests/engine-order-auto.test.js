const fs = require('fs'); const path = require('path');
const admin = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
const ej = fs.readFileSync(path.join(__dirname, '../routes/engine-jobs.js'), 'utf8');
test('engine result is auto-completed in admin; failed stays failed', () => {
  expect(admin).toMatch(/auto_status: row\.outcome === 'failed' \? 'failed' : 'completed'/);
});
test('admin file is the same stored engine file, read-only', () => {
  const h = ej.slice(ej.indexOf("adminEngineJobs.get('/:id/file'"), ej.indexOf("// DELETE /api/admin/engine-jobs"));
  expect(h).toMatch(/FROM engine_jobs WHERE id = \$1/);
  expect(h).not.toMatch(/INSERT|UPDATE|DELETE|balance/);
});
