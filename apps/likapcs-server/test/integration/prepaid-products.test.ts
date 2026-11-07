/**
 * Products on a prepaid PC (0.28.0). The time was paid at the start and stays paid. Products added
 * to the running PC go on its bill: paid now, or left on the bill. When the PC ends, a bill with
 * products still open waits at the desk (\"Pagesat në pritje\"), and collecting it sells only the
 * products. The time is never billed again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  LoginResponse,
  ProductSummary,
  SaleDetail,
  SessionSummary,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

type StationOrder = {
  id: string;
  status: string;
  settlement: string;
  saleId: string | null;
  totalCents: number;
};
type Err = { error?: { code: string; message: string } };

describe('products on a prepaid PC', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cola: ProductSummary;

  const call = <T>(url: string, method: 'GET' | 'POST', payload?: Record<string, unknown>) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));

  // Each test uses its own PC, so a session left open by one test cannot block the next.
  let pcNumber = 1;
  const startPrepaid = async () => {
    pcNumber += 1;
    const pc = (
      await call<StationSummary>('/stations', 'POST', { number: pcNumber, name: `PC ${pcNumber}` })
    ).body;
    const started = await call<{ session: SessionSummary }>('/sessions', 'POST', {
      stationId: pc.id,
      billingMode: 'prepaid',
      minutes: 60,
      payments: [{ method: 'cash', amountCents: 120 }],
    });
    expect(started.status).toBe(201);
    return started.body.session.id;
  };

  const sessionOf = (id: string) => call<SessionSummary>(`/sessions/${id}`, 'GET');
  const salesCount = async () =>
    Number(
      (await ctx.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sales')).rows[0]!.n,
    );

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect((await call('/cash/shifts/open', 'POST', { openingCents: 2000 })).status).toBe(201);
    expect(
      (
        await call('/pricing/rules', 'POST', {
          name: 'Standard',
          rateCentsPerHour: 120,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    const cat = await call<{ id: string }>('/catalog/categories', 'POST', { name: 'Drinks' });
    cola = (
      await call<ProductSummary>('/products', 'POST', {
        name: 'Coca-Cola 0.5',
        sellingPriceCents: 150,
        purchaseCostCents: 80,
        categoryId: cat.body.id,
        initialStockMilli: 10_000,
      })
    ).body;
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('products added while the time runs go on the bill; the paid time is untouched', async () => {
    const sessionId = await startPrepaid();
    const before = await salesCount();
    const added = await call<StationOrder>(`/sessions/${sessionId}/orders`, 'POST', {
      items: [{ productId: cola.id, quantity: 2 }],
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      status: 'accepted',
      settlement: 'on_bill',
      totalCents: 300,
    });
    expect(await salesCount()).toBe(before);
    const s = await sessionOf(sessionId);
    expect(s.body.currentPriceCents).toBe(120);
    expect(s.body.openOrdersCents).toBe(300);
    expect(s.body.awaitingPayment).toBe(false);
  });

  it('products added with a payment are paid at once, as before', async () => {
    const sessionId = await startPrepaid();
    const paid = await call<StationOrder>(`/sessions/${sessionId}/orders`, 'POST', {
      items: [{ productId: cola.id, quantity: 1 }],
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe('paid');
    expect(paid.body.saleId).not.toBeNull();
  });

  it('ending the PC without payment leaves the products waiting at the desk', async () => {
    const sessionId = await startPrepaid();
    const added = await call<StationOrder>(`/sessions/${sessionId}/orders`, 'POST', {
      items: [{ productId: cola.id, quantity: 2 }],
    });
    expect(added.status).toBe(201);
    const ended = await call<{ session: SessionSummary; payment: unknown }>(
      `/sessions/${sessionId}/end`,
      'POST',
      {},
    );
    expect(ended.status).toBe(200);
    expect(ended.body.payment).toBeNull();
    expect(ended.body.session.awaitingPayment).toBe(true);
    expect(ended.body.session.openOrdersCents).toBe(300);
    const waiting = await call<{ items: SessionSummary[] }>(
      '/sessions?awaitingPayment=true&pageSize=200',
      'GET',
    );
    expect(waiting.body.items.map((x) => x.id)).toContain(sessionId);
  });

  it('collecting the waiting bill sells only the products, once', async () => {
    const sessionId = await startPrepaid();
    const added = await call<StationOrder>(`/sessions/${sessionId}/orders`, 'POST', {
      items: [{ productId: cola.id, quantity: 2 }],
    });
    const orderId = added.body.id;
    await call(`/sessions/${sessionId}/end`, 'POST', {});
    const tooLittle = await call<Err>(`/sessions/${sessionId}/collect`, 'POST', {
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(tooLittle.status).toBe(400);
    const collected = await call<{ session: SessionSummary; payment: { totalCents: number } }>(
      `/sessions/${sessionId}/collect`,
      'POST',
      { payments: [{ method: 'cash', amountCents: 300 }] },
    );
    expect(collected.status).toBe(200);
    expect(collected.body.payment.totalCents).toBe(300);
    expect(collected.body.session.awaitingPayment).toBe(false);
    const order = await call<StationOrder>(`/orders/${orderId}`, 'GET');
    expect(order.body.status).toBe('billed');
    const sale = await call<SaleDetail>(`/sales/${order.body.saleId}`, 'GET');
    expect(sale.body.items.map((i) => [i.productId, i.quantityMilli])).toEqual([[cola.id, 2000]]);
    // Nothing is left to collect, and the paid time is never billed again.
    const again = await call<Err>(`/sessions/${sessionId}/collect`, 'POST', {
      payments: [{ method: 'cash', amountCents: 300 }],
    });
    expect(again.status).toBe(409);
  });

  it('a prepaid PC with no products ends without a bill', async () => {
    const sessionId = await startPrepaid();
    const ended = await call<{ session: SessionSummary; payment: unknown }>(
      `/sessions/${sessionId}/end`,
      'POST',
      {},
    );
    expect(ended.status).toBe(200);
    expect(ended.body.session.awaitingPayment).toBe(false);
    const nothing = await call<Err>(`/sessions/${sessionId}/collect`, 'POST', {});
    expect(nothing.status).toBe(409);
  });
});
