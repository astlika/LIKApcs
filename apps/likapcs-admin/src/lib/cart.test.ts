import { describe, expect, it } from 'vitest';
import type { ProductSummary } from '@likapcs/shared';
import {
  addToCart,
  cartToRequest,
  cartTotals,
  emptyCart,
  removeLine,
  ScanBuffer,
  setLineDiscount,
  setQuantity,
} from './cart';

const product = (over: Partial<ProductSummary>): ProductSummary => ({
  id: 'p1',
  name: 'Cola',
  sku: 'SKU-1',
  categoryId: null,
  categoryName: null,
  categoryColor: null,
  brand: null,
  supplierId: null,
  taxCategoryId: null,
  taxRateBp: 1800,
  unitCode: 'pc',
  unitIsDecimal: false,
  purchaseCostCents: 90,
  averageCostCents: 90,
  sellingPriceCents: 150,
  priceIncludesTax: true,
  stockMilli: 10_000,
  minStockMilli: 0,
  allowNegativeStock: false,
  trackStock: true,
  lowStock: false,
  description: null,
  storageLocation: null,
  isActive: true,
  barcodes: [],
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('cart', () => {
  it('merges the same product, edits quantities and removes lines', () => {
    let cart = addToCart(emptyCart(), product({}));
    cart = addToCart(cart, product({}), 2000);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]!.quantityMilli).toBe(3000);
    cart = addToCart(cart, product({ id: 'p2', name: 'Chips', sellingPriceCents: 120 }));
    expect(cart.lines).toHaveLength(2);
    cart = setQuantity(cart, 'p1', 1000);
    expect(cart.lines[0]!.quantityMilli).toBe(1000);
    cart = setQuantity(cart, 'p2', 0);
    expect(cart.lines.map((l) => l.product.id)).toEqual(['p1']);
    cart = removeLine(cart, 'p1');
    expect(cart.lines).toEqual([]);
  });

  it('previews totals with the shared arithmetic and clamps impossible discounts', () => {
    let cart = addToCart(emptyCart(), product({}), 2000);
    cart = setLineDiscount(cart, 'p1', 50);
    cart = { ...cart, discountCents: 10 };
    const t = cartTotals(cart);
    expect(t.subtotalCents).toBe(250);
    expect(t.totalCents).toBe(240);
    expect(t.taxCents).toBe(37); // 240 / 1.18 = 203.39 → tax 37
    const clamped = cartTotals({ ...cart, discountCents: 10_000 });
    expect(clamped.totalCents).toBe(0);
  });

  it('serialises the request body with the idempotency key', () => {
    const cart = addToCart(emptyCart(), product({}));
    const body = cartToRequest({ ...cart, notes: '  table 4 ' });
    expect(body.items).toEqual([{ productId: 'p1', quantityMilli: 1000, discountCents: 0 }]);
    expect(body.notes).toBe('table 4');
    expect(body.clientRequestId).toHaveLength(36);
    expect(emptyCart().clientRequestId).not.toBe(cart.clientRequestId);
  });
});

describe('ScanBuffer', () => {
  it('recognises a fast burst ending with Enter as a scan', () => {
    const buf = new ScanBuffer(40, 4);
    const t0 = 1000;
    for (const [i, ch] of [...'5449000000996'].entries()) buf.push(ch, t0 + i * 8);
    expect(buf.flush(t0 + 13 * 8)).toBe('5449000000996');
  });

  it('ignores human typing speed and short bursts', () => {
    const buf = new ScanBuffer(40, 4);
    const t0 = 1000;
    for (const [i, ch] of [...'cola'].entries()) buf.push(ch, t0 + i * 150);
    expect(buf.flush(t0 + 4 * 150)).toBeNull();
    buf.push('1', 5000);
    buf.push('2', 5005);
    expect(buf.flush(5010)).toBeNull();
  });
});
