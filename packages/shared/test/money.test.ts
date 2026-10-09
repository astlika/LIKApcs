import { describe, expect, it } from 'vitest';
import {
  addExclusiveTax,
  formatMoney,
  formatQuantity,
  multiplyByQuantity,
  parseMoneyInput,
  parseQuantityInput,
  percentOf,
  roundToIncrement,
  splitInclusiveTax,
  sumCents,
} from '../src/money.js';

describe('money arithmetic (integer cents)', () => {
  it('multiplies unit price by milli-quantities with commercial rounding', () => {
    expect(multiplyByQuantity(150, 1000)).toBe(150); // 1 × 1.50
    expect(multiplyByQuantity(150, 3000)).toBe(450); // 3 × 1.50
    expect(multiplyByQuantity(199, 500)).toBe(100); // 0.5 × 1.99 = 0.995 → 1.00
    expect(multiplyByQuantity(333, 333)).toBe(111); // 0.333 × 3.33 = 1.10889 → 1.11
    expect(multiplyByQuantity(-199, 500)).toBe(-100); // symmetric rounding
  });

  it('rejects non-integer input', () => {
    expect(() => multiplyByQuantity(1.5, 1000)).toThrow(TypeError);
    expect(() => multiplyByQuantity(150, 0.5)).toThrow(TypeError);
  });

  it('computes percentages in basis points', () => {
    expect(percentOf(1000, 1800)).toBe(180); // 18 % of 10.00
    expect(percentOf(1, 5000)).toBe(1); // 0.5 cent rounds up
    expect(percentOf(999, 1000)).toBe(100); // 99.9 → 100
  });

  it('splits inclusive tax so that net + tax always equals gross', () => {
    for (const gross of [1, 99, 100, 118, 1000, 1234, 99999]) {
      const { net, tax } = splitInclusiveTax(gross, 1800);
      expect(net + tax).toBe(gross);
    }
    expect(splitInclusiveTax(11800, 1800)).toEqual({ net: 10000, tax: 1800 });
    expect(splitInclusiveTax(100, 0)).toEqual({ net: 100, tax: 0 });
  });

  it('adds exclusive tax', () => {
    expect(addExclusiveTax(10000, 1800)).toEqual({ gross: 11800, tax: 1800 });
  });

  it('sums safely', () => {
    expect(sumCents([1, 2, 3])).toBe(6);
    expect(sumCents([])).toBe(0);
    expect(() => sumCents([1.1])).toThrow();
  });

  it('rounds to increments (session billing / cash rounding)', () => {
    expect(roundToIncrement(1234, 50, 'up')).toBe(1250);
    expect(roundToIncrement(1234, 50, 'down')).toBe(1200);
    expect(roundToIncrement(1225, 50, 'nearest')).toBe(1250);
    expect(roundToIncrement(1224, 50, 'nearest')).toBe(1200);
    expect(roundToIncrement(1200, 50, 'up')).toBe(1200);
    expect(roundToIncrement(-1234, 50, 'up')).toBe(-1250);
  });
});

describe('money parsing & formatting', () => {
  it('parses user input with comma or dot', () => {
    expect(parseMoneyInput('12,50')).toBe(1250);
    expect(parseMoneyInput('12.5')).toBe(1250);
    expect(parseMoneyInput('1 234,00')).toBe(123400);
    expect(parseMoneyInput('€ 3')).toBe(300);
    expect(parseMoneyInput('-0,99')).toBe(-99);
    expect(parseMoneyInput('12.345')).toBeNull();
    expect(parseMoneyInput('abc')).toBeNull();
    expect(parseMoneyInput('')).toBeNull();
  });

  it('parses quantities into milli-units', () => {
    expect(parseQuantityInput('1')).toBe(1000);
    expect(parseQuantityInput('0,5')).toBe(500);
    expect(parseQuantityInput('2.250')).toBe(2250);
    expect(parseQuantityInput('1.2345')).toBeNull();
  });

  it('formats EUR deterministically for both languages', () => {
    expect(formatMoney(123450)).toBe('€1,234.50');
    expect(formatMoney(123450, { locale: 'sq' })).toBe('1.234,50 €');
    expect(formatMoney(-99)).toBe('-€0.99');
    expect(formatMoney(5, { showSymbol: false })).toBe('0.05');
    expect(formatMoney(100, { currency: 'CHF' })).toBe('1.00 CHF');
  });

  it('formats quantities', () => {
    expect(formatQuantity(1000)).toBe('1');
    expect(formatQuantity(1500)).toBe('1.5');
    expect(formatQuantity(2250, 'sq')).toBe('2,25');
    expect(formatQuantity(-500)).toBe('-0.5');
  });
});
