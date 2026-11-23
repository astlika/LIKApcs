import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatMinutesShort,
  formatTime,
  formatTimeOnDay,
  formatTimeWithSeconds,
  toIsoDate,
  timeOnDayParts,
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

  it('shows a calendar date (YYYY-MM-DD) as-is, whatever the zone', () => {
    expect(formatDate('2026-10-18', { timeZone: 'America/Los_Angeles' })).toBe('18.10.2026');
    expect(formatDate('2026-10-18', { timeZone: 'Pacific/Auckland' })).toBe('18.10.2026');
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

describe('formatTimeOnDay — the time of one line of a bill', () => {
  const tz = { timeZone: 'Europe/Belgrade' }; // UTC+1 in November (CET)

  it('is the bare time on the day the reader has in mind', () => {
    expect(formatTimeOnDay('2026-11-23T13:05:40Z', '2026-11-23T20:00:00Z', tz)).toBe('14:05');
    // The same day in the shop, although the UTC dates differ (00:30 and 23:50 local time).
    expect(formatTimeOnDay('2026-11-22T23:30:00Z', '2026-11-23T22:50:00Z', tz)).toBe('00:30');
  });

  it('carries the day when the product was added on another day', () => {
    // A session over midnight: added 23:40 on the 22nd, the bill is paid at 01:10 on the 23rd.
    expect(formatTimeOnDay('2026-11-22T22:40:00Z', '2026-11-23T00:10:00Z', tz)).toBe('22.11 23:40');
    // The reference may be the earlier one (a reprint read against the receipt's date).
    expect(formatTimeOnDay('2026-11-23T00:10:00Z', '2026-11-22T22:40:00Z', tz)).toBe('23.11 01:10');
  });

  it('gives the day and the time apart, for a text that names them separately', () => {
    expect(timeOnDayParts('2026-11-23T13:05:40Z', '2026-11-23T20:00:00Z', tz)).toEqual({
      time: '14:05',
      day: null,
    });
    expect(timeOnDayParts('2026-11-22T22:40:00Z', '2026-11-23T00:10:00Z', tz)).toEqual({
      time: '23:40',
      day: '22.11',
    });
    expect(timeOnDayParts('2025-12-31T22:40:00Z', '2026-01-01T00:10:00Z', tz)).toEqual({
      time: '23:40',
      day: '31.12.2025',
    });
  });

  it('carries the year too when it is another year', () => {
    expect(formatTimeOnDay('2025-12-31T22:40:00Z', '2026-01-01T00:10:00Z', tz)).toBe(
      '31.12.2025 23:40',
    );
  });

  it('goes by the calendar day of the time zone, not by 24 hours', () => {
    // 23 hours apart but two calendar days; one minute apart across midnight is two days as well.
    expect(formatTimeOnDay('2026-11-22T08:00:00Z', '2026-11-23T07:00:00Z', tz)).toBe('22.11 09:00');
    expect(formatTimeOnDay('2026-11-22T22:59:30Z', '2026-11-22T23:00:30Z', tz)).toBe('22.11 23:59');
    // Without a time zone the machine's own is used, as in the other formatters.
    const noon = new Date(2026, 10, 23, 12, 0, 0);
    expect(formatTimeOnDay(new Date(2026, 10, 23, 9, 7, 0), noon)).toBe('09:07');
    expect(formatTimeOnDay(new Date(2026, 10, 22, 9, 7, 0), noon)).toBe('22.11 09:07');
  });
});
