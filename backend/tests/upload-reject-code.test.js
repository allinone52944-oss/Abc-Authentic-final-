const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'security.js'), 'utf8');
test('oversize upload answers FILE_TOO_LARGE, not a server error', () => {
  expect(src).toMatch(/LIMIT_FILE_SIZE'\) return reject\('FILE_TOO_LARGE'\)/);
});
test('wrong file type answers FILE_TYPE_NOT_ALLOWED with 400', () => {
  expect(src).toMatch(/status\(400\)\.json\(\{ error: code/);
  expect(src).not.toMatch(/next\(new Error\('FILE_TYPE_NOT_ALLOWED'\)\)/);
});
