const { matches, normalize } = require('../../../frontend/js/orders-history-clean');

describe('loaded order search', () => {
  test('matches Bengali order digits with English input', () => {
    expect(matches('অর্ডার #১২৩৪', '1234')).toBe(true);
    expect(matches('অর্ডার #১২৩৪', '5678')).toBe(false);
  });
  test('matches English order digits with Bengali input', () => {
    expect(matches('Order #1234', '১২৩৪')).toBe(true);
    expect(matches('Order #1234', '৫৬৭৮')).toBe(false);
  });
  test('search is case insensitive and trims input', () => {
    expect(matches('Document Review', ' REVIEW ')).toBe(true);
    expect(matches('Document Review', 'passport')).toBe(false);
    expect(normalize(null)).toBe('');
  });
});