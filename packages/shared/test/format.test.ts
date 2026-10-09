import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatMinutesShort,
  formatTime,
  formatTimeWithSeconds,
  toIsoDate,
} from '../src/format.js';

const instant = new Date('2026-10-09T12:05:09Z');

describe('date & time formatting', () => {
  it('uses DD.MM.YYYY and 24-hour time in a fixed zone', () => {
    const tz = { timeZone: 'Europe/Belgrade' }; // UTC+2 in October (CEST)
    expect(formatDate(instant, tz)).toBe('09.10.2026');
    expect(formatTime(instant, tz)).toBe('14:05');
    expect(formatTimeWithSeconds(instant, tz)).toBe('14:05:09');
    expect(formatDateTime(instant, tz)).toBe('09.10.2026 14:05');
    expect(toIsoDate(instant, tz)).toBe('2026-10-09');
  });

  it('never renders 24:xx for midnight', () => {
    const midnight = new Date('2026-01-01T23:00:00Z'); // 00:00 in Belgrade (CET)
    expect(formatTime(midnight, { timeZone: 'Europe/Belgrade' })).toBe('00:00');
  });

  it('formats running timers as HH:MM:SS', () => {
    expect(formatDuration(0)).toBe('00:00:00');
    expect(formatDuration(59)).toBe('00:00:59');
    expect(formatDuration(3725)).toBe('01:02:05');
    expect(formatDuration(100 * 3600)).toBe('100:00:00');
    expect(formatDuration(-5)).toBe('00:00:00');
  });

  it('formats short durations', () => {
    expect(formatMinutesShort(30)).toBe('30m');
    expect(formatMinutesShort(60)).toBe('1h');
    expect(formatMinutesShort(90)).toBe('1h 30m');
  });
});
