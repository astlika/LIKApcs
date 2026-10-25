import { describe, expect, it } from 'vitest';
import {
  formatUnitMoney,
  millsToCents,
  multiplyMillsByQuantity,
  parseUnitMoneyInput,
} from './money.js';

describe('unit money in mills (thousandths of €)', () => {
  it('parses up to three decimals without floats', () => {
    expect(parseUnitMoneyInput('0.125')).toBe(125);
    expect(parseUnitMoneyInput('0,125')).toBe(125);
    expect(parseUnitMoneyInput('12,5')).toBe(12_500);
    expect(parseUnitMoneyInput('1 234,125 €')).toBe(1_234_125);
    expect(parseUnitMoneyInput('0.1')).toBe(100);
    expect(parseUnitMoneyInput('')).toBeNull();
    expect(parseUnitMoneyInput('1.2345')).toBeNull();
    expect(parseUnitMoneyInput('abc')).toBeNull();
  });

  it('rounds mills to whole cents, half away from zero', () => {
    expect(millsToCents(125)).toBe(13);
    expect(millsToCents(124)).toBe(12);
    expect(millsToCents(1500)).toBe(150);
    expect(millsToCents(0)).toBe(0);
  });

  it('multiplies a unit in mills by a milli quantity, rounding the cents', () => {
    expect(multiplyMillsByQuantity(125, 10_000)).toBe(125); // 10 × 0.125 € = 1.25 € = 125 cents
    expect(multiplyMillsByQuantity(125, 1_000)).toBe(13); // 1 × 0.125 € → 13 cents
    expect(multiplyMillsByQuantity(900, 1_500)).toBe(135); // 1.5 × 0.90 €
  });

  it('formats with three decimals only when needed', () => {
    expect(formatUnitMoney(125, { currency: 'EUR', locale: 'en' })).toBe('€0.125');
    expect(formatUnitMoney(1500, { currency: 'EUR', locale: 'en' })).toBe('€1.50');
    expect(formatUnitMoney(125, { currency: 'EUR', locale: 'sq' })).toBe('0,125 €');
  });
});
