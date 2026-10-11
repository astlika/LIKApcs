import { describe, expect, it } from 'vitest';
import { stripScannedCode } from './scanner';
import { offeredPaymentMethods } from './payment-methods';

describe('stripScannedCode', () => {
  it('removes the scanned code from the end of the field that received it', () => {
    expect(stripScannedCode('5449000000996', '5449000000996')).toBe('');
    expect(stripScannedCode('25449000000996', '5449000000996')).toBe('2');
  });
  it('leaves values alone that do not end with the code', () => {
    expect(stripScannedCode('12.50', '5449000000996')).toBe('12.50');
    expect(stripScannedCode('', '5449000000996')).toBe('');
    expect(stripScannedCode('abc', '')).toBe('abc');
  });
});

describe('offeredPaymentMethods', () => {
  it('never mentions card unless card payments are enabled', () => {
    expect(offeredPaymentMethods(false)).toEqual(['cash', 'bank_transfer', 'other']);
    expect(offeredPaymentMethods(true)).toEqual(['cash', 'card', 'bank_transfer', 'other']);
  });
});
