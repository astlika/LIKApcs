/**
 * 0.19.4 — "Ndalo" for several PCs at once (`POST /sessions/bulk-end`).
 *
 * Every running session is stopped the way the single stop does, but nothing is charged now:
 * postpaid and pay-at-the-end bills wait at the desk (collected per PC, "pay all"), prepaid time is
 * already paid and open orders stay open. One session that cannot be stopped (already ended) is
 * reported and does not stop the others.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  BulkEndSessionsResult,
  LoginResponse,
  PricingRuleSummary,
  SessionMutationResponse,
  SessionSummary,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const plusMinutes = (minutes: number, base: Date = T0) =>
  new Date(base.getTime() + minutes * 60_000);

describe('bulk stop: several PCs stopped in one step, nothing charged now', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let pc1: StationSummary;
  let pc2: StationSummary;
  let pc3: StationSummary;
  let pc4: StationSummary;
  /** Session ids from the first test, reused by the later ones. */
  let postpaidId = '';
  let prepaidId = '';

  const H = () => authHeader(owner.token);
  const post = <T>(url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: H(), payload }).then((r) => ({
      status: r.statusCode,
      body: r.json<T>(),
    }));
  const get = <T>(url: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: H() }).then((r) => r.json<T>());
  const sessionOf = (id: string) => get<SessionSummary>(`/sessions/${id}`);
  const awaitingAt = async (station: StationSummary) =>
    (await get<StationSummary[]>('/stations')).find((s) => s.id === station.id)!.awaitingPayment
      .count;
  const salesCount = async () => {
    const r = await ctx.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sales');
    return Number(r.rows[0]!.n);
  };
  const setClock = (date: Date) => vi.setSystemTime(date);

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setClock(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    pc1 = (await post<StationSummary>('/stations', { number: 1, name: 'Arena 1' })).body;
    pc2 = (await post<StationSummary>('/stations', { number: 2, name: 'Arena 2' })).body;
    pc3 = (await post<StationSummary>('/stations', { number: 3, name: 'Arena 3' })).body;
    pc4 = (await post<StationSummary>('/stations', { number: 4, name: 'Arena 4' })).body;
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

  it('stops every running PC at once; postpaid and pay-at-the-end wait at the desk, nothing is sold', async () => {
    setClock(T0);
    const postpaid = await post<SessionMutationResponse>('/sessions', {
      stationId: pc1.id,
      billingMode: 'postpaid',
      customerName: 'Pa kohë',
    });
    expect(postpaid.status).toBe(201);
    const prepaid = await post<SessionMutationResponse>('/sessions', {
      stationId: pc2.id,
      billingMode: 'prepaid',
      minutes: 60,
      paymentMethod: 'cash',
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(prepaid.status).toBe(201);
    postpaidId = postpaid.body.session.id;
    prepaidId = prepaid.body.session.id;
    const endpay = await post<SessionMutationResponse>('/sessions', {
      stationId: pc3.id,
      billingMode: 'endpay',
      minutes: 60,
      customerName: 'Walk-in',
    });
    expect(endpay.status).toBe(201);

    // 30 minutes later the staff press "Ndalo" for the three PCs (pc4 is idle and not selected).
    setClock(plusMinutes(30));
    const salesBefore = await salesCount();
    const res = await post<BulkEndSessionsResult>('/sessions/bulk-end', {
      sessionIds: [postpaid.body.session.id, prepaid.body.session.id, endpay.body.session.id],
    });
    expect(res.status).toBe(200);
    expect(res.body.ended).toBe(3);
    expect(res.body.failed).toBe(0);
    expect(res.body.results.map((r) => r.stationId).sort()).toEqual(
      [pc1.id, pc2.id, pc3.id].sort(),
    );

    // Nothing was charged now.
    expect(await salesCount()).toBe(salesBefore);

    // Postpaid: priced at the time used (30 min at 1.50/h = 75), waiting at the desk.
    const p = await sessionOf(postpaid.body.session.id);
    expect(p.status).toBe('completed');
    expect(p.finalPriceCents).toBe(75);
    expect(p.billedAt).toBeNull();
    expect(p.awaitingPayment).toBe(true);
    expect(await awaitingAt(pc1)).toBe(1);

    // Pay-at-the-end: waits at the desk as before.
    const e = await sessionOf(endpay.body.session.id);
    expect(e.status).toBe('completed');
    expect(e.billedAt).toBeNull();
    expect(e.awaitingPayment).toBe(true);
    expect(await awaitingAt(pc3)).toBe(1);

    // Prepaid: stopped, already paid at the start, nothing waiting.
    const pre = await sessionOf(prepaid.body.session.id);
    expect(pre.status).toBe('completed');
    expect(pre.awaitingPayment).toBe(false);
    expect(await awaitingAt(pc2)).toBe(0);
  });

  it('reports a session that cannot be stopped again, and still ends the others', async () => {
    const already = await sessionOf(prepaidId); // stopped by the bulk stop above
    const running = await post<SessionMutationResponse>('/sessions', {
      stationId: pc4.id,
      billingMode: 'postpaid',
    });
    expect(running.status).toBe(201);
    const res = await post<BulkEndSessionsResult>('/sessions/bulk-end', {
      sessionIds: [already.id, running.body.session.id],
    });
    expect(res.status).toBe(200);
    expect(res.body.ended).toBe(1);
    expect(res.body.failed).toBe(1);
    const failed = res.body.results.find((r) => r.sessionId === already.id)!;
    expect(failed.ok).toBe(false);
    expect(failed.error).toBeTruthy();
    expect((await sessionOf(running.body.session.id)).status).toBe('completed');
  });

  it('the parked bills are collected per PC in one step, like any pay-all', async () => {
    const res = await post<{ totalCents: number }>(`/stations/${pc1.id}/collect-all`, {
      paymentMethod: 'cash',
      payments: [{ method: 'cash', amountCents: 75 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.totalCents).toBe(75);
    const p = await sessionOf(postpaidId);
    expect(p.billedAt).not.toBeNull();
    expect(p.awaitingPayment).toBe(false);
    expect(await awaitingAt(pc1)).toBe(0);
  });

  it('needs the control permission and a non-empty list', async () => {
    const anon = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sessions/bulk-end',
      payload: { sessionIds: [pc1.id] },
    });
    expect(anon.statusCode).toBe(401);
    expect((await post('/sessions/bulk-end', { sessionIds: [] })).status).toBe(400);
  });
});
