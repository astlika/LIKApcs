/**
 * "Zbrit kohën" for several PCs at once (`POST /sessions/bulk-remove-time`): the same minutes come
 * off every selected running session, each session is checked on its own, and the outcome is
 * reported per session. Clock faked (Date only) so the durations are exact.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  BulkRemoveTimeResult,
  LoginResponse,
  PricingRuleSummary,
  SessionMutationResponse,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);

describe('removing minutes from several sessions at once', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let s1 = '';
  let s2 = '';
  const H = () => authHeader(owner.token);

  const post = <T>(url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: H(), payload }).then((r) => ({
      status: r.statusCode,
      body: r.json<T>(),
    }));
  const at = (date: Date) => vi.setSystemTime(date);
  const plusMinutes = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect((await post('/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    expect(
      (
        await post<PricingRuleSummary>('/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 150,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('takes the minutes off each selected session and reports every outcome', async () => {
    const make = async (number: number) =>
      (await post<StationSummary>('/stations', { number, name: `Arena ${number}` })).body;
    const a = await make(1);
    const b = await make(2);
    s1 = (
      await post<SessionMutationResponse>('/sessions', {
        stationId: a.id,
        billingMode: 'prepaid',
        minutes: 60,
        payments: [{ method: 'cash', amountCents: 150 }],
      })
    ).body.session.id;
    s2 = (
      await post<SessionMutationResponse>('/sessions', {
        stationId: b.id,
        billingMode: 'prepaid',
        minutes: 60,
        payments: [{ method: 'cash', amountCents: 150 }],
      })
    ).body.session.id;

    at(plusMinutes(10));
    const unknown = '00000000-0000-4000-8000-000000000000';
    const res = await post<BulkRemoveTimeResult>('/sessions/bulk-remove-time', {
      sessionIds: [s1, s2, unknown],
      minutes: 20,
    });
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.results.find((r) => r.sessionId === unknown)?.ok).toBe(false);

    // 60 min from T0, 20 removed → each session now ends at T0 + 40 and is still running.
    for (const id of [s1, s2]) {
      const row = (
        await ctx.app.inject({ method: 'GET', url: `/api/v1/sessions/${id}`, headers: H() })
      ).json<SessionMutationResponse['session']>();
      expect(row.plannedSeconds).toBe(2400);
      expect(row.endsAt).toBe(plusMinutes(40).toISOString());
      expect(row.status).toBe('active');
    }
  });

  it('a session that cannot give the minutes is refused alone; the others still change', async () => {
    // At T0 + 10: the first session has 30 min left (can give 20); this one started now with 15 min
    // left at most 14 can go, so 20 is refused for it only.
    const c = (await post<StationSummary>('/stations', { number: 3, name: 'Arena 3' })).body;
    const short = (
      await post<SessionMutationResponse>('/sessions', {
        stationId: c.id,
        billingMode: 'prepaid',
        minutes: 15,
        payments: [{ method: 'cash', amountCents: 38 }],
      })
    ).body.session.id;

    const res = await post<BulkRemoveTimeResult>('/sessions/bulk-remove-time', {
      sessionIds: [s1, short],
      minutes: 20,
    });
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.results.find((r) => r.sessionId === short)?.error).toBeTruthy();

    const first = (
      await ctx.app.inject({ method: 'GET', url: `/api/v1/sessions/${s1}`, headers: H() })
    ).json<SessionMutationResponse['session']>();
    expect(first.plannedSeconds).toBe(1200); // 2400 s (40 min) − 20 more minutes
    const second = (
      await ctx.app.inject({ method: 'GET', url: `/api/v1/sessions/${short}`, headers: H() })
    ).json<SessionMutationResponse['session']>();
    expect(second.plannedSeconds).toBe(900); // untouched
  });
});
