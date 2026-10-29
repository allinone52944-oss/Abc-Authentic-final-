/**
 * Frontend test — admin.js engine dropdown must offer the mouza engine.
 *
 * Regression: the Admin service-edit modal listed 9 hardcoded engines but
 * not 'land-mouza-value', so editing the mouza service showed no engine
 * selected — and saving that modal overwrote the service row's engine_id
 * (null or a wrong engine), breaking mouza routing and pricing.
 * Both dropdowns (service create + service edit) must offer the option,
 * and the edit dropdown must pre-select it for a mouza service row.
 */
const fs = require('fs');
const path = require('path');

const ADMIN_SRC = fs.readFileSync(
  path.join(__dirname, '../../../frontend/js/admin.js'),
  'utf8',
);

describe('admin engine dropdown: land-mouza-value option', () => {
  test('create-form dropdown offers land-mouza-value', () => {
    expect(ADMIN_SRC).toContain(
      '<option value="land-mouza-value">মৌজা মূল্য রিপোর্ট ইঞ্জিন</option>',
    );
  });

  test('edit-form dropdown offers land-mouza-value with selected logic', () => {
    expect(ADMIN_SRC).toContain(
      `<option value="land-mouza-value"' + (s.engine_id === 'land-mouza-value' ? ' selected' : '') + '>মৌজা মূল্য রিপোর্ট ইঞ্জিন</option>`,
    );
  });

  test('option appears in both dropdowns (create + edit)', () => {
    const count = (ADMIN_SRC.match(/value="land-mouza-value"/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
