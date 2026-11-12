/**
 * Punkti 4, shtresa 1 (0.28.0): POS sales made while a PC was offline, synced to the server.
 * Covers: a sync writes the sale once (clientRequestId), the local number is kept, the official
 * receipt number is given by the server, a changed price is flagged, stock may go below zero,
 * a refused sale does not stop the others, and what an offline sale may not contain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CategorySummary,
  LoginResponse,
  ProductSummary,
  SyncSalesResponse,
} from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

describe('offline sales sync', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cola: ProductSummary;
  let chips: ProductSummary;

  const call = <T>(token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: authHeader(token),
        payload: payload as object,
      })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));

  const count = async (sql: string, params: unknown[] = []) =>
    Number((await ctx.pool.query<{ n: string }>(sql, params)).rows[0]!.n);

  const offlineSale = (
    n: number,
    items: { product: ProductSummary; qty: number; unitPriceCents?: number }[],
    extra: Record<string, unknown> = {},
  ) => ({
    clientRequestId: `offline-test-${n}-${Math.random().toString(36).slice(2, 10)}`,
    items: items.map((i) => ({
      productId: i.product.id,
      quantityMilli: i.qty * 1000,
      discountCents: 0,
      addonIds: [],
    })),
    discountCents: 0,
    customerId: null,
    payments: [{ method: 'cash', amountCents: 1000 }],
    offline: {
      deviceCode: 'PC2',
      localNumber: `PC2-${String(n).padStart(6, '0')}`,
      createdAt: new Date().toISOString(),
      unitPrices: items.map((i) => ({
        productId: i.product.id,
        unitPriceCents: i.unitPriceCents ?? i.product.sellingPriceCents,
      })),
    },
    ...extra,
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect(
      (await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 2000 })).status,
    ).toBe(201);
    const cat = await call<CategorySummary>(owner.token, 'POST', '/catalog/categories', {
      name: 'Offline drinks',
      color: '#2f7bff',
    });
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Offline cola',
        categoryId: cat.body.id,
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        barcodes: [{ barcode: '5449000000101' }],
        initialStockMilli: 24_000,
      })
    ).body;
    chips = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Offline chips',
        categoryId: cat.body.id,
        sellingPriceCents: 120,
        purchaseCostCents: 70,
        barcodes: [{ barcode: '4000000000102' }],
        initialStockMilli: 10_000,
      })
    ).body;
    void login;
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('syncs an offline sale: receipt from the server, local number kept, stock taken', async () => {
    const sale = offlineSale(1, [{ product: cola, qty: 2 }]);
    const res = await call<SyncSalesResponse>(owner.token, 'POST', '/sales/sync', {
      sales: [sale],
    });
    expect(res.status).toBe(200);
    const r = res.body.results[0]!;
    expect(r.status).toBe('created');
    expect(r.localNumber).toBe('PC2-000001');
    expect(r.receiptNo).toMatch(/^R-\d{4}-\d{6}$/);
    expect(r.priceChanged).toBe(false);
    const row = await ctx.pool.query<{
      local_number: string;
      device_code: string;
      price_changed: boolean;
    }>('SELECT local_number, device_code, price_changed FROM sales WHERE id = $1', [r.saleId]);
    expect(row.rows[0]).toEqual({
      local_number: 'PC2-000001',
      device_code: 'PC2',
      price_changed: false,
    });
    expect(
      await count(
        `SELECT COUNT(*)::text AS n FROM inventory_movements
          WHERE reference_id = $1 AND movement_type = 'sale' AND quantity_milli_delta = -2000`,
        [r.saleId],
      ),
    ).toBe(1);
  });

  it('a retry of the same sale is a duplicate and writes nothing again', async () => {
    const sale = offlineSale(2, [{ product: cola, qty: 1 }]);
    const first = await call<SyncSalesResponse>(owner.token, 'POST', '/sales/sync', {
      sales: [sale],
    });
    expect(first.body.results[0]!.status).toBe('created');
    const before = await count('SELECT COUNT(*)::text AS n FROM sales');
    const again = await call<SyncSalesResponse>(owner.token, 'POST', '/sales/sync', {
      sales: [sale],
    });
    expect(again.body.results[0]!.status).toBe('duplicate');
    expect(again.body.results[0]!.saleId).toBe(first.body.results[0]!.saleId);
    expect(await count('SELECT COUNT(*)::text AS n FROM sales')).toBe(before);
  });

  it('flags a sale whose price changed while the PC was offline, and charges the price the cashier saw', async () => {
    const sale = offlineSale(3, [{ product: cola, qty: 1, unitPriceCents: 130 }]);
    const res = await call<SyncSalesResponse>(owner.token, 'POST', '/sales/sync', {
      sales: [sale],
    });
    const r = res.body.results[0]!;
    expect(r.status).toBe('created');
    expect(r.priceChanged).toBe(true);
    const total = await ctx.pool.query<{ total_cents: string }>(
      'SELECT total_cents::text FROM sales WHERE id = $1',
      [r.saleId],
    );
    expect(Number(total.rows[0]!.total_cents)).toBe(130);
    const detail = await call<{ localNumber: string | null; priceChanged: boolean }>(
      owner.token,
      'GET',
      `/sales/${r.saleId}`,
    );
    expect(detail.body.localNumber).toMatch(/^PC2-\d{6}$/);
    expect(detail.body.priceChanged).toBe(true);
  });

  it('lets the stock go below zero for an offline sale (it is counted later)', async () => {
    const sale = offlineSale(4, [{ product: chips, qty: 12 }], {
      payments: [{ method: 'cash', amountCents: 2000 }],
    });
    const res = await call<SyncSalesResponse>(owner.token, 'POST', '/sales/sync', {
      sales: [sale],
    });
    expect(res.body.results[0]!.status).toBe('created');
    const stock = await ctx.pool.query<{ s: string }>(
      `SELECT COALESCE(SUM(quantity_milli_delta),0)::text AS s FROM inventory_movements WHERE product_id = $1`,
      [chips.id],
    );
    expect(Number(stock.rows[0]!.s)).toBeLessThan(0);
  });

  it('refuses what needs the live server, and one bad sale does not stop the others', async () => {
    const onTab = offlineSale(5, [{ product: cola, qty: 1 }], { customerId: null });
    const badPrice = offlineSale(6, [{ product: cola, qty: 1 }]);
    (badPrice.offline as { unitPrices: unknown[] }).unitPrices = [
      { productId: '00000000-0000-4000-8000-000000000000', unitPriceCents: 150 },
    ];
    const good = offlineSale(7, [{ product: cola, qty: 1 }]);
    const pay = {
      ...offlineSale(8, [{ product: cola, qty: 1 }]),
      payments: [{ method: 'credit', amountCents: 150 }],
    };
    const res = await call<SyncSalesResponse>(owner.token, 'POST', '/sales/sync', {
      sales: [onTab, badPrice, pay, good],
    });
    expect(res.status).toBe(200);
    const [a, b, c, d] = res.body.results;
    expect(a!.status).toBe('created');
    expect(b!.status).toBe('failed');
    expect(b!.error!.code).toBe('OFFLINE_PRICES');
    expect(c!.status).toBe('failed');
    expect(c!.error!.code).toBe('OFFLINE_PAYMENT');
    expect(d!.status).toBe('created');
  });

  it('refuses a local number that was already synced by this PC', async () => {
    const taken = offlineSale(1, [{ product: cola, qty: 1 }]);
    const res = await call<SyncSalesResponse>(owner.token, 'POST', '/sales/sync', {
      sales: [taken],
    });
    expect(res.body.results[0]!.status).toBe('failed');
    expect(res.body.results[0]!.error!.code).toBe('LOCAL_NUMBER_TAKEN');
  });

  it('reports a malformed sale as failed without blocking the rest of the batch', async () => {
    const wrong = offlineSale(9, [{ product: cola, qty: 1 }]);
    (wrong.offline as { localNumber: string }).localNumber = 'PC3-000009';
    const good = offlineSale(11, [{ product: cola, qty: 1 }]);
    const res = await call<SyncSalesResponse>(owner.token, 'POST', '/sales/sync', {
      sales: [wrong, good],
    });
    expect(res.status).toBe(200);
    expect(res.body.results[0]!.status).toBe('failed');
    expect(res.body.results[0]!.error!.code).toBe('INVALID_SALE');
    expect(res.body.results[1]!.status).toBe('created');
  });

  it('refuses a sale to a cashier without pos.sell, the same as /sales', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sales/sync',
      payload: { sales: [offlineSale(10, [{ product: cola, qty: 1 }])] },
    });
    expect(res.statusCode).toBe(401);
  });
});
