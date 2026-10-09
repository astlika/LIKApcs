import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatMoney } from '@likapcs/shared';

// The Admin relies on the shared formatting rules: EUR, DD.MM.YYYY, 24h.
describe('admin presentation rules', () => {
  it('money is displayed from integer cents in EUR', () => {
    expect(formatMoney(123456, { currency: 'EUR', locale: 'en' })).toBe('€1,234.56');
    expect(formatMoney(-500, { currency: 'EUR', locale: 'en' })).toBe('-€5.00');
  });
  it('dates use DD.MM.YYYY and 24-hour time in the business time zone', () => {
    expect(formatDate('2026-10-09T22:30:00Z', { timeZone: 'Europe/Belgrade' })).toBe('10.10.2026');
    expect(formatDateTime('2026-10-09T22:30:00Z', { timeZone: 'Europe/Belgrade' })).toBe(
      '10.10.2026 00:30',
    );
  });
});
