/**
 * 0.21.0 — the cash book: one row per cash shift, with the shift's drawer movements. Two shifts:
 * the first has a cash sale with change, a deposit and a withdrawal, then closes 1.00 short; the
 * second is still open. The report, its totals and the `cash_book` CSV export must agree with the
 * drawer ledger, and a range with `from` after `to` is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CashBookReport,
  CashShiftDetail,
  LoginResponse,
  ProductSummary,
  SaleDetail,
} from '@likapcs/shared';
import { SETTING_DEFAULTS } from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

/** Today's calendar date in the business time zone (the cash book groups shifts in that zone). */
const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: SETTING_DEFAULTS['locale.timezone'] }).format(
    new Date(),
  );

describe('cash book: one row per cash shift', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let accountant: LoginResponse;
  let cola: ProductSummary;
  let first: CashShiftDetail;
  let second: CashShiftDetail;

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
        text: r.body,
        contentType: String(r.headers['content-type']),
      }));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
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

  it('shift one: a cash sale with change, a deposit, a withdrawal, closed 1.00 short', async () => {
    first = (
      await call<CashShiftDetail>(owner.token, 'POST', '/cash/shifts/open', { openingCents: 5000 })
    ).body;
    expect(first.status).toBe('open');

    // 2.00 handed over for a 1.50 cola: the drawer takes the 1.50 net.
    const sale = await call<SaleDetail>(owner.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(sale.status).toBe(201);
    expect(
      (
        await call(owner.token, 'POST', '/cash/movements', {
          type: 'deposit',
          amountCents: 1000,
          reason: 'Float top-up',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(owner.token, 'POST', '/cash/movements', {
          type: 'withdrawal',
          amountCents: 500,
          reason: 'Bank drop',
        })
      ).status,
    ).toBe(201);

    // Expected in the drawer: 5000 + 150 + 1000 − 500 = 5650.
    const closed = await call<CashShiftDetail>(
      owner.token,
      'POST',
      `/cash/shifts/${first.id}/close`,
      { countedCashCents: 5550, notes: 'One euro short' },
    );
    expect(closed.status).toBe(200);
    expect(closed.body.expectedCashCents).toBe(5650);
    expect(closed.body.differenceCents).toBe(-100);
  });

  it('shift two is open with only its float', async () => {
    const open = await call<CashShiftDetail>(owner.token, 'POST', '/cash/shifts/open', {
      openingCents: 2000,
    });
    expect(open.status).toBe(201);
    second = open.body;
  });

  it('the report has one row per shift, with cash in, cash out, expected and the difference', async () => {
    const res = await call<CashBookReport>(
      owner.token,
      'GET',
      `/reports/cash-book?from=${today()}&to=${today()}`,
    );
    expect(res.status).toBe(200);
    const book = res.body;
    expect(book.rows.map((r) => r.shift.id)).toEqual([first.id, second.id]);

    const a = book.rows[0]!;
    expect(a.shift).toMatchObject({
      status: 'closed',
      openingCents: 5000,
      countedCashCents: 5550,
      differenceCents: -100,
    });
    expect(a.cashInCents).toBe(150 + 1000);
    expect(a.cashOutCents).toBe(500);
    expect(a.expectedCashCents).toBe(5650);
    expect(a.expectedCashCents).toBe(a.shift.expectedCashCents);
    expect(a.movements.map((m) => m.type)).toEqual(['opening', 'sale', 'deposit', 'withdrawal']);

    const b = book.rows[1]!;
    expect(b.shift).toMatchObject({
      status: 'open',
      openingCents: 2000,
      countedCashCents: null,
      differenceCents: null,
    });
    expect(b.cashInCents).toBe(0);
    expect(b.cashOutCents).toBe(0);
    expect(b.expectedCashCents).toBe(2000);
    expect(b.movements.map((m) => m.type)).toEqual(['opening']);
  });

  it('the totals add up the rows; counted and difference cover closed shifts only', async () => {
    const book = (
      await call<CashBookReport>(
        owner.token,
        'GET',
        `/reports/cash-book?from=${today()}&to=${today()}`,
      )
    ).body;
    expect(book.totals).toEqual({
      shiftsCount: 2,
      openShiftsCount: 1,
      openingCents: 5000 + 2000,
      cashInCents: 1150,
      cashOutCents: 500,
      expectedCashCents: 5650 + 2000,
      countedCashCents: 5550,
      differenceCents: -100,
    });
  });

  it('the cash_book CSV has one row per shift, with cash in and out, in the business time zone', async () => {
    const res = await call<null>(
      accountant.token,
      'GET',
      `/reports/export?kind=cash_book&from=${today()}&to=${today()}`,
    );
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/csv');
    expect(res.text.startsWith('\uFEFF')).toBe(true);
    const lines = res.text.slice(1).trimEnd().split('\r\n');
    const header = lines[0]!.split(';');
    expect(header.slice(6, 12)).toEqual([
      'opening_cents',
      'cash_in_cents',
      'cash_out_cents',
      'expected_cash_cents',
      'counted_cash_cents',
      'difference_cents',
    ]);
    expect(lines).toHaveLength(3);
    const cell = (row: string, column: string) => row.split(';')[header.indexOf(column)];
    expect(cell(lines[1]!, 'status')).toBe('closed');
    expect(cell(lines[1]!, 'cash_in_cents')).toBe('1150');
    expect(cell(lines[1]!, 'expected_cash_cents')).toBe('5650');
    expect(cell(lines[1]!, 'difference_cents')).toBe('-100');
    expect(cell(lines[1]!, 'movements')).toBe('4');
    expect(cell(lines[1]!, 'opened_at')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(cell(lines[2]!, 'status')).toBe('open');
    expect(cell(lines[2]!, 'counted_cash_cents')).toBe('');
  });

  it('a range with "from" after "to" is refused', async () => {
    const res = await call(owner.token, 'GET', `/reports/cash-book?from=${today()}&to=2000-01-01`);
    expect(res.status).toBe(400);
  });
});
