const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../../frontend/js/admin.js'), 'utf8');
const m = src.match(/function isEngineOrder\(o\)\{[^\n]*\}/);
// eslint-disable-next-line no-new-func
const isEngineOrder = new Function(m[0] + '; return isEngineOrder;')();

describe('engine orders skip manual delivered step', () => {
  test('engine-backed order is recognised', () => {
    expect(isEngineOrder({ service_engine: 'nid-replica', service_type: 'manual' })).toBe(true);
    expect(isEngineOrder({ service_engine: null, service_type: 'automated' })).toBe(true);
  });
  test('manual order keeps the delivered button', () => {
    expect(isEngineOrder({ service_engine: '  ', service_type: 'manual' })).toBe(false);
    expect(isEngineOrder(null)).toBe(false);
  });
  test('markDelivered refuses engine orders before calling the server', () => {
    const body = src.slice(src.indexOf('async markDelivered('), src.indexOf('smartTransition(id, o ? o.status : \'completed\', \'delivered\')'));
    expect(body).toMatch(/if \(isEngineOrder\(o\)\)/);
  });
});
