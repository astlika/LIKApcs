/**
 * 0.19.0 — off-inventory lines at the till: a name and a price typed in, no product row. They use
 * the default tax (prices include tax), book no stock and no cost, survive suspend/resume and can be
 * refunded; the audit trail keeps what was typed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResponse, ProductSummary, SaleDetail } from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('off-inventory (free) items at the till', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cola: ProductSummary;

  const call = <T>(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: Record<string, unknown>,
    token = owner.token,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({ status: r.statusCode, body: (r.statusCode === 204 ? null : r.json()) as T }));

  const lines = async (saleId: string) =>
    (
      await ctx.pool.query<{
        product_id: string | null;
        description: string;
        cost_cents: string;
        tax_cents: string;
        line_total_cents: string;
      }>(
        `SELECT product_id, description, cost_cents::text, tax_cents::text, line_total_cents::text
           FROM sale_items WHERE sale_id = $1 ORDER BY line_no`,
        [saleId],
      )
    ).rows;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect((await call('POST', '/cash/shifts/open', { openingCents: 1000 })).status).toBe(201);
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

  it('sells a product and a free item on one receipt: the free line books no stock and no cost', async () => {
    const sale = await call<SaleDetail>('POST', '/sales', {
      items: [
        { productId: cola.id, quantityMilli: 2000 },
        { description: 'Phone repair', unitPriceCents: 1000, quantityMilli: 1000 },
      ],
      payments: [{ method: 'cash', amountCents: 1500 }],
    });
    expect(sale.status).toBe(201);
    // 2 × 1.50 + 10.00, prices include tax.
    expect(sale.body.totalCents).toBe(1300);
    const rows = await lines(sale.body.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ product_id: cola.id, description: 'Cola 0.5L' });
    expect(rows[1]).toMatchObject({
      product_id: null,
      description: 'Phone repair',
      cost_cents: '0',
      line_total_cents: '1000',
    });
    // 18 % default tax, included: 1000 × 1800 / 11800 = 152.5 → 153 (the same rule as products).
    expect(rows[1]!.tax_cents).toBe('153');
    expect((await call<ProductSummary>('GET', `/products/${cola.id}`)).body.stockMilli).toBe(8000);
    const audit = await ctx.pool.query(
      `SELECT details FROM audit_logs WHERE action = 'sale.completed' AND entity_id = $1`,
      [sale.body.id],
    );
    expect(audit.rows[0].details.freeItems).toEqual([
      { description: 'Phone repair', unitPriceCents: 1000 },
    ]);
  });

  it('refuses a free line without a name or a price', async () => {
    const noPrice = await call('POST', '/sales', {
      items: [{ description: 'Ticket', quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 100 }],
    });
    expect(noPrice.status).toBe(400);
    const noName = await call('POST', '/sales', {
      items: [{ unitPriceCents: 100, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 100 }],
    });
    expect(noName.status).toBe(400);
  });

  it('suspends and resumes a sale with a free line; the line survives intact', async () => {
    const parked = await call<SaleDetail>('POST', '/sales/suspend', {
      items: [{ description: 'Printing 20 pages', unitPriceCents: 200, quantityMilli: 2000 }],
    });
    expect(parked.status).toBe(201);
    expect(parked.body.totalCents).toBe(400);
    // Completing sends the sale in full again (the same items), plus the tender.
    const done = await call<SaleDetail>('POST', `/sales/${parked.body.id}/complete`, {
      items: [{ description: 'Printing 20 pages', unitPriceCents: 200, quantityMilli: 2000 }],
      payments: [{ method: 'cash', amountCents: 400 }],
    });
    expect(done.status).toBe(200);
    expect(done.body.totalCents).toBe(400);
    expect((await lines(parked.body.id))[0]).toMatchObject({
      product_id: null,
      description: 'Printing 20 pages',
    });
  });

  it('refunds a free line without touching stock', async () => {
    const sale = await call<SaleDetail>('POST', '/sales', {
      items: [{ description: 'Ticket', unitPriceCents: 500, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 500 }],
    });
    expect(sale.status).toBe(201);
    const free = await ctx.pool.query<{ id: string }>(
      'SELECT id::text AS id FROM sale_items WHERE sale_id = $1',
      [sale.body.id],
    );
    const refund = await call<SaleDetail>('POST', `/sales/${sale.body.id}/refund`, {
      items: [{ saleItemId: Number(free.rows[0]!.id), quantityMilli: 1000 }],
      reason: 'customer changed mind',
      method: 'cash',
    });
    expect(refund.status).toBe(200);
    expect(refund.body).toMatchObject({ status: 'refunded' });
    expect((await call<ProductSummary>('GET', `/products/${cola.id}`)).body.stockMilli).toBe(8000);
  });
});
