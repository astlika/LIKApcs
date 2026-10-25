/**
 * Profit & loss and the spending register. One small business day with every kind of money in and
 * out: two sales (one refunded without restock), two expenses (one from the drawer), a stock
 * purchase received and partly paid, opening stock, a stock gain and a damaged bottle. The report
 * must match the hand calculation written below.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CashShiftDetail,
  LoginResponse,
  ProductSummary,
  ProfitReport,
  PurchaseDetail,
  SaleDetail,
  SpendingReport,
  SupplierSummary,
} from '@likapcs/shared';
import { SETTING_DEFAULTS } from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: SETTING_DEFAULTS['locale.timezone'] }).format(
    new Date(),
  );

describe('profit & loss and spending', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cola: ProductSummary;
  let saleA: SaleDetail;
  let saleB: SaleDetail;

  const call = <T>(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({
        status: r.statusCode,
        body: (r.statusCode === 204 || !String(r.headers['content-type']).includes('json')
          ? null
          : r.json()) as T,
        text: r.body,
      }));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    // 50 bottles at 0.90 € in stock on the first day (opening stock).
    cola = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Coca-Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 50_000,
      })
    ).body;
    expect(cola.averageCostCents).toBe(90);
    // Station and an open drawer with 50.00 € float.
    const opened = await call<CashShiftDetail>('POST', '/cash/shifts/open', { openingCents: 5000 });
    expect(opened.status).toBe(201);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('counts the cost of every sale and keeps refunded goods that were not restocked as lost', async () => {
    // A: 2 bottles, cash, no change. Cost 2 × 0.90.
    const a = await call<SaleDetail>('POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 2000 }],
      payments: [{ method: 'cash', amountCents: 300 }],
    });
    expect(a.status).toBe(201);
    saleA = a.body;
    // B: 1 bottle, card. Cost 0.90 — then refunded and NOT put back on the shelf (it was damaged).
    const b = await call<SaleDetail>('POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'card', amountCents: 150 }],
    });
    expect(b.status).toBe(201);
    saleB = b.body;
    const { rows } = await ctx.pool.query<{ id: string }>(
      'SELECT id::text FROM sale_items WHERE sale_id = $1',
      [saleB.id],
    );
    const refund = await call('POST', `/sales/${saleB.id}/refund`, {
      items: [{ saleItemId: Number(rows[0]!.id), quantityMilli: 1000 }],
      reason: 'Damaged bottle',
      restock: false,
      method: 'card',
    });
    expect(refund.status).toBe(200);
  });

  it('books operating expenses, a stock purchase with a part payment, a stock gain and a loss', async () => {
    const rent = await call('POST', '/expenses', {
      expenseDate: today(),
      categoryCode: 'rent',
      amountCents: 30_000,
      paymentMethod: 'bank_transfer',
      description: 'October rent',
    });
    expect(rent.status).toBe(201);
    const cleaning = await call('POST', '/expenses', {
      expenseDate: today(),
      categoryCode: 'cleaning',
      amountCents: 1000,
      paymentMethod: 'cash',
      description: 'Cleaning products',
    });
    expect(cleaning.status).toBe(201);

    const supplier = await call<SupplierSummary>('POST', '/suppliers', { name: 'Pepsi Kosova' });
    expect(supplier.status).toBe(201);
    const purchase = await call<PurchaseDetail>('POST', '/purchases', {
      supplierId: supplier.body.id,
      items: [{ productId: cola.id, quantityMilli: 10_000, unitCostCents: 90 }],
      receiveNow: true,
    });
    expect(purchase.status).toBe(201);
    const paid = await call('POST', `/purchases/${purchase.body.id}/payments`, {
      method: 'bank_transfer',
      amountCents: 500,
    });
    expect(paid.status).toBe(201);

    // Stock gain of 5 bottles valued at 1.00 € each; a damaged bottle valued at the average cost.
    const gain = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/products/${cola.id}/stock`,
      headers: authHeader(owner.token),
      payload: {
        type: 'adjustment',
        quantityMilliDelta: 5000,
        reason: 'Found on shelf',
        unitCostCents: 100,
      },
    });
    expect(gain.statusCode).toBe(200);
    const broken = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/products/${cola.id}/stock`,
      headers: authHeader(owner.token),
      payload: { type: 'damaged', quantityMilliDelta: -1000, reason: 'Broken bottle' },
    });
    expect(broken.statusCode).toBe(200);
  });

  it('the profit report matches the hand calculation', async () => {
    const r = await call<ProfitReport>('GET', `/reports/profit?from=${today()}&to=${today()}`);
    expect(r.status).toBe(200);
    const p = r.body;
    // VAT is inside the shelf price (18 %). Sale A (300) keeps its VAT; sale B (150) is refunded in full.
    const { rows: tax } = await ctx.pool.query<{ tax: string }>(
      'SELECT tax_cents::text AS tax FROM sales WHERE id = $1',
      [saleA.id],
    );
    const vatA = Number(tax[0]!.tax);
    expect(vatA).toBeGreaterThan(0);
    // Revenue: 300 (A) + 150 (B) − 150 (B refunded) = 300 with VAT; without VAT only A's VAT is left out.
    expect(p.revenue.netSalesCents).toBe(300);
    expect(p.revenue.vatCents).toBe(vatA);
    expect(p.revenue.revenueCents).toBe(300 - vatA);
    // Cost of sales: 2 + 1 bottles at 0.90; the refunded bottle was not restocked, so it stays.
    expect(p.costOfSalesCents).toBe(270);
    expect(p.refundedNotRestockedCents).toBe(90);
    // Gross profit: sale A earns (300 − VAT) − 180; sale B earns nothing and loses its 90 cost.
    expect(p.grossProfitCents).toBe(300 - vatA - 270);
    expect(p.grossMarginBp).toBe(Math.round(((300 - vatA - 270) * 10_000) / (300 - vatA)));
    // Operating expenses: rent 300.00 + cleaning 10.00.
    expect(p.operatingExpensesCents).toBe(31_000);
    expect(p.expensesByCategory.map((b) => b.key).sort()).toEqual(['cleaning', 'rent']);
    // Stock loss: one damaged bottle at 0.90.
    expect(p.stockLossCents).toBe(90);
    expect(p.stockLossByType).toEqual([
      expect.objectContaining({ key: 'damaged', amountCents: 90, count: 1 }),
    ]);
    expect(p.netProfitCents).toBe(p.grossProfitCents - 31_000 - 90);
    // Stock in: 9.00 € received (10 × 0.90), opening 45.00 €, gain 5.00 €.
    expect(p.stock).toEqual({ receivedCents: 900, openingCents: 4500, addedCents: 500 });
    // Cash: only the cash sale (3.00 €) and the drawer cleaning expense (10.00 €); the float is excluded.
    expect(p.cash.drawerInCents).toBe(300);
    expect(p.cash.drawerOutCents).toBe(1000);
    expect(p.cash.supplierPaidCents).toBe(500);
    // Owed to Pepsi Kosova: 9.00 € received minus 5.00 € paid.
    expect(p.payables.supplierBalanceCents).toBe(400);
    expect(p.checks).toEqual({
      productsWithoutCost: 0,
      saleLinesWithoutCost: 0,
      lossesWithoutCost: 0,
    });
  });

  it('the spending register lists every money-out and every stock movement with its effect', async () => {
    const r = await call<SpendingReport>('GET', `/reports/spending?from=${today()}&to=${today()}`);
    expect(r.status).toBe(200);
    const byKind = Object.fromEntries(r.body.totals.map((t) => [t.kind, t]));
    expect(byKind.expense).toEqual({ kind: 'expense', count: 2, amountCents: 31_000 });
    expect(byKind.stock_received).toEqual({ kind: 'stock_received', count: 1, amountCents: 900 });
    expect(byKind.stock_opening).toEqual({ kind: 'stock_opening', count: 1, amountCents: 4500 });
    expect(byKind.stock_added).toEqual({ kind: 'stock_added', count: 1, amountCents: 500 });
    expect(byKind.stock_loss).toEqual({ kind: 'stock_loss', count: 1, amountCents: 90 });
    expect(byKind.supplier_payment).toEqual({
      kind: 'supplier_payment',
      count: 1,
      amountCents: 500,
    });
    expect(r.body.rowCount).toBe(7);
    expect(r.body.truncated).toBe(false);
    const effects = Object.fromEntries(r.body.rows.map((x) => [x.kind, x.effect]));
    expect(effects).toEqual({
      expense: 'profit',
      stock_received: 'stock',
      stock_opening: 'stock',
      stock_added: 'stock',
      stock_loss: 'profit',
      supplier_payment: 'cash',
    });
  });

  it('the CSV export carries every spending row', async () => {
    const r = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/reports/export?kind=spending&from=${today()}&to=${today()}`,
      headers: authHeader(owner.token),
    });
    expect(r.statusCode).toBe(200);
    const lines = r.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/);
    expect(lines[0]).toBe('date;kind;effect;description;category;method;amount_cents;reference');
    expect(lines).toHaveLength(8); // header + 7 rows
  });

  it('flags a product that holds stock but has no cost', async () => {
    const water = await call<ProductSummary>('POST', '/products', {
      name: 'Water 0.5L',
      sellingPriceCents: 50,
      purchaseCostCents: 0,
      initialStockMilli: 10_000,
    });
    expect(water.status).toBe(201);
    const r = await call<ProfitReport>('GET', `/reports/profit?from=${today()}&to=${today()}`);
    expect(r.body.checks.productsWithoutCost).toBe(1);
  });
});
