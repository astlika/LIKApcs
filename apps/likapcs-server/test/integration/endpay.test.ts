/**
 * "Pay at the end" sessions (0.14.0, billing mode `endpay`): a fixed time like prepaid, nothing
 * paid at the start. Expiry parks the full reserved amount as "awaiting payment" (PC freed, bill at
 * the desk) until staff collect it — exactly once, with open orders on the bill on the same receipt.
 * Stopped early, the used time is billed, capped at the reservation; extensions add to the bill
 * without money moving. The clock is faked (Date only) so durations are exact.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  CustomerSummary,
  LoginResponse,
  PricingRuleSummary,
  ProductSummary,
  SessionEventSummary,
  SessionMutationResponse,
  SessionQuoteResponse,
  SessionSummary,
  StationOrder,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);

describe('pay-at-the-end sessions', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let station: StationSummary;
  let second: StationSummary;
  let rule: PricingRuleSummary;
  let cola: ProductSummary;
  const H = () => authHeader(owner.token);

  const post = <T>(url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: H(), payload }).then((r) => ({
      status: r.statusCode,
      body: r.json<T>(),
    }));
  const get = <T>(url: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: H() }).then((r) => r.json<T>());
  const money = async () => {
    const sales = await ctx.pool.query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, COALESCE(sum(total_cents), 0)::text AS total FROM sales`,
    );
    const payments = await ctx.pool.query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, COALESCE(sum(amount_cents), 0)::text AS total FROM payments`,
    );
    return {
      sales: Number(sales.rows[0]!.n),
      salesTotal: Number(sales.rows[0]!.total),
      payments: Number(payments.rows[0]!.n),
      paymentsTotal: Number(payments.rows[0]!.total),
    };
  };
  const at = (date: Date) => vi.setSystemTime(date);
  const plusMinutes = (minutes: number, base: Date = T0) =>
    new Date(base.getTime() + minutes * 60_000);
  const stationNow = (id = station.id) =>
    get<StationSummary[]>('/stations').then((all) => all.find((s) => s.id === id)!);
  const awaiting = () =>
    get<{ items: SessionSummary[]; total: number }>('/sessions?awaitingPayment=true');

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    station = (await post<StationSummary>('/stations', { number: 1, name: 'Arena 1' })).body;
    second = (await post<StationSummary>('/stations', { number: 2, name: 'Arena 2' })).body;
    expect((await post('/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    const ruleRes = await post<PricingRuleSummary>('/pricing/rules', {
      name: 'Standard',
      rateCentsPerHour: 150,
      billingIncrementMinutes: 1,
    });
    expect(ruleRes.status).toBe(201);
    rule = ruleRes.body;
    const product = await post<ProductSummary>('/products', {
      name: 'Cola',
      sellingPriceCents: 150,
      purchaseCostCents: 90,
      initialStockMilli: 20_000,
    });
    expect(product.status).toBe(201);
    cola = product.body;
    expect(
      (
        await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/catalog/menu',
          headers: H(),
          payload: { productIds: [cola.id] },
        })
      ).statusCode,
    ).toBe(200);
  }, 30_000);

  afterEach(() => at(T0));
  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('quotes end pay like prepaid: minutes → the amount due at the end', async () => {
    const q = await post<SessionQuoteResponse>('/sessions/quote', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 60,
    });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({
      billingMode: 'endpay',
      minutes: 60,
      priceCents: 150,
      rule: { id: rule.id },
    });
    const invalid = await post('/sessions/quote', { stationId: station.id, billingMode: 'endpay' });
    expect(invalid.status).toBe(400);
  });

  it('runs out → the PC is freed and the full reservation waits at the desk; collect bills it once', async () => {
    const before = await money();
    const started = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 60,
      customerName: 'Walk-in Bob',
    });
    expect(started.status).toBe(201);
    const s = started.body.session;
    expect(s).toMatchObject({
      billingMode: 'endpay',
      status: 'active',
      quotedPriceCents: 150,
      finalPriceCents: null,
      saleId: null,
      billedAt: null,
      awaitingPayment: false,
      currentPriceCents: 150,
    });
    expect(s.endsAt).toBe(plusMinutes(60).toISOString());
    // Nothing was taken at the start.
    expect(started.body.payment ?? null).toBeNull();
    expect(await money()).toEqual(before);
    // The station grid shows the amount that will be due, as a countdown session.
    const live = await stationNow();
    expect(live.activeSession).toMatchObject({ billingMode: 'endpay', currentPriceCents: 150 });
    expect(live.activeSession!.remainingSeconds).toBe(3600);

    // An extension adds time and money to the bill — still no sale.
    at(plusMinutes(10));
    const extended = await post<SessionMutationResponse>(`/sessions/${s.id}/extend`, {
      minutes: 30,
    });
    expect(extended.status).toBe(200);
    expect(extended.body.session).toMatchObject({ quotedPriceCents: 225, plannedSeconds: 5400 });
    expect(extended.body.session.endsAt).toBe(plusMinutes(90).toISOString());
    expect(extended.body.payment ?? null).toBeNull();
    expect(await money()).toEqual(before);

    // A drink on the bill during the session.
    const device = await ctx.pool.query<{ id: string }>(
      `INSERT INTO station_devices (station_id, machine_id, hostname, app_version, status, token_hash, registration_secret_hash, approved_at)
       VALUES ($1, 'machine-endpay-1', 'pc-endpay', '0.14.0', 'approved', 'x', 'y', now()) RETURNING id`,
      [station.id],
    );
    const order = await ctx.pool.query<{ id: string }>(
      `INSERT INTO station_orders (station_id, session_id, device_id, status, settlement, total_cents, decided_at, decided_by)
       VALUES ($1, $2, $3, 'accepted', 'on_bill', 150, now(), $4) RETURNING id`,
      [station.id, s.id, device.rows[0]!.id, owner.user.id],
    );
    await ctx.pool.query(
      `INSERT INTO station_order_items (order_id, product_id, name, quantity_milli, unit_price_cents, line_total_cents)
       VALUES ($1, $2, 'Cola', 1000, 150, 150)`,
      [order.rows[0]!.id, cola.id],
    );

    // Time runs out: expired, the reservation (225) is the amount due, nothing billed yet.
    at(plusMinutes(89));
    await ctx.app.services.sessions.tick();
    expect((await get<SessionSummary>(`/sessions/${s.id}`)).status).toBe('active');
    at(plusMinutes(91));
    await ctx.app.services.sessions.tick();
    const expired = await get<SessionSummary>(`/sessions/${s.id}`);
    expect(expired).toMatchObject({
      status: 'expired',
      endReason: 'expired',
      finalPriceCents: 225,
      billedAt: null,
      saleId: null,
      awaitingPayment: true,
      openOrdersCents: 150,
      openOrdersCount: 1,
    });
    expect(expired.endedAt).toBe(plusMinutes(90).toISOString());
    expect(await money()).toEqual(before);
    const freed = await stationNow();
    expect(freed.activeSession).toBeNull();
    expect(freed.awaitingPayment).toEqual({ count: 1, amountCents: 225 });
    const list = await awaiting();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ id: s.id, customerName: 'Walk-in Bob' });

    // Ending or extending an ended session is refused; a new session on the PC is fine.
    expect((await post(`/sessions/${s.id}/end`, {})).status).toBe(409);
    expect((await post(`/sessions/${s.id}/extend`, { minutes: 10 })).status).toBe(409);

    // Collect: one receipt for the time (225) and the cola (150), cash with change.
    const collected = await post<SessionMutationResponse>(`/sessions/${s.id}/collect`, {
      payments: [{ method: 'cash', amountCents: 500 }],
    });
    expect(collected.status).toBe(200);
    expect(collected.body.session).toMatchObject({
      status: 'expired',
      finalPriceCents: 225,
      awaitingPayment: false,
      openOrdersCount: 0,
    });
    expect(collected.body.session.billedAt).not.toBeNull();
    expect(collected.body.payment).toMatchObject({
      totalCents: 375,
      paidCents: 500,
      changeCents: 125,
    });
    const after = await money();
    expect(after.sales - before.sales).toBe(1);
    expect(after.salesTotal - before.salesTotal).toBe(375);
    expect((await stationNow()).awaitingPayment).toEqual({ count: 0, amountCents: 0 });
    expect((await awaiting()).total).toBe(0);
    expect((await get<StationOrder>(`/orders/${order.rows[0]!.id}`)).status).toBe('billed');
    // Exactly once.
    const again = await post(`/sessions/${s.id}/collect`, {
      payments: [{ method: 'cash', amountCents: 375 }],
    });
    expect(again.status).toBe(409);
    expect(await money()).toEqual(after);
    const events = await get<SessionEventSummary[]>(`/sessions/${s.id}/events`);
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['created', 'started', 'extended', 'expired', 'billed']),
    );
    expect(events.filter((e) => e.eventType === 'billed')).toHaveLength(1);
  });

  it('stopped early: the used time is billed, capped at the reservation — now or at the desk', async () => {
    const before = await money();
    // 60 min reserved (150); stopped after 20 min → 50 cents, paid right away.
    const a = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 60,
    });
    expect(a.status).toBe(201);
    at(plusMinutes(20));
    const endedNow = await post<SessionMutationResponse>(`/sessions/${a.body.session.id}/end`, {
      payments: [{ method: 'cash', amountCents: 100 }],
    });
    expect(endedNow.status).toBe(200);
    expect(endedNow.body.session).toMatchObject({
      status: 'completed',
      billableSeconds: 1200,
      finalPriceCents: 50,
      awaitingPayment: false,
    });
    expect(endedNow.body.payment).toMatchObject({ totalCents: 50, changeCents: 50 });
    expect((await money()).salesTotal - before.salesTotal).toBe(50);

    // A short reservation that was cheaper than the metered time: the cap holds (10 min reserved
    // = 25 cents; at 1-minute increments 10 min is 25 cents, so the used time never exceeds it).
    at(T0);
    const b = await post<SessionMutationResponse>('/sessions', {
      stationId: second.id,
      billingMode: 'endpay',
      minutes: 10,
    });
    expect(b.status).toBe(201);
    // Without `payments` the PC is freed and the bill waits at the desk.
    at(plusMinutes(8));
    const parked = await post<SessionMutationResponse>(`/sessions/${b.body.session.id}/end`, {});
    expect(parked.status).toBe(200);
    expect(parked.body.session).toMatchObject({
      status: 'completed',
      finalPriceCents: 20,
      billedAt: null,
      awaitingPayment: true,
    });
    expect(parked.body.payment ?? null).toBeNull();
    expect((await stationNow(second.id)).awaitingPayment).toEqual({ count: 1, amountCents: 20 });
    expect((await awaiting()).items.map((s) => s.id)).toEqual([b.body.session.id]);

    // Collected later, on the customer's tab (pay later needs a customer).
    const customer = await post<CustomerSummary>('/customers', { name: 'Ana Debt' });
    expect(customer.status).toBe(201);
    const collected = await post<SessionMutationResponse>(
      `/sessions/${b.body.session.id}/collect`,
      {
        customerId: customer.body.id,
        payments: [{ method: 'credit', amountCents: 20, dueDate: '2030-01-01' }],
      },
    );
    expect(collected.status).toBe(200);
    expect(collected.body.session).toMatchObject({
      customerId: customer.body.id,
      awaitingPayment: false,
      finalPriceCents: 20,
    });
    expect(collected.body.payment).toMatchObject({ totalCents: 20, creditCents: 20 });
    expect((await get<CustomerSummary>(`/customers/${customer.body.id}`)).balanceDueCents).toBe(20);
    expect((await awaiting()).total).toBe(0);
  });

  it('cancel frees the PC without a charge; collect refuses running, cancelled and prepaid sessions', async () => {
    const before = await money();
    const s = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 30,
    });
    expect(s.status).toBe(201);
    const running = await post(`/sessions/${s.body.session.id}/collect`, {
      payments: [{ method: 'cash', amountCents: 75 }],
    });
    expect(running.status).toBe(409);
    const cancelled = await post<SessionMutationResponse>(`/sessions/${s.body.session.id}/cancel`, {
      reason: 'wrong PC',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.session).toMatchObject({
      status: 'cancelled',
      finalPriceCents: 0,
      awaitingPayment: false,
    });
    expect((await post(`/sessions/${s.body.session.id}/collect`, {})).status).toBe(409);
    expect(await money()).toEqual(before);
    expect((await stationNow()).awaitingPayment).toEqual({ count: 0, amountCents: 0 });

    const prepaid = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 30,
      payments: [{ method: 'cash', amountCents: 75 }],
    });
    expect(prepaid.status).toBe(201);
    expect((await post(`/sessions/${prepaid.body.session.id}/collect`, {})).status).toBe(409);
    await post(`/sessions/${prepaid.body.session.id}/end`, {});
  });

  it('waive: a full discount collects a zero bill; an empty tender list never pays a real one', async () => {
    const before = await money();
    const s = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 30,
    });
    expect(s.status).toBe(201);
    at(plusMinutes(31));
    await ctx.app.services.sessions.tick();
    expect((await stationNow()).awaitingPayment).toEqual({ count: 1, amountCents: 75 });
    // Nothing handed over while 75 is due → refused, nothing recorded.
    const unpaid = await post(`/sessions/${s.body.session.id}/collect`, { payments: [] });
    expect(unpaid.status).toBe(400);
    expect(await money()).toEqual(before);
    // The whole time price discounted (pos.discount): a zero receipt, the PC's bill is closed.
    const waived = await post<SessionMutationResponse>(`/sessions/${s.body.session.id}/collect`, {
      discountCents: 75,
      payments: [],
    });
    expect(waived.status).toBe(200);
    expect(waived.body.session).toMatchObject({
      status: 'expired',
      finalPriceCents: 0,
      discountCents: 75,
      awaitingPayment: false,
    });
    expect(waived.body.session.billedAt).not.toBeNull();
    expect(waived.body.payment).toMatchObject({ totalCents: 0, paidCents: 0, changeCents: 0 });
    const after = await money();
    expect(after.sales - before.sales).toBe(1);
    expect(after.salesTotal - before.salesTotal).toBe(0);
    expect((await stationNow()).awaitingPayment).toEqual({ count: 0, amountCents: 0 });
    expect((await awaiting()).total).toBe(0);
  });
});
