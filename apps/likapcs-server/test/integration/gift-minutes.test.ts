/**
 * 0.18.0 — gift minutes (free, prepaid only, audited), bulk "+ minutes" across a multi-selection
 * with a per-PC outcome, the grouped debts view (one row per customer) and the new POS setting
 * default (hide sold-out products).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  BulkMinutesResult,
  CustomerSummary,
  DebtCustomerGroup,
  LoginResponse,
  PricingRuleSummary,
  ProductSummary,
  SessionMutationResponse,
  SettingsMap,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

// Like sessions.test: freeze time at "now" — a fixed past date would make freshly issued tokens
// look expired against the database clock.
const T0 = Math.floor(Date.now() / 60_000) * 60_000;
const at = (ms: number) => vi.setSystemTime(new Date(ms));

describe('gift minutes & bulk +minutes', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let a: StationSummary;
  let b: StationSummary;
  let c: StationSummary;
  let rule: PricingRuleSummary;

  const call = <T>(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: Record<string, unknown>,
    token = owner.token,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({ status: r.statusCode, body: (r.statusCode === 204 ? null : r.json()) as T }));

  const startPrepaid = (stationId: string, minutes: number, tag: string) =>
    call<SessionMutationResponse>('POST', '/sessions', {
      stationId,
      billingMode: 'prepaid',
      minutes,
      paymentMethod: 'cash',
      clientRequestId: `req-${tag}`,
    });

  const salesCount = async () =>
    Number(
      (await ctx.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sales')).rows[0]!.n,
    );

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    a = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'Arena 1' })).body;
    b = (await call<StationSummary>('POST', '/stations', { number: 2, name: 'Arena 2' })).body;
    c = (await call<StationSummary>('POST', '/stations', { number: 3, name: 'Arena 3' })).body;
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    rule = (
      await call<PricingRuleSummary>('POST', '/pricing/rules', {
        name: 'Standard',
        rateCentsPerHour: 600,
        billingIncrementMinutes: 1,
      })
    ).body;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('gifts free minutes on a prepaid session: time grows, money does not, audit remembers', async () => {
    const started = await startPrepaid(a.id, 30, 'gift-0001');
    expect(started.status).toBe(201);
    const session = started.body.session;
    const salesBefore = await salesCount();

    const gifted = await call<SessionMutationResponse>('POST', `/sessions/${session.id}/gift`, {
      minutes: 5,
      reason: 'sorry for the wait',
    });
    expect(gifted.status).toBe(200);
    expect(gifted.body.session.plannedSeconds).toBe(2100);
    const before = session.endsAt ? Date.parse(session.endsAt) : 0;
    const after = gifted.body.session.endsAt ? Date.parse(gifted.body.session.endsAt) : 0;
    expect(after - before).toBe(5 * 60_000);
    // Free means free: no new sale, and the session price did not move.
    expect(await salesCount()).toBe(salesBefore);
    expect(gifted.body.session.quotedPriceCents).toBe(session.quotedPriceCents);
    expect(gifted.body.payment).toBeNull();

    const events = await call<{ eventType: string; payload: Record<string, unknown> }[]>(
      'GET',
      `/sessions/${session.id}/events`,
    );
    const giftEvent = events.body.find((e) => e.payload?.gift === true);
    expect(giftEvent?.eventType).toBe('extended');
    expect(giftEvent?.payload).toMatchObject({ minutes: 5, priceCents: 0, gift: true });

    const audit = await ctx.pool.query(
      `SELECT details FROM audit_logs WHERE action = 'session.gift' AND entity_id = $1`,
      [session.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].details).toMatchObject({ minutes: 5, reason: 'sorry for the wait' });
  });

  it('refuses gifts on postpaid sessions (elapsed-time billing would charge the "free" minutes)', async () => {
    const postpaid = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: b.id,
      billingMode: 'postpaid',
      clientRequestId: 'req-postpaid-0001',
    });
    expect(postpaid.status).toBe(201);
    const gifted = await call<{ error: { code: string } }>(
      'POST',
      `/sessions/${postpaid.body.session.id}/gift`,
      { minutes: 5 },
    );
    expect(gifted.status).toBe(409);
    expect(rule.name).toBe('Standard');
  });

  it('bulk gift: applies to live prepaid sessions, reports every skip with a reason', async () => {
    // a = prepaid live, b = postpaid live, c = idle
    const result = (
      await call<BulkMinutesResult>('POST', '/sessions/bulk-minutes', {
        stationIds: [a.id, b.id, c.id],
        minutes: 10,
        gift: true,
        reason: 'tournament bonus',
      })
    ).body;
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ stationId: a.id, minutes: 10, priceCents: 0 });
    expect(result.totalCents).toBe(0);
    const skipped = Object.fromEntries(result.skipped.map((s) => [s.stationId, s.reason]));
    expect(skipped[b.id]).toBe('not_extendable');
    expect(skipped[c.id]).toBe('no_active_session');

    const audit = await ctx.pool.query(
      `SELECT details FROM audit_logs WHERE action = 'station.bulk_minutes' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0].details).toMatchObject({ gift: true, applied: 1, skipped: 2 });
  });

  it('bulk paid: every live session gets its own cash sale at the quoted price', async () => {
    const startedC = await startPrepaid(c.id, 30, 'bulk-0002');
    expect(startedC.status).toBe(201);
    const salesBefore = await salesCount();

    const result = (
      await call<BulkMinutesResult>('POST', '/sessions/bulk-minutes', {
        stationIds: [a.id, c.id],
        minutes: 15,
        gift: false,
      })
    ).body;
    expect(result.applied).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    // 600 cents/hour → 15 min = 150 cents per station.
    expect(result.totalCents).toBe(300);
    expect(result.applied.every((x) => x.priceCents === 150)).toBe(true);
    expect(await salesCount()).toBe(salesBefore + 2);
  });

  it('groups debts by customer: one row with the open total, searchable by name', async () => {
    const customer = (
      await call<CustomerSummary>('POST', '/customers', {
        name: 'Arben Krasniqi',
        phone: '044111222',
        creditLimitCents: 5000,
      })
    ).body;
    const cola = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Coca-Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 10_000,
      })
    ).body;
    const sale = await call('POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 2000 }],
      customerId: customer.id,
      payments: [{ method: 'credit', amountCents: 300 }],
    });
    expect(sale.status).toBe(201);

    const groups = (await call<DebtCustomerGroup[]>('GET', '/debts/by-customer')).body;
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      customerId: customer.id,
      name: 'Arben Krasniqi',
      totalCents: 300,
      count: 1,
    });
    expect(groups[0]?.oldestDue).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const found = (await call<DebtCustomerGroup[]>('GET', '/debts/by-customer?q=arben')).body;
    expect(found).toHaveLength(1);
    const missed = (await call<DebtCustomerGroup[]>('GET', '/debts/by-customer?q=zzz')).body;
    expect(missed).toHaveLength(0);
  });

  it('defaults the POS grid to hiding sold-out products', async () => {
    const settings = (await call<SettingsMap>('GET', '/settings')).body;
    expect(settings['pos.hide_out_of_stock']).toBe(true);
    const patched = await call<SettingsMap>('PATCH', '/settings', {
      'pos.hide_out_of_stock': false,
    });
    expect(patched.status).toBe(200);
    expect(patched.body['pos.hide_out_of_stock']).toBe(false);
  });
});
