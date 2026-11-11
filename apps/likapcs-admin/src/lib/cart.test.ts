import { describe, expect, it } from 'vitest';
import type { ProductSummary } from '@likapcs/shared';
import {
  addToCart,
  addWithinStock,
  cartToRequest,
  cartTotals,
  emptyCart,
  overStockLines,
  quantityInCart,
  refreshCartProducts,
  removeLine,
  ScanBuffer,
  setLineDiscount,
  setQuantity,
  setQuantityWithinStock,
  stockLimitMilli,
  withKnownStock,
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
  promoPriceCents: null,
  clientMenu: false,
  clientMenuOrder: 0,
  priceIncludesTax: true,
  imageUrl: null,
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

describe('stock ceiling in the cart', () => {
  const cola = product({ stockMilli: 3000 });

  it('has no ceiling for untracked products and for products the owner allows below zero', () => {
    expect(stockLimitMilli(cola)).toBe(3000);
    expect(stockLimitMilli(product({ stockMilli: 0 }))).toBe(0);
    expect(stockLimitMilli(product({ stockMilli: -2000 }))).toBe(0);
    expect(stockLimitMilli(product({ stockMilli: 0, allowNegativeStock: true }))).toBeNull();
    expect(stockLimitMilli(product({ stockMilli: 0, trackStock: false }))).toBeNull();
  });

  it('adds up to the stock and refuses the unit that would go beyond it', () => {
    let cart = emptyCart();
    for (let i = 0; i < 3; i++) {
      const r = addWithinStock(cart, cola);
      expect(r.added).toBe(true);
      cart = r.cart;
    }
    expect(quantityInCart(cart, 'p1')).toBe(3000);
    const refused = addWithinStock(cart, cola);
    expect(refused).toMatchObject({ added: false, limitMilli: 3000 });
    expect(refused.cart).toBe(cart); // untouched
    // A pack barcode (6 pieces) does not fit either: nothing is added, not a part of it.
    expect(addWithinStock(emptyCart(), cola, 6000).added).toBe(false);
  });

  it('refuses a sold-out product, but not one that may be sold without stock', () => {
    const soldOut = product({ id: 'p2', stockMilli: 0 });
    expect(addWithinStock(emptyCart(), soldOut)).toMatchObject({ added: false, limitMilli: 0 });
    const allowed = product({ id: 'p3', stockMilli: 0, allowNegativeStock: true });
    let cart = emptyCart();
    for (let i = 0; i < 5; i++) cart = addWithinStock(cart, allowed).cart;
    expect(quantityInCart(cart, 'p3')).toBe(5000);
    const service = product({ id: 'p4', stockMilli: 0, trackStock: false });
    expect(addWithinStock(emptyCart(), service, 9000).added).toBe(true);
  });

  it('cuts a typed quantity down to the stock and keeps smaller ones', () => {
    const cart = addWithinStock(emptyCart(), cola).cart;
    const over = setQuantityWithinStock(cart, 'p1', 10_000);
    expect(over.clampedToMilli).toBe(3000);
    expect(quantityInCart(over.cart, 'p1')).toBe(3000);
    const fine = setQuantityWithinStock(cart, 'p1', 2000);
    expect(fine.clampedToMilli).toBeNull();
    expect(quantityInCart(fine.cart, 'p1')).toBe(2000);
    expect(setQuantityWithinStock(cart, 'p1', 0).cart.lines).toHaveLength(0);
  });

  it('flags lines that hold more than the shelf once fresher stock is known', () => {
    // A parked sale restored as it was (plain addToCart), then the list says only 1 is left.
    let cart = addToCart(emptyCart(), cola, 3000);
    expect(overStockLines(cart)).toHaveLength(0);
    const same = refreshCartProducts(cart, [cola]);
    expect(same).toBe(cart); // nothing changed → same object
    cart = refreshCartProducts(cart, [product({ stockMilli: 1000 })]);
    expect(overStockLines(cart).map((l) => l.product.id)).toEqual(['p1']);
    // The owner then allows this product below zero → no longer flagged.
    cart = refreshCartProducts(cart, [product({ stockMilli: 1000, allowNegativeStock: true })]);
    expect(overStockLines(cart)).toHaveLength(0);
    // The server's own figure (409 INSUFFICIENT_STOCK) is remembered on the line.
    cart = withKnownStock(addToCart(emptyCart(), cola, 3000), 'p1', 2000);
    expect(overStockLines(cart)).toHaveLength(1);
    expect(cart.lines[0]!.product.stockMilli).toBe(2000);
  });
});
