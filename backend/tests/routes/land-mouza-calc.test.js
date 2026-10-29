// Pure calculation tests for engines/land-mouza-value/calc.js.
// No portal, no database, no money — generic sample values only.
const { calcMouzaReport, CLASSES } = require('../../../engines/land-mouza-value/calc');

describe('calcMouzaReport', () => {
  test('two lines: total 1300000, deed basis = max(total, declared)', () => {
    const r = calcMouzaReport({
      lines: [
        { mouza: 'নমুনা মৌজা', class: 'নাল', rate: 100000, amount: 10, unit: 'shatangsho' },
        { mouza: 'নমুনা মৌজা', class: 'বাগান', rate: 60000, amount: 5, unit: 'shatangsho' },
      ],
      declaredPrice: 1500000, scheduleVersion: '2025-2026',
    });
    expect(r.totalMinimum).toBe(1300000);
    expect(r.deedBasis).toBe(1500000);
    expect(r.breakdown).toEqual({ 'নাল': 1000000, 'বাগান': 300000 });
    expect(r.valid).toBe(true);
  });
  test('rate follows the selected unit: katha, bigha, gonda', () => {
    const r = calcMouzaReport({
      lines: [
        { mouza: 'নমুনা মৌজা', class: 'নাল', rate: 100000, amount: 10, unit: 'katha' },
        { mouza: 'নমুনা মৌজা', class: 'নাল', rate: 1000, amount: 1, unit: 'bigha' },
        { mouza: 'নমুনা মৌজা', class: 'নাল', rate: 100000, amount: 10, unit: 'gonda' },
      ],
    });
    // shatangsho equivalents are still shown, but value = rate × amount
    // in the selected unit — never rate × shatangsho.
    expect(r.lines[0].qtyShatangsho).toBe(16.5);
    expect(r.lines[0].value).toBe(1000000);
    expect(r.lines[1].qtyShatangsho).toBe(33);
    expect(r.lines[1].value).toBe(1000);
    expect(r.lines[2].qtyShatangsho).toBe(20);
    expect(r.lines[2].value).toBe(1000000);
    expect(() => calcMouzaReport({
      lines: [{ mouza: 'নমুনা মৌজা', class: 'নাল', rate: 1, amount: 1, unit: 'kani' }],
    })).toThrow();
  });
  test("shopkeeper example: 2.5 gonda at 400000 per gonda = 1000000 total", () => {
    const r = calcMouzaReport({
      lines: [
        { mouza: 'নমুনা মৌজা', class: 'ভিটা', rate: 400000, amount: 2.5, unit: 'gonda' },
      ],
    });
    expect(r.lines[0].qtyShatangsho).toBe(5);
    expect(r.lines[0].value).toBe(1000000);
    expect(r.totalMinimum).toBe(1000000);
    expect(r.deedBasis).toBe(1000000);
  });
  test('old-vs-new comparison only when an old rate is supplied', () => {
    const withOld = calcMouzaReport({
      lines: [{ mouza: 'নমুনা মৌজা', class: 'নাল', rate: 60000, amount: 5, unit: 'shatangsho', oldRate: 50000 }],
    });
    expect(withOld.hasOldComparison).toBe(true);
    expect(withOld.lines[0]).toMatchObject({ oldValue: 250000, delta: 50000 });
    const withoutOld = calcMouzaReport({
      lines: [{ mouza: 'নমুনা মৌজা', class: 'নাল', rate: 60000, amount: 5, unit: 'shatangsho' }],
    });
    expect(withoutOld.hasOldComparison).toBe(false);
  });
  test('all seven classes are accepted, unknown class rejected', () => {
    expect(CLASSES).toEqual(['নাল', 'বাড়ী', 'ভিটা', 'বাগান', 'পুকুর', 'ডোবা', 'বাণিজ্যিক']);
    expect(() => calcMouzaReport({ lines: [] })).toThrow();
    expect(() => calcMouzaReport({
      lines: [{ mouza: 'নমুনা মৌজা', class: 'অজানা', rate: 1, amount: 1, unit: 'shatangsho' }],
    })).toThrow();
    expect(() => calcMouzaReport({
      lines: [{ mouza: 'নমুনা মৌজা', class: 'নাল', rate: 1, amount: 0, unit: 'shatangsho' }],
    })).toThrow();
  });
});
