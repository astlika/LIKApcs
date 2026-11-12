/**
 * 0.19.0 — cart stations ("sell time now, the PC starts later"). A till sale of PC time creates a
 * time credit for that PC; starting or extending a session there redeems minutes from it — no new
 * sale, no second payment. A credit is all-or-nothing per request, bound to one PC, and a refund is
 * refused once any of its minutes were used (migration 0031).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  LoginResponse,
  SaleDetail,
  SessionMutationResponse,
  SessionQuoteResponse,
  StationSummary,
  TimeCreditSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

// Like gift-minutes: a frozen clock — sessions never run down during the test.
const T0 = Math.floor(Date.now() / 60_000) * 60_000;

describe('cart stations: PC time sold at the till', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let a: StationSummary;
  let b: StationSummary;
  let c: StationSummary;

  const call = <T>(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({ status: r.statusCode, body: (r.statusCode === 204 ? null : r.json()) as T }));

  const credits = async (stationId?: string) =>
    (
      await call<{ credits: TimeCreditSummary[] }>(
        'GET',
        `/time-credits${stationId ? `?stationId=${stationId}` : ''}`,
      )
    ).body.credits;

  const creditRow = async (stationId: string) =>
    (
      await ctx.pool.query<{
        minutes_total: number;
        minutes_remaining: number;
        cancelled_at: Date | null;
      }>(
        'SELECT minutes_total, minutes_remaining, cancelled_at FROM time_credits WHERE station_id = $1 ORDER BY created_at DESC LIMIT 1',
        [stationId],
      )
    ).rows[0]!;

  const salesCount = async () =>
    Number(
      (await ctx.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sales')).rows[0]!.n,
    );

  /** Sells `minutes` on a PC for the amount the server quotes. */
  const sellTime = (stationId: string, minutes: number) =>
    call<SaleDetail>('POST', '/sales', {
      items: [{ stationId, minutes }],
      payments: [{ method: 'cash', amountCents: 100_000 }],
    });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0));
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    a = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'Arena 1' })).body;
    b = (await call<StationSummary>('POST', '/stations', { number: 2, name: 'Arena 2' })).body;
    c = (await call<StationSummary>('POST', '/stations', { number: 3, name: 'Arena 3' })).body;
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    await call('POST', '/pricing/rules', {
      name: 'Standard',
      rateCentsPerHour: 600,
      billingIncrementMinutes: 1,
    });
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('a till sale of PC time is priced by the station and creates one open credit', async () => {
    const quote = await call<SessionQuoteResponse>('POST', '/sessions/quote', {
      stationId: a.id,
      billingMode: 'prepaid',
      minutes: 60,
    });
    const sale = await sellTime(a.id, 60);
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(quote.body.priceCents);

    const line = sale.body.items[0]!;
    expect(line.description).toBe(`${a.code} · 60 min`);
    const row = (
      await ctx.pool.query<{ product_id: string | null; cost_cents: string }>(
        'SELECT product_id, cost_cents::text FROM sale_items WHERE id = $1',
        [line.id],
      )
    ).rows[0]!;
    expect(row).toEqual({ product_id: null, cost_cents: '0' });

    const open = await credits(a.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ stationId: a.id, minutesTotal: 60, minutesRemaining: 60 });
  });

  it('starting the PC with a credit: no new sale, nothing billed again, the minutes are taken', async () => {
    const before = await salesCount();
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: a.id,
      billingMode: 'prepaid',
      minutes: 60,
      creditId: (await credits(a.id))[0]!.id,
    });
    expect(started.status).toBe(201);
    expect(started.body.session).toMatchObject({
      billingMode: 'prepaid',
      plannedSeconds: 3600,
      quotedPriceCents: 0,
    });
    expect(await salesCount()).toBe(before);
    expect(await credits(a.id)).toEqual([]);
    expect((await creditRow(a.id)).minutes_remaining).toBe(0);
  });

  it('a credit that cannot cover the minutes asked is refused and nothing is taken', async () => {
    expect((await sellTime(b.id, 30)).status).toBe(201);
    const id = (await credits(b.id))[0]!.id;
    const refused = await call('POST', '/sessions', {
      stationId: b.id,
      billingMode: 'prepaid',
      minutes: 60,
      creditId: id,
    });
    expect(refused.status).toBe(409);
    expect((await creditRow(b.id)).minutes_remaining).toBe(30);
  });

  it('a credit belongs to the PC it was sold for', async () => {
    const id = (await credits(b.id))[0]!.id;
    const other = await call('POST', '/sessions', {
      stationId: c.id,
      billingMode: 'prepaid',
      minutes: 30,
      creditId: id,
    });
    expect(other.status).toBe(400);
    expect((await creditRow(b.id)).minutes_remaining).toBe(30);
    const running = await ctx.pool.query('SELECT 1 FROM gaming_sessions WHERE station_id = $1', [
      c.id,
    ]);
    expect(running.rowCount).toBe(0);
  });

  it('a partly used credit cannot be refunded; an extension takes minutes from it too', async () => {
    const sale = await sellTime(c.id, 60);
    expect(sale.status).toBe(201);
    const creditId = (await credits(c.id))[0]!.id;
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: c.id,
      billingMode: 'prepaid',
      minutes: 20,
      creditId,
    });
    expect(started.status).toBe(201);
    expect((await creditRow(c.id)).minutes_remaining).toBe(40);

    const refund = await call('POST', `/sales/${sale.body.id}/refund`, {
      items: [{ saleItemId: sale.body.items[0]!.id, quantityMilli: 1000 }],
      reason: 'Customer changed mind',
      restock: false,
    });
    expect(refund.status).toBe(409);
    expect((await creditRow(c.id)).cancelled_at).toBeNull();

    const sessionId = started.body.session.id;
    const before = await salesCount();
    const extended = await call<SessionMutationResponse>('POST', `/sessions/${sessionId}/extend`, {
      minutes: 10,
      creditId,
    });
    expect(extended.status).toBe(200);
    expect(extended.body.session.plannedSeconds).toBe(30 * 60);
    expect(await salesCount()).toBe(before);
    expect((await creditRow(c.id)).minutes_remaining).toBe(30);
  });

  it('refunding an unused time line cancels its credit', async () => {
    const sale = await sellTime(a.id, 30);
    expect(sale.status).toBe(201);
    expect(await credits(a.id)).toHaveLength(1);
    const refund = await call<SaleDetail>('POST', `/sales/${sale.body.id}/refund`, {
      items: [{ saleItemId: sale.body.items[0]!.id, quantityMilli: 1000 }],
      reason: 'Wrong PC',
      restock: false,
    });
    expect(refund.status).toBe(200);
    expect(await credits(a.id)).toEqual([]);
    expect((await creditRow(a.id)).cancelled_at).not.toBeNull();
  });

  it('PC time cannot be parked: it is paid and credited only when the sale completes', async () => {
    const before = await salesCount();
    const parked = await call('POST', '/sales/suspend', {
      items: [{ stationId: a.id, minutes: 30 }],
    });
    expect(parked.status).toBe(409);
    expect(parked.body).toMatchObject({
      error: { code: 'conflict', details: { code: 'TIME_NOT_PARKABLE' } },
    });
    expect(await salesCount()).toBe(before);
  });

  it('invalid time lines are refused before anything is written', async () => {
    const before = await salesCount();
    for (const item of [
      { stationId: a.id, minutes: 0 },
      { stationId: a.id, minutes: 24 * 60 + 1 },
      { stationId: 'not-a-uuid', minutes: 30 },
    ]) {
      const r = await call('POST', '/sales', {
        items: [item],
        payments: [{ method: 'cash', amountCents: 100_000 }],
      });
      expect(r.status).toBe(400);
    }
    const unknown = await call('POST', '/sales', {
      items: [{ stationId: '00000000-0000-4000-8000-000000000000', minutes: 30 }],
      payments: [{ method: 'cash', amountCents: 100_000 }],
    });
    expect(unknown.status).toBe(404);
    expect(await salesCount()).toBe(before);
  });
});
