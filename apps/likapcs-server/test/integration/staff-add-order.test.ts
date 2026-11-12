/**
 * The desk adds products to a PC's bill (`POST /sessions/:id/orders`, 0.27.1).
 * Unbilled session (running, or ended but not yet collected): the lines join the session's receipt
 * and are paid with it. Billed session (prepaid, or collected): the products are paid at once as a
 * POS sale. Out-of-stock products are refused; the owner/manager can write an order off.
 * The clock is faked (Date only): 150 cents per hour, 30 minutes = 75 cents.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  LoginResponse,
  PricingRuleSummary,
  ProductSummary,
  SessionMutationResponse,
  SessionSummary,
  StationOrder,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);

describe('the desk adds products to a PC bill', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  const H = () => authHeader(owner.token);

  const call = <T>(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method, url: `/api/v1${url}`, headers: H(), payload }).then((r) => ({
      status: r.statusCode,
      body: r.json<T>(),
    }));
  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    ctx.pool.query<T>(sql, params).then((r) => r.rows);

  const makeStation = async (number: number) =>
    (await call<StationSummary>('POST', '/stations', { number, name: `Arena ${number}` })).body;

  let cola: ProductSummary;
  let empty: ProductSummary;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    expect(
      (
        await call<PricingRuleSummary>('POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 150,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    cola = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Cola',
        sellingPriceCents: 200,
        trackStock: false,
      })
    ).body;
    // Tracked stock with nothing in it: it cannot be sold.
    empty = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Chips (empty)',
        sellingPriceCents: 150,
        trackStock: true,
      })
    ).body;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('adds to a pay-later session; the lines join the receipt when it is collected', async () => {
    const station = await makeStation(1);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 60,
    });
    const sid = started.body.session.id;

    const added = await call<StationOrder>('POST', `/sessions/${sid}/orders`, {
      items: [{ productId: cola.id, quantity: 2 }],
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      status: 'accepted',
      settlement: 'on_bill',
      sessionId: sid,
      totalCents: 400,
    });

    const during = await call<SessionSummary>('GET', `/sessions/${sid}`);
    expect(during.body.openOrdersCents).toBe(400);
    expect(during.body.openOrdersCount).toBe(1);

    // 30 minutes later: time 75 + two colas 400 = 475, one cash receipt.
    vi.setSystemTime(new Date(T0.getTime() + 30 * 60_000));
    expect((await call('POST', `/sessions/${sid}/end`, {})).status).toBe(200);
    const collected = await call<SessionMutationResponse>('POST', `/sessions/${sid}/collect`, {
      payments: [{ method: 'cash', amountCents: 475 }],
    });
    expect(collected.status).toBe(200);

    const order = await call<StationOrder>('GET', `/orders/${added.body.id}`);
    expect(order.body.status).toBe('billed');
    const sale = await q<{ total_cents: string }>(
      'SELECT total_cents::text FROM sales WHERE id = $1',
      [order.body.saleId],
    );
    expect(Number(sale[0]!.total_cents)).toBe(475);
    const lines = await q<{ quantity_milli: string; line_total_cents: string }>(
      'SELECT quantity_milli::text, line_total_cents::text FROM sale_items WHERE sale_id = $1 AND product_id = $2',
      [order.body.saleId, cola.id],
    );
    expect(lines).toEqual([{ quantity_milli: '2000', line_total_cents: '400' }]);
  });

  it('on a prepaid session the products wait on the bill, or are sold at once with a payment', async () => {
    const station = await makeStation(2);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 60,
      payments: [{ method: 'card', amountCents: 150 }],
    });
    const sid = started.body.session.id;
    const salesBefore = Number(
      (await q<{ n: string }>('SELECT count(*)::text AS n FROM sales'))[0]!.n,
    );

    // 0.28.0: the paid time is not touched; the products go on the bill and are paid later.
    const onBill = await call<StationOrder>('POST', `/sessions/${sid}/orders`, {
      items: [{ productId: cola.id, quantity: 2 }],
    });
    expect(onBill.status).toBe(201);
    expect(onBill.body).toMatchObject({ status: 'accepted', totalCents: 400 });
    expect(Number((await q<{ n: string }>('SELECT count(*)::text AS n FROM sales'))[0]!.n)).toBe(
      salesBefore,
    );

    const paid = await call<StationOrder>('POST', `/sessions/${sid}/orders`, {
      items: [{ productId: cola.id, quantity: 2 }],
      payments: [{ method: 'card', amountCents: 400 }],
    });
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ status: 'paid', totalCents: 400 });
    expect(paid.body.saleId).toBeTruthy();

    const salesAfter = Number(
      (await q<{ n: string }>('SELECT count(*)::text AS n FROM sales'))[0]!.n,
    );
    expect(salesAfter - salesBefore).toBe(1);
    const during = await call<SessionSummary>('GET', `/sessions/${sid}`);
    expect(during.body.openOrdersCents).toBe(400);
  });

  it('on a running (unbilled) session, paying now sells the lines at once and they stay on the PC', async () => {
    const station = await makeStation(5);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 60,
    });
    const sid = started.body.session.id;

    const short = await call<{ error: { code: string } }>('POST', `/sessions/${sid}/orders`, {
      items: [{ productId: cola.id, quantity: 2 }],
      payments: [{ method: 'cash', amountCents: 100 }],
    });
    expect(short.status).toBe(400);

    const paid = await call<StationOrder>('POST', `/sessions/${sid}/orders`, {
      items: [{ productId: cola.id, quantity: 2 }],
      payments: [{ method: 'cash', amountCents: 400 }],
    });
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ status: 'paid', totalCents: 400, sessionId: sid });
    expect(paid.body.saleId).toBeTruthy();

    const during = await call<SessionSummary>('GET', `/sessions/${sid}`);
    expect(during.body.openOrdersCents).toBe(0);
    // The session's own bill (time) is still open: it is not paid by this order.
    expect(during.body.billedAt).toBeNull();
  });

  it('refuses a product with no stock', async () => {
    const station = await makeStation(3);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 60,
    });
    const res = await call<{ error: { code: string } }>(
      'POST',
      `/sessions/${started.body.session.id}/orders`,
      { items: [{ productId: empty.id, quantity: 1 }] },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('out_of_stock');
  });

  it('the owner or manager can write off a bill item, and the bill goes back', async () => {
    const station = await makeStation(4);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 60,
    });
    const sid = started.body.session.id;
    const added = await call<StationOrder>('POST', `/sessions/${sid}/orders`, {
      items: [{ productId: cola.id, quantity: 1 }],
    });
    expect(added.status).toBe(201);

    const voided = await call<StationOrder>('POST', `/orders/${added.body.id}/void`, {
      reason: 'Gabim i kasieres',
    });
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe('void');
    const after = await call<SessionSummary>('GET', `/sessions/${sid}`);
    expect(after.body.openOrdersCents).toBe(0);
  });
});
