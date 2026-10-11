import { describe, expect, it } from 'vitest';
import { suggestTenders } from './tender';

describe('suggestTenders', () => {
  it('offers the 50 cent coin for a 20 cent total', () => {
    expect(suggestTenders(20)).toEqual([50, 100, 200, 500, 1000, 2000]);
  });

  it('offers 2 € (not 1.50) for 1 € and 1.50 € totals', () => {
    expect(suggestTenders(100)).toEqual([200, 500, 1000, 2000, 5000]);
    expect(suggestTenders(150)).toEqual([200, 500, 1000, 2000, 5000]);
  });

  it('offers 3, 4 and the 5 € note for 2.50 €', () => {
    expect(suggestTenders(250)).toEqual([300, 400, 500, 1000, 2000, 5000]);
  });

  it('rounds odd cents up to the next half euro first', () => {
    expect(suggestTenders(730)).toEqual([750, 800, 1000, 2000, 5000]);
    expect(suggestTenders(2340)).toEqual([2350, 2400, 2500, 3000, 4000, 5000]);
  });

  it('never repeats the exact amount and stays ascending', () => {
    for (const total of [50, 100, 200, 500, 1000, 2000, 5000, 1337, 9999]) {
      const list = suggestTenders(total);
      expect(list).not.toContain(total);
      expect([...list].sort((a, b) => a - b)).toEqual(list);
      expect(list.every((c) => c > total && Number.isInteger(c))).toBe(true);
    }
  });

  it('keeps a 100 € note reachable above 50 €', () => {
    expect(suggestTenders(6000)).toEqual([10000]);
    expect(suggestTenders(7500)).toEqual([7600, 8000, 10000]);
  });

  it('returns nothing for a zero or invalid total', () => {
    expect(suggestTenders(0)).toEqual([]);
    expect(suggestTenders(-5)).toEqual([]);
    expect(suggestTenders(Number.NaN)).toEqual([]);
  });

  it('respects the maximum', () => {
    expect(suggestTenders(20, 3)).toEqual([50, 100, 200]);
  });
});
