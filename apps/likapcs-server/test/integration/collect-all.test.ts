/**
 * 0.21.0 — pay all: every bill waiting at one PC (pay-at-the-end sessions that ran out or ended)
 * is paid in ONE tender step and ONE transaction. Each bill keeps its own sale and receipt. A
 * tender that does not cover every bill refuses the whole step, and other PCs are not touched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  LoginResponse,
  PricingRuleSummary,
  ProductSummary,
  SessionMutationResponse,
  SessionSummary,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const plusMinutes = (minutes: number, base: Date = T0) =>
  new Date(base.getTime() + minutes * 60_000);

describe('pay all: the bills waiting at one PC, in one step', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let pc1: StationSummary;
  let pc2: StationSummary;
  let pc3: StationSummary;

  const H = () => authHeader(owner.token);
  const post = <T>(url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: H(), payload }).then((r) => ({
      status: r.statusCode,
      body: r.json<T>(),
    }));
  const get = <T>(url: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: H() }).then((r) => r.json<T>());
  const counts = async () => {
    const r = await ctx.pool.query<{ sales: string; payments: string; total: string }>(
      `SELECT (SELECT count(*) FROM sales)::text AS sales,
              (SELECT count(*) FROM payments)::text AS payments,
              (SELECT COALESCE(sum(amount_cents), 0) FROM payments)::text AS total`,
    );
    return {
      sales: Number(r.rows[0]!.sales),
      payments: Number(r.rows[0]!.payments),
      total: Number(r.rows[0]!.total),
    };
  };
  const setClock = (date: Date) => vi.setSystemTime(date);
  /** Ends the time of every running session whose reservation has run out. */
  const expireDue = async () => {
    await ctx.app.services.sessions.tick();
    await ctx.app.services.sessions.tick();
  };
  const startEndpay = async (station: StationSummary, minutes: number) => {
    const res = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes,
      customerName: `Walk-in ${station.code}`,
    });
    expect(res.status).toBe(201);
    return res.body.session;
  };
  const sessionOf = (id: string) => get<SessionSummary>(`/sessions/${id}`);
  const awaitingAt = (station: StationSummary) =>
    get<StationSummary[]>('/stations').then(
      (all) => all.find((s) => s.id === station.id)!.awaitingPayment.count,
    );

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setClock(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    pc1 = (await post<StationSummary>('/stations', { number: 1, name: 'Arena 1' })).body;
    pc2 = (await post<StationSummary>('/stations', { number: 2, name: 'Arena 2' })).body;
    pc3 = (await post<StationSummary>('/stations', { number: 3, name: 'Arena 3' })).body;
    expect((await post('/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    const rule = await post<PricingRuleSummary>('/pricing/rules', {
      name: 'Standard',
      rateCentsPerHour: 150,
      billingIncrementMinutes: 1,
    });
    expect(rule.status).toBe(201);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('pays both bills of one PC in one step: one sale and one receipt each', async () => {
    // One PC runs one session at a time: the second bill starts once the first has run out.
    setClock(T0);
    const a = await startEndpay(pc1, 30); // 75
    setClock(plusMinutes(31));
    await expireDue();
    const b = await startEndpay(pc1, 60); // 150
    setClock(plusMinutes(92));
    await expireDue();
    expect((await sessionOf(a.id)).status).toBe('expired');
    expect((await sessionOf(b.id)).status).toBe('expired');
    expect(await awaitingAt(pc1)).toBe(2);

    const before = await counts();
    const res = await post<{
      stationId: string;
      collected: {
        sessionId: string;
        receiptNo: string;
        totalCents: number;
        payment: { saleId: string; receiptNo: string } | null;
      }[];
      totalCents: number;
    }>(`/stations/${pc1.id}/collect-all`, {
      paymentMethod: 'cash',
      payments: [{ method: 'cash', amountCents: 225 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.totalCents).toBe(225);
    expect(res.body.collected.map((c) => c.sessionId).sort()).toEqual([a.id, b.id].sort());
    expect(res.body.collected.find((c) => c.sessionId === a.id)!.totalCents).toBe(75);
    expect(res.body.collected.find((c) => c.sessionId === b.id)!.totalCents).toBe(150);
    const receipts = new Set(res.body.collected.map((c) => c.receiptNo));
    expect(receipts.size).toBe(2);
    expect(receipts.has('')).toBe(false);
    // Each bill comes back with its full receipt payment, so the desk can print it.
    expect(res.body.collected.every((c) => c.payment && c.payment.saleId)).toBe(true);
    expect(res.body.collected.find((c) => c.sessionId === a.id)!.payment!.receiptNo).toBe(
      res.body.collected.find((c) => c.sessionId === a.id)!.receiptNo,
    );

    const after = await counts();
    expect(after.sales - before.sales).toBe(2);
    expect(after.total - before.total).toBe(225);
    expect((await sessionOf(a.id)).billedAt).not.toBeNull();
    expect((await sessionOf(b.id)).billedAt).not.toBeNull();
    expect(await awaitingAt(pc1)).toBe(0);

    // Exactly once: nothing is left to pay, so a second step is refused and takes nothing.
    const again = await post(`/stations/${pc1.id}/collect-all`, { paymentMethod: 'cash' });
    expect(again.status).toBe(409);
    expect(await counts()).toEqual(after);
  });

  it('a tender that does not cover every bill refuses the whole step; other PCs are untouched', async () => {
    setClock(plusMinutes(200));
    const a = await startEndpay(pc2, 30); // 75
    const other = await startEndpay(pc3, 30); // 75, PC 3's own bill
    setClock(plusMinutes(231));
    await expireDue();
    const b = await startEndpay(pc2, 60); // 150, starts after a has run out
    setClock(plusMinutes(292));
    await expireDue();
    expect(await awaitingAt(pc2)).toBe(2);
    expect(await awaitingAt(pc3)).toBe(1);

    const before = await counts();
    const short = await post(`/stations/${pc2.id}/collect-all`, {
      paymentMethod: 'cash',
      payments: [{ method: 'cash', amountCents: 100 }],
    });
    expect(short.status).toBe(400);
    expect(await counts()).toEqual(before);
    expect((await sessionOf(a.id)).billedAt).toBeNull();
    expect((await sessionOf(b.id)).billedAt).toBeNull();
    expect(await awaitingAt(pc2)).toBe(2);

    // Paying PC 2 does not pay PC 3's bill.
    const paid = await post(`/stations/${pc2.id}/collect-all`, {
      paymentMethod: 'cash',
      payments: [{ method: 'cash', amountCents: 225 }],
    });
    expect(paid.status).toBe(200);
    expect(await awaitingAt(pc2)).toBe(0);
    expect(await awaitingAt(pc3)).toBe(1);
    expect((await sessionOf(other.id)).billedAt).toBeNull();
  });

  it('open order lines are part of the pay-all total and settle with their bill', async () => {
    setClock(plusMinutes(400));
    const pc4 = (await post<StationSummary>('/stations', { number: 4, name: 'Arena 4' })).body;
    const cola = await post<ProductSummary>('/products', {
      name: 'Cola (pay all)',
      sellingPriceCents: 150,
      purchaseCostCents: 90,
      initialStockMilli: 20_000,
    });
    expect(cola.status).toBe(201);
    const a = await startEndpay(pc4, 30); // 75 + a 150 drink = 225
    const device = await ctx.pool.query<{ id: string }>(
      `INSERT INTO station_devices (station_id, machine_id, hostname, app_version, status, token_hash, registration_secret_hash, approved_at)
       VALUES ($1, 'machine-collect-all-4', 'pc-collect-all-4', '0.14.0', 'approved', 'x', 'y', now()) RETURNING id`,
      [pc4.id],
    );
    const order = await ctx.pool.query<{ id: string }>(
      `INSERT INTO station_orders (station_id, session_id, device_id, status, settlement, total_cents, decided_at, decided_by)
       VALUES ($1, $2, $3, 'accepted', 'on_bill', 150, now(), $4) RETURNING id`,
      [pc4.id, a.id, device.rows[0]!.id, owner.user.id],
    );
    await ctx.pool.query(
      `INSERT INTO station_order_items (order_id, product_id, name, quantity_milli, unit_price_cents, line_total_cents)
       VALUES ($1, $2, 'Cola', 1000, 150, 150)`,
      [order.rows[0]!.id, cola.body.id],
    );
    setClock(plusMinutes(431));
    await expireDue();
    const b = await startEndpay(pc4, 60); // 150, starts after a has run out
    setClock(plusMinutes(492));
    await expireDue();

    const billA = await sessionOf(a.id);
    expect(billA).toMatchObject({
      finalPriceCents: 75,
      openOrdersCents: 150,
      awaitingPayment: true,
    });
    expect(await awaitingAt(pc4)).toBe(2);

    // The total is 225 + 150 = 375: a tender of 374 is refused and takes nothing.
    const before = await counts();
    const short = await post(`/stations/${pc4.id}/collect-all`, {
      paymentMethod: 'cash',
      payments: [{ method: 'cash', amountCents: 374 }],
    });
    expect(short.status).toBe(400);
    expect(await counts()).toEqual(before);

    const paid = await post<{
      totalCents: number;
      collected: { sessionId: string; totalCents: number }[];
    }>(`/stations/${pc4.id}/collect-all`, {
      paymentMethod: 'cash',
      payments: [{ method: 'cash', amountCents: 375 }],
    });
    expect(paid.status).toBe(200);
    expect(paid.body.totalCents).toBe(375);
    expect(paid.body.collected.find((c) => c.sessionId === a.id)!.totalCents).toBe(225);
    expect(paid.body.collected.find((c) => c.sessionId === b.id)!.totalCents).toBe(150);
    expect((await counts()).total - before.total).toBe(375);
    expect((await get<{ status: string }>(`/orders/${order.rows[0]!.id}`)).status).toBe('billed');
    expect(await awaitingAt(pc4)).toBe(0);
  });

  it('a PC with nothing waiting is refused, and no tender is taken', async () => {
    const before = await counts();
    const res = await post(`/stations/${pc1.id}/collect-all`, { paymentMethod: 'cash' });
    expect(res.status).toBe(409);
    expect(await counts()).toEqual(before);
  });

  it('0.19.5 — collect all PCs: the bills of every PC in one step; a short tender takes nothing', async () => {
    // Earlier tests left PC 3's bill waiting (75). PC 5 and PC 6 end together with bills too.
    setClock(plusMinutes(600));
    const pc5 = (await post<StationSummary>('/stations', { number: 5, name: 'Arena 5' })).body;
    const pc6 = (await post<StationSummary>('/stations', { number: 6, name: 'Arena 6' })).body;
    const a = await startEndpay(pc5, 30); // 75
    const c = await startEndpay(pc6, 30); // 75
    setClock(plusMinutes(631));
    await expireDue();
    const b = await startEndpay(pc5, 60); // 150, starts after a has run out
    setClock(plusMinutes(692));
    await expireDue();
    expect(await awaitingAt(pc5)).toBe(2);
    expect(await awaitingAt(pc6)).toBe(1);
    expect(await awaitingAt(pc3)).toBe(1);

    // Four bills in all: 75 + 150 + 75 + 75 = 375.
    const before = await counts();
    const short = await post('/sessions/collect-all', {
      paymentMethod: 'cash',
      payments: [{ method: 'cash', amountCents: 374 }],
    });
    expect(short.status).toBe(400);
    expect(await counts()).toEqual(before);
    expect((await sessionOf(a.id)).billedAt).toBeNull();
    expect((await sessionOf(c.id)).billedAt).toBeNull();

    const paid = await post<{
      stationId: string | null;
      totalCents: number;
      collected: { sessionId: string; totalCents: number }[];
    }>('/sessions/collect-all', {
      paymentMethod: 'cash',
      payments: [{ method: 'cash', amountCents: 375 }],
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.stationId).toBeNull();
    expect(paid.body.totalCents).toBe(375);
    expect(paid.body.collected).toHaveLength(4);
    const ids = paid.body.collected.map((x) => x.sessionId);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    expect((await counts()).total - before.total).toBe(375);
    expect((await sessionOf(a.id)).billedAt).not.toBeNull();
    expect((await sessionOf(c.id)).billedAt).not.toBeNull();
    expect(await awaitingAt(pc5)).toBe(0);
    expect(await awaitingAt(pc6)).toBe(0);
    expect(await awaitingAt(pc3)).toBe(0);

    // Nothing left anywhere: refused, and no tender is taken.
    const settled = await counts();
    const again = await post<{ error: { message: string } }>('/sessions/collect-all', {
      paymentMethod: 'cash',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('No bill is waiting at any PC');
    expect(await counts()).toEqual(settled);
  });
});
