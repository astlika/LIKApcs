/**
 * Staff purchase (0.20.7): the items are charged at their purchase cost, the PC time is free, no
 * money moves through the drawer, the stock goes out, and the purchase cannot be refunded or
 * discounted. A normal sale must not be able to use the `staff` tender.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CategorySummary, LoginResponse, ProductSummary, SaleDetail } from '@likapcs/shared';
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

  const drawerMovements = async () =>
    Number(
      (await ctx.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM cash_movements'))
        .rows[0]!.n,
    );

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

  it('charges the purchase cost, takes no money, and takes the stock out', async () => {
    const drawerBefore = await drawerMovements();
    const res = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [
        { productId: cola.id, quantityMilli: 2000 },
        { productId: chips.id, quantityMilli: 1000 },
      ],
      staff: true,
      payments: [],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'completed', totalCents: 250, paidCents: 250 });
    expect(await drawerMovements()).toBe(drawerBefore);

    const pays = await ctx.pool.query<{ method: string; amount_cents: string }>(
      'SELECT method, amount_cents::text FROM payments WHERE sale_id = $1',
      [res.body.id],
    );
    expect(pays.rows).toEqual([{ method: 'staff', amount_cents: '250' }]);

    const stock = await call<ProductSummary>(owner.token, 'GET', `/products/${cola.id}`);
    expect(stock.body.stockMilli).toBe(22_000);
  });

  it('refuses a staff purchase with a discount or with a payment', async () => {
    const disc = await call(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000, discountCents: 10 }],
      staff: true,
      payments: [],
    });
    expect(disc.status).toBe(400);
    const paid = await call(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      staff: true,
      payments: [{ method: 'cash', amountCents: 90 }],
    });
    expect(paid.status).toBe(400);
  });

  it('keeps the staff tender away from normal sales', async () => {
    const res = await call(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'staff', amountCents: 90 }],
    });
    expect(res.status).toBe(400);
  });

  it('cannot be refunded', async () => {
    const sale = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      staff: true,
      payments: [],
    });
    expect(sale.status).toBe(201);
    const line = (sale.body as unknown as { items: { id: number }[] }).items[0]!;
    const refund = await call(owner.token, 'POST', `/sales/${sale.body.id}/refund`, {
      items: [{ saleItemId: line.id, quantityMilli: 1000 }],
      reason: 'Staff refund test',
    });
    expect(refund.status).toBe(409);
  });

  it('lists staff purchases on their own, with the buyer and the time', async () => {
    const list = await call<{
      items: { totalCents: number; cashierName: string; createdAt: string }[];
    }>(owner.token, 'GET', '/sales?tender=staff');
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
    expect(list.body.items.every((s) => typeof s.createdAt === 'string')).toBe(true);
    expect(list.body.items[0]).toMatchObject({ cashierName: 'Staff Cashier' });
  });

  it('refuses a free (typed-price) item in a staff purchase', async () => {
    const res = await call(cashier.token, 'POST', '/sales', {
      items: [{ description: 'Gjë', unitPriceCents: 500, quantityMilli: 1000 }],
      staff: true,
      payments: [],
    });
    expect(res.status).toBe(400);
    expect((res.body as unknown as { error: { message: string } }).error.message).toMatch(
      /stock items/,
    );
  });
});
