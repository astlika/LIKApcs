/**
 * Date / time formatting rules shared by Admin, Client and printed documents.
 *   Dates:  DD.MM.YYYY        Time: 24-hour HH:mm        Running timers: HH:MM:SS
 */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export interface DateFormatOptions {
  /** IANA time zone; defaults to the machine's local zone. */
  timeZone?: string;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getParts(date: Date, timeZone?: string): DateParts {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

export function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "09.10.2026" */
export function formatDate(value: Date | string | number, options: DateFormatOptions = {}): string {
  const p = getParts(toDate(value), options.timeZone);
  return `${pad2(p.day)}.${pad2(p.month)}.${p.year}`;
}

/** "14:05" */
export function formatTime(value: Date | string | number, options: DateFormatOptions = {}): string {
  const p = getParts(toDate(value), options.timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** "14:05:09" */
export function formatTimeWithSeconds(
  value: Date | string | number,
  options: DateFormatOptions = {},
): string {
  const p = getParts(toDate(value), options.timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/** "09.10.2026 14:05" */
export function formatDateTime(
  value: Date | string | number,
  options: DateFormatOptions = {},
): string {
  return `${formatDate(value, options)} ${formatTime(value, options)}`;
}

/** Running timer: 3725 s → "01:02:05". Hours are not capped at 24 (e.g. "27:15:00"). */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/** Short human duration: 90 min → "1h 30m" (used in lists and packages). */
export function formatMinutesShort(totalMinutes: number): string {
  const safe = Math.max(0, Math.floor(totalMinutes));
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** ISO calendar date "YYYY-MM-DD" in a given time zone — used for API date filters. */
export function toIsoDate(value: Date | string | number, options: DateFormatOptions = {}): string {
  const p = getParts(toDate(value), options.timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export const ISO_DATE_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
