import { describe, expect, it } from 'vitest';
import type { ProductSummary } from '@likapcs/shared';
import {
  addFreeItem,
  pcBlocker,
  pcItemsFromCart,
  addTimeItem,
  addToCart,
  addToCartChecked,
  cartQuantityOf,
  cartToRequest,
  cartTotals,
  emptyCart,
  hasInternetAccess,
  isInternetAccess,
  lineKey,
  lineName,
  removeLine,
  ScanBuffer,
  setLineDiscount,
  setQuantity,
  setQuantityChecked,
  stockLimitMilli,
} from './cart';

const product = (over: Partial<ProductSummary>): ProductSummary => ({
  id: 'p1',
  kind: 'standard',
  parentId: null,
  parentName: null,
  variantLabel: null,
  variantCount: 0,
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
  sellingPriceMills: 1500,
  purchaseCostMills: 900,
  averageCostMills: 900,
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
  addons: [],
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
    expect(cart.lines.map((l) => lineKey(l))).toEqual(['p1']);
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

describe('staff purchase (0.20.7)', () => {
  it('prices products at purchase cost, PC time at zero, and ignores discounts and promos', () => {
    let cart = addToCart(
      emptyCart(),
      product({ sellingPriceCents: 150, purchaseCostCents: 90, promoPriceCents: 100 }),
      2000,
    );
    cart = addToCart(
      cart,
      product({ id: 'p2', name: 'Chips', sellingPriceCents: 120, purchaseCostCents: 70 }),
    );
    cart = { ...cart, staff: true, discountCents: 50 };
    cart = setLineDiscount(cart, lineKey(cart.lines[0]!), 30);
    const totals = cartTotals(cart, 1000);
    expect(totals.subtotalCents).toBe(2 * 90 + 70);
    expect(totals.discountCents).toBe(0);
    expect(totals.totalCents).toBe(250);
  });

  it('is the normal price again when the flag is off', () => {
    const cart = addToCart(emptyCart(), product({ sellingPriceCents: 150, purchaseCostCents: 90 }));
    expect(cartTotals(cart).totalCents).toBe(150);
    expect(cartTotals({ ...cart, staff: false }).totalCents).toBe(150);
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

  it('0.19.0: an off-inventory line is priced at the typed price, with the default tax, and sent as a description', () => {
    const cart = addFreeItem(
      emptyCart(),
      { name: '  Repair  ', unitPriceCents: 1000, taxRateBp: 1800, quantityMilli: 2000 },
      () => 'k1',
    );
    expect(cart.lines).toHaveLength(1);
    const line = cart.lines[0]!;
    expect(lineKey(line)).toBe('free:k1');
    expect(lineName(line)).toBe('Repair');
    // 2 × 10.00, prices include tax at 18 %: total 20.00, tax 3.05 (20.00 × 18/118 rounded).
    const t = cartTotals(cart);
    expect(t.totalCents).toBe(2000);
    expect(t.taxCents).toBe(305);
    const body = cartToRequest(cart);
    expect(body.items).toEqual([
      { description: 'Repair', unitPriceCents: 1000, quantityMilli: 2000, discountCents: 0 },
    ]);
  });

  it('0.19.0: free lines never merge; each keeps its own key, quantity and discount', () => {
    let cart = addFreeItem(
      emptyCart(),
      { name: 'Tape', unitPriceCents: 50, taxRateBp: 0 },
      () => 'a',
    );
    cart = addFreeItem(cart, { name: 'Tape', unitPriceCents: 50, taxRateBp: 0 }, () => 'b');
    expect(cart.lines.map((l) => lineKey(l))).toEqual(['free:a', 'free:b']);
    cart = setQuantity(cart, 'free:a', 3000);
    cart = setLineDiscount(cart, 'free:b', 20);
    expect(cartTotals(cart).totalCents).toBe(150 + 50 - 20);
    cart = removeLine(cart, 'free:a');
    expect(cart.lines.map((l) => lineKey(l))).toEqual(['free:b']);
  });

  it('0.19.0: a product line added after a free line keeps the product request shape', () => {
    let cart = addFreeItem(
      emptyCart(),
      { name: 'Service', unitPriceCents: 300, taxRateBp: 0 },
      () => 'z',
    );
    cart = addToCart(cart, product({}), 1000);
    expect(cartToRequest(cart).items).toEqual([
      { description: 'Service', unitPriceCents: 300, quantityMilli: 1000, discountCents: 0 },
      { productId: 'p1', quantityMilli: 1000, discountCents: 0 },
    ]);
  });

  it('0.19.0: a PC-time line is one unit per booking, priced by the quote, and sent as stationId + minutes', () => {
    let cart = addTimeItem(
      emptyCart(),
      { stationId: 's1', stationCode: 'PC-03', minutes: 60, unitPriceCents: 600, taxRateBp: 0 },
      () => 'a',
    );
    cart = addTimeItem(
      cart,
      { stationId: 's2', stationCode: 'PC-04', minutes: 30, unitPriceCents: 300, taxRateBp: 0 },
      () => 'b',
    );
    expect(cart.lines.map((l) => lineKey(l))).toEqual(['time:a', 'time:b']);
    expect(lineName(cart.lines[0]!)).toBe('PC-03 · 60 min');
    // Quantity is fixed for PC time: the edit is ignored, not turned into a second booking.
    cart = setQuantity(cart, 'time:a', 3000);
    expect(cart.lines[0]!).toMatchObject({ quantityMilli: 1000 });
    expect(cartTotals(cart).totalCents).toBe(600 + 300);
    cart = setLineDiscount(cart, 'time:b', 50);
    expect(cartTotals(cart).totalCents).toBe(600 + 250);
    expect(cartToRequest(cart).items).toEqual([
      { stationId: 's1', minutes: 60, discountCents: 0 },
      { stationId: 's2', minutes: 30, discountCents: 50 },
    ]);
    cart = removeLine(cart, 'time:a');
    expect(cart.lines.map((l) => lineKey(l))).toEqual(['time:b']);
  });

  it('0.19.0: a PC-time line never changes a product line into something else', () => {
    let cart = addToCart(emptyCart(), product({}), 1000);
    cart = addTimeItem(
      cart,
      { stationId: 's1', stationCode: 'PC-03', minutes: 60, unitPriceCents: 600, taxRateBp: 0 },
      () => 'a',
    );
    cart = addToCart(cart, product({}), 1000);
    expect(cart.lines[0]).toMatchObject({ kind: 'product', quantityMilli: 2000 });
    expect(cart.lines[1]).toMatchObject({ kind: 'time', minutes: 60 });
  });

  it('0.19.1: the same product with different extras is separate lines; the same extras merge', () => {
    const tost = product({
      id: 'tost',
      name: 'Tost',
      sellingPriceCents: 300,
      addons: [
        { id: 'k', name: 'Kackavall', priceCents: 50 },
        { id: 'h', name: 'Proshute', priceCents: 120 },
      ],
    });
    let cart = emptyCart();
    cart = addToCart(cart, tost, 1000, ['k']);
    cart = addToCart(cart, tost, 1000);
    cart = addToCart(cart, tost, 1000, ['k']);
    cart = addToCart(cart, tost, 1000, ['h', 'k']);
    cart = addToCart(cart, tost, 1000, ['k', 'h']);
    expect(cart.lines).toHaveLength(3);
    expect(cart.lines[0]).toMatchObject({ addonIds: ['k'], quantityMilli: 2000 });
    expect(cart.lines[1]).toMatchObject({ addonIds: [], quantityMilli: 1000 });
    expect(cart.lines[2]).toMatchObject({ addonIds: ['h', 'k'], quantityMilli: 2000 });
    expect(lineKey(cart.lines[0]!)).not.toBe(lineKey(cart.lines[1]!));
    expect(lineName(cart.lines[0]!)).toBe('Tost + Kackavall');
    expect(lineName(cart.lines[2]!)).toBe('Tost + Kackavall + Proshute');
  });

  it('0.19.1: extras add their price to the unit price, and are sent as addonIds', () => {
    const tost = product({
      id: 'tost',
      sellingPriceCents: 300,
      addons: [{ id: 'k', name: 'Kackavall', priceCents: 50 }],
    });
    const cart = addToCart(emptyCart(), tost, 2000, ['k', 'unknown']);
    const totals = cartTotals(cart);
    expect(totals.subtotalCents).toBe(700);
    expect(cartToRequest(cart).items[0]).toEqual({
      productId: 'tost',
      quantityMilli: 2000,
      discountCents: 0,
      addonIds: ['k'],
    });
    // a line without extras sends the plain request shape
    expect(cartToRequest(addToCart(emptyCart(), tost)).items[0]).not.toHaveProperty('addonIds');
  });
  it('0.20.8: PC time with no PC is sent as minutes + the name (no stationId); the line says so', () => {
    let cart = addTimeItem(
      emptyCart(),
      { holderName: 'Arben', minutes: 45, unitPriceCents: 450, taxRateBp: 0 },
      () => 'n',
    );
    expect(lineName(cart.lines[0]!)).toBe('PC time · 45 min · Arben');
    expect(cartToRequest(cart).items[0]).toEqual({
      holderName: 'Arben',
      minutes: 45,
      discountCents: 0,
    });
    cart = addTimeItem(emptyCart(), { minutes: 30, unitPriceCents: 300, taxRateBp: 0 }, () => 'm');
    expect(cartToRequest(cart).items[0]).toEqual({ minutes: 30, discountCents: 0 });
  });
});

describe('0.27.4: a cart can go to a PC bill', () => {
  it('a product-only cart with whole units goes to a PC', () => {
    const cart = addToCart(emptyCart(), product({ id: 'cola' }), 2000);
    expect(pcBlocker(cart)).toBeNull();
    expect(pcItemsFromCart(cart)).toEqual([{ productId: 'cola', quantity: 2 }]);
  });

  it('PC time and free items stop it', () => {
    const timed = addTimeItem(emptyCart(), { minutes: 30, unitPriceCents: 75, taxRateBp: 0 });
    expect(pcBlocker(timed)).toBe('notPc');
    const free = addFreeItem(emptyCart(), { name: 'Kafe', unitPriceCents: 100, taxRateBp: 0 });
    expect(pcBlocker(free)).toBe('notPc');
    expect(pcItemsFromCart(free)).toEqual([]);
  });

  it('extras, fractions and discounts stop it', () => {
    const base = addToCart(emptyCart(), product({ id: 'cola' }));
    const line = base.lines[0]!;
    if (line.kind !== 'product') throw new Error('expected a product line');
    const withExtra = { ...base, lines: [{ ...line, addonIds: ['x'] }] };
    expect(pcBlocker(withExtra)).toBe('addons');
    expect(pcBlocker(addToCart(emptyCart(), product({ id: 'cola' }), 500))).toBe('whole');
    expect(pcBlocker(setLineDiscount(base, lineKey(line), 50))).toBe('discount');
    expect(pcBlocker({ ...base, discountCents: 100 })).toBe('discount');
  });
});

describe('stock at the till (0.33.4)', () => {
  const stocked = (over: Record<string, unknown> = {}) =>
    ({
      id: 'cola',
      name: 'Coca-Cola',
      isActive: true,
      sellingPriceCents: 150,
      promoPriceCents: null,
      taxRateBp: 0,
      trackStock: true,
      allowNegativeStock: false,
      stockMilli: 3000,
      addons: [],
      ...over,
    }) as unknown as Parameters<typeof addToCartChecked>[1];

  it('limits only products that are tracked and may not go below zero', () => {
    expect(stockLimitMilli(stocked())).toBe(3000);
    expect(stockLimitMilli(stocked({ stockMilli: -2000 }))).toBe(0);
    expect(stockLimitMilli(stocked({ allowNegativeStock: true, stockMilli: 0 }))).toBeNull();
    expect(stockLimitMilli(stocked({ trackStock: false, stockMilli: 0 }))).toBeNull();
  });

  it('adds up to the stock and refuses the next one whole', () => {
    let cart = emptyCart();
    for (let i = 0; i < 3; i += 1) {
      const res = addToCartChecked(cart, stocked());
      expect(res.refused).toBeNull();
      cart = res.cart;
    }
    expect(cartQuantityOf(cart, 'cola')).toBe(3000);
    const fourth = addToCartChecked(cart, stocked());
    expect(fourth.refused).toEqual({ productName: 'Coca-Cola', stockMilli: 3000, allowedMilli: 0 });
    expect(fourth.cart).toBe(cart);
    // A product with no stock cannot be added at all.
    const empty = addToCartChecked(
      emptyCart(),
      stocked({ id: 'chips', name: 'Çips', stockMilli: 0 }),
    );
    expect(empty.refused?.allowedMilli).toBe(0);
    expect(empty.cart.lines).toHaveLength(0);
  });

  it('never limits a product allowed below zero or not tracked', () => {
    const water = stocked({ id: 'water', allowNegativeStock: true, stockMilli: -2000 });
    const coffee = stocked({ id: 'coffee', trackStock: false, stockMilli: 0 });
    let cart = emptyCart();
    for (const p of [water, water, water, coffee, coffee]) {
      const res = addToCartChecked(cart, p);
      expect(res.refused).toBeNull();
      cart = res.cart;
    }
    expect(cartQuantityOf(cart, 'water')).toBe(3000);
    expect(cartQuantityOf(cart, 'coffee')).toBe(2000);
  });

  it('cuts a typed quantity to the stock and lets it go down freely', () => {
    const cart = addToCartChecked(emptyCart(), stocked()).cart;
    const typed = setQuantityChecked(cart, 'cola', 10_000);
    expect(typed.refused).toEqual({
      productName: 'Coca-Cola',
      stockMilli: 3000,
      allowedMilli: 3000,
    });
    expect(cartQuantityOf(typed.cart, 'cola')).toBe(3000);
    const down = setQuantityChecked(typed.cart, 'cola', 1000);
    expect(down.refused).toBeNull();
    expect(cartQuantityOf(down.cart, 'cola')).toBe(1000);
    // The stock shrank under a parked sale: raising is refused and the line keeps what it has.
    const shrunk = {
      ...typed.cart,
      lines: typed.cart.lines.map((l) =>
        l.kind === 'product' ? { ...l, product: stocked({ stockMilli: 1000 }) } : l,
      ),
    };
    const more = setQuantityChecked(shrunk, 'cola', 4000);
    expect(more.refused?.allowedMilli).toBe(1000);
    expect(cartQuantityOf(more.cart, 'cola')).toBe(3000);
  });
});

describe('internet access at the till (0.34.0)', () => {
  const wifi = (over: Partial<ProductSummary> = {}) =>
    product({
      id: 'wifi-1h',
      name: 'Internet 1h',
      kind: 'internet_access',
      stockMilli: 3000,
      ...over,
    });

  it('is an ordinary line in the cart, limited by the codes that are left', () => {
    let cart = addToCartChecked(emptyCart(), wifi()).cart;
    cart = addToCartChecked(cart, wifi()).cart;
    expect(cart.lines).toHaveLength(1);
    expect(cartQuantityOf(cart, 'wifi-1h')).toBe(2000);
    expect(isInternetAccess(wifi())).toBe(true);
    expect(isInternetAccess(product({}))).toBe(false);
    expect(hasInternetAccess(cart)).toBe(true);
    expect(hasInternetAccess(addToCart(emptyCart(), product({})))).toBe(false);
    // Three codes left: the fourth is refused.
    cart = addToCartChecked(cart, wifi()).cart;
    const fourth = addToCartChecked(cart, wifi());
    expect(fourth.refused).toEqual({
      productName: 'Internet 1h',
      stockMilli: 3000,
      allowedMilli: 0,
    });
    expect(cartQuantityOf(fourth.cart, 'wifi-1h')).toBe(3000);
    // No codes at all: nothing goes in.
    const none = addToCartChecked(emptyCart(), wifi({ stockMilli: 0 }));
    expect(none.refused?.allowedMilli).toBe(0);
    expect(none.cart.lines).toHaveLength(0);
  });

  it('is sold by the piece: a typed fraction becomes a whole number of codes', () => {
    const cart = addToCartChecked(emptyCart(), wifi({ stockMilli: 10_000 })).cart;
    expect(cartQuantityOf(setQuantityChecked(cart, 'wifi-1h', 2500).cart, 'wifi-1h')).toBe(3000);
    expect(cartQuantityOf(setQuantityChecked(cart, 'wifi-1h', 2400).cart, 'wifi-1h')).toBe(2000);
    expect(cartQuantityOf(setQuantityChecked(cart, 'wifi-1h', 300).cart, 'wifi-1h')).toBe(1000);
    // Zero still removes the line; an ordinary product keeps its fraction.
    expect(setQuantityChecked(cart, 'wifi-1h', 0).cart.lines).toHaveLength(0);
    const cola = addToCart(emptyCart(), product({ id: 'cola' }));
    expect(cartQuantityOf(setQuantityChecked(cola, 'cola', 2500).cart, 'cola')).toBe(2500);
  });

  it('never goes to a PC bill: the code is handed over when the sale is paid', () => {
    const cart = addToCart(addToCart(emptyCart(), product({ id: 'cola' })), wifi());
    expect(pcBlocker(cart)).toBe('internet');
    expect(pcBlocker(removeLine(cart, 'wifi-1h'))).toBeNull();
  });

  it('a product saved before this version has no kind and is an ordinary product', () => {
    const old = { ...product({ id: 'old' }) } as Partial<ProductSummary>;
    delete old.kind;
    const cart = addToCart(emptyCart(), old as ProductSummary);
    expect(hasInternetAccess(cart)).toBe(false);
    expect(pcBlocker(cart)).toBeNull();
  });
});
