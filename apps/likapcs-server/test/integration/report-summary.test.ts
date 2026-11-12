/**
 * 0.30.0 — the management summary and the staff report. One real cash shift is run through the
 * API: a cashier opens it, sells a cola for cash (with change), the owner pays an electricity bill
 * from the drawer, and the cashier closes 0.50 short. The summary must agree with the sales,
 * profit and cash-book reports it is built from, and the staff report must show the hours, the
 * sales and the shortage against the right person. A second shift, opened by the owner, must show
 * as "on duty now". A cashier must not see either report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CashBookReport,
  CashShiftDetail,
  LoginResponse,
  ProductSummary,
  ProfitReport,
  ReportSummary,
  SalesReport,
  StaffReport,
} from '@likapcs/shared';
import { SETTING_DEFAULTS } from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

/** Today's calendar date in the business time zone (reports group by that zone). */
const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: SETTING_DEFAULTS['locale.timezone'] }).format(
    new Date(),
  );

describe('management summary and staff report', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let cashierId: string;
  let ownerId: string;
  let cola: ProductSummary;
  let closedShift: CashShiftDetail;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({
        status: r.statusCode,
        body: (String(r.headers['content-type']).includes('json') ? r.json() : null) as T,
      }));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    ownerId = owner.user.id;
    expect(
      (
        await call(owner.token, 'POST', '/users', {
          username: 'kasjer',
          fullName: 'Arben Kasjeri',
          password: 'Kasjer12345',
          roles: ['cashier'],
          mustChangePassword: false,
        })
      ).status,
    ).toBe(201);
    cashier = await login(ctx.app, 'kasjer', 'Kasjer12345');
    cashierId = cashier.user.id;
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 50_000,
      })
    ).body;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('one shift: the cashier sells for cash, the owner pays a bill from the drawer, the cashier closes 0.50 short', async () => {
    const opened = await call<CashShiftDetail>(cashier.token, 'POST', '/cash/shifts/open', {
      openingCents: 5000,
    });
    expect(opened.status).toBe(201);

    // 2.00 handed over for a 1.50 cola: the drawer takes 1.50.
    const sale = await call(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(sale.status).toBe(201);

    const expense = await call(owner.token, 'POST', '/expenses', {
      expenseDate: today(),
      categoryCode: 'electricity',
      amountCents: 100,
      paymentMethod: 'cash',
      description: 'Bill paid from the drawer',
      fromDrawer: true,
    });
    expect(expense.status).toBe(201);

    // Expected: 5000 + 150 − 100 = 5050. Counted 5000 → 50 short.
    const closed = await call<CashShiftDetail>(
      cashier.token,
      'POST',
      `/cash/shifts/${opened.body.id}/close`,
      { countedCashCents: 5000 },
    );
    expect(closed.status).toBe(200);
    expect(closed.body.differenceCents).toBe(-50);
    closedShift = closed.body;
  });

  it('the summary agrees with the reports it is built from', async () => {
    const from = today();
    const q = `from=${from}&to=${from}`;
    const [summary, sales, profit, cashBook] = await Promise.all([
      call<ReportSummary>(owner.token, 'GET', `/reports/summary?${q}`),
      call<SalesReport>(owner.token, 'GET', `/reports/sales?${q}`),
      call<ProfitReport>(owner.token, 'GET', `/reports/profit?${q}`),
      call<CashBookReport>(owner.token, 'GET', `/reports/cash-book?${q}`),
    ]);
    expect(summary.status).toBe(200);
    const s = summary.body;

    // Turnover: VAT included, after refunds — the sales report figure.
    expect(s.turnoverCents).toBe(150);
    expect(s.turnoverCents).toBe(sales.body.sales.netCents);
    expect(s.salesCount).toBe(sales.body.sales.count);
    expect(s.daily.reduce((acc, d) => acc + d.turnoverCents, 0)).toBe(s.turnoverCents);

    // Profit: the summary is the profit report, line by line.
    expect(s.revenueCents).toBe(s.turnoverCents - s.vatCents);
    expect(s.costOfSalesCents).toBe(profit.body.costOfSalesCents);
    expect(s.grossProfitCents).toBe(s.revenueCents - s.costOfSalesCents);
    expect(s.expensesCents).toBe(100);
    expect(s.netProfitCents).toBe(s.grossProfitCents - s.expensesCents - s.stockLossCents);

    // The drawer: cash in 150, out 100, the shift closed 50 short.
    expect(s.cash.inCents).toBe(cashBook.body.totals.cashInCents);
    expect(s.cash.outCents).toBe(cashBook.body.totals.cashOutCents);
    expect(s.cash.inCents).toBe(150);
    expect(s.cash.outCents).toBe(100);
    expect(s.cash.netCents).toBe(50);
    expect(s.cash.closedShiftsCount).toBe(1);
    expect(s.cash.openShiftsCount).toBe(0);
    expect(s.cash.differenceCents).toBe(-50);
  });

  it('the staff report shows the cashier\'s hours, sales and shortage', async () => {
    const from = today();
    const res = await call<StaffReport>(
      owner.token,
      'GET',
      `/reports/staff?from=${from}&to=${from}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.onDuty).toEqual([]);
    const row = res.body.staff.find((r) => r.userId === cashierId);
    expect(row).toBeDefined();
    expect(row!.name).toBe('Arben Kasjeri');
    expect(row!.shiftsCount).toBe(1);
    expect(row!.salesCount).toBe(1);
    expect(row!.salesCents).toBe(150);
    expect(row!.cashDifferenceCents).toBe(-50);
    expect(row!.onDutyNow).toBe(false);
    // The shift opened and closed within the test run: a few minutes at most, never negative.
    expect(row!.workedMinutes).toBeGreaterThanOrEqual(0);
    expect(row!.workedMinutes).toBeLessThan(60);
    expect(closedShift.openedBy.id).toBe(cashierId);
  });

  it('the owner opens a shift: the staff report shows them on duty now', async () => {
    const opened = await call<CashShiftDetail>(owner.token, 'POST', '/cash/shifts/open', {
      openingCents: 1000,
    });
    expect(opened.status).toBe(201);
    const from = today();
    const res = await call<StaffReport>(
      owner.token,
      'GET',
      `/reports/staff?from=${from}&to=${from}`,
    );
    expect(res.body.onDuty).toHaveLength(1);
    expect(res.body.onDuty[0]!.userId).toBe(ownerId);
    expect(res.body.onDuty[0]!.name).toBe(owner.user.fullName);
    expect(res.body.staff[0]!.userId).toBe(ownerId);
    expect(res.body.staff[0]!.onDutyNow).toBe(true);
    const summary = await call<ReportSummary>(
      owner.token,
      'GET',
      `/reports/summary?from=${from}&to=${from}`,
    );
    expect(summary.body.cash.openShiftsCount).toBe(1);
    expect(summary.body.cash.closedShiftsCount).toBe(1);
  });

  it('refuses a cashier, and refuses a range that starts after it ends', async () => {
    const from = today();
    expect((await call(cashier.token, 'GET', `/reports/staff?from=${from}&to=${from}`)).status).toBe(403);
    expect((await call(cashier.token, 'GET', `/reports/summary?from=${from}&to=${from}`)).status).toBe(403);
    const bad = await call(owner.token, 'GET', '/reports/summary?from=2030-01-02&to=2030-01-01');
    expect(bad.status).toBe(400);
  });
});
