/**
 * Phase 6 — cash register shifts, drawer movements, expenses, customers and reports.
 *
 * The whole money trail of one shift is checked against the drawer ledger: opening float, a cash
 * sale with change, a card sale (no drawer impact), a session billed in cash, a refund, an expense
 * paid from the drawer and its void, a deposit and a withdrawal, then the close with a counted
 * amount. The report endpoint must agree with the same numbers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CashShiftDetail,
  CashShiftSummary,
  CashStatusResponse,
  CustomerDetail,
  CustomerSummary,
  ExpenseListResponse,
  ExpenseSummary,
  LoginResponse,
  Paginated,
  ProductSummary,
  SaleDetail,
  SalesReport,
  SessionMutationResponse,
  StationSummary,
} from '@likapcs/shared';
import { SETTING_DEFAULTS } from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

/** Today's calendar date in the business time zone (reports group days in that zone, not UTC). */
const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: SETTING_DEFAULTS['locale.timezone'] }).format(
    new Date(),
  );

describe('cash register, expenses, customers & reports', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let accountant: LoginResponse;
  let cola: ProductSummary;
  let station: StationSummary;
  let shift: CashShiftDetail;
  let customer: CustomerSummary;
  let cashSale: SaleDetail;
  let drawerExpense: ExpenseSummary;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({
        status: r.statusCode,
        body: (r.statusCode === 204 || !String(r.headers['content-type']).includes('json')
          ? null
          : r.json()) as T,
        text: r.body,
        headers: r.headers,
      }));
  const current = async () =>
    (await call<CashStatusResponse>(owner.token, 'GET', '/cash/status')).body.current!;

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
      (
        await call(owner.token, 'POST', '/users', {
          username: 'books',
          fullName: 'Read-only Accountant',
          password: 'Books12345',
          roles: ['accountant'],
          mustChangePassword: false,
        })
      ).status,
    ).toBe(201);
    accountant = await login(ctx.app, 'books', 'Books12345');
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Coca-Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 50_000,
      })
    ).body;
    station = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 1, name: 'PC 01' })
    ).body;
    expect(
      (
        await call(owner.token, 'POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 120,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('has a default register and no open shift; cash sales are refused until a shift is open', async () => {
    const status = await call<CashStatusResponse>(owner.token, 'GET', '/cash/status');
    expect(status.status).toBe(200);
    expect(status.body.registers).toHaveLength(1);
    expect(status.body.registers[0]!.name).toBe('Main register');
    expect(status.body.current).toBeNull();
    expect(status.body.requireOpenShift).toBe(true);

    const refused = await call<{ error: { code: string } }>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SHIFT_REQUIRED');
    // Nothing was written.
    const n = await ctx.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sales');
    expect(Number(n.rows[0]!.n)).toBe(0);

    // A card sale is allowed without a shift (no cash changes hands).
    const card = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'card', amountCents: 150 }],
    });
    expect(card.status).toBe(201);
  });

  it('read-only users cannot open a shift; a second open shift on the same register is refused', async () => {
    expect(
      (await call(accountant.token, 'POST', '/cash/shifts/open', { openingCents: 5000 })).status,
    ).toBe(403);
    const opened = await call<CashShiftDetail>(owner.token, 'POST', '/cash/shifts/open', {
      openingCents: 5000,
      notes: 'Morning',
    });
    expect(opened.status).toBe(201);
    shift = opened.body;
    expect(shift.status).toBe('open');
    expect(shift.openingCents).toBe(5000);
    expect(shift.totals.expectedCashCents).toBe(5000);
    expect(shift.movements).toHaveLength(1);
    expect(shift.movements[0]!.type).toBe('opening');
    expect((await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 1 })).status).toBe(
      409,
    );
  });

  it('records the net cash of a sale with change and ignores card tenders in the drawer', async () => {
    const sale = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 2000 }], // 3.00
      payments: [{ method: 'cash', amountCents: 500 }],
    });
    expect(sale.status).toBe(201);
    cashSale = sale.body;
    expect(cashSale.changeCents).toBe(200);
    let s = await current();
    expect(s.totals.cashSalesCents).toBe(300);
    expect(s.totals.expectedCashCents).toBe(5300);
    expect(s.totals.salesCount).toBe(1);
    const paymentRows = await ctx.pool.query<{ shift_id: string | null }>(
      'SELECT shift_id FROM payments WHERE sale_id = $1',
      [cashSale.id],
    );
    expect(paymentRows.rows[0]!.shift_id).toBe(shift.id);

    const split = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 3000 }], // 4.50
      payments: [
        { method: 'card', amountCents: 300 },
        { method: 'cash', amountCents: 150 },
      ],
    });
    expect(split.status).toBe(201);
    s = await current();
    expect(s.totals.cashSalesCents).toBe(450);
    expect(s.totals.expectedCashCents).toBe(5450);
    expect(s.totals.salesCount).toBe(2);
    expect(s.totals.salesByMethod.find((m) => m.method === 'card')?.amountCents).toBe(300);
    expect(s.totals.salesByMethod.find((m) => m.method === 'cash')?.amountCents).toBe(650);
  });

  it('a prepaid gaming session paid in cash lands in the same drawer', async () => {
    const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 60,
      paymentMethod: 'cash',
      customerName: 'Arben',
    });
    expect(started.status).toBe(201);
    const s = await current();
    expect(s.totals.cashSalesCents).toBe(450 + 120);
    expect(s.totals.salesBySource.find((x) => x.source === 'gaming')?.amountCents).toBe(120);
    expect(s.totals.salesBySource.find((x) => x.source === 'retail')?.amountCents).toBe(750);
    await call(owner.token, 'POST', `/sessions/${started.body.session.id}/end`, {});
  });

  it('a cash refund leaves the drawer', async () => {
    const refund = await call(owner.token, 'POST', `/sales/${cashSale.id}/refund`, {
      items: [{ saleItemId: cashSale.items[0]!.id, quantityMilli: 1000 }],
      method: 'cash',
      reason: 'Warm',
      restock: true,
    });
    expect(refund.status).toBe(200);
    const s = await current();
    expect(s.totals.cashRefundsCents).toBe(150);
    expect(s.totals.refundsCount).toBe(1);
    expect(s.totals.expectedCashCents).toBe(5000 + 570 - 150);
  });

  it('expenses: categories, a drawer expense lowers the expected cash, void puts it back', async () => {
    const cats = await call<{ code: string }[]>(owner.token, 'GET', '/expenses/categories');
    expect(cats.status).toBe(200);
    expect(cats.body.map((c) => c.code)).toContain('electricity');
    const custom = await call(owner.token, 'POST', '/expenses/categories', {
      code: 'snacks_supply',
      nameEn: 'Snack supply',
      nameSq: 'Furnizim snacks',
    });
    expect(custom.status).toBe(201);

    const e = await call<ExpenseSummary>(owner.token, 'POST', '/expenses', {
      expenseDate: today(),
      categoryCode: 'cleaning',
      amountCents: 1000,
      paymentMethod: 'cash',
      description: 'Cleaning products',
    });
    expect(e.status).toBe(201);
    drawerExpense = e.body;
    expect(drawerExpense.shiftId).toBe(shift.id);
    let s = await current();
    expect(s.totals.expensesCents).toBe(1000);
    expect(s.totals.expectedCashCents).toBe(5420 - 1000);

    // Bank transfer expense: no drawer impact.
    const rent = await call<ExpenseSummary>(owner.token, 'POST', '/expenses', {
      expenseDate: today(),
      categoryCode: 'rent',
      amountCents: 30_000,
      paymentMethod: 'bank_transfer',
      description: 'October rent',
    });
    expect(rent.status).toBe(201);
    expect(rent.body.shiftId).toBeNull();
    s = await current();
    expect(s.totals.expectedCashCents).toBe(4420);

    // The accountant can view but not create.
    expect((await call(accountant.token, 'GET', '/expenses')).status).toBe(200);
    expect(
      (
        await call(accountant.token, 'POST', '/expenses', {
          expenseDate: today(),
          categoryCode: 'other',
          amountCents: 1,
          paymentMethod: 'cash',
          description: 'x',
        })
      ).status,
    ).toBe(403);

    const voided = await call<ExpenseSummary>(
      owner.token,
      'POST',
      `/expenses/${drawerExpense.id}/void`,
      {
        reason: 'Entered twice',
      },
    );
    expect(voided.status).toBe(200);
    expect(voided.body.voidedAt).not.toBeNull();
    s = await current();
    expect(s.totals.expectedCashCents).toBe(5420);
    expect(s.movements.some((m) => m.type === 'correction' && m.amountCents === 1000)).toBe(true);
    expect(
      (await call(owner.token, 'POST', `/expenses/${drawerExpense.id}/void`, { reason: 'again' }))
        .status,
    ).toBe(409);

    const list = await call<ExpenseListResponse>(
      owner.token,
      'GET',
      `/expenses?from=${today()}&to=${today()}`,
    );
    expect(list.body.items.map((x) => x.id)).not.toContain(drawerExpense.id);
    expect(list.body.totalCents).toBe(30_000);
    const withVoided = await call<ExpenseListResponse>(
      owner.token,
      'GET',
      '/expenses?includeVoided=true',
    );
    expect(withVoided.body.items.map((x) => x.id)).toContain(drawerExpense.id);
  });

  it('deposits and withdrawals; a withdrawal cannot exceed the drawer', async () => {
    expect(
      (
        await call(owner.token, 'POST', '/cash/movements', {
          type: 'withdrawal',
          amountCents: 999_999,
          reason: 'Safe',
        })
      ).status,
    ).toBe(400);
    const dep = await call<CashShiftDetail>(owner.token, 'POST', '/cash/movements', {
      type: 'deposit',
      amountCents: 2000,
      reason: 'Change from the bank',
    });
    expect(dep.status).toBe(201);
    const wd = await call<CashShiftDetail>(owner.token, 'POST', '/cash/movements', {
      type: 'withdrawal',
      amountCents: 3000,
      reason: 'To the safe',
    });
    expect(wd.status).toBe(201);
    expect(wd.body.totals.depositsCents).toBe(2000);
    expect(wd.body.totals.withdrawalsCents).toBe(3000);
    expect(wd.body.totals.expectedCashCents).toBe(5420 + 2000 - 3000);
    // Pay-ins/outs are a cashier duty; the read-only accountant is refused.
    expect(
      (
        await call(accountant.token, 'POST', '/cash/movements', {
          type: 'deposit',
          amountCents: 100,
          reason: 'Tip jar',
        })
      ).status,
    ).toBe(403);
  });

  it('closes the shift with a counted amount and freezes expected / difference', async () => {
    const before = await current();
    const counted = before.totals.expectedCashCents - 50; // 0.50 short
    const closed = await call<CashShiftDetail>(
      owner.token,
      'POST',
      `/cash/shifts/${shift.id}/close`,
      {
        countedCashCents: counted,
        notes: 'Closed by test',
      },
    );
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('closed');
    expect(closed.body.expectedCashCents).toBe(before.totals.expectedCashCents);
    expect(closed.body.countedCashCents).toBe(counted);
    expect(closed.body.differenceCents).toBe(-50);
    expect(closed.body.closedBy?.name).toBeTruthy();
    expect(
      (await call(owner.token, 'POST', `/cash/shifts/${shift.id}/close`, { countedCashCents: 1 }))
        .status,
    ).toBe(409);
    expect((await current()) ?? null).toBeNull();
    // Cash sale is again refused, the shift history lists the closed shift.
    const refused = await call(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(refused.status).toBe(409);
    const history = await call<Paginated<CashShiftSummary>>(
      owner.token,
      'GET',
      '/cash/shifts?status=closed',
    );
    expect(history.body.total).toBe(1);
    expect(history.body.items[0]!.differenceCents).toBe(-50);
    // Audit trail
    const audit = await ctx.pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE action LIKE 'cash.%' ORDER BY occurred_at`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'cash.shift.open',
        'cash.deposit',
        'cash.withdrawal',
        'cash.shift.close',
      ]),
    );
  });

  it('with cash.require_open_shift=false, cash sales work without a shift and carry no shift id', async () => {
    expect(
      (await call(owner.token, 'PATCH', '/settings', { 'cash.require_open_shift': false })).status,
    ).toBe(200);
    const sale = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(sale.status).toBe(201);
    const row = await ctx.pool.query<{ shift_id: string | null }>(
      'SELECT shift_id FROM sales WHERE id = $1',
      [sale.body.id],
    );
    expect(row.rows[0]!.shift_id).toBeNull();
    await call(owner.token, 'PATCH', '/settings', { 'cash.require_open_shift': true });
  });

  it('customers: generated codes, search, update, detail with history, archive', async () => {
    const created = await call<CustomerSummary>(owner.token, 'POST', '/customers', {
      name: 'Blerim Krasniqi',
      phone: '+383 44 123 456',
      membership: 'VIP',
      discountBp: 1000,
    });
    expect(created.status).toBe(201);
    customer = created.body;
    expect(customer.code).toBe('C-000001');
    const second = await call<CustomerSummary>(owner.token, 'POST', '/customers', {
      name: 'Dren Gashi',
      code: 'VIP-7',
    });
    expect(second.status).toBe(201);
    expect(second.body.code).toBe('VIP-7');
    expect(
      (await call(owner.token, 'POST', '/customers', { name: 'Dup', code: 'vip-7' })).status,
    ).toBe(409);

    const found = await call<Paginated<CustomerSummary>>(owner.token, 'GET', '/customers?q=blerim');
    expect(found.body.items.map((c) => c.id)).toEqual([customer.id]);
    const byPhone = await call<Paginated<CustomerSummary>>(
      owner.token,
      'GET',
      '/customers?q=44%20123',
    );
    expect(byPhone.body.items.map((c) => c.id)).toEqual([customer.id]);

    // Link a sale and a session to the customer, then read the detail. The customer's 10 % default
    // discount is applied by the server even though the cashier role has no pos.discount permission.
    await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 1000 });
    const sale = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 150 }],
      customerId: customer.id,
    });
    expect(sale.status).toBe(201);
    expect(sale.body.subtotalCents).toBe(150);
    expect(sale.body.discountCents).toBe(15);
    expect(sale.body.totalCents).toBe(135);
    expect(sale.body.changeCents).toBe(15);
    const authorized = await ctx.pool.query<{ discount_authorized_by: string | null }>(
      'SELECT discount_authorized_by FROM sales WHERE id = $1',
      [sale.body.id],
    );
    expect(authorized.rows[0]!.discount_authorized_by).toBeNull(); // configured, not a cashier override
    // An explicit sale discount replaces (never stacks on) the member discount.
    const explicit = await call<SaleDetail>(owner.token, 'POST', '/sales/suspend', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      discountCents: 5,
      customerId: customer.id,
    });
    expect(explicit.status).toBe(201);
    expect(explicit.body.discountCents).toBe(5);
    await call(owner.token, 'POST', `/sales/${explicit.body.id}/void`, {});
    // Blocked customers cannot be attached to a sale.
    const blocked = await call<CustomerSummary>(owner.token, 'POST', '/customers', {
      name: 'Blocked Person',
      status: 'blocked',
    });
    expect(blocked.status).toBe(201);
    const refused = await call(owner.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'card', amountCents: 150 }],
      customerId: blocked.body.id,
    });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: { details: { code: string } } }).error.details.code).toBe(
      'CUSTOMER_NOT_ACTIVE',
    );
    const session = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 30,
      paymentMethod: 'cash',
      customerId: customer.id,
    });
    expect(session.status).toBe(201);
    await call(owner.token, 'POST', `/sessions/${session.body.session.id}/end`, {});
    const detail = await call<CustomerDetail>(owner.token, 'GET', `/customers/${customer.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.stats.salesCount).toBe(2); // retail sale + session bill
    expect(detail.body.stats.sessionsCount).toBe(1);
    expect(detail.body.recentSales.length).toBe(2);
    expect(detail.body.recentSessions[0]!.customerName).toBe('Blerim Krasniqi');

    const updated = await call<CustomerSummary>(owner.token, 'PATCH', `/customers/${customer.id}`, {
      phone: null,
      notes: 'Prefers PC 01',
    });
    expect(updated.body.phone).toBeNull();
    expect(updated.body.notes).toBe('Prefers PC 01');
    expect(
      (await call(accountant.token, 'PATCH', `/customers/${customer.id}`, { name: 'x' })).status,
    ).toBe(403);
    expect((await call(accountant.token, 'GET', `/customers/${customer.id}`)).status).toBe(200);

    const archived = await call<CustomerSummary>(
      owner.token,
      'DELETE',
      `/customers/${second.body.id}`,
    );
    expect(archived.body.status).toBe('archived');
    const list = await call<Paginated<CustomerSummary>>(owner.token, 'GET', '/customers');
    expect(list.body.items.map((c) => c.id)).not.toContain(second.body.id);
  });

  it('reports agree with the ledger and export CSV', async () => {
    const report = await call<SalesReport>(
      owner.token,
      'GET',
      `/reports/sales?from=${today()}&to=${today()}`,
    );
    expect(report.status).toBe(200);
    const r = report.body;
    // Completed sales so far: card 1.50, cash 3.00 (refunded 1.50), split 4.50, session 1.20,
    // no-shift cash 1.50, customer sale 1.35 (1.50 − 10 %), customer session 0.60
    // → gross 13.65, refunded 1.50
    expect(r.sales.count).toBe(7);
    expect(r.sales.grossCents).toBe(150 + 300 + 450 + 120 + 150 + 135 + 60);
    expect(r.sales.discountCents).toBe(15);
    expect(r.sales.refundedCents).toBe(150);
    expect(r.sales.netCents).toBe(r.sales.grossCents - 150);
    expect(r.sales.refundsCount).toBe(1);
    const cash = r.byMethod.find((b) => b.key === 'cash')!;
    const card = r.byMethod.find((b) => b.key === 'card')!;
    expect(card.amountCents).toBe(150 + 300);
    expect(cash.amountCents).toBe(500 - 200 + 150 + 120 + 150 + 135 + 60 - 150);
    expect(r.bySource.find((b) => b.key === 'gaming')?.amountCents).toBe(180);
    expect(r.gaming.sessionsCount).toBe(2);
    expect(r.gaming.byStation[0]!.code).toBe(station.code);
    expect(r.topProducts[0]!.name).toBe('Coca-Cola 0.5L');
    expect(r.expenses.totalCents).toBe(30_000); // the voided one is excluded
    expect(r.expenses.byCategory[0]!.key).toBe('rent');
    expect(r.cash.shiftsCount).toBe(2);
    expect(r.cash.differenceCents).toBe(-50);
    expect(r.byEmployee.length).toBeGreaterThanOrEqual(2);
    expect(r.byDay).toHaveLength(1);
    expect(r.byDay[0]!.amountCents).toBe(r.sales.netCents);

    expect(
      (await call(owner.token, 'GET', '/reports/sales?from=2026-02-01&to=2026-01-01')).status,
    ).toBe(400);
    expect(
      (await call(cashier.token, 'GET', `/reports/sales?from=${today()}&to=${today()}`)).status,
    ).toBe(403);

    const csv = await call<string>(
      owner.token,
      'GET',
      `/reports/export?kind=sales&from=${today()}&to=${today()}`,
    );
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    const lines = csv.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'receipt_no;completed_at;status;source;cashier;customer;subtotal_cents;discount_cents;tax_cents;total_cents;refunded_cents;tenders',
    );
    expect(lines).toHaveLength(1 + 7);
    for (const kind of ['sale_items', 'expenses', 'sessions', 'shifts']) {
      const res = await call(
        owner.token,
        'GET',
        `/reports/export?kind=${kind}&from=${today()}&to=${today()}`,
      );
      expect(res.status).toBe(200);
      expect(res.text.split('\r\n').length).toBeGreaterThan(2);
    }
  });

  it('report days follow the business time zone, not UTC', async () => {
    // 2026-03-10 23:30 UTC is 2026-03-11 00:30 in Europe/Belgrade (CET): the sale belongs to the 11th.
    await ctx.pool.query(
      `INSERT INTO sales (receipt_no, status, source, cashier_user_id, subtotal_cents, total_cents, paid_cents, completed_at)
       VALUES ('R-TZ-000001', 'completed', 'retail', $1, 999, 999, 999, '2026-03-10T23:30:00Z')`,
      [owner.user.id],
    );
    const day10 = await call<SalesReport>(
      owner.token,
      'GET',
      '/reports/sales?from=2026-03-10&to=2026-03-10',
    );
    const day11 = await call<SalesReport>(
      owner.token,
      'GET',
      '/reports/sales?from=2026-03-11&to=2026-03-11',
    );
    expect(day10.body.sales.count).toBe(0);
    expect(day11.body.sales.count).toBe(1);
    expect(day11.body.byDay).toEqual([
      { date: '2026-03-11', count: 1, amountCents: 999, gamingCents: 0, retailCents: 999 },
    ]);
    expect(day11.body.byHour).toEqual([{ hour: 0, count: 1, amountCents: 999 }]);
    const csv = await call<string>(
      owner.token,
      'GET',
      '/reports/export?kind=sales&from=2026-03-11&to=2026-03-11',
    );
    expect(csv.text).toContain('R-TZ-000001;2026-03-11 00:30:00;');
  });
});
