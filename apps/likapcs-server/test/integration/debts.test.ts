/**
 * Customer debts ("pay later"): the feature flag, credit tenders on a sale (customer required,
 * credit limit, blocked customers), the receivable ledger, partial and full repayments with
 * change, customer-level FIFO repayment, rescheduling and write-off, cash-drawer effects and
 * the audit trail. Money assertions are exact integers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CashStatusResponse,
  CustomerSummary,
  DebtDetail,
  DebtPaymentResult,
  DebtSummary,
  DebtsOverview,
  LoginResponse,
  Paginated,
  ProductSummary,
  SaleDetail,
} from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

describe('customer debts (pay later)', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let cola: ProductSummary;
  let arben: CustomerSummary;
  let blerta: CustomerSummary;
  let blocked: CustomerSummary;
  let firstDebt: DebtSummary;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({ status: r.statusCode, body: (r.statusCode === 204 ? null : r.json()) as T }));
  const expectedCash = async () =>
    (await call<CashStatusResponse>(owner.token, 'GET', '/cash/status')).body.current!.totals
      .expectedCashCents;
  const balanceOf = async (id: string) =>
    (await call<CustomerSummary>(owner.token, 'GET', `/customers/${id}`)).body.balanceDueCents;
  const sell = (token: string, customerId: string | null, payments: Record<string, unknown>[]) =>
    call<SaleDetail>(token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 2000 }], // 2 × 1.50 = 3.00
      customerId,
      payments,
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
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Coca-Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 100_000,
      })
    ).body;
    arben = (
      await call<CustomerSummary>(owner.token, 'POST', '/customers', {
        name: 'Arben Gashi',
        phone: '+383 44 111 222',
        creditLimitCents: 1000,
      })
    ).body;
    blerta = (
      await call<CustomerSummary>(owner.token, 'POST', '/customers', { name: 'Blerta Krasniqi' })
    ).body;
    blocked = (
      await call<CustomerSummary>(owner.token, 'POST', '/customers', {
        name: 'Blocked Person',
        status: 'blocked',
      })
    ).body;
    expect(arben.creditLimitCents).toBe(1000);
    expect(blerta.creditLimitCents).toBe(0);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('refuses credit tenders while pos.credit_sales is off', async () => {
    const r = await sell(cashier.token, arben.id, [{ method: 'credit', amountCents: 300 }]);
    expect(r.status).toBe(409);
    expect((r.body as unknown as { error: { details: { code: string } } }).error.details.code).toBe(
      'CREDIT_DISABLED',
    );
    const n = await ctx.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sales');
    expect(Number(n.rows[0]!.n)).toBe(0); // the whole sale rolled back
  });

  it('opens a debt for a credit sale: customer required, blocked refused, limit enforced, drawer untouched', async () => {
    await call(owner.token, 'PATCH', '/settings', {
      'pos.credit_sales': true,
      'pos.credit_default_days': 10,
    });
    const cashBefore = await expectedCash();

    const noCustomer = await sell(cashier.token, null, [{ method: 'credit', amountCents: 300 }]);
    expect(noCustomer.status).toBe(400);
    const blockedSale = await sell(cashier.token, blocked.id, [
      { method: 'credit', amountCents: 300 },
    ]);
    expect(blockedSale.status).toBe(409);
    // Credit must not exceed the total (no "change" on a debt).
    const over = await sell(cashier.token, arben.id, [{ method: 'credit', amountCents: 400 }]);
    expect(over.status).toBe(400);

    // Split tender: 1.00 cash now, 2.00 on the tab, due in 5 days (explicit date).
    const due = new Date();
    due.setDate(due.getDate() + 5);
    const dueDate = due.toISOString().slice(0, 10);
    const split = await sell(cashier.token, arben.id, [
      { method: 'cash', amountCents: 100 },
      { method: 'credit', amountCents: 200, dueDate },
    ]);
    expect(split.status).toBe(201);
    expect(split.body.status).toBe('completed');
    expect(split.body.paidCents).toBe(300);
    expect(split.body.changeCents).toBe(0);
    expect(split.body.debt).toMatchObject({
      amountCents: 200,
      remainingCents: 200,
      dueDate,
      status: 'open',
    });
    expect(split.body.payments.map((p) => p.method).sort()).toEqual(['cash', 'credit']);
    expect(await expectedCash()).toBe(cashBefore + 100); // only the cash part reached the drawer
    expect(await balanceOf(arben.id)).toBe(200);

    // Limit is 10.00: 2.00 open + 8.00 fits exactly, 8.01 would not.
    const tooMuch = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 6000 }], // 9.00
      customerId: arben.id,
      payments: [{ method: 'credit', amountCents: 900 }],
    });
    expect(tooMuch.status).toBe(409);
    expect(
      (tooMuch.body as unknown as { error: { details: { code: string } } }).error.details.code,
    ).toBe('CREDIT_LIMIT');
    expect(await balanceOf(arben.id)).toBe(200);

    // Default due date comes from the setting (today + 10).
    const dflt = await sell(cashier.token, arben.id, [{ method: 'credit', amountCents: 300 }]);
    expect(dflt.status).toBe(201);
    const expected = new Date();
    expected.setDate(expected.getDate() + 10);
    expect(dflt.body.debt!.dueDate).toBe(
      `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`,
    );
    expect(await balanceOf(arben.id)).toBe(500);

    // Unlimited customer (limit 0).
    const b = await sell(cashier.token, blerta.id, [{ method: 'credit', amountCents: 300 }]);
    expect(b.status).toBe(201);
    expect(await balanceOf(blerta.id)).toBe(300);
  });

  it('lists and summarises open debts (oldest due first) and filters by customer', async () => {
    const list = await call<Paginated<DebtSummary>>(cashier.token, 'GET', '/debts?filter=open');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(3);
    expect(list.body.items.map((d) => d.remainingCents)).toEqual([200, 300, 300]);
    firstDebt = list.body.items[0]!;
    expect(firstDebt).toMatchObject({
      customerName: 'Arben Gashi',
      customerPhone: '+383 44 111 222',
      amountCents: 200,
      paidCents: 0,
      status: 'open',
      overdueDays: 0,
    });
    expect(firstDebt.receiptNo).toMatch(/^R-/);

    const forArben = await call<Paginated<DebtSummary>>(
      cashier.token,
      'GET',
      `/debts?filter=all&customerId=${arben.id}`,
    );
    expect(forArben.body.total).toBe(2);
    const search = await call<Paginated<DebtSummary>>(cashier.token, 'GET', '/debts?q=Blerta');
    expect(search.body.items.map((d) => d.customerName)).toEqual(['Blerta Krasniqi']);

    const overview = await call<DebtsOverview>(cashier.token, 'GET', '/debts/overview');
    expect(overview.body).toEqual({
      openCents: 800,
      overdueCents: 0,
      dueTodayCents: 0,
      openCount: 3,
      overdueCount: 0,
      debtors: 2,
    });

    const detail = await call<DebtDetail>(cashier.token, 'GET', `/debts/${firstDebt.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.items).toEqual([
      { description: 'Coca-Cola 0.5L', quantityMilli: 2000, lineTotalCents: 300 },
    ]);
    expect(detail.body.payments).toEqual([]);
  });

  it('takes a partial cash repayment with change, then settles the rest; drawer and balance follow', async () => {
    const cashBefore = await expectedCash();
    const tooMuch = await call(cashier.token, 'POST', `/debts/${firstDebt.id}/pay`, {
      amountCents: 250,
      method: 'cash',
    });
    expect(tooMuch.status).toBe(400);
    const short = await call(cashier.token, 'POST', `/debts/${firstDebt.id}/pay`, {
      amountCents: 150,
      method: 'cash',
      tenderedCents: 100,
    });
    expect(short.status).toBe(400);

    const partial = await call<DebtPaymentResult>(
      cashier.token,
      'POST',
      `/debts/${firstDebt.id}/pay`,
      { amountCents: 150, method: 'cash', tenderedCents: 200 },
    );
    expect(partial.status).toBe(200);
    expect(partial.body.paidCents).toBe(150);
    expect(partial.body.changeCents).toBe(50);
    expect(partial.body.customer.balanceDueCents).toBe(350);
    expect(partial.body.debts[0]).toMatchObject({
      status: 'partial',
      paidCents: 150,
      remainingCents: 50,
    });
    expect(await expectedCash()).toBe(cashBefore + 150);

    const rest = await call<DebtPaymentResult>(
      cashier.token,
      'POST',
      `/debts/${firstDebt.id}/pay`,
      { amountCents: 50, method: 'cash' },
    );
    expect(rest.status).toBe(200);
    expect(rest.body.debts[0]).toMatchObject({ status: 'paid', paidCents: 200, remainingCents: 0 });
    expect(rest.body.debts[0]!.settledAt).not.toBeNull();
    expect(rest.body.debts[0]!.payments).toHaveLength(2);
    expect(rest.body.debts[0]!.payments.map((p) => p.amountCents)).toEqual([150, 50]);
    expect(await balanceOf(arben.id)).toBe(300);
    expect(await expectedCash()).toBe(cashBefore + 200);

    const again = await call(cashier.token, 'POST', `/debts/${firstDebt.id}/pay`, {
      amountCents: 10,
      method: 'cash',
    });
    expect(again.status).toBe(409);

    // The originating sale now reports the settled debt.
    const sale = await call<SaleDetail>(owner.token, 'GET', `/sales/${firstDebt.saleId}`);
    expect(sale.body.debt).toMatchObject({ status: 'paid', remainingCents: 0 });

    // Shift totals break the repayments out.
    const status = await call<CashStatusResponse>(owner.token, 'GET', '/cash/status');
    expect(status.body.current!.totals.debtPaymentsCents).toBe(200);
  });

  it("pays a customer's debts oldest-first from one amount and reschedules / writes off", async () => {
    // Arben: one open debt of 3.00. Add a second one (1.50) so FIFO has something to allocate.
    const second = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      customerId: arben.id,
      payments: [{ method: 'credit', amountCents: 150 }],
    });
    expect(second.status).toBe(201);
    expect(await balanceOf(arben.id)).toBe(450);

    const over = await call(cashier.token, 'POST', `/customers/${arben.id}/debts/pay`, {
      amountCents: 451,
      method: 'cash',
    });
    expect(over.status).toBe(400);

    const fifo = await call<DebtPaymentResult>(
      cashier.token,
      'POST',
      `/customers/${arben.id}/debts/pay`,
      { amountCents: 350, method: 'cash', tenderedCents: 400 },
    );
    expect(fifo.status).toBe(200);
    expect(fifo.body.changeCents).toBe(50);
    expect(fifo.body.customer.balanceDueCents).toBe(100);
    expect(fifo.body.debts.map((d) => [d.amountCents, d.status, d.remainingCents])).toEqual([
      [300, 'paid', 0],
      [150, 'partial', 100],
    ]);

    // A cashier may agree a new due date (customers.manage) but not forgive the debt.
    const remaining = fifo.body.debts[1]!;
    const cashierWriteOff = await call(cashier.token, 'POST', `/debts/${remaining.id}/write-off`, {
      reason: 'Nope',
    });
    expect(cashierWriteOff.status).toBe(403);
    const rescheduled = await call<DebtDetail>(
      cashier.token,
      'POST',
      `/debts/${remaining.id}/reschedule`,
      { dueDate: '2030-01-15', notes: 'Promised after payday' },
    );
    expect(rescheduled.status).toBe(200);
    expect(rescheduled.body.dueDate).toBe('2030-01-15');
    expect(rescheduled.body.notes).toBe('Promised after payday');

    const cashBefore = await expectedCash();
    const written = await call<DebtDetail>(
      owner.token,
      'POST',
      `/debts/${remaining.id}/write-off`,
      {
        reason: 'Customer moved away',
      },
    );
    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({
      status: 'written_off',
      remainingCents: 0,
      writtenOffReason: 'Customer moved away',
    });
    expect(await balanceOf(arben.id)).toBe(0);
    expect(await expectedCash()).toBe(cashBefore); // a write-off never touches the drawer

    const writtenList = await call<Paginated<DebtSummary>>(
      owner.token,
      'GET',
      '/debts?filter=written_off',
    );
    expect(writtenList.body.total).toBe(1);
    const open = await call<Paginated<DebtSummary>>(owner.token, 'GET', '/debts');
    expect(open.body.items.map((d) => d.customerName)).toEqual(['Blerta Krasniqi']);

    const audit = await ctx.pool.query<{ action: string; n: string }>(
      `SELECT action, count(*)::text AS n FROM audit_logs WHERE action LIKE 'debt.%' GROUP BY action ORDER BY action`,
    );
    expect(Object.fromEntries(audit.rows.map((r) => [r.action, Number(r.n)]))).toEqual({
      'debt.opened': 4,
      'debt.paid': 4,
      'debt.rescheduled': 1,
      'debt.written_off': 1,
    });
  });

  it('flags overdue debts once the due date has passed', async () => {
    const blertaDebt = (
      await call<Paginated<DebtSummary>>(owner.token, 'GET', `/debts?customerId=${blerta.id}`)
    ).body.items[0]!;
    await ctx.pool.query(`UPDATE customer_debts SET due_date = CURRENT_DATE - 3 WHERE id = $1`, [
      blertaDebt.id,
    ]);
    const overdue = await call<Paginated<DebtSummary>>(owner.token, 'GET', '/debts?filter=overdue');
    expect(overdue.body.total).toBe(1);
    expect(overdue.body.items[0]).toMatchObject({ id: blertaDebt.id, overdueDays: 3 });
    const overview = await call<DebtsOverview>(owner.token, 'GET', '/debts/overview');
    expect(overview.body).toMatchObject({ openCents: 300, overdueCents: 300, overdueCount: 1 });
    // Cashier may view and collect; a payment with no permission at all is refused.
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/debts' });
    expect(anon.statusCode).toBe(401);
  });
});
