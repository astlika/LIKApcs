import { describe, expect, it } from 'vitest';
import {
  allocateProportionally,
  computeSale,
  customerDiscountCents,
  refundAmountForQuantity,
  settlePayments,
} from '../src/sale-math.js';

describe('computeSale', () => {
  it('multiplies, splits inclusive tax and sums', () => {
    const r = computeSale([{ unitPriceCents: 150, quantityMilli: 2000, taxRateBp: 1800 }]);
    expect(r.subtotalCents).toBe(300);
    expect(r.totalCents).toBe(300);
    expect(r.taxCents).toBe(46); // 300 / 1.18 = 254.24 → net 254, tax 46
    expect(r.lines[0]).toMatchObject({ grossCents: 300, lineTotalCents: 300, netCents: 254 });
  });

  it('handles fractional quantities in milli units with half-up rounding', () => {
    const r = computeSale([{ unitPriceCents: 299, quantityMilli: 1500, taxRateBp: 800 }]);
    expect(r.lines[0]!.grossCents).toBe(449); // 448.5 → 449
  });

  it('adds tax on top for net-priced products', () => {
    const r = computeSale([
      { unitPriceCents: 1000, quantityMilli: 1000, taxRateBp: 1800, priceIncludesTax: false },
    ]);
    expect(r.lines[0]).toMatchObject({ unitPriceCents: 1180, grossCents: 1180, taxCents: 180 });
    expect(r.totalCents).toBe(1180);
  });

  it('applies line discounts before the sale discount and allocates the sale discount for tax', () => {
    const r = computeSale(
      [
        { unitPriceCents: 1000, quantityMilli: 1000, discountCents: 0, taxRateBp: 1800 },
        { unitPriceCents: 500, quantityMilli: 1000, discountCents: 0, taxRateBp: 0 },
      ],
      100,
    );
    expect(r.subtotalCents).toBe(1500);
    expect(r.discountCents).toBe(100);
    expect(r.totalCents).toBe(1400);
    expect(r.lines.map((l) => l.allocatedSaleDiscountCents)).toEqual([67, 33]);
    // Tax only on the 18 % line: 933 charged → net 791, tax 142.
    expect(r.lines[0]!.taxCents).toBe(142);
    expect(r.lines[1]!.taxCents).toBe(0);
    expect(r.taxCents).toBe(142);
  });

  it('rejects invalid quantities, prices and discounts', () => {
    expect(() => computeSale([{ unitPriceCents: 100, quantityMilli: 0, taxRateBp: 0 }])).toThrow(
      /Quantity/,
    );
    expect(() => computeSale([{ unitPriceCents: 1.5, quantityMilli: 1000, taxRateBp: 0 }])).toThrow(
      /Unit price/,
    );
    expect(() =>
      computeSale([{ unitPriceCents: 100, quantityMilli: 1000, discountCents: 101, taxRateBp: 0 }]),
    ).toThrow(/Line discount/);
    expect(() =>
      computeSale([{ unitPriceCents: 100, quantityMilli: 1000, taxRateBp: 0 }], 101),
    ).toThrow(/exceeds/);
    expect(() => computeSale([], -1)).toThrow(/Sale discount/);
  });

  it('allows an empty sale to total zero', () => {
    expect(computeSale([])).toMatchObject({ subtotalCents: 0, totalCents: 0, taxCents: 0 });
  });
});

describe('allocateProportionally', () => {
  it('distributes with largest remainder and keeps the sum exact', () => {
    expect(allocateProportionally(100, [1000, 500])).toEqual([67, 33]);
    expect(allocateProportionally(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(allocateProportionally(10, [0, 0])).toEqual([10, 0]);
    const parts = allocateProportionally(999, [333, 333, 334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(999);
  });
});

describe('settlePayments', () => {
  it('gives change only on cash', () => {
    expect(settlePayments(1000, [{ method: 'cash', amountCents: 2000 }])).toEqual({
      paidCents: 2000,
      changeCents: 1000,
    });
    expect(
      settlePayments(1000, [
        { method: 'card', amountCents: 600 },
        { method: 'cash', amountCents: 500 },
      ]),
    ).toEqual({ paidCents: 1100, changeCents: 100 });
  });

  it('rejects under-payment, card over-payment and non-positive amounts', () => {
    expect(() => settlePayments(1000, [{ method: 'cash', amountCents: 999 }])).toThrow(/cover/);
    expect(() => settlePayments(1000, [{ method: 'card', amountCents: 1001 }])).toThrow(/Non-cash/);
    expect(() => settlePayments(1000, [{ method: 'cash', amountCents: 0 }])).toThrow(/positive/);
  });
});

describe('refundAmountForQuantity', () => {
  const line = { lineTotalCents: 1000, allocatedSaleDiscountCents: 100, quantityMilli: 3000 };
  it('refunds the charged share of the quantity and never more than what is left', () => {
    expect(refundAmountForQuantity(line, 0, 1000)).toBe(300);
    expect(refundAmountForQuantity(line, 300, 1000)).toBe(300);
    expect(refundAmountForQuantity(line, 600, 1000)).toBe(300);
    expect(refundAmountForQuantity(line, 850, 1000)).toBe(50);
  });
});

describe('customerDiscountCents', () => {
  it('applies the member percentage to the subtotal, rounded to the cent', () => {
    expect(customerDiscountCents(1000, 1000)).toBe(100); // 10 %
    expect(customerDiscountCents(333, 1500)).toBe(50); // 49.95 → 50
    expect(customerDiscountCents(1, 500)).toBe(0); // 0.05 → 0
  });
  it('never stacks on an explicit cashier discount and ignores empty carts', () => {
    expect(customerDiscountCents(1000, 1000, 50)).toBe(0);
    expect(customerDiscountCents(0, 1000)).toBe(0);
    expect(customerDiscountCents(1000, 0)).toBe(0);
  });
  it('is capped at the subtotal', () => {
    expect(customerDiscountCents(1000, 10_000)).toBe(1000);
  });
});
