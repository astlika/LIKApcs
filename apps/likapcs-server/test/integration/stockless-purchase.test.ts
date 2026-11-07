/**
 * 0.19.1 — a purchase line for a product that does not track stock is an expense, booked once when
 * it is received. A stock product still goes into inventory, as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ExpenseListResponse,
  LoginResponse,
  ProductSummary,
  PurchaseDetail,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('stock-less purchase lines are expenses (0.19.1)', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cola: ProductSummary;
  let service: ProductSummary;
  let supplierId: string;

  const call = <T>(
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<{ status: number; body: T }> =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));
  const product = async (id: string) => (await call<ProductSummary>('GET', `/products/${id}`)).body;
  const expensesFor = async (reference: string) => {
    const list = await call<ExpenseListResponse>('GET', '/expenses?pageSize=200');
    return list.body.items.filter((e) => e.description.startsWith(reference));
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    cola = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Coca-Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 10_000,
      })
    ).body;
    service = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Servis pajisjesh',
        sellingPriceCents: 500,
        purchaseCostCents: 0,
        trackStock: false,
      })
    ).body;
    supplierId = (await call<{ id: string }>('POST', '/suppliers', { name: 'Furnitor Test' })).body
      .id;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('a stock-less line books one expense on receipt; a stock line still goes to inventory', async () => {
    expect(service.trackStock).toBe(false);
    const created = await call<PurchaseDetail>('POST', '/purchases', {
      supplierId,
      items: [
        { productId: service.id, quantityMilli: 2_000, unitCostCents: 500 },
        { productId: cola.id, quantityMilli: 5_000, unitCostCents: 70 },
      ],
      receiveNow: true,
    });
    expect(created.status).toBe(201);
    const p = created.body;

    const expenses = await expensesFor(p.referenceNo);
    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({
      categoryCode: 'other',
      amountCents: 1000,
      paymentMethod: 'other',
      voidedAt: null,
    });

    // the stock product went into inventory, the stock-less one did not move any stock
    expect((await product(cola.id)).stockMilli).toBe(15_000);
    expect((await product(service.id)).stockMilli).toBe(0);
  });

  it('a partial receipt books the expense for the received part only, and never twice', async () => {
    const created = await call<PurchaseDetail>('POST', '/purchases', {
      supplierId,
      items: [{ productId: service.id, quantityMilli: 3_000, unitCostCents: 400 }],
      receiveNow: false,
    });
    const p = created.body;
    expect(await expensesFor(p.referenceNo)).toHaveLength(0);

    await call('POST', `/purchases/${p.id}/receive`, {
      items: [{ purchaseItemId: p.items[0]!.id, quantityMilli: 1_000 }],
    });
    let expenses = await expensesFor(p.referenceNo);
    expect(expenses.map((e) => e.amountCents)).toEqual([400]);

    await call('POST', `/purchases/${p.id}/receive`, {});
    expenses = await expensesFor(p.referenceNo);
    expect(expenses.map((e) => e.amountCents).sort()).toEqual([400, 800]);
    expect(expenses.reduce((n, e) => n + e.amountCents, 0)).toBe(1200);

    // nothing left: a further receive is refused and books nothing
    expect((await call('POST', `/purchases/${p.id}/receive`, {})).status).toBe(409);
    expect(await expensesFor(p.referenceNo)).toHaveLength(2);
  });
});
