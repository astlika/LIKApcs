/**
 * 0.18.0 — two additions that touch money and the desk:
 *  • Gift minutes: staff hand free time to a running prepaid / end-pay session. Nothing is billed,
 *    the new end time is exact, the gift is audited, a retry never adds time twice, cashiers
 *    without `stations.gift` are refused, and open-time sessions have no end to move.
 *  • Debts per customer: the default debt view groups every open bill of a customer into one line
 *    (totals, earliest due date, most overdue), with the same filters and search as the bill list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CustomerSummary,
  DebtCustomerSummary,
  LoginResponse,
  Paginated,
  PricingRuleSummary,
  ProductSummary,
  SaleDetail,
  SessionMutationResponse,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

describe('gift minutes and debts per customer (0.18.0)', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let station: StationSummary;
  let second: StationSummary;
  let cola: ProductSummary;
  let arben: CustomerSummary;
  let blerta: CustomerSummary;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({ status: r.statusCode, body: (r.statusCode === 204 ? null : r.json()) as T }));
  const credit = (customerId: string, amountCents: number, dueDate: string, qty = 2000) =>
    call<SaleDetail>(owner.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: qty }],
      customerId,
      payments: [{ method: 'credit', amountCents, dueDate }],
    });

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect(
      (
        await call(owner.token, 'POST', '/users', {
          username: 'kasa',
          fullName: 'Kasa Cashier',
          password: 'Cashier123',
          roles: ['cashier'],
          mustChangePassword: false,
        })
      ).status,
    ).toBe(201);
    cashier = await login(ctx.app, 'kasa', 'Cashier123');
    expect(
      (await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 2000 })).status,
    ).toBe(201);
    station = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 1, name: 'Arena 1' })
    ).body;
    second = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 2, name: 'Arena 2' })
    ).body;
    // A pricing rule so that PCs can be billed (prepaid / open time).
    await call<PricingRuleSummary>(owner.token, 'POST', '/pricing/rules', {
      name: 'Standard',
      rateCentsPerHour: 150,
      billingIncrementMinutes: 1,
    });
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Coca-Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 100_000,
      })
    ).body;
    arben = (
      await call<CustomerSummary>(owner.token, 'POST', '/customers', { name: 'Arben Gashi' })
    ).body;
    blerta = (
      await call<CustomerSummary>(owner.token, 'POST', '/customers', { name: 'Blerta Krasniqi' })
    ).body;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('gift minutes', () => {
    it('adds the minutes to the end of a running end-pay session and bills nothing', async () => {
      const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
        stationId: station.id,
        billingMode: 'endpay',
        minutes: 30,
        customerName: 'Walk-in Gift',
      });
      expect(started.status).toBe(201);
      const sessionId = started.body.session.id;
      const before = new Date(started.body.session.endsAt!).getTime();
      const salesBefore = await ctx.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM sales',
      );

      const gifted = await call<SessionMutationResponse>(
        owner.token,
        'POST',
        `/sessions/${sessionId}/gift`,
        { minutes: 10, reason: 'Regular customer', clientRequestId: 'gift-0001-aaaa' },
      );
      expect(gifted.status).toBe(200);
      expect(gifted.body.payment).toBeNull();
      expect(new Date(gifted.body.session.endsAt!).getTime() - before).toBe(10 * 60_000);

      const salesAfter = await ctx.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM sales',
      );
      expect(salesAfter.rows[0]!.n).toBe(salesBefore.rows[0]!.n);
      const audit = await ctx.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'session.gift'`,
      );
      expect(Number(audit.rows[0]!.n)).toBe(1);
    });

    it('a retry with the same request id never adds time twice', async () => {
      const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
        stationId: second.id,
        billingMode: 'endpay',
        minutes: 30,
        customerName: 'Retry Guest',
      });
      const sessionId = started.body.session.id;
      const body = { minutes: 5, clientRequestId: 'retry-0002-bbbb' };
      const first = await call<SessionMutationResponse>(
        owner.token,
        'POST',
        `/sessions/${sessionId}/gift`,
        body,
      );
      const again = await call<SessionMutationResponse>(
        owner.token,
        'POST',
        `/sessions/${sessionId}/gift`,
        body,
      );
      expect(first.status).toBe(200);
      expect(again.status).toBe(200);
      expect(again.body.session.endsAt).toBe(first.body.session.endsAt);
    });

    it('needs the stations.gift permission: a cashier is refused', async () => {
      const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
        stationId: second.id,
        billingMode: 'endpay',
        minutes: 30,
        customerName: 'Refused Guest',
      }).catch(() => null);
      // The second PC may already run a session from the previous test; use the owner's session.
      const sessionId = started?.body.session?.id;
      const target =
        sessionId ??
        (
          await ctx.pool.query<{ id: string }>(
            `SELECT id FROM gaming_sessions WHERE status IN ('active', 'paused') ORDER BY started_at DESC LIMIT 1`,
          )
        ).rows[0]!.id;
      const refused = await call(cashier.token, 'POST', `/sessions/${target}/gift`, { minutes: 5 });
      expect(refused.status).toBe(403);
    });

    it('open-time (postpaid) sessions have no end to move: 409', async () => {
      const open = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
        stationId: station.id,
        billingMode: 'postpaid',
        customerName: 'Open Time',
      });
      if (open.status !== 201) {
        // The first PC may be busy from the earlier tests; a fresh station keeps this exact.
        const third = (
          await call<StationSummary>(owner.token, 'POST', '/stations', {
            number: 3,
            name: 'Arena 3',
          })
        ).body;
        const opened = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
          stationId: third.id,
          billingMode: 'postpaid',
          customerName: 'Open Time',
        });
        expect(opened.status).toBe(201);
        const res = await call(owner.token, 'POST', `/sessions/${opened.body.session.id}/gift`, {
          minutes: 5,
        });
        expect(res.status).toBe(409);
        return;
      }
      const res = await call(owner.token, 'POST', `/sessions/${open.body.session.id}/gift`, {
        minutes: 5,
      });
      expect(res.status).toBe(409);
    });

    it('validates the amount: 0 minutes and more than 240 are refused', async () => {
      const sessionRow = await ctx.pool.query<{ id: string }>(
        `SELECT id FROM gaming_sessions WHERE status IN ('active', 'paused') LIMIT 1`,
      );
      const id = sessionRow.rows[0]!.id;
      expect((await call(owner.token, 'POST', `/sessions/${id}/gift`, { minutes: 0 })).status).toBe(
        400,
      );
      expect(
        (await call(owner.token, 'POST', `/sessions/${id}/gift`, { minutes: 241 })).status,
      ).toBe(400);
    });
  });

  describe('debts per customer', () => {
    beforeAll(async () => {
      // Arben: one overdue bill (due 2020) and one not yet due; Blerta: one bill, not yet due.
      expect((await credit(arben.id, 300, '2020-01-01')).status).toBe(201);
      expect((await credit(arben.id, 300, '2030-01-01')).status).toBe(201);
      expect((await credit(blerta.id, 300, '2030-01-01')).status).toBe(201);
    });

    it('groups every open bill of a customer into one line with the right totals', async () => {
      const res = await call<Paginated<DebtCustomerSummary>>(
        owner.token,
        'GET',
        '/debts/customers?filter=open',
      );
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      const [first, second2] = res.body.items;
      // Most overdue first.
      expect(first!.customerId).toBe(arben.id);
      expect(first!.openCount).toBe(2);
      expect(first!.remainingCents).toBe(600);
      expect(first!.overdueCents).toBe(300);
      expect(first!.oldestDueDate).toBe('2020-01-01');
      expect(first!.maxOverdueDays).toBeGreaterThan(0);
      expect(second2!.customerId).toBe(blerta.id);
      expect(second2!.openCount).toBe(1);
      expect(second2!.remainingCents).toBe(300);
      expect(second2!.overdueCents).toBe(0);
      expect(second2!.maxOverdueDays).toBe(0);
    });

    it('the overdue filter counts only the overdue bills', async () => {
      const res = await call<Paginated<DebtCustomerSummary>>(
        owner.token,
        'GET',
        '/debts/customers?filter=overdue',
      );
      expect(res.body.total).toBe(1);
      expect(res.body.items[0]!.customerId).toBe(arben.id);
      expect(res.body.items[0]!.openCount).toBe(1);
      expect(res.body.items[0]!.remainingCents).toBe(300);
    });

    it('search finds the customer by name and pages through the groups', async () => {
      const found = await call<Paginated<DebtCustomerSummary>>(
        owner.token,
        'GET',
        `/debts/customers?filter=open&q=${encodeURIComponent('Blerta')}`,
      );
      expect(found.body.total).toBe(1);
      expect(found.body.items[0]!.customerId).toBe(blerta.id);

      const paged = await call<Paginated<DebtCustomerSummary>>(
        owner.token,
        'GET',
        '/debts/customers?filter=open&pageSize=1&page=2',
      );
      expect(paged.body.total).toBe(2);
      expect(paged.body.items).toHaveLength(1);
      expect(paged.body.items[0]!.customerId).toBe(blerta.id);
    });
  });
});
