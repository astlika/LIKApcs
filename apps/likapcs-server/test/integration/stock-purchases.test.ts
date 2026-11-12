/**
 * Stock purchases on the Expenses page: goods received into stock are listed for information (not
 * spending); stock-less lines are spending; the spending export never shows a line twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CashShiftDetail,
  ExpenseListResponse,
  LoginResponse,
  ProductSummary,
  PurchaseDetail,
  StockPurchaseListResponse,
  SupplierSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const WIDE = { from: '2000-01-01', to: '2100-01-01' };
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('stock purchases on the expenses page', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let coffee: ProductSummary;
  let service: ProductSummary;
  let supplier: SupplierSummary;

  const call = <T>(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({
        status: r.statusCode,
        body: (String(r.headers['content-type'] ?? '').includes('json') ? r.json() : null) as T,
        text: r.body,
      }));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    supplier = (await call<SupplierSummary>('POST', '/suppliers', { name: 'Kafe Import SH.P.K.' }))
      .body;
    await call<CashShiftDetail>('POST', '/cash/shifts/open', { openingCents: 5000 });
    coffee = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Kafe 1kg',
        sellingPriceCents: 500,
        purchaseCostCents: 0,
      })
    ).body;
    service = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Shërbim montimi',
        sellingPriceCents: 0,
        purchaseCostCents: 0,
        trackStock: false,
      })
    ).body;
    // 10 kg of coffee at 0.125 € per 1 g (mills), plus one stock-less service at 5.00 €.
    const purchase = await call<PurchaseDetail>('POST', '/purchases', {
      supplierId: supplier.id,
      supplierInvoiceNo: 'F-100',
      items: [
        { productId: coffee.id, quantityMilli: 10_000, unitCostCents: 13, unitCostMills: 125 },
        { productId: service.id, quantityMilli: 1_000, unitCostCents: 500 },
      ],
      receiveNow: true,
    });
    expect(purchase.status).toBe(201);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('lists only goods that went into stock, valued at their cost', async () => {
    const res = await call<StockPurchaseListResponse>(
      'GET',
      `/expenses/stock-purchases?${new URLSearchParams(WIDE)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.totalCents).toBe(125);
    const row = res.body.items[0]!;
    expect(row.productId).toBe(coffee.id);
    expect(row.supplierName).toBe('Kafe Import SH.P.K.');
    expect(row.quantityMilli).toBe(10_000);
    expect(row.unitCostMills).toBe(125);
    expect(row.amountCents).toBe(125);
  });

  it('the stock-less line is spending, not a stock purchase', async () => {
    const res = await call<ExpenseListResponse>('GET', `/expenses?${new URLSearchParams(WIDE)}`);
    expect(res.body.totalCents).toBe(500);
    expect(res.body.items.every((e) => e.categoryCode === 'other')).toBe(true);
  });

  it('filters by product, supplier and search text', async () => {
    const byQuery = (extra: Record<string, string>) =>
      call<StockPurchaseListResponse>(
        'GET',
        `/expenses/stock-purchases?${new URLSearchParams({ ...WIDE, ...extra })}`,
      );
    expect((await byQuery({ q: 'kafe' })).body.total).toBe(1);
    expect((await byQuery({ q: 'Kafe Import' })).body.total).toBe(1);
    expect((await byQuery({ q: 'nuk-ekziston' })).body.total).toBe(0);
    expect((await byQuery({ supplierId: supplier.id })).body.total).toBe(1);
    expect((await byQuery({ supplierId: '00000000-0000-4000-8000-000000000000' })).body.total).toBe(
      0,
    );
    expect((await byQuery({ from: day(10), to: day(20) })).body.total).toBe(0);
  });

  it('exports the same rows as CSV, with the effect column', async () => {
    const res = await call<null>(
      'GET',
      `/expenses/stock-purchases/export?${new URLSearchParams(WIDE)}`,
    );
    expect(res.status).toBe(200);
    expect(res.text.startsWith('\uFEFF')).toBe(true);
    const lines = res.text.split('\r\n').filter(Boolean);
    expect(lines[0]).toContain('quantity_milli;unit_cost_mills;amount_cents');
    const data = lines.filter((l) => l.includes('Kafe 1kg'));
    expect(data).toHaveLength(1);
    expect(data[0]).toMatch(/;125;125;/);
    expect(data[0]!.endsWith(';stock')).toBe(true);
  });

  it('the spending export shows the coffee once (stock) and the service once (expense)', async () => {
    const res = await call<null>(
      'GET',
      `/reports/export?kind=spending&from=${day(-1)}&to=${day(1)}`,
    );
    expect(res.status).toBe(200);
    const lines = res.text.split('\r\n').filter(Boolean);
    const coffeeLines = lines.filter((l) => l.includes('Kafe 1kg'));
    expect(coffeeLines).toHaveLength(1);
    expect(coffeeLines[0]).toContain(';stock;');
    const serviceLines = lines.filter((l) => l.includes('Shërbim montimi'));
    expect(serviceLines).toHaveLength(1);
    expect(serviceLines[0]).toContain(';profit;');
  });
});
