// Unit tests for the pure helpers of engines/land-core/client.js
// (no network — owner matching + land totals only).
const client = require('../../../engines/land-core/client');

describe('ownerMatches', () => {
  test('exact name inside owners string', () => {
    expect(client.ownerMatches('আকবর আলী', 'আকবর আলী')).toBe(true);
  });
  test('name among several owners', () => {
    expect(client.ownerMatches('আকবর আলী, রহিম উদ্দিন', 'রহিম উদ্দিন')).toBe(true);
  });
  test('whitespace differences tolerated', () => {
    expect(client.ownerMatches('আকবর  আলী', ' আকবর আলী ')).toBe(true);
  });
  test('different name → false', () => {
    expect(client.ownerMatches('করিম শেখ', 'আকবর আলী')).toBe(false);
  });
  test('empty inputs → false', () => {
    expect(client.ownerMatches('', 'আকবর')).toBe(false);
    expect(client.ownerMatches('আকবর আলী', '')).toBe(false);
    expect(client.ownerMatches(null, null)).toBe(false);
  });
});

describe('sumLand', () => {
  test('sums TOTAL_LAND strings', () => {
    expect(client.sumLand([{ TOTAL_LAND: '0.0544' }, { TOTAL_LAND: '1.03' }])).toBeCloseTo(1.0844, 4);
  });
  test('ignores junk values', () => {
    expect(client.sumLand([{ TOTAL_LAND: 'x' }, {}, { TOTAL_LAND: '0.5' }])).toBe(0.5);
  });
  test('empty list → 0', () => {
    expect(client.sumLand([])).toBe(0);
  });
});
