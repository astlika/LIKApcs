/**
 * 0.19.0 — simple installments: a pay-later sale can be paid in N parts. No dates are scheduled
 * (the due date still applies); the debt shows the planned count, the parts paid so far (each
 * repayment is one part) and the next part. Only the pay-later tender can carry installments.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  CustomerSummary,
  DebtSummary,
  LoginResponse,
  Paginated,
  SaleDetail,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = Math.floor(Date.now() / 60_000) * 60_000;

describe('simple installments on pay-later sales', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let customer: CustomerSummary;

  const call = <T>(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({
        status: r.statusCode,
        body: (r.statusCode === 204 ? null : r.json()) as T,
      }));

  /** A 900.00 off-inventory item (a PC build), part paid in cash, the rest on the tab. */
  const sellOnTab = (installments?: number) =>
    call<SaleDetail>('POST', '/sales', {
      customerId: customer.id,
      items: [
        {
          description: 'PC build',
          unitPriceCents: 90_000,
          quantityMilli: 1000,
          discountCents: 0,
        },
      ],
      payments: [
        { method: 'cash', amountCents: 30_000 },
        { method: 'credit', amountCents: 60_000, ...(installments ? { installments } : {}) },
      ],
    });

  const debtOf = async (saleId: string) =>
    (await call<Paginated<DebtSummary>>('GET', '/debts')).body.items.find(
      (d) => d.saleId === saleId,
    )!;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0));
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    customer = (await call<CustomerSummary>('POST', '/customers', { name: 'Arben Gashi' })).body;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('a pay-later sale in 3 installments opens a debt with the next part', async () => {
    const sale = await sellOnTab(3);
    expect(sale.status).toBe(201);
    const debt = await debtOf(sale.body.id);
    expect(debt).toMatchObject({
      amountCents: 60_000,
      installmentCount: 3,
      installmentsPaid: 0,
      installmentCents: 20_000,
    });
  });

  it('each repayment is a part: the next part is what is left over the parts still to pay', async () => {
    const sale = await sellOnTab(3);
    const debt = await debtOf(sale.body.id);
    const paid = await call('POST', `/debts/${debt.id}/pay`, {
      amountCents: 10_000,
      method: 'cash',
    });
    expect(paid.status).toBe(200);
    const after = (await call<DebtSummary>('GET', `/debts/${debt.id}`)).body;
    expect(after).toMatchObject({
      remainingCents: 50_000,
      installmentsPaid: 1,
      // 500.00 left over the 2 parts still to pay.
      installmentCents: 25_000,
    });
  });

  it('a plain pay-later sale has no installment plan', async () => {
    const sale = await sellOnTab();
    expect(sale.status).toBe(201);
    expect(await debtOf(sale.body.id)).toMatchObject({
      installmentCount: null,
      installmentCents: null,
      installmentsPaid: 0,
    });
  });

  it('installments are refused on anything but the pay-later tender, and need at least 2 parts', async () => {
    const before = (await call<Paginated<DebtSummary>>('GET', '/debts')).body.total;
    const onCash = await call('POST', '/sales', {
      customerId: customer.id,
      items: [{ description: 'Cable', unitPriceCents: 500, quantityMilli: 1000, discountCents: 0 }],
      payments: [{ method: 'cash', amountCents: 500, installments: 3 }],
    });
    expect(onCash.status).toBe(400);
    expect(onCash.body).toMatchObject({ error: { details: { code: 'INSTALLMENTS_CREDIT_ONLY' } } });

    const one = await sellOnTab(1);
    expect(one.status).toBe(400);

    expect((await call<Paginated<DebtSummary>>('GET', '/debts')).body.total).toBe(before);
  });
});
