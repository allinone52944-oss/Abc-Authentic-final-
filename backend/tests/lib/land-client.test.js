// Unit tests for the pure helpers of engines/land-core/client.js
// (no network — owner matching + land totals only).
const client = require('../../../engines/land-core/client');

describe('filterUpazilas (audit #11)', () => {
  test('revenue circles (IS_CIRCLE=1) are dropped', () => {
    const rows = [
      { BBS_CODE: '48', NAME: 'Mirpur', IS_CIRCLE: 1 },
      { BBS_CODE: '49', NAME: 'Mirpur Upazila', IS_CIRCLE: 0 },
      { BBS_CODE: '50', NAME: 'Other Circle', IS_CIRCLE: '1' },
    ];
    expect(client.filterUpazilas(rows)).toEqual([
      { BBS_CODE: '49', NAME: 'Mirpur Upazila', IS_CIRCLE: 0 },
    ]);
  });
  test('rows without IS_CIRCLE are kept (never dropped silently)', () => {
    const rows = [{ BBS_CODE: '49', NAME: 'Upazila' }];
    expect(client.filterUpazilas(rows)).toEqual(rows);
  });
  test('non-array input -> empty list', () => {
    expect(client.filterUpazilas(null)).toEqual([]);
    expect(client.filterUpazilas(undefined)).toEqual([]);
  });
});

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
  test('single word is a whole-token match, not a substring accident', () => {
    expect(client.ownerMatches('আকবর আলী', 'আকবর')).toBe(true);
    expect(client.ownerMatches('পরীক্ষক দুই', 'দুই')).toBe(true);
  });
  test('partial word never matches (audit #7)', () => {
    expect(client.ownerMatches('আকবর আলী', 'আল')).toBe(false);
    expect(client.ownerMatches('আকবর আলী', 'আক')).toBe(false);
  });
  test('substring inside a different word never matches', () => {
    expect(client.ownerMatches('আকরিম উদ্দিন', 'করিম')).toBe(false);
  });
  test('query spanning two owners never matches', () => {
    expect(client.ownerMatches('আকবর আলী, রহিম উদ্দিন', 'আলী, রহিম')).toBe(false);
    expect(client.ownerMatches('আকবর আলী, রহিম উদ্দিন', 'আলী রহিম')).toBe(false);
  });
  test('token order does not matter; extra query word blocks', () => {
    expect(client.ownerMatches('রহিম উদ্দিন', 'উদ্দিন রহিম')).toBe(true);
    expect(client.ownerMatches('আকবর আলী', 'আকবর আলী মিয়া')).toBe(false);
  });
});

describe('ownerMatchDetail', () => {
  test('names the matched owner entry and the matched tokens', () => {
    const d = client.ownerMatchDetail('আকবর আলী, রহিম উদ্দিন', 'রহিম উদ্দিন');
    expect(d).toEqual({ match: true, matchedOwner: 'রহিম উদ্দিন', matchedTokens: ['রহিম', 'উদ্দিন'] });
  });
  test('non-match names no owner', () => {
    const d = client.ownerMatchDetail('আকবর আলী', 'করিম শেখ');
    expect(d).toEqual({ match: false, matchedOwner: null, matchedTokens: [] });
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
