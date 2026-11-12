/**
 * 0.19.1 — product extras with their own price (Toast + cheese +0.50). An extra adds its price to
 * the line, never moves stock, is named on the line, and is refused when it does not belong to the
 * product. Editing the extras later does not change a sale already made.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResponse, ProductSummary, SaleDetail } from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('product extras (add-ons) at the till', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let toast: ProductSummary;
  let cola: ProductSummary;
  let cheese: string;

  const call = <T>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect((await call('POST', '/cash/shifts/open', { openingCents: 1000 })).status).toBe(201);
    toast = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Tost',
        sellingPriceCents: 150,
        purchaseCostCents: 40,
        initialStockMilli: 10_000,
      })
    ).body;
    cola = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 10_000,
      })
    ).body;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('saves the extras of a product and returns them with it', async () => {
    const saved = await call<ProductSummary>('PUT', `/products/${toast.id}/addons`, {
      addons: [
        { name: 'Kackavall', priceCents: 50 },
        { name: 'Salcë', priceCents: 30 },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.addons.map((a) => [a.name, a.priceCents])).toEqual([
      ['Kackavall', 50],
      ['Salcë', 30],
    ]);
    cheese = saved.body.addons[0]!.id;
    const fetched = await call<ProductSummary>('GET', `/products/${toast.id}`);
    expect(fetched.body.addons).toHaveLength(2);
  });

  it('prices the line at base + extras, names it, and moves only the product stock', async () => {
    const sale = await call<SaleDetail>('POST', '/sales', {
      items: [{ productId: toast.id, quantityMilli: 2000, addonIds: [cheese] }],
      payments: [{ method: 'cash', amountCents: 400 }],
    });
    expect(sale.status).toBe(201);
    // 2 × (1.50 + 0.50) = 4.00
    expect(sale.body.totalCents).toBe(400);
    const row = await ctx.pool.query<{
      description: string;
      unit_price_cents: string;
      addons: unknown;
    }>(`SELECT description, unit_price_cents::text, addons FROM sale_items WHERE sale_id = $1`, [
      sale.body.id,
    ]);
    expect(row.rows[0]).toMatchObject({
      description: 'Tost + Kackavall',
      unit_price_cents: '200',
    });
    expect(row.rows[0]!.addons).toEqual([{ id: cheese, name: 'Kackavall', priceCents: 50 }]);
    expect((await call<ProductSummary>('GET', `/products/${toast.id}`)).body.stockMilli).toBe(8000);
  });

  it('refuses an extra the product does not have, and an unknown extra', async () => {
    const otherProductsExtra = (
      await call<ProductSummary>('PUT', `/products/${cola.id}/addons`, {
        addons: [{ name: 'Lëng limoni', priceCents: 20 }],
      })
    ).body.addons[0]!.id;
    const wrong = await call('POST', '/sales', {
      items: [{ productId: toast.id, quantityMilli: 1000, addonIds: [otherProductsExtra] }],
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(wrong.status).toBe(400);
    const unknown = await call('POST', '/sales', {
      items: [
        {
          productId: toast.id,
          quantityMilli: 1000,
          addonIds: ['00000000-0000-4000-8000-000000000000'],
        },
      ],
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(unknown.status).toBe(400);
  });

  it('keeps a past sale as it was when the extras are later changed', async () => {
    const sale = await call<SaleDetail>('POST', '/sales', {
      items: [{ productId: toast.id, quantityMilli: 1000, addonIds: [cheese] }],
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(sale.status).toBe(201);
    await call('PUT', `/products/${toast.id}/addons`, {
      addons: [{ name: 'Salcë', priceCents: 30 }],
    });
    const past = await ctx.pool.query<{ addons: { name: string }[] }>(
      `SELECT addons FROM sale_items WHERE sale_id = $1`,
      [sale.body.id],
    );
    expect(past.rows[0]!.addons.map((a) => a.name)).toEqual(['Kackavall']);
  });
});
