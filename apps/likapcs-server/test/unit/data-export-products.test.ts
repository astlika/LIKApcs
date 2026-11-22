/**
 * The product tables of «Skedar për AI» (0.39.1): whether a product is in stock, in the
 * program's own terms; which products get a row in «Sipas produktit»; which ones stand in
 * «Stoku tani sipas produktit», in what order and with what value; and how «Gjendja tani»
 * counts them.
 */
import { describe, expect, it } from 'vitest';
import { stockStatus } from '../../src/services/data-export/sections.js';
import {
  productLines,
  stockCounts,
  stockLines,
  type ProductFigure,
  type ProductState,
} from '../../src/services/data-export/summary.js';

const product = (id: string, name: string, over: Partial<ProductState> = {}): ProductState => ({
  id,
  name,
  variant: null,
  sku: `SKU-${id}`,
  category: null,
  price_mills: 1500,
  cost_mills: 900,
  stock_milli: 10_000,
  min_stock_milli: 0,
  track_stock: true,
  is_active: true,
  unit_code: 'pc',
  ...over,
});

const sold = (productId: string | null, over: Partial<ProductFigure> = {}): ProductFigure => ({
  product: productId ? `name of ${productId}` : null,
  sku: productId ? `SKU-${productId}` : null,
  category: null,
  free_text: null,
  pc_time: false,
  desk_time: false,
  qty: 2000,
  amount: 300,
  vat: 46,
  cost: 180,
  product_id: productId,
  category_id: null,
  bills: 2,
  refunded_qty: 0,
  no_cost_lines: 0,
  last_sold: '2026-11-22 10:00',
  ...over,
});

describe('whether a product is in stock', () => {
  const state = (stock: number, min: number, tracked = true) =>
    stockStatus({ track_stock: tracked, stock_milli: stock, min_stock_milli: min });

  it('nothing left, or less than nothing, is out of stock', () => {
    expect(state(0, 0)).toBe('out');
    expect(state(0, 5000)).toBe('out');
    // Sold before it was received (negative stock is allowed on some products).
    expect(state(-2000, 0)).toBe('out');
  });

  it('something left but not more than the minimum is low stock, as the Products page counts it', () => {
    expect(state(4000, 10_000)).toBe('low');
    // Exactly the minimum is low already: the program compares with "not more than".
    expect(state(10_000, 10_000)).toBe('low');
    expect(state(10_001, 10_000)).toBe('in');
    // Half a kilo of a weighed product, with a minimum of one kilo.
    expect(state(500, 1000)).toBe('low');
  });

  it('with no minimum set, anything left is in stock', () => {
    expect(state(1, 0)).toBe('in');
    expect(state(57_000, 0)).toBe('in');
  });

  it('a product sold without counting has no state, whatever number stands in its row', () => {
    expect(state(0, 0, false)).toBe('untracked');
    expect(state(-5000, 10_000, false)).toBe('untracked');
    expect(state(99_000, 0, false)).toBe('untracked');
  });
});

describe('the rows of «Sipas produktit»', () => {
  const cola = product('cola', 'Cola');
  const fanta = product('fanta', 'Fanta', { stock_milli: 0 });
  const kafe = product('kafe', 'Kafe', { track_stock: false });
  const oldChips = product('chips', 'Chips', { is_active: false, stock_milli: 18_000 });
  const removed = product('ice', 'Akullore', { is_active: false, stock_milli: 0 });
  // As the database gives them: by name.
  const states = [removed, oldChips, cola, fanta, kafe];

  it('the sold ones keep their order; every active product that did not sell follows with zeros', () => {
    const pcTime = sold(null, { pc_time: true, amount: 75, vat: 11, cost: 0, qty: 1000 });
    const lines = productLines([sold('chips', { amount: 400 }), sold('cola'), pcTime], states);
    expect(lines.map((line) => line.product ?? 'PC time')).toEqual([
      'name of chips',
      'name of cola',
      'PC time',
      'Fanta',
      'Kafe',
    ]);
    // A sold product carries what it is now — also one archived since.
    expect(lines[0]!.state).toBe(oldChips);
    expect(lines[1]!.state).toBe(cola);
    // A line without a product has no product behind it.
    expect(lines[2]!.state).toBeNull();
    expect(lines[3]).toMatchObject({
      product_id: 'fanta',
      sku: 'SKU-fanta',
      qty: 0,
      amount: 0,
      vat: 0,
      cost: 0,
      bills: 0,
      refunded_qty: 0,
      no_cost_lines: 0,
      last_sold: null,
      state: fanta,
    });
  });

  it('an archived product that did not sell gets no row; one that sold does', () => {
    const lines = productLines([sold('chips')], states);
    const ids = lines.map((line) => line.product_id);
    expect(ids).toContain('chips');
    expect(ids).not.toContain('ice');
    expect(ids.filter((id) => id === 'chips')).toHaveLength(1);
  });

  it('the rows with zeros change no sum', () => {
    const figures = [sold('cola'), sold('chips', { amount: 400, vat: 57, cost: 240 })];
    const lines = productLines(figures, states);
    const sum = (key: 'amount' | 'vat' | 'cost' | 'qty') =>
      lines.reduce((total, line) => total + line[key], 0);
    expect(sum('amount')).toBe(700);
    expect(sum('vat')).toBe(103);
    expect(sum('cost')).toBe(420);
    expect(sum('qty')).toBe(4000);
  });

  it('a sale of a product the list no longer knows keeps its row, without a state', () => {
    const lines = productLines([sold('deleted')], [cola]);
    expect(lines.map((line) => line.product_id)).toEqual(['deleted', 'cola']);
    expect(lines[0]!.state).toBeNull();
  });

  it('nothing sold at all: one row for every active product', () => {
    const lines = productLines([], states);
    expect(lines.map((line) => line.product)).toEqual(['Cola', 'Fanta', 'Kafe']);
    expect(lines.every((line) => line.qty === 0 && line.amount === 0)).toBe(true);
  });
});

describe('the rows of «Stoku tani sipas produktit»', () => {
  const states = [
    product('a', 'Akullore', { is_active: false, stock_milli: 0 }),
    product('b', 'Birrë', { stock_milli: 24_000, min_stock_milli: 6000 }),
    product('c', 'Chips', {
      is_active: false,
      stock_milli: 3000,
      cost_mills: 500,
      price_mills: 2000,
    }),
    product('d', 'Djathë', { stock_milli: 500, min_stock_milli: 1000, cost_mills: 4250 }),
    product('f', 'Fanta', { stock_milli: 0 }),
    product('k', 'Kafe', { track_stock: false, stock_milli: 0, cost_mills: 0, price_mills: 1000 }),
    product('m', 'Mish', { stock_milli: -2000, cost_mills: 6000 }),
    product('u', 'Ujë', { stock_milli: 4000, min_stock_milli: 10_000, cost_mills: 333 }),
  ];
  const lines = stockLines(states, [sold('b', { qty: 12_000 }), sold('f', { qty: 5000 })]);

  it('lists every active product and the archived ones that still have goods', () => {
    expect(lines.map((line) => line.state.name).sort()).toEqual(
      ['Birrë', 'Chips', 'Djathë', 'Fanta', 'Kafe', 'Mish', 'Ujë'].sort(),
    );
  });

  it('nothing left comes first, then low stock, then in stock, last the uncounted; by name inside', () => {
    expect(lines.map((line) => [line.state.name, line.status])).toEqual([
      ['Fanta', 'out'],
      ['Mish', 'out'],
      ['Djathë', 'low'],
      ['Ujë', 'low'],
      ['Birrë', 'in'],
      ['Chips', 'in'],
      ['Kafe', 'untracked'],
    ]);
  });

  it('the value is stock × cost and stock × price, in cents; nothing for stock below zero or uncounted', () => {
    const by = (name: string) => lines.find((line) => line.state.name === name)!;
    // 24 × 0.90 and 24 × 1.50.
    expect(by('Birrë')).toMatchObject({ costValue: 2160, saleValue: 3600 });
    // Half a kilo at 4.25: 2.125 → 2.13 (rounded to the cent); at 1.50: 0.75.
    expect(by('Djathë')).toMatchObject({ costValue: 213, saleValue: 75 });
    // 4 × 0.333 = 1.332 → 1.33.
    expect(by('Ujë')).toMatchObject({ costValue: 133, saleValue: 600 });
    expect(by('Fanta')).toMatchObject({ costValue: 0, saleValue: 0 });
    // Two below zero are not minus twelve of value.
    expect(by('Mish')).toMatchObject({ costValue: 0, saleValue: 0 });
    expect(by('Kafe')).toMatchObject({ costValue: null, saleValue: null });
    expect(by('Chips')).toMatchObject({ costValue: 150, saleValue: 600 });
  });

  it('says what each one sold in the period', () => {
    const by = (name: string) => lines.find((line) => line.state.name === name)!;
    expect(by('Birrë').soldQty).toBe(12_000);
    expect(by('Fanta').soldQty).toBe(5000);
    expect(by('Ujë').soldQty).toBe(0);
  });

  it('«Gjendja tani» counts the active ones by state — they add up — and values every row', () => {
    const counts = stockCounts(lines);
    expect(counts).toEqual({
      active: 6,
      inStock: 3, // Birrë, and the two low ones
      low: 2,
      out: 2,
      untracked: 1,
      inactiveWithStock: 1,
      costCents: 2160 + 213 + 133 + 150,
      saleCents: 3600 + 75 + 600 + 600,
    });
    expect(counts.inStock + counts.out + counts.untracked).toBe(counts.active);
    expect(counts.active + counts.inactiveWithStock).toBe(lines.length);
    expect(counts.costCents).toBe(lines.reduce((sum, line) => sum + (line.costValue ?? 0), 0));
  });

  it('no products: no rows, and zeros', () => {
    expect(stockLines([], [])).toEqual([]);
    expect(stockCounts([])).toEqual({
      active: 0,
      inStock: 0,
      low: 0,
      out: 0,
      untracked: 0,
      inactiveWithStock: 0,
      costCents: 0,
      saleCents: 0,
    });
  });
});
