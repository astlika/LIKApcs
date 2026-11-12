/**
 * Unit prices and costs with three decimals (mills, 0.125 € = 125 mills).
 *
 * Products and purchase lines keep the exact value; the till still charges whole cents, so a
 * 0.125 € price is charged as 0.13 € and its cost is booked as 13 cents per piece.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CashShiftDetail,
  LoginResponse,
  ProductSummary,
  PurchaseDetail,
  SaleDetail,
  SupplierSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('unit prices with three decimals', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let candy: ProductSummary;
  let supplier: SupplierSummary;

  const call = <T>(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({
        status: r.statusCode,
        body: (r.statusCode === 204 ? null : r.json()) as T,
      }));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    supplier = (await call<SupplierSummary>('POST', '/suppliers', { name: 'Bonboni SH.P.K.' }))
      .body;
    // Sales need an open cash shift.
    await call<CashShiftDetail>('POST', '/cash/shifts/open', { openingCents: 5000 });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('stores a product price in mills; the cent columns are the same value rounded', async () => {
    const created = await call<ProductSummary>('POST', '/products', {
      name: 'Karamele',
      sellingPriceCents: 13,
      sellingPriceMills: 125,
      purchaseCostCents: 0,
      purchaseCostMills: 0,
    });
    expect(created.status).toBe(201);
    candy = created.body;
    expect(candy.sellingPriceMills).toBe(125);
    expect(candy.sellingPriceCents).toBe(13);
    expect(candy.purchaseCostMills).toBe(0);
  });

  it('a purchase of 10 pcs at 0.125 € costs 125 cents, with the unit cost kept in mills', async () => {
    const created = await call<PurchaseDetail>('POST', '/purchases', {
      supplierId: supplier.id,
      items: [
        {
          productId: candy.id,
          quantityMilli: 10_000,
          unitCostCents: 13,
          unitCostMills: 125,
        },
      ],
      receiveNow: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.subtotalCents).toBe(125);
    expect(created.body.totalCents).toBe(125);
    expect(created.body.items[0]!.unitCostMills).toBe(125);

    const after = (await call<ProductSummary>('GET', `/products/${candy.id}`)).body;
    expect(after.stockMilli).toBe(10_000);
    expect(after.purchaseCostMills).toBe(125);
    expect(after.averageCostMills).toBe(125);
    expect(after.averageCostCents).toBe(13);
  });

  it('a sale of 1 pc at 0.125 € charges 13 cents and books a cost of 13 cents', async () => {
    const sale = await call<SaleDetail>('POST', '/sales', {
      items: [{ productId: candy.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 13 }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(13);

    const line = await ctx.pool.query<{ cost_cents: string }>(
      'SELECT cost_cents::text FROM sale_items WHERE sale_id = $1',
      [sale.body.id],
    );
    expect(line.rows[0]!.cost_cents).toBe('13');
    const movement = await ctx.pool.query<{ unit_cost_mills: string }>(
      `SELECT unit_cost_mills::text FROM inventory_movements
        WHERE product_id = $1 AND movement_type = 'sale' ORDER BY id DESC LIMIT 1`,
      [candy.id],
    );
    expect(movement.rows[0]!.unit_cost_mills).toBe('125');
  });

  it('refuses an unreasonable price in mills', async () => {
    const res = await call<{ error: { code: string } }>('POST', '/products', {
      name: 'Gabim',
      sellingPriceCents: 1,
      sellingPriceMills: 1_234_567_890_123,
      purchaseCostCents: 0,
    });
    expect(res.status).toBe(400);
  });
});
