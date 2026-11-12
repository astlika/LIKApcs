/**
 * 0.33.4 — stock on a PC's bill. A product that may not go below zero cannot be put on a bill
 * beyond what is left (what already waits on the bills counts as taken); a product that is allowed
 * below zero, or is not tracked, is not limited. The bill itself always closes: selling the lines of
 * an accepted order never stops the end of a session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  LoginResponse,
  PricingRuleSummary,
  ProductSummary,
  SessionMutationResponse,
  StationOrder,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('stock on a PC bill', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cola: ProductSummary;
  let water: ProductSummary;
  let pc1: StationSummary;
  let pc2: StationSummary;

  const call = <T>(method: 'GET' | 'POST', url: string, payload?: unknown) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: authHeader(owner.token),
        payload: payload as object,
      })
      .then((r) => ({
        status: r.statusCode,
        body: r.body ? (JSON.parse(r.body) as T) : (null as T),
        raw: r.body,
      }));
  const stockOf = async (id: string) =>
    Number(
      (
        await ctx.pool.query<{ stock_milli: string }>(
          'SELECT stock_milli FROM products WHERE id = $1',
          [id],
        )
      ).rows[0]!.stock_milli,
    );
  const start = async (stationId: string) =>
    (
      await call<SessionMutationResponse>('POST', '/sessions', {
        stationId,
        billingMode: 'postpaid',
      })
    ).body.session.id;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    expect(
      (
        await call<PricingRuleSummary>('POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 120,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    pc1 = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'Arena 1' })).body;
    pc2 = (await call<StationSummary>('POST', '/stations', { number: 2, name: 'Arena 2' })).body;
    cola = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Cola',
        sellingPriceCents: 150,
        initialStockMilli: 3000,
      })
    ).body;
    water = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Ujë',
        sellingPriceCents: 50,
        initialStockMilli: 0,
        allowNegativeStock: true,
      })
    ).body;
    expect(await stockOf(cola.id)).toBe(3000);
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('refuses more than the stock on a bill, counts what other bills already hold, and names what is left', async () => {
    const s1 = await start(pc1.id);
    const s2 = await start(pc2.id);

    const tooMany = await call<{ error: { code: string; details: Record<string, unknown> } }>(
      'POST',
      `/sessions/${s1}/orders`,
      { items: [{ productId: cola.id, quantity: 4 }] },
    );
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('out_of_stock');
    expect(tooMany.body.error.details).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      productId: cola.id,
      availableMilli: 3000,
      requestedMilli: 4000,
    });

    // Two go on PC 1's bill: the stock itself does not move until the bill is paid…
    const two = await call<StationOrder>('POST', `/sessions/${s1}/orders`, {
      items: [{ productId: cola.id, quantity: 2 }],
    });
    expect(two.status).toBe(201);
    expect(await stockOf(cola.id)).toBe(3000);
    // …but they are taken: PC 2 can only have the last one.
    const second = await call<{ error: { code: string; details: Record<string, unknown> } }>(
      'POST',
      `/sessions/${s2}/orders`,
      { items: [{ productId: cola.id, quantity: 2 }] },
    );
    expect(second.status).toBe(409);
    expect(second.body.error.details).toMatchObject({ availableMilli: 1000, requestedMilli: 2000 });
    expect(
      (
        await call('POST', `/sessions/${s2}/orders`, {
          items: [{ productId: cola.id, quantity: 1 }],
        })
      ).status,
    ).toBe(201);

    // A product allowed below zero is never limited.
    expect(
      (
        await call('POST', `/sessions/${s2}/orders`, {
          items: [{ productId: water.id, quantity: 5 }],
        })
      ).status,
    ).toBe(201);

    // The till sells one Cola meanwhile (the POS checks the shelf, not the bills).
    const sale = await call('POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(sale.status).toBe(201);
    expect(await stockOf(cola.id)).toBe(2000);

    // Both bills still close: PC 1 takes its two, PC 2 its one (already handed over) → −1 to count.
    const end1 = await call('POST', `/sessions/${s1}/end`, {
      payments: [{ method: 'cash', amountCents: 5000 }],
    });
    expect(end1.status).toBe(200);
    expect(await stockOf(cola.id)).toBe(0);
    const end2 = await call('POST', `/sessions/${s2}/end`, {
      payments: [{ method: 'cash', amountCents: 5000 }],
    });
    expect(end2.status).toBe(200);
    expect(await stockOf(cola.id)).toBe(-1000);
    expect(await stockOf(water.id)).toBe(-5000);
  });

  it('the till still refuses a sale beyond the stock of a product that may not go below zero', async () => {
    const refused = await call<{ error: { details: Record<string, unknown> } }>('POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      productName: 'Cola',
    });
    const allowed = await call('POST', '/sales', {
      items: [{ productId: water.id, quantityMilli: 2000 }],
      payments: [{ method: 'cash', amountCents: 100 }],
    });
    expect(allowed.status).toBe(201);
  });
});
