/**
 * Installments on a pay-later sale (0.19.0, schedule since 0.19.8). The debt is split into N parts
 * with their own amount and due date (monthly). A repayment goes to the part it names, or else to
 * the oldest unpaid part. Only the pay-later tender can carry installments.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  installmentDueDate,
  type CustomerSummary,
  type DebtDetail,
  type DebtSummary,
  type LoginResponse,
  type Paginated,
  type SaleDetail,
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

  it('a part that is only partly paid is not counted: the next part is what it still owes', async () => {
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
      installmentsPaid: 0,
      // Part 1 still owes 100.00.
      installmentCents: 10_000,
    });
  });

  it('the plan lists its parts: equal amounts, the first on the debt date, then monthly', async () => {
    const sale = await sellOnTab(3);
    const debt = await debtOf(sale.body.id);
    const detail = (await call<DebtDetail>('GET', `/debts/${debt.id}`)).body;
    expect(detail.installments.map((p) => [p.seq, p.amountCents, p.status])).toEqual([
      [1, 20_000, 'open'],
      [2, 20_000, 'open'],
      [3, 20_000, 'open'],
    ]);
    expect(detail.installments[0]!.dueDate).toBe(debt.dueDate);
    expect(detail.installments[1]!.dueDate).toBe(installmentDueDate(debt.dueDate, 1));
    expect(detail.installments[2]!.dueDate).toBe(installmentDueDate(debt.dueDate, 2));
    expect(detail.itemsText).toBe('PC build');
  });

  it('an amount that does not split evenly: the first parts take the extra cents', async () => {
    const sale = await call<SaleDetail>('POST', '/sales', {
      customerId: customer.id,
      items: [
        { description: 'Cable', unitPriceCents: 1000, quantityMilli: 1000, discountCents: 0 },
      ],
      payments: [{ method: 'credit', amountCents: 1000, installments: 3 }],
    });
    expect(sale.status).toBe(201);
    const debt = await debtOf(sale.body.id);
    const detail = (await call<DebtDetail>('GET', `/debts/${debt.id}`)).body;
    expect(detail.installments.map((p) => p.amountCents)).toEqual([334, 333, 333]);
  });

  it('paying one part by number pays that part only', async () => {
    const sale = await sellOnTab(3);
    const debt = await debtOf(sale.body.id);
    const paid = await call<{ debts: DebtDetail[] }>('POST', `/debts/${debt.id}/pay`, {
      amountCents: 20_000,
      method: 'cash',
      installmentSeq: 2,
    });
    expect(paid.status).toBe(200);
    const detail = (await call<DebtDetail>('GET', `/debts/${debt.id}`)).body;
    expect(detail.installments.map((p) => [p.seq, p.status])).toEqual([
      [1, 'open'],
      [2, 'paid'],
      [3, 'open'],
    ]);
    expect(detail).toMatchObject({ installmentsPaid: 1, installmentCents: 20_000 });
    // The debt's due date is now the first part that is still unpaid.
    expect(detail.dueDate).toBe(detail.installments[0]!.dueDate);
    // The payment is recorded against that part.
    expect(detail.payments).toHaveLength(1);
  });

  it('a payment without a part goes to the oldest unpaid parts first', async () => {
    const sale = await sellOnTab(3);
    const debt = await debtOf(sale.body.id);
    expect(
      (
        await call('POST', `/debts/${debt.id}/pay`, {
          amountCents: 25_000,
          method: 'cash',
        })
      ).status,
    ).toBe(200);
    const detail = (await call<DebtDetail>('GET', `/debts/${debt.id}`)).body;
    expect(detail.installments.map((p) => [p.paidCents, p.status])).toEqual([
      [20_000, 'paid'],
      [5_000, 'partial'],
      [0, 'open'],
    ]);
    expect(detail).toMatchObject({ installmentsPaid: 1, installmentCents: 15_000 });
  });

  it('a part cannot take more than it owes, and a paid part is refused', async () => {
    const sale = await sellOnTab(3);
    const debt = await debtOf(sale.body.id);
    const over = await call('POST', `/debts/${debt.id}/pay`, {
      amountCents: 25_000,
      method: 'cash',
      installmentSeq: 1,
    });
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({ error: { details: { code: 'OVERPAY_INSTALLMENT' } } });

    expect(
      (
        await call('POST', `/debts/${debt.id}/pay`, {
          amountCents: 20_000,
          method: 'cash',
          installmentSeq: 1,
        })
      ).status,
    ).toBe(200);
    const again = await call('POST', `/debts/${debt.id}/pay`, {
      amountCents: 1_000,
      method: 'cash',
      installmentSeq: 1,
    });
    expect(again.status).toBe(409);

    const unknown = await call('POST', `/debts/${debt.id}/pay`, {
      amountCents: 1_000,
      method: 'cash',
      installmentSeq: 9,
    });
    expect(unknown.status).toBe(404);
  });

  it('a customer-level payment cannot name a part (pick the debt first)', async () => {
    const r = await call('POST', `/customers/${customer.id}/debts/pay`, {
      amountCents: 1_000,
      method: 'cash',
      installmentSeq: 1,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { details: { code: 'INSTALLMENT_NEEDS_DEBT' } } });
  });

  it('rescheduling a plan dates its unpaid parts again from the new date, monthly', async () => {
    const sale = await sellOnTab(3);
    const debt = await debtOf(sale.body.id);
    expect(
      (
        await call('POST', `/debts/${debt.id}/reschedule`, {
          dueDate: '2026-12-01',
        })
      ).status,
    ).toBe(200);
    const detail = (await call<DebtDetail>('GET', `/debts/${debt.id}`)).body;
    expect(detail.dueDate).toBe('2026-12-01');
    expect(detail.installments.map((p) => p.dueDate)).toEqual([
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ]);
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
