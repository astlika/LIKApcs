/**
 * 0.19.0 coverage pass — the rules the till and the database must hold, checked directly:
 *  • a free line's total, discount and tax (prices include tax; the default rate applies);
 *  • a free line books no stock movement, no product and no cost;
 *  • invalid free and PC-time lines are refused with 400 and nothing is written (also in a mixed sale);
 *  • migration 0031 (time_credits): its CHECK, UNIQUE and FOREIGN KEY rules reject bad rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LoginResponse, ProductSummary, SaleDetail, StationSummary } from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = Math.floor(Date.now() / 60_000) * 60_000;

describe('0.19 coverage: free lines, PC-time lines and migration 0031', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cola: ProductSummary;
  let station: StationSummary;

  const call = <T>(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));
  const count = async (sql: string) =>
    Number((await ctx.pool.query<{ n: string }>(sql)).rows[0]!.n);
  const snapshot = async () => ({
    sales: await count('SELECT count(*)::text AS n FROM sales'),
    items: await count('SELECT count(*)::text AS n FROM sale_items'),
    payments: await count('SELECT count(*)::text AS n FROM payments'),
    stockMovements: await count('SELECT count(*)::text AS n FROM inventory_movements'),
    credits: await count('SELECT count(*)::text AS n FROM time_credits'),
    stock: Number(
      (
        await ctx.pool.query<{ s: string }>(
          'SELECT stock_milli::text AS s FROM products WHERE id = $1',
          [cola.id],
        )
      ).rows[0]!.s,
    ),
  });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0));
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    cola = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 10_000,
      })
    ).body;
    station = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'PC 01' })).body;
    expect(
      (
        await call('POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 600,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('a free line with a discount: the total is price × qty − discount, tax at the default rate', async () => {
    const before = await snapshot();
    // 3 × 5.00 = 15.00, less a 1.00 discount = 14.00 (tax included at 18 %).
    const sale = await call<SaleDetail>('POST', '/sales', {
      items: [
        {
          description: 'Desk service',
          unitPriceCents: 500,
          quantityMilli: 3000,
          discountCents: 100,
        },
      ],
      payments: [{ method: 'cash', amountCents: 1400 }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(1400);
    const row = (
      await ctx.pool.query<{
        product_id: string | null;
        cost_cents: string;
        line_total_cents: string;
        tax_cents: string;
        tax_rate_bp: number;
      }>(
        'SELECT product_id, cost_cents::text, line_total_cents::text, tax_cents::text, tax_rate_bp FROM sale_items WHERE sale_id = $1',
        [sale.body.id],
      )
    ).rows[0]!;
    expect(row).toEqual({
      product_id: null,
      cost_cents: '0',
      line_total_cents: '1400',
      tax_cents: String(Math.round((1400 * 1800) / 11800)), // 214
      tax_rate_bp: 1800,
    });
    // No stock moved and no movement was written for it.
    const after = await snapshot();
    expect(after.stockMovements).toBe(before.stockMovements);
    expect(after.stock).toBe(before.stock);
  });

  it('a free line on its own is never a product row: no stock, no movement, cost 0 after a product sale too', async () => {
    const before = await snapshot();
    const mixed = await call<SaleDetail>('POST', '/sales', {
      items: [
        { productId: cola.id, quantityMilli: 2000 },
        { description: 'Setup fee', unitPriceCents: 200, quantityMilli: 1000 },
      ],
      payments: [{ method: 'cash', amountCents: 500 }],
    });
    expect(mixed.status).toBe(201);
    const after = await snapshot();
    // The product line moves 2 units (one movement); the free line moves nothing.
    expect(after.stockMovements - before.stockMovements).toBe(1);
    expect(after.stock - before.stock).toBe(-2000);
    const free = (
      await ctx.pool.query<{ product_id: string | null; cost_cents: string }>(
        `SELECT product_id, cost_cents::text FROM sale_items WHERE sale_id = $1 AND description = 'Setup fee'`,
        [mixed.body.id],
      )
    ).rows[0]!;
    expect(free).toEqual({ product_id: null, cost_cents: '0' });
  });

  it('invalid free lines are refused with 400 and nothing is written, not even the valid product line', async () => {
    const before = await snapshot();
    const bad: Record<string, unknown>[] = [
      { description: 'Zero qty', unitPriceCents: 100, quantityMilli: 0 },
      { description: 'Fraction', unitPriceCents: 100, quantityMilli: 1.5 },
      { description: 'Too many', unitPriceCents: 100, quantityMilli: 1_000_000_001 },
      { description: 'Negative price', unitPriceCents: -1, quantityMilli: 1000 },
      { description: 'Price fraction', unitPriceCents: 1.25, quantityMilli: 1000 },
      {
        description: 'Negative discount',
        unitPriceCents: 100,
        quantityMilli: 1000,
        discountCents: -5,
      },
      { description: 'x'.repeat(121), unitPriceCents: 100, quantityMilli: 1000 },
      { description: '   ', unitPriceCents: 100, quantityMilli: 1000 },
    ];
    for (const line of bad) {
      const res = await call('POST', '/sales', {
        items: [{ productId: cola.id, quantityMilli: 1000 }, line],
        payments: [{ method: 'cash', amountCents: 1000 }],
      });
      expect(res.status, JSON.stringify(line)).toBe(400);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('invalid PC-time lines are refused with 400 and sell no time', async () => {
    const before = await snapshot();
    const bad: Record<string, unknown>[] = [
      { stationId: station.id, minutes: 0 },
      { stationId: station.id, minutes: 24 * 60 + 1 },
      { stationId: station.id, minutes: 1.5 },
      { stationId: 'not-a-uuid', minutes: 30 },
    ];
    for (const line of bad) {
      const res = await call('POST', '/sales', {
        items: [line],
        payments: [{ method: 'cash', amountCents: 100_000 }],
      });
      expect(res.status, JSON.stringify(line)).toBe(400);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('migration 0031 creates time_credits with its open-credit index', async () => {
    const idx = await count(
      `SELECT count(*)::text AS n FROM pg_indexes WHERE tablename = 'time_credits' AND indexname = 'time_credits_open_idx'`,
    );
    expect(idx).toBe(1);
  });

  it('migration 0031 CHECK, UNIQUE and FOREIGN KEY rules reject bad credit rows', async () => {
    // A real credit to borrow a sale and sale item from.
    const sale = await call<SaleDetail>('POST', '/sales', {
      items: [{ stationId: station.id, minutes: 30 }],
      payments: [{ method: 'cash', amountCents: 100_000 }],
    });
    expect(sale.status).toBe(201);
    const item = (
      await ctx.pool.query<{ id: string }>('SELECT id::text FROM sale_items WHERE sale_id = $1', [
        sale.body.id,
      ])
    ).rows[0]!;
    const freshItem = async () =>
      (
        await ctx.pool.query<{ id: string }>(
          `INSERT INTO sale_items (sale_id, line_no, description, quantity_milli, unit_price_cents, line_total_cents)
           VALUES ($1, 99, 'Spare line', 1000, 100, 100) RETURNING id::text`,
          [sale.body.id],
        )
      ).rows[0]!.id;
    const insert = async (over: Partial<Record<string, unknown>>) => {
      const v = {
        sale_id: sale.body.id,
        sale_item_id: 'NEW',
        station_id: station.id,
        minutes_total: 30,
        minutes_remaining: 30,
        price_cents: 100,
        ...over,
      };
      return ctx.pool.query(
        `INSERT INTO time_credits (sale_id, sale_item_id, station_id, minutes_total, minutes_remaining, price_cents)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          v.sale_id,
          v.sale_item_id === 'NEW'
            ? item.id
            : v.sale_item_id === 'FRESH'
              ? await freshItem()
              : v.sale_item_id,
          v.station_id,
          v.minutes_total,
          v.minutes_remaining,
          v.price_cents,
        ],
      );
    };
    const cases: [string, Partial<Record<string, unknown>>, string][] = [
      ['zero minutes_total', { minutes_total: 0, minutes_remaining: 0 }, '23514'],
      ['remaining above total', { minutes_remaining: 31 }, '23514'],
      ['negative remaining', { minutes_remaining: -1 }, '23514'],
      ['negative price', { price_cents: -1 }, '23514'],
      ['second credit for one sale item', {}, '23505'],
      [
        'unknown station',
        { station_id: '00000000-0000-4000-8000-000000000000', sale_item_id: 'FRESH' },
        '23503',
      ],
    ];
    for (const [label, over, code] of cases) {
      const err = await insert(over).then(
        () => null,
        (e: { code?: string }) => e,
      );
      expect(err?.code, label).toBe(code);
    }
    // Nothing from the refused rows stayed: only the sale's own credit is there.
    expect(
      await count(`SELECT count(*)::text AS n FROM time_credits WHERE sale_id = '${sale.body.id}'`),
    ).toBe(1);
  });
});
