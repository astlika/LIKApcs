import { describe, expect, it } from 'vitest';
import { restoreOrder } from '../../src/services/backups.js';

const ref = (child: string, parent: string) => ({ child, parent });

/** Every table once, and each child after the parents named in `mustFollow`. */
function expectAfter(order: string[], child: string, parents: string[]): void {
  for (const parent of parents) {
    expect(order.indexOf(parent), `${parent} before ${child}`).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(child), `${child} after ${parent}`).toBeGreaterThan(order.indexOf(parent));
  }
}

describe('restoreOrder', () => {
  it('puts every parent before its children', () => {
    const tables = ['sale_items', 'sales', 'users', 'products', 'payments'];
    const order = restoreOrder(tables, [
      ref('sales', 'users'),
      ref('sale_items', 'sales'),
      ref('sale_items', 'products'),
      ref('payments', 'sales'),
    ]);
    expect([...order].sort()).toEqual([...tables].sort());
    expectAfter(order, 'sales', ['users']);
    expectAfter(order, 'sale_items', ['sales', 'products']);
    expectAfter(order, 'payments', ['sales']);
  });

  it('ignores a table that references itself, and references to tables that are not restored', () => {
    const order = restoreOrder(
      ['categories', 'products'],
      [
        ref('categories', 'categories'),
        ref('products', 'categories'),
        ref('products', 'schema_migrations'),
      ],
    );
    expect(order).toEqual(['categories', 'products']);
  });

  it('opens a circle and still restores every table once', () => {
    // sessions → time_credits → sale_items → sessions, as in the real schema.
    const tables = ['gaming_sessions', 'sale_items', 'sales', 'time_credits', 'users'];
    const order = restoreOrder(tables, [
      ref('sales', 'users'),
      ref('sale_items', 'sales'),
      ref('sale_items', 'gaming_sessions'),
      ref('time_credits', 'sale_items'),
      ref('gaming_sessions', 'time_credits'),
      ref('gaming_sessions', 'users'),
    ]);
    expect([...order].sort()).toEqual([...tables].sort());
    expectAfter(order, 'sales', ['users']);
    // Only one reference of the circle is left to the end; the other two are in order.
    const inOrder = [
      ['sale_items', 'gaming_sessions'],
      ['time_credits', 'sale_items'],
      ['gaming_sessions', 'time_credits'],
    ].filter(([child, parent]) => order.indexOf(child!) > order.indexOf(parent!));
    expect(inOrder).toHaveLength(2);
  });

  it('never moves a table that only waits for a circle ahead of its parents', () => {
    // `codes` references the circle (sale_items) and `products`, but nothing references it: it
    // has the fewest parents missing of all, and must still come last. Its trigger looks the
    // product up, so `products` has to be there.
    const tables = ['codes', 'a', 'b', 'c', 'products', 'sale_items', 'zz_root'];
    const order = restoreOrder(tables, [
      ref('codes', 'sale_items'),
      ref('codes', 'products'),
      ref('products', 'zz_root'),
      // a circle of four in which every member waits for two others
      ref('sale_items', 'a'),
      ref('sale_items', 'b'),
      ref('a', 'b'),
      ref('a', 'c'),
      ref('b', 'c'),
      ref('b', 'sale_items'),
      ref('c', 'sale_items'),
      ref('c', 'a'),
    ]);
    expect([...order].sort()).toEqual([...tables].sort());
    expectAfter(order, 'codes', ['sale_items', 'products']);
    expectAfter(order, 'products', ['zz_root']);
    expect(order.at(-1)).toBe('codes');
  });

  it('gives the same order every time', () => {
    const tables = ['b', 'a', 'd', 'c'];
    const refs = [ref('a', 'b'), ref('b', 'a'), ref('c', 'd'), ref('d', 'c')];
    const first = restoreOrder(tables, refs);
    expect(restoreOrder(tables, refs)).toEqual(first);
    // each circle is opened at its first table by name
    expect(first).toEqual(['a', 'b', 'c', 'd']);
  });
});
