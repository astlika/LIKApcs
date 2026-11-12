/**
 * 0.30.2 — the staff report counts hours from what each person did in a shift, not only from the
 * shifts they opened. One shift is opened by the owner; two cashiers sell in it. Each cashier gets
 * hours and is on duty while the shift is open; the owner keeps the whole shift; after the close
 * nobody is on duty.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CashShiftDetail,
  LoginResponse,
  ProductSummary,
  StaffReport,
} from '@likapcs/shared';
import { SETTING_DEFAULTS } from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: SETTING_DEFAULTS['locale.timezone'] }).format(
    new Date(),
  );

describe('staff report: hours from actions inside a shift', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let ana: LoginResponse;
  let ben: LoginResponse;
  let cola: ProductSummary;

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
    for (const [username, fullName, password] of [
      ['ana', 'Ana Shitese', 'Ana123456'],
      ['ben', 'Ben Shitës', 'Ben123456'],
    ] as const) {
      expect(
        (
          await call(owner.token, 'POST', '/users', {
            username,
            fullName,
            password,
            roles: ['cashier'],
            mustChangePassword: false,
          })
        ).status,
      ).toBe(201);
    }
    ana = await login(ctx.app, 'ana', 'Ana123456');
    ben = await login(ctx.app, 'ben', 'Ben123456');
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

  it('the owner opens the shift; two cashiers sell in it and get hours', async () => {
    const opened = await call<CashShiftDetail>(owner.token, 'POST', '/cash/shifts/open', {
      openingCents: 1000,
    });
    expect(opened.status).toBe(201);

    const sellAs = (token: string) =>
      call(token, 'POST', '/sales', {
        items: [{ productId: cola.id, quantityMilli: 1000 }],
        payments: [{ method: 'cash', amountCents: 150 }],
      });
    expect((await sellAs(ana.token)).status).toBe(201);
    expect((await sellAs(ben.token)).status).toBe(201);

    const from = today();
    const res = await call<StaffReport>(
      owner.token,
      'GET',
      `/reports/staff?from=${from}&to=${from}`,
    );
    expect(res.status).toBe(200);

    const ownerRow = res.body.staff.find((r) => r.userId === owner.user.id)!;
    const anaRow = res.body.staff.find((r) => r.userId === ana.user.id)!;
    const benRow = res.body.staff.find((r) => r.userId === ben.user.id)!;

    // The owner opened the shift: it is theirs, and it is still open.
    expect(ownerRow.shiftsCount).toBe(1);
    expect(ownerRow.onDutyNow).toBe(true);
    expect(ownerRow.workedMinutes).toBeGreaterThanOrEqual(0);

    // The cashiers did not open anything, but they sold in the shift: they have a row, one
    // shift each, sales, hours (never negative), and they are on duty right now.
    for (const row of [anaRow, benRow]) {
      expect(row).toBeDefined();
      expect(row.shiftsCount).toBe(1);
      expect(row.salesCount).toBe(1);
      expect(row.salesCents).toBe(150);
      expect(row.workedMinutes).toBeGreaterThanOrEqual(0);
      expect(row.onDutyNow).toBe(true);
    }
    const onDutyIds = res.body.onDuty.map((d) => d.userId).sort();
    expect(onDutyIds).toEqual([ana.user.id, ben.user.id, owner.user.id].sort());
  });

  it('after the close nobody is on duty, and the hours stay', async () => {
    const status = await call<{ current: CashShiftDetail }>(owner.token, 'GET', '/cash/status');
    const openId = status.body.current.id;
    const closed = await call<CashShiftDetail>(owner.token, 'POST', `/cash/shifts/${openId}/close`, {
      countedCashCents: 1000 + 300,
    });
    expect(closed.status).toBe(200);

    const from = today();
    const res = await call<StaffReport>(
      owner.token,
      'GET',
      `/reports/staff?from=${from}&to=${from}`,
    );
    expect(res.body.onDuty).toEqual([]);
    for (const id of [ana.user.id, ben.user.id, owner.user.id]) {
      const row = res.body.staff.find((r) => r.userId === id)!;
      expect(row.onDutyNow).toBe(false);
      expect(row.workedMinutes).toBeGreaterThanOrEqual(0);
    }
    expect(res.body.staff.find((r) => r.userId === ana.user.id)!.shiftsCount).toBe(1);
  });
});
