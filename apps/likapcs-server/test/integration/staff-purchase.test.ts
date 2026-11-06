/**
 * Staff purchase (0.28.0): stock items taken by staff at their purchase cost. This is not a sale:
 * no receipt, no money through the drawer, the stock goes out, and an expense of category
 * `staff_purchase` is booked automatically. Only `pos.staff_purchase` may record one (owner and
 * admin by default). A normal sale cannot use the staff tender any more.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CategorySummary, LoginResponse, ProductSummary } from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

describe('staff purchase', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let cola: ProductSummary;
  let chips: ProductSummary;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));

  const count = async (sql: string) =>
    Number((await ctx.pool.query<{ n: string }>(sql)).rows[0]!.n);

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    const created = await call(owner.token, 'POST', '/users', {
      username: 'staffkasa',
      fullName: 'Staff Cashier',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    expect(created.status).toBe(201);
    cashier = await login(ctx.app, 'staffkasa', 'Cashier123');
    expect(
      (await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 2000 })).status,
    ).toBe(201);
    const cat = await call<CategorySummary>(owner.token, 'POST', '/catalog/categories', {
      name: 'Staff drinks',
      color: '#2f7bff',
    });
    const c = await call<ProductSummary>(owner.token, 'POST', '/products', {
      name: 'Staff cola',
      categoryId: cat.body.id,
      sellingPriceCents: 150,
      purchaseCostCents: 90,
      barcodes: [{ barcode: '5449000000997' }],
      initialStockMilli: 24_000,
    });
    cola = c.body;
    const ch = await call<ProductSummary>(owner.token, 'POST', '/products', {
      name: 'Staff chips',
      categoryId: cat.body.id,
      sellingPriceCents: 120,
      purchaseCostCents: 70,
      barcodes: [{ barcode: '4000000000002' }],
      initialStockMilli: 10_000,
    });
    chips = ch.body;
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('is refused to a cashier who does not have pos.staff_purchase', async () => {
    const res = await call(cashier.token, 'POST', '/staff-purchases', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
    });
    expect(res.status).toBe(403);
  });

  it('takes the stock out at cost and books one expense, with no drawer movement and no sale', async () => {
    const drawerBefore = await count('SELECT count(*)::text AS n FROM cash_movements');
    const salesBefore = await count('SELECT count(*)::text AS n FROM sales');
    const res = await call<{ id: string; totalCostCents: number; expenseId: string }>(
      owner.token,
      'POST',
      '/staff-purchases',
      {
        items: [
          { productId: cola.id, quantityMilli: 2000 },
          { productId: chips.id, quantityMilli: 1000 },
        ],
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.totalCostCents).toBe(250);

    expect(await count('SELECT count(*)::text AS n FROM cash_movements')).toBe(drawerBefore);
    expect(await count('SELECT count(*)::text AS n FROM sales')).toBe(salesBefore);

    const exp = await ctx.pool.query<{
      category_code: string;
      amount_cents: string;
      payment_method: string;
      shift_id: string | null;
    }>(
      'SELECT category_code, amount_cents::text, payment_method, shift_id FROM expenses WHERE staff_purchase_id = $1',
      [res.body.id],
    );
    expect(exp.rows).toEqual([
      {
        category_code: 'staff_purchase',
        amount_cents: '250',
        payment_method: 'other',
        shift_id: null,
      },
    ]);

    const stock = await call<ProductSummary>(owner.token, 'GET', `/products/${cola.id}`);
    expect(stock.body.stockMilli).toBe(22_000);
    const movement = await ctx.pool.query<{ movement_type: string; quantity_milli_delta: string }>(
      "SELECT movement_type, quantity_milli_delta::text FROM inventory_movements WHERE reference_type = 'staff_purchase' AND reference_id = $1 AND product_id = $2",
      [res.body.id, cola.id],
    );
    expect(movement.rows).toEqual([{ movement_type: 'staff_out', quantity_milli_delta: '-2000' }]);
  });

  it('refuses a purchase larger than the stock and records nothing', async () => {
    const expensesBefore = await count('SELECT count(*)::text AS n FROM expenses');
    const res = await call(owner.token, 'POST', '/staff-purchases', {
      items: [{ productId: chips.id, quantityMilli: 99_000 }],
    });
    expect(res.status).toBe(409);
    expect(await count('SELECT count(*)::text AS n FROM expenses')).toBe(expensesBefore);
  });

  it('cannot be booked through a normal sale any more', async () => {
    const staffFlag = await call(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      staff: true,
      payments: [],
    });
    expect(staffFlag.status).toBe(400);
    const tender = await call(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'staff', amountCents: 90 }],
    });
    expect(tender.status).toBe(400);
  });

  it('cannot void the expense of a staff purchase', async () => {
    const row = await ctx.pool.query<{ id: string }>(
      'SELECT id FROM expenses WHERE staff_purchase_id IS NOT NULL LIMIT 1',
    );
    const res = await call(owner.token, 'POST', `/expenses/${row.rows[0]!.id}/void`, {
      reason: 'Test void',
    });
    expect(res.status).toBe(409);
  });
});
