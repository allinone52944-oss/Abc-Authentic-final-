// Audit #49 — charge rule per service: WHEN the wallet is cut.
// The mapping is derived from the charge call sites (see the module
// header for the per-rule evidence); these tests pin it so a later
// charge change cannot silently desync the card labels.
const { chargeRuleFor, RULES } = require('../../lib/chargeRule');

describe('chargeRuleFor (audit #49)', () => {
  test('every known engine_id maps to its true rule', () => {
    expect(chargeRuleFor({ engine_id: 'bdris-apply' })).toEqual(
      { rule: 'upfront', label: 'আগে কাটবে', detail: 'জমা দেওয়ার সময়' });
    for (const id of ['birth-final', 'death-final', 'qr-photo-verify']) {
      expect(chargeRuleFor({ engine_id: id }).rule).toBe('success');
      expect(chargeRuleFor({ engine_id: id }).detail).toBe('যাচাই সফল হলেই');
    }
    expect(chargeRuleFor({ engine_id: 'nid-replica' })).toEqual(
      { rule: 'success', label: 'সফল হলেই কাটবে', detail: 'কার্ড তৈরি হলেই' });
    expect(chargeRuleFor({ engine_id: 'nid-server-copy' }).detail).toBe('প্রতিটি সফল ডাউনলোডে');
    for (const id of ['land-scan', 'land-verify']) {
      expect(chargeRuleFor({ engine_id: id }).detail).toBe('রেকর্ড পেলেই');
    }
    expect(chargeRuleFor({ engine_id: 'land-mouza-value' }).detail).toBe('রিপোর্ট তৈরি হলেই');
    expect(chargeRuleFor({ engine_id: 'land-khatian' }).detail).toBe('খতিয়ান পেলেই');
    expect(chargeRuleFor({ engine_id: 'land-mouza-map' }).detail).toBe('ম্যাপ পেলেই');
  });

  test('the map covers the whole closed engine set (11 IDs)', () => {
    // Audit #14 — land-search left the set with its route (audit #6);
    // birth/death carry their directory names now.
    expect(Object.keys(RULES).sort()).toEqual([
      'bdris-apply', 'birth-final', 'death-final', 'land-khatian',
      'land-mouza-map', 'land-mouza-value', 'land-scan',
      'land-verify', 'nid-replica', 'nid-server-copy', 'qr-photo-verify',
    ]);
  });

  test('a manual service (no engine_id) is upfront', () => {
    expect(chargeRuleFor({ engine_id: null, type: 'manual' })).toEqual(
      { rule: 'upfront', label: 'আগে কাটবে', detail: 'অর্ডার কনফার্মের সাথে সাথে' });
    expect(chargeRuleFor({ type: 'manual' }).rule).toBe('upfront');
  });

  test('an unknown engine_id is never guessed — no label', () => {
    expect(chargeRuleFor({ engine_id: 'something-new', type: 'automated' })).toBeNull();
    expect(chargeRuleFor(null)).toBeNull();
    expect(chargeRuleFor({})).toEqual(
      { rule: 'upfront', label: 'আগে কাটবে', detail: 'অর্ডার কনফার্মের সাথে সাথে' });
  });
});
