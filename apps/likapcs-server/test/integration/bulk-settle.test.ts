/**
 * Fixed payment and discount for several PCs at once (`POST /sessions/bulk-settle`, 0.23.0).
 * Pay-at-the-end sessions are ended and collected with the discount that gives the wanted amount;
 * prepaid sessions get a price change instead (0.27.0, needs pos.adjust_paid, which owner has);
 * a fixed amount above the bill is refused and nothing is billed.
 * The clock is faked (Date only) so the bills are exact: 150 cents per hour, 30 minutes = 75 cents.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  BulkSettleResult,
  LoginResponse,
  PricingRuleSummary,
  SessionMutationResponse,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);

describe('fixed payment and discount for several PCs', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  const H = () => authHeader(owner.token);

  const post = <T>(url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: H(), payload }).then((r) => ({
      status: r.statusCode,
      body: r.json<T>(),
    }));
  const get = <T>(url: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: H() }).then((r) => r.json<T>());
  const sales = async () =>
    Number(
      (await ctx.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sales')).rows[0]!.n,
    );

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
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

  it('settles pay-at-the-end bills and changes prepaid bills, and refuses a fixed amount above the bill', async () => {
    const make = async (number: number) =>
      (await post<StationSummary>('/stations', { number, name: `Arena ${number}` })).body;
    const start = async (station: StationSummary, billingMode: 'prepaid' | 'endpay') =>
      (
        await post<SessionMutationResponse>('/sessions', {
          stationId: station.id,
          billingMode,
          minutes: 60,
          ...(billingMode === 'prepaid'
            ? { payments: [{ method: 'cash', amountCents: 150 }] }
            : {}),
        })
      ).body.session.id;

    const a = await make(1);
    const b = await make(2);
    const c = await make(3);
    const d = await make(4);
    const sA = await start(a, 'endpay');
    const sB = await start(b, 'prepaid');
    const sC = await start(c, 'endpay');
    const sD = await start(d, 'endpay');

    // 30 minutes in: each running bill would be 75 cents.
    vi.setSystemTime(new Date(T0.getTime() + 30 * 60_000));
    const before = await sales();

    // Fixed 50 cents: A ends and is billed 50; prepaid B (paid 150) is changed to 50, 100 given back.
    const fixed = await post<BulkSettleResult>('/sessions/bulk-settle', {
      sessionIds: [sA, sB],
      mode: 'fixed',
      amountCents: 50,
    });
    expect(fixed.status).toBe(200);
    expect(fixed.body.settled).toBe(2);
    expect(fixed.body.failed).toBe(0);
    expect(fixed.body.results.find((r) => r.sessionId === sA)).toMatchObject({
      ok: true,
      finalCents: 50,
    });
    expect(fixed.body.results.find((r) => r.sessionId === sB)).toMatchObject({
      ok: true,
      finalCents: 50,
    });
    expect((await get<{ billedAt: string | null }>(`/sessions/${sA}`)).billedAt).toBeTruthy();

    // Discount 10 cents: C ends and is billed 75 − 10 = 65.
    const discount = await post<BulkSettleResult>('/sessions/bulk-settle', {
      sessionIds: [sC],
      mode: 'discount',
      amountCents: 10,
    });
    expect(discount.body.results[0]).toMatchObject({ ok: true, finalCents: 65 });

    // Fixed 200 cents is above D's bill of 75: refused. D has ended but is not billed.
    const tooHigh = await post<BulkSettleResult>('/sessions/bulk-settle', {
      sessionIds: [sD],
      mode: 'fixed',
      amountCents: 200,
    });
    expect(tooHigh.body.results[0]?.ok).toBe(false);
    expect(tooHigh.body.results[0]?.error).toContain('above the bill');
    expect((await get<{ billedAt: string | null }>(`/sessions/${sD}`)).billedAt).toBeNull();

    // A and C made sales; B's change is a refund, not a new sale.
    expect((await sales()) - before).toBe(2);
  });
});
