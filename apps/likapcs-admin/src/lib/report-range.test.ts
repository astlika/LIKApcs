import { describe, expect, it } from 'vitest';
import { isoDate, presetRange } from './report-range';

/** A local moment; months as people count them (1 = January). */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

describe('isoDate', () => {
  it('gives the local calendar date, also a minute before and after midnight', () => {
    expect(isoDate(at(2026, 1, 5, 23, 59))).toBe('2026-01-05');
    expect(isoDate(at(2026, 1, 6, 0, 0))).toBe('2026-01-06');
    expect(isoDate(at(2026, 11, 22))).toBe('2026-11-22');
  });
});

describe('presetRange', () => {
  it('today and yesterday are one day each', () => {
    expect(presetRange('today', at(2026, 11, 22))).toEqual({
      from: '2026-11-22',
      to: '2026-11-22',
    });
    expect(presetRange('yesterday', at(2026, 11, 22))).toEqual({
      from: '2026-11-21',
      to: '2026-11-21',
    });
  });

  it('yesterday crosses the month and the year', () => {
    expect(presetRange('yesterday', at(2026, 3, 1)).from).toBe('2026-02-28');
    expect(presetRange('yesterday', at(2028, 3, 1)).from).toBe('2028-02-29');
    expect(presetRange('yesterday', at(2027, 1, 1)).from).toBe('2026-12-31');
  });

  it('the week starts on Monday and ends today', () => {
    // 2026-11-22 is a Sunday: its week began on Monday the 16th.
    expect(presetRange('week', at(2026, 11, 22))).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    // A Monday is the first day of its own week.
    expect(presetRange('week', at(2026, 11, 16))).toEqual({ from: '2026-11-16', to: '2026-11-16' });
    // A week that began in the month before.
    expect(presetRange('week', at(2026, 12, 2))).toEqual({ from: '2026-11-30', to: '2026-12-02' });
  });

  it('this month runs from the first to today', () => {
    expect(presetRange('month', at(2026, 11, 22))).toEqual({
      from: '2026-11-01',
      to: '2026-11-22',
    });
    expect(presetRange('month', at(2026, 11, 1))).toEqual({ from: '2026-11-01', to: '2026-11-01' });
  });

  it('last month is the whole month before, whatever its length', () => {
    expect(presetRange('lastMonth', at(2026, 11, 22))).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(presetRange('lastMonth', at(2026, 1, 15))).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    expect(presetRange('lastMonth', at(2028, 3, 31))).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    // The 31st of a month after a 30-day month must not skip to the month before that.
    expect(presetRange('lastMonth', at(2026, 5, 31))).toEqual({
      from: '2026-04-01',
      to: '2026-04-30',
    });
  });

  it('own dates start from today', () => {
    expect(presetRange('custom', at(2026, 11, 22))).toEqual({
      from: '2026-11-22',
      to: '2026-11-22',
    });
  });
});
