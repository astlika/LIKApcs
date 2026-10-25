import { describe, expect, it } from 'vitest';
import { installmentDueDate, splitInstallments } from '../src/installments.js';

describe('installment plans', () => {
  it('splits the amount in cents, the first parts take the extra cents', () => {
    expect(splitInstallments(1000, 3)).toEqual([334, 333, 333]);
    expect(splitInstallments(60_000, 3)).toEqual([20_000, 20_000, 20_000]);
    expect(splitInstallments(10, 4)).toEqual([3, 3, 2, 2]);
    for (const [total, count] of [
      [12_345, 7],
      [999_999, 24],
      [2, 2],
    ] as const) {
      const parts = splitInstallments(total, count);
      expect(parts).toHaveLength(count);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
    }
  });

  it('rejects amounts and counts that cannot be split', () => {
    expect(() => splitInstallments(0, 3)).toThrow();
    expect(() => splitInstallments(10.5, 3)).toThrow();
    expect(() => splitInstallments(100, 0)).toThrow();
  });

  it('dates the parts monthly, on the same day, clamped to the end of short months', () => {
    expect(installmentDueDate('2026-11-17', 0)).toBe('2026-11-17');
    expect(installmentDueDate('2026-11-17', 2)).toBe('2027-01-17');
    expect(installmentDueDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(installmentDueDate('2028-01-31', 1)).toBe('2028-02-29');
    expect(installmentDueDate('2026-01-31', 2)).toBe('2026-03-31');
    expect(installmentDueDate('2026-10-05', 12)).toBe('2027-10-05');
  });
});
