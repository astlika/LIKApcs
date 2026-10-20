/**
 * Removing minutes from a running session (0.20.11, `POST /sessions/:id/remove-time`). No money
 * moves: a prepaid session keeps what was paid, a pay-at-the-end session gets a smaller reservation
 * by the price of the removed minutes. At least one minute must stay, postpaid sessions are refused,
 * and a repeated request (same clientRequestId) does not remove twice. The clock is faked (Date
 * only) so durations are exact.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  LoginResponse,
  PricingRuleSummary,
  SessionMutationResponse,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);

describe('removing minutes from a running session', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let pc: Record<'prepaid' | 'repeat' | 'endpay' | 'postpaid' | 'dup', StationSummary>;
  let postpaidSessionId = '';
  const H = () => authHeader(owner.token);

  const post = <T>(url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: H(), payload }).then((r) => ({
      status: r.statusCode,
      body: r.json<T>(),
    }));
  const money = async () => {
    const sales = await ctx.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sales');
    const payments = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM payments',
    );
    return { sales: Number(sales.rows[0]!.n), payments: Number(payments.rows[0]!.n) };
  };
  const at = (date: Date) => vi.setSystemTime(date);
  const plusMinutes = (minutes: number, base: Date = T0) =>
    new Date(base.getTime() + minutes * 60_000);

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    const make = async (number: number, name: string) =>
      (await post<StationSummary>('/stations', { number, name })).body;
    pc = {
      prepaid: await make(1, 'Arena 1'),
      repeat: await make(2, 'Arena 2'),
      endpay: await make(3, 'Arena 3'),
      postpaid: await make(4, 'Arena 4'),
      dup: await make(5, 'Arena 5'),
    };
    expect((await post('/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    const ruleRes = await post<PricingRuleSummary>('/pricing/rules', {
      name: 'Standard',
      rateCentsPerHour: 150,
      billingIncrementMinutes: 1,
    });
    expect(ruleRes.status).toBe(201);
  }, 30_000);

  afterEach(() => at(T0));
  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('takes minutes off a prepaid session: the end moves, the paid price and the money stay', async () => {
    const started = await post<SessionMutationResponse>('/sessions', {
      stationId: pc.prepaid.id,
      billingMode: 'prepaid',
      minutes: 60,
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(started.status).toBe(201);
    const id = started.body.session.id;
    expect(started.body.session).toMatchObject({ quotedPriceCents: 150, plannedSeconds: 3600 });
    const before = await money();

    at(plusMinutes(10));
    const removed = await post<SessionMutationResponse>(`/sessions/${id}/remove-time`, {
      minutes: 20,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.session).toMatchObject({ quotedPriceCents: 150, plannedSeconds: 2400 });
    // Started at T0 for 60 min; 20 removed → the session now ends at T0 + 40.
    expect(removed.body.session.endsAt).toBe(plusMinutes(40).toISOString());
    expect(removed.body.payment ?? null).toBeNull();
    expect(await money()).toEqual(before);
  });

  it('keeps at least one minute: at most the time left minus one minute can go', async () => {
    const started = await post<SessionMutationResponse>('/sessions', {
      stationId: pc.repeat.id,
      billingMode: 'prepaid',
      minutes: 60,
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    const id = started.body.session.id;
    // At T0 + 10 the session has 50 minutes left: 50 is refused, 49 is fine.
    at(plusMinutes(10));
    const tooMany = await post(`/sessions/${id}/remove-time`, { minutes: 50 });
    expect(tooMany.status).toBe(409);
    expect(JSON.stringify(tooMany.body)).toContain('"maxMinutes":49');

    const ok = await post<SessionMutationResponse>(`/sessions/${id}/remove-time`, { minutes: 49 });
    expect(ok.status).toBe(200);
    expect(ok.body.session.status).toBe('active');
    expect(ok.body.session.endsAt).toBe(plusMinutes(11).toISOString());
  });

  it('a repeated request with the same clientRequestId removes the minutes once', async () => {
    const started = await post<SessionMutationResponse>('/sessions', {
      stationId: pc.dup.id,
      billingMode: 'prepaid',
      minutes: 60,
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(started.status).toBe(201);
    const id = started.body.session.id;
    at(plusMinutes(5));
    const body = { minutes: 10, clientRequestId: 'remove-once-0001' };
    const first = await post<SessionMutationResponse>(`/sessions/${id}/remove-time`, body);
    const again = await post<SessionMutationResponse>(`/sessions/${id}/remove-time`, body);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.session.plannedSeconds).toBe(3000);
    expect(again.body.session.endsAt).toBe(first.body.session.endsAt);
    expect(first.body.session.endsAt).toBe(plusMinutes(50).toISOString());
  });

  it('pay at the end: the reservation shrinks by the price of the removed minutes', async () => {
    const started = await post<SessionMutationResponse>('/sessions', {
      stationId: pc.endpay.id,
      billingMode: 'endpay',
      minutes: 60,
    });
    expect(started.status).toBe(201);
    const id = started.body.session.id;
    expect(started.body.session).toMatchObject({ quotedPriceCents: 150 });
    const before = await money();

    at(plusMinutes(10));
    // 30 of the 50 minutes left are worth €0.75 at €1.50 per hour.
    const removed = await post<SessionMutationResponse>(`/sessions/${id}/remove-time`, {
      minutes: 30,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.session).toMatchObject({ quotedPriceCents: 75, plannedSeconds: 1800 });
    expect(removed.body.session.endsAt).toBe(plusMinutes(30).toISOString());
    expect(await money()).toEqual(before);
  });

  it('postpaid sessions run until stopped, so there is nothing to remove', async () => {
    const started = await post<SessionMutationResponse>('/sessions', {
      stationId: pc.postpaid.id,
      billingMode: 'postpaid',
    });
    expect(started.status).toBe(201);
    postpaidSessionId = started.body.session.id;
    const removed = await post(`/sessions/${postpaidSessionId}/remove-time`, { minutes: 5 });
    expect(removed.status).toBe(409);
  });

  it('rejects a bad minute count before touching the session', async () => {
    const zero = await post(`/sessions/${postpaidSessionId}/remove-time`, { minutes: 0 });
    expect(zero.status).toBe(400);
  });
});
