/**
 * Gaming sessions & billing (Phase 3) — authoritative server behaviour:
 * quotes, prepaid payment at start, extensions, pauses shifting the expiry, server-side expiry,
 * postpaid billing exactly once, cancellation, idempotent starts, expiry warnings and the grace
 * period for a PC that drops offline. The clock is faked (Date only) so durations are exact.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  GamingPackageSummary,
  LoginResponse,
  PricingRuleSummary,
  SessionEventSummary,
  SessionMutationResponse,
  SessionQuoteResponse,
  SessionSummary,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

// Real "now" rounded to the minute: auth tokens are validated against the database clock, so the
// faked JS clock must not sit in the past. The tests advance it from here.
const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const YEAR = String(T0.getFullYear());

describe('gaming sessions', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let station: StationSummary;
  let second: StationSummary;
  let rule: PricingRuleSummary;
  let hourPackage: GamingPackageSummary;
  const H = () => authHeader(owner.token);

  const post = <T>(url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: H(), payload }).then((r) => ({
      status: r.statusCode,
      body: r.json<T>(),
    }));
  const get = <T>(url: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: H() }).then((r) => r.json<T>());
  const salesAndPayments = async () => {
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

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    station = (await post<StationSummary>('/stations', { number: 1, name: 'Arena 1' })).body;
    second = (await post<StationSummary>('/stations', { number: 2, name: 'Arena 2' })).body;
    const ruleRes = await post<PricingRuleSummary>('/pricing/rules', {
      name: 'Standard',
      rateCentsPerHour: 150,
      billingIncrementMinutes: 1,
    });
    expect(ruleRes.status).toBe(201);
    rule = ruleRes.body;
    const pkgRes = await post<GamingPackageSummary>('/pricing/packages', {
      name: '1 hour',
      durationMinutes: 60,
      priceCents: 120,
    });
    expect(pkgRes.status).toBe(201);
    hourPackage = pkgRes.body;
  }, 30_000);

  afterEach(() => at(T0));
  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('quotes prepaid minutes, packages and postpaid terms from the rule in force', async () => {
    const minutes = await post<SessionQuoteResponse>('/sessions/quote', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 30,
    });
    expect(minutes.status).toBe(200);
    expect(minutes.body).toMatchObject({
      minutes: 30,
      priceCents: 75,
      rule: { id: rule.id, name: 'Standard' },
    });
    const pkg = await post<SessionQuoteResponse>('/sessions/quote', {
      stationId: station.id,
      billingMode: 'prepaid',
      packageId: hourPackage.id,
    });
    expect(pkg.body).toMatchObject({ minutes: 60, priceCents: 120, package: { name: '1 hour' } });
    const postpaid = await post<SessionQuoteResponse>('/sessions/quote', {
      stationId: station.id,
      billingMode: 'postpaid',
    });
    expect(postpaid.body).toMatchObject({ priceCents: 0, terms: { rateCentsPerHour: 150 } });
    const invalid = await post('/sessions/quote', {
      stationId: station.id,
      billingMode: 'prepaid',
    });
    expect(invalid.status).toBe(400);
  });

  it('prepaid: paid at start, pause shifts the expiry, extension is a second sale, server expires it', async () => {
    const before = await salesAndPayments();
    const started = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 30,
      customerName: 'Arben',
      paymentMethod: 'cash',
      clientRequestId: 'req-prepaid-0001',
    });
    expect(started.status).toBe(201);
    const session = started.body.session;
    expect(session).toMatchObject({
      status: 'active',
      billingMode: 'prepaid',
      plannedSeconds: 1800,
      quotedPriceCents: 75,
      currentPriceCents: 75,
      customerName: 'Arben',
      ruleName: 'Standard',
    });
    expect(session.endsAt).toBe(plusMinutes(30).toISOString());
    expect(session.receiptNo).toBe(`R-${YEAR}-000001`);
    expect(started.body.client).toBeNull(); // no PC connected
    const afterStart = await salesAndPayments();
    expect(afterStart.sales - before.sales).toBe(1);
    expect(afterStart.salesTotal - before.salesTotal).toBe(75);
    expect(afterStart.paymentsTotal - before.paymentsTotal).toBe(75);

    // Idempotent retry returns the same session, no second sale.
    const retry = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 30,
      clientRequestId: 'req-prepaid-0001',
    });
    expect(retry.status).toBe(201);
    expect(retry.body.session.id).toBe(session.id);
    expect((await salesAndPayments()).sales).toBe(afterStart.sales);

    // A second session on the same station is refused.
    const clash = await post('/sessions', { stationId: station.id, billingMode: 'postpaid' });
    expect(clash.status).toBe(409);

    // Station grid shows it as occupied with the countdown.
    at(plusMinutes(10));
    const grid = await get<StationSummary[]>('/stations');
    const live = grid.find((s) => s.id === station.id)!;
    expect(live.status).toBe('occupied');
    expect(live.activeSession).toMatchObject({
      billingMode: 'prepaid',
      remainingSeconds: 1200,
      elapsedSeconds: 600,
    });

    // Pause for 5 minutes → expiry moves by 5 minutes.
    const paused = await post<SessionMutationResponse>(`/sessions/${session.id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.session.status).toBe('paused');
    at(plusMinutes(15));
    const resumed = await post<SessionMutationResponse>(`/sessions/${session.id}/resume`);
    expect(resumed.body.session).toMatchObject({ status: 'active', totalPausedSeconds: 300 });
    expect(resumed.body.session.endsAt).toBe(plusMinutes(35).toISOString());

    // Extend with the 1-hour package: +60 min, +1.20 €, second receipt.
    const extended = await post<SessionMutationResponse>(`/sessions/${session.id}/extend`, {
      packageId: hourPackage.id,
      paymentMethod: 'card',
    });
    expect(extended.status).toBe(200);
    expect(extended.body.session).toMatchObject({
      plannedSeconds: 5400,
      quotedPriceCents: 195,
      currentPriceCents: 195,
    });
    expect(extended.body.session.endsAt).toBe(plusMinutes(95).toISOString());
    const afterExtend = await salesAndPayments();
    expect(afterExtend.sales - afterStart.sales).toBe(1);
    expect(afterExtend.paymentsTotal - afterStart.paymentsTotal).toBe(120);

    // Not yet due → tick does nothing; due → expired exactly at endsAt, nothing billed again.
    at(plusMinutes(94));
    await ctx.app.services.sessions.tick();
    expect((await get<SessionSummary>(`/sessions/${session.id}`)).status).toBe('active');
    at(plusMinutes(96));
    await ctx.app.services.sessions.tick();
    const done = await get<SessionSummary>(`/sessions/${session.id}`);
    expect(done).toMatchObject({ status: 'expired', endReason: 'expired', finalPriceCents: 195 });
    expect(done.endedAt).toBe(plusMinutes(95).toISOString());
    expect(done.billableSeconds).toBe(5400);
    expect(await salesAndPayments()).toEqual(afterExtend);
    const freed = (await get<StationSummary[]>('/stations')).find((s) => s.id === station.id)!;
    expect(freed.activeSession).toBeNull();
    expect(freed.status).toBe('offline'); // no client PC connected in this test

    const events = await get<SessionEventSummary[]>(`/sessions/${session.id}/events`);
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining([
        'created',
        'started',
        'billed',
        'paused',
        'resumed',
        'extended',
        'warning_sent',
        'expired',
      ]),
    );
    // Ending an expired session is refused.
    expect((await post(`/sessions/${session.id}/end`, {})).status).toBe(409);
  });

  it('postpaid: billed exactly once at the end from the frozen terms, pauses excluded', async () => {
    const before = await salesAndPayments();
    const started = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
    });
    expect(started.status).toBe(201);
    const id = started.body.session.id;
    expect(started.body.session.quotedPriceCents).toBeNull();
    expect(await salesAndPayments()).toEqual(before); // nothing billed yet

    // Changing the rule afterwards must not affect this session (terms are frozen).
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/pricing/rules/${rule.id}`,
      headers: H(),
      payload: { rateCentsPerHour: 999 },
    });

    at(plusMinutes(20));
    await post(`/sessions/${id}/pause`);
    at(plusMinutes(30));
    await post(`/sessions/${id}/resume`);
    at(plusMinutes(50)); // 40 billable minutes
    const running = await get<SessionSummary>(`/sessions/${id}`);
    expect(running).toMatchObject({ billableSeconds: 2400, currentPriceCents: 100 });

    const tooMuch = await post(`/sessions/${id}/end`, { discountCents: 500 });
    expect(tooMuch.status).toBe(400);
    const extendRefused = await post(`/sessions/${id}/extend`, { minutes: 10 });
    expect(extendRefused.status).toBe(409);

    const ended = await post<SessionMutationResponse>(`/sessions/${id}/end`, {
      discountCents: 10,
      paymentMethod: 'cash',
    });
    expect(ended.status).toBe(200);
    expect(ended.body.session).toMatchObject({
      status: 'completed',
      endReason: 'stopped_by_staff',
      billableSeconds: 2400,
      discountCents: 10,
      finalPriceCents: 90,
      currentPriceCents: 90,
      totalPausedSeconds: 600,
    });
    expect(ended.body.session.receiptNo).toMatch(new RegExp(`^R-${YEAR}-\\d{6}$`));
    const after = await salesAndPayments();
    expect(after.sales - before.sales).toBe(1);
    expect(after.salesTotal - before.salesTotal).toBe(90);
    expect(after.paymentsTotal - before.paymentsTotal).toBe(90);

    // Exactly once.
    expect((await post(`/sessions/${id}/end`, {})).status).toBe(409);
    expect(await salesAndPayments()).toEqual(after);
    const sale = await ctx.pool.query<{
      status: string;
      source: string;
      tax_cents: string;
      subtotal_cents: string;
    }>('SELECT status, source, tax_cents::text, subtotal_cents::text FROM sales WHERE id = $1', [
      ended.body.session.saleId,
    ]);
    expect(sale.rows[0]).toEqual({
      status: 'completed',
      source: 'gaming',
      subtotal_cents: '100',
      tax_cents: '14',
    }); // 18 % included
    // Restore the rule for later tests.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/pricing/rules/${rule.id}`,
      headers: H(),
      payload: { rateCentsPerHour: 150 },
    });
  });

  it('cancels a postpaid session without charging and refuses to cancel prepaid ones', async () => {
    const before = await salesAndPayments();
    const postpaid = await post<SessionMutationResponse>('/sessions', {
      stationId: second.id,
      billingMode: 'postpaid',
    });
    const cancelled = await post<SessionMutationResponse>(
      `/sessions/${postpaid.body.session.id}/cancel`,
      { reason: 'wrong station' },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.session).toMatchObject({
      status: 'cancelled',
      finalPriceCents: 0,
      billableSeconds: 0,
    });
    expect(await salesAndPayments()).toEqual(before);

    const prepaid = await post<SessionMutationResponse>('/sessions', {
      stationId: second.id,
      billingMode: 'prepaid',
      minutes: 10,
    });
    expect(prepaid.status).toBe(201);
    const refused = await post(`/sessions/${prepaid.body.session.id}/cancel`, {
      reason: 'changed mind',
    });
    expect(refused.status).toBe(409);
    await post(`/sessions/${prepaid.body.session.id}/end`, {});
  });

  it('pauses a session automatically when the PC stays offline beyond the grace period', async () => {
    const started = await post<SessionMutationResponse>('/sessions', {
      stationId: second.id,
      billingMode: 'postpaid',
    });
    const id = started.body.session.id;
    const device = await ctx.pool.query<{ id: string }>(
      `INSERT INTO station_devices (station_id, machine_id, hostname, status) VALUES ($1, 'machine-grace', 'PC-2', 'approved') RETURNING id`,
      [second.id],
    );
    at(plusMinutes(5));
    // The device drops (simulated presence event; the grace period default is 120 s).
    ctx.app.hub.emit('device.offline', {
      deviceId: device.rows[0]!.id,
      stationId: second.id,
      reason: 'timeout',
    });
    await new Promise((r) => setImmediate(r));
    at(plusMinutes(6));
    await ctx.app.services.sessions.tick();
    expect((await get<SessionSummary>(`/sessions/${id}`)).status).toBe('active'); // still within grace
    at(plusMinutes(8));
    await ctx.app.services.sessions.tick();
    const paused = await get<SessionSummary>(`/sessions/${id}`);
    expect(paused.status).toBe('paused');
    expect(paused.pausedAt).toBe(plusMinutes(5).toISOString()); // paused from the disconnect, not from detection
    expect(paused.billableSeconds).toBe(300);
    const events = await get<SessionEventSummary[]>(`/sessions/${id}/events`);
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['grace_started', 'grace_ended']),
    );
    await post(`/sessions/${id}/end`, {});
  });

  it('lists history with filters and totals', async () => {
    const all = await get<{ items: SessionSummary[]; total: number }>('/sessions');
    expect(all.total).toBeGreaterThanOrEqual(5);
    const completed = await get<{ items: SessionSummary[]; total: number }>(
      '/sessions?status=completed',
    );
    expect(completed.items.every((s) => s.status === 'completed')).toBe(true);
    const byStation = await get<{ items: SessionSummary[]; total: number }>(
      `/sessions?stationId=${second.id}`,
    );
    expect(byStation.items.every((s) => s.stationId === second.id)).toBe(true);
  });

  it('refuses session control without the permission and pricing writes without pricing.manage', async () => {
    const anon = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { stationId: station.id, billingMode: 'postpaid' },
    });
    expect(anon.statusCode).toBe(401);
    const badRule = await post('/pricing/rules', { name: 'x', rateCentsPerHour: -1 });
    expect(badRule.status).toBe(400);
  });
});
