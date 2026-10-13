/**
 * Concurrent money movements of ONE customer must never deadlock.
 *
 * Regression for 0.16.0: starting several PCs at once on a customer's tab (the bulk start fires
 * one `POST /sessions` per PC in parallel) failed for all but one PC with `deadlock detected`.
 * Every INSERT carrying `customer_id` takes a `FOR KEY SHARE` lock on the customer row; one
 * transaction then waited for the receipt-number row while the other waited to upgrade its
 * customer lock to `FOR UPDATE` (`debts.open`). The services now take the customer row `FOR
 * UPDATE` as the very first lock of the transaction, so concurrent transactions of the same
 * customer queue up instead of crossing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CustomerSummary,
  LoginResponse,
  PricingRuleSummary,
  ProductSummary,
  SaleDetail,
  SessionMutationResponse,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const ROUNDS = 4;
const PCS = 4;

describe('one customer, many concurrent transactions', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let customer: CustomerSummary;
  let cola: ProductSummary;
  const stations: StationSummary[] = [];

  const call = <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({ status: r.statusCode, body: (r.statusCode === 204 ? null : r.json()) as T }));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    const rule = await call<PricingRuleSummary>('POST', '/pricing/rules', {
      name: 'Standard',
      rateCentsPerHour: 150,
      billingIncrementMinutes: 1,
    });
    expect(rule.status).toBe(201);
    for (let n = 1; n <= PCS; n++) {
      const st = await call<StationSummary>('POST', '/stations', { number: n, name: `PC ${n}` });
      expect(st.status).toBe(201);
      stations.push(st.body);
    }
    customer = (
      await call<CustomerSummary>('POST', '/customers', {
        name: 'Besnik Parallel',
        creditLimitCents: 100_000,
      })
    ).body;
    cola = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Cola',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 1_000_000,
      })
    ).body;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it(`starts ${PCS} PCs at once on the tab, ${ROUNDS} rounds, without a single failure`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const results = await Promise.all(
        stations.map((s) =>
          call<SessionMutationResponse>('POST', '/sessions', {
            stationId: s.id,
            billingMode: 'prepaid',
            minutes: 60,
            customerId: customer.id,
            payments: [{ method: 'credit', amountCents: 150 }],
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(stations.map(() => 201));
      // Free the PCs for the next round (cancelling a prepaid session is refused; end them).
      await Promise.all(
        results.map((r) => call('POST', `/sessions/${r.body.session.id}/end`, { payments: [] })),
      );
    }
    const after = await call<CustomerSummary>('GET', `/customers/${customer.id}`);
    expect(after.body.balanceDueCents).toBe(ROUNDS * PCS * 150);
  }, 60_000);

  it('mixes concurrent POS sales on the tab, balance top-ups and tab repayments', async () => {
    expect(
      (await call('POST', `/customers/${customer.id}/wallet/topup`, { amountCents: 5000 })).status,
    ).toBe(201);
    const before = (await call<CustomerSummary>('GET', `/customers/${customer.id}`)).body;
    const results = await Promise.all([
      ...Array.from({ length: 3 }, () =>
        call<SaleDetail>('POST', '/sales', {
          customerId: customer.id,
          items: [{ productId: cola.id, quantityMilli: 1000 }],
          payments: [{ method: 'credit', amountCents: 150 }],
        }),
      ),
      ...Array.from({ length: 3 }, () =>
        call<SaleDetail>('POST', '/sales', {
          customerId: customer.id,
          items: [{ productId: cola.id, quantityMilli: 1000 }],
          payments: [{ method: 'wallet', amountCents: 150 }],
        }),
      ),
      call('POST', `/customers/${customer.id}/debts/pay`, { amountCents: 300, method: 'cash' }),
      call('POST', `/customers/${customer.id}/wallet/topup`, { amountCents: 1000 }),
    ]);
    // 6 sales created, one repayment (200), one top-up (201)
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201, 200, 201]);
    const after = (await call<CustomerSummary>('GET', `/customers/${customer.id}`)).body;
    expect(after.balanceDueCents).toBe(before.balanceDueCents + 3 * 150 - 300);
    expect(after.walletBalanceCents).toBe(before.walletBalanceCents - 3 * 150 + 1000);
  }, 60_000);
});
