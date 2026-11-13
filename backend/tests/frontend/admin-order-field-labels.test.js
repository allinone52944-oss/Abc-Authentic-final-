// Admin order detail must show the service's OWN field labels (the
// বাংলা labels the customer saw on the order form), falling back to
// the generic ORDER_LABELS_BN dictionary only for unknown keys.
const fs = require('fs'), path = require('path');
const adminJs = fs.readFileSync(path.join(__dirname, '../../../frontend/js/admin.js'), 'utf8');
const adminRoutes = fs.readFileSync(path.join(__dirname, '../../../backend/routes/admin.js'), 'utf8');

function labelMapFor(o) {
  const start = adminJs.indexOf('let svcFieldLabels = {}');
  const catchEnd = adminJs.indexOf('} catch (_) {}', start);
  expect(start).toBeGreaterThan(-1);
  expect(catchEnd).toBeGreaterThan(start);
  const snippet = adminJs.slice(start, catchEnd + '} catch (_) {}'.length);
  return new Function('o', snippet + ';return svcFieldLabels;')(o);
}

test('detail endpoint returns the service form schema for label resolution', () => {
  expect(adminRoutes).toContain('s.fields_required AS service_fields');
});

test('service-defined labels are preferred over the generic dictionary', () => {
  expect(adminJs).toContain('svcFieldLabels[k] || ORDER_LABELS_BN[k] ||');
});

test('service field labels map names to their বাংলা labels', () => {
  const o = { service_fields: JSON.stringify([
    { name: 'applicantName', label: 'আবেদনকারীর নাম' },
    { name: 'land_office', label: 'ভূমি অফিস' },
  ]) };
  const m = labelMapFor(o);
  expect(m.applicantName).toBe('আবেদনকারীর নাম');
  expect(m.land_office).toBe('ভূমি অফিস');
});

test('a field without a label falls back to its own name', () => {
  const m = labelMapFor({ service_fields: [{ name: 'tracking_no' }] });
  expect(m.tracking_no).toBe('tracking_no');
});

test('broken or missing schema never breaks the detail view', () => {
  expect(labelMapFor({ service_fields: '{not json' })).toEqual({});
  expect(labelMapFor({})).toEqual({});
  expect(labelMapFor({ service_fields: 'null' })).toEqual({});
});

test('view() fills service_fields from the single-order fetch when the list row lacks it', () => {
  const viewStart = adminJs.indexOf('async view(id)');
  const viewEnd = adminJs.indexOf('openQuickComplete', viewStart);
  const body = adminJs.slice(viewStart, viewEnd === -1 ? undefined : viewEnd);
  expect(body).toContain("o.service_fields === undefined");
  expect(body).toContain("o.service_fields = fd.order.service_fields");
});
