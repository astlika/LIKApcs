/**
 * 0.33.1 — a finished customer's name stays on the PC only while the bill is unpaid.
 * 0.33.4 — "paid" includes "put on the customer's tab": a bill taken on credit is settled for the
 * PC, so the PC shows no name and no debt (the debt lives with the customer, under Debts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  CustomerSummary,
  LoginResponse,
  PricingRuleSummary,
  SessionMutationResponse,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);

describe('station name after payment', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let pc: StationSummary;
  let customer: CustomerSummary;

  const call = <T>(method: 'GET' | 'POST', url: string, payload?: unknown) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload: payload as object })
      .then((r) => ({ status: r.statusCode, body: r.body ? (JSON.parse(r.body) as T) : (null as T) }));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    expect(
      (await call<PricingRuleSummary>('POST', '/pricing/rules', { name: 'Standard', rateCentsPerHour: 150, billingIncrementMinutes: 1 }))
        .status,
    ).toBe(201);
    pc = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'Arena 1' })).body;
    customer = (await call<CustomerSummary>('POST', '/customers', { name: 'Ardit Pagues' })).body;
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('keeps the name while the bill is unpaid, removes it after the payment', async () => {
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: pc.id,
      billingMode: 'endpay',
      minutes: 60,
      customerId: customer.id,
    });
    expect(started.status).toBe(201);
    const sessionId = started.body.session.id;

    vi.setSystemTime(new Date(T0.getTime() + 20 * 60_000));
    expect((await call('POST', `/sessions/${sessionId}/end`, {})).status).toBe(200);

    let board = (await call<StationSummary>('GET', `/stations/${pc.id}`)).body;
    expect(board.awaitingPayment.count).toBe(1);
    expect(board.debt.customerName).toBe('Ardit Pagues');

    const due = board.awaitingPayment.amountCents;
    expect(due).toBeGreaterThan(0);
    const collected = await call('POST', `/sessions/${sessionId}/collect`, {
      paymentMethod: 'cash',
      payments: [{ method: 'cash', amountCents: due }],
    });
    expect(collected.status).toBe(200);

    board = (await call<StationSummary>('GET', `/stations/${pc.id}`)).body;
    expect(board.awaitingPayment.count).toBe(0);
    expect(board.debt.customerName).toBeNull();
  });

  it('shows no name and no debt once the bill went on the customer tab (0.33.4)', async () => {
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: pc.id,
      billingMode: 'endpay',
      minutes: 60,
      customerId: customer.id,
    });
    expect(started.status).toBe(201);
    const sessionId = started.body.session.id;

    vi.setSystemTime(new Date(T0.getTime() + 40 * 60_000));
    expect((await call('POST', `/sessions/${sessionId}/end`, {})).status).toBe(200);
    const due = (await call<StationSummary>('GET', `/stations/${pc.id}`)).body.awaitingPayment.amountCents;

    // Taken on credit: the bill becomes a debt of this customer.
    const credit = await call('POST', `/sessions/${sessionId}/collect`, {
      paymentMethod: 'cash',
      payments: [{ method: 'credit', amountCents: due }],
    });
    expect(credit.status).toBe(200);

    let board = (await call<StationSummary>('GET', `/stations/${pc.id}`)).body;
    expect(board.awaitingPayment.count).toBe(0);
    expect(board.debt.cents).toBe(0);
    expect(board.debt.customerName).toBeNull();
    // The debt itself is not lost: it is the customer's.
    const owes = (await call<CustomerSummary>('GET', `/customers/${customer.id}`)).body;
    expect(owes.balanceDueCents).toBe(due);

    const debt = (
      await ctx.pool.query<{ id: string }>(
        "SELECT d.id FROM customer_debts d JOIN gaming_sessions g ON g.sale_id = d.sale_id WHERE g.id = $1 AND d.status IN ('open','partial')",
        [sessionId],
      )
    ).rows[0]!;
    expect((await call('POST', `/debts/${debt.id}/pay`, { amountCents: due, method: 'cash' })).status).toBe(200);

    board = (await call<StationSummary>('GET', `/stations/${pc.id}`)).body;
    expect(board.debt.cents).toBe(0);
    expect(board.debt.customerName).toBeNull();
  });

  it('a PC started on the customer tab shows the name while it runs and nothing after it ends (0.33.4)', async () => {
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: pc.id,
      billingMode: 'prepaid',
      minutes: 30,
      customerId: customer.id,
      payments: [{ method: 'credit', amountCents: 75 }],
    });
    expect(started.status).toBe(201);
    let board = (await call<StationSummary>('GET', `/stations/${pc.id}`)).body;
    expect(board.activeSession?.customerName).toBe('Ardit Pagues');
    expect(board.debt.cents).toBeGreaterThan(0);

    expect((await call('POST', `/sessions/${started.body.session.id}/end`, {})).status).toBe(200);
    board = (await call<StationSummary>('GET', `/stations/${pc.id}`)).body;
    expect(board.activeSession).toBeNull();
    expect(board.awaitingPayment.count).toBe(0);
    expect(board.debt.cents).toBe(0);
    expect(board.debt.customerName).toBeNull();
  });

  it('does not show a debt from a stale customer balance when no bill of this PC is open', async () => {
    // A leftover balance on the customer with no open debt behind it must not mark the PC as debt.
    await ctx.pool.query("UPDATE customers SET balance_due_cents = 500 WHERE id = $1", [customer.id]);
    const board = (await call<StationSummary>('GET', `/stations/${pc.id}`)).body;
    expect(board.debt.cents).toBe(0);
    expect(board.debt.customerName).toBeNull();
  });
});
