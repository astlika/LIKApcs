/**
 * Catalogue, inventory and point of sale: products with barcodes and opening stock, scanning,
 * one-transaction sales with stock movements and receipts, idempotent submission, permission
 * checks for discounts/refunds, suspended sales, partial and full refunds, stock adjustments.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CategorySummary,
  InventoryMovementSummary,
  LoginResponse,
  ProductLookupResponse,
  ProductSummary,
  ReceiptData,
  SaleDetail,
  SalesListResponse,
} from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

const YEAR = String(new Date().getFullYear());

describe('catalogue & POS', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let drinks: CategorySummary;
  let cola: ProductSummary;
  let chips: ProductSummary;
  let printing: ProductSummary;
  let firstSale: SaleDetail;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({ status: r.statusCode, body: (r.statusCode === 204 ? null : r.json()) as T }));
  const stockOf = async (id: string) =>
    (await call<ProductSummary>(owner.token, 'GET', `/products/${id}`)).body.stockMilli;
  const counts = async () => {
    const r = await ctx.pool.query<{ sales: string; payments: string; movements: string }>(
      `SELECT (SELECT count(*) FROM sales)::text AS sales, (SELECT count(*) FROM payments)::text AS payments,
              (SELECT count(*) FROM inventory_movements)::text AS movements`,
    );
    return {
      sales: Number(r.rows[0]!.sales),
      payments: Number(r.rows[0]!.payments),
      movements: Number(r.rows[0]!.movements),
    };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    const created = await call(owner.token, 'POST', '/users', {
      username: 'kasa',
      fullName: 'Kasa Cashier',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    expect(created.status).toBe(201);
    cashier = await login(ctx.app, 'kasa', 'Cashier123');
    // Cash tenders need an open cash shift (cash.require_open_shift defaults to true).
    expect(
      (await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 2000 })).status,
    ).toBe(201);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('creates categories and products with generated SKUs, barcodes and opening stock', async () => {
    const cat = await call<CategorySummary>(owner.token, 'POST', '/catalog/categories', {
      name: 'Drinks',
      color: '#2f7bff',
    });
    expect(cat.status).toBe(201);
    drinks = cat.body;
    const dup = await call(owner.token, 'POST', '/catalog/categories', { name: 'drinks' });
    expect(dup.status).toBe(409);

    const c = await call<ProductSummary>(owner.token, 'POST', '/products', {
      name: 'Coca-Cola 0.5L',
      categoryId: drinks.id,
      sellingPriceCents: 150,
      purchaseCostCents: 90,
      minStockMilli: 6000,
      barcodes: [{ barcode: '5449000000996' }],
      initialStockMilli: 24_000,
    });
    expect(c.status).toBe(201);
    cola = c.body;
    expect(cola).toMatchObject({
      sku: 'SKU-000001',
      stockMilli: 24_000,
      taxRateBp: 1800,
      categoryName: 'Drinks',
      lowStock: false,
      barcodes: [{ barcode: '5449000000996', isPrimary: true, quantityMilli: 1000 }],
    });
    const ch = await call<ProductSummary>(owner.token, 'POST', '/products', {
      name: 'Chips 50g',
      sku: 'CHIPS-50',
      categoryId: drinks.id,
      sellingPriceCents: 120,
      purchaseCostCents: 70,
      barcodes: [{ barcode: '4000000000001' }],
      initialStockMilli: 10_000,
    });
    chips = ch.body;
    const pr = await call<ProductSummary>(owner.token, 'POST', '/products', {
      name: 'Printing (per page)',
      sellingPriceCents: 50,
      trackStock: false,
    });
    printing = pr.body;
    expect(printing.sku).toBe('SKU-000002');

    const dupBarcode = await call(owner.token, 'POST', '/products', {
      name: 'Other cola',
      sellingPriceCents: 100,
      barcodes: [{ barcode: '5449000000996' }],
    });
    expect(dupBarcode.status).toBe(409);
    const asCashier = await call(cashier.token, 'POST', '/products', {
      name: 'Nope',
      sellingPriceCents: 1,
    });
    expect(asCashier.status).toBe(403);
  });

  it('looks products up by barcode (with pack quantity) and SKU, and searches the list', async () => {
    const byBarcode = await call<ProductLookupResponse>(
      cashier.token,
      'GET',
      '/products/lookup?code=5449000000996',
    );
    expect(byBarcode.status).toBe(200);
    expect(byBarcode.body).toMatchObject({
      matchedBy: 'barcode',
      quantityMilli: 1000,
      product: { id: cola.id },
    });

    const pack = await call<ProductSummary>(owner.token, 'POST', `/products/${cola.id}/barcodes`, {
      barcode: '5449000000996-6',
      quantityMilli: 6000,
    });
    expect(pack.status).toBe(201);
    const sixPack = await call<ProductLookupResponse>(
      cashier.token,
      'GET',
      '/products/lookup?code=5449000000996-6',
    );
    expect(sixPack.body.quantityMilli).toBe(6000);

    const bySku = await call<ProductLookupResponse>(
      cashier.token,
      'GET',
      '/products/lookup?code=chips-50',
    );
    expect(bySku.body).toMatchObject({ matchedBy: 'sku', product: { id: chips.id } });
    expect((await call(cashier.token, 'GET', '/products/lookup?code=0000')).status).toBe(404);

    const search = await call<{ items: ProductSummary[]; total: number }>(
      cashier.token,
      'GET',
      '/products?q=coca',
    );
    expect(search.body.items.map((p) => p.id)).toEqual([cola.id]);
    const byCategory = await call<{ items: ProductSummary[]; total: number }>(
      cashier.token,
      'GET',
      `/products?categoryId=${drinks.id}`,
    );
    expect(byCategory.body.total).toBe(2);
  });

  it('completes a sale in one transaction: totals, tax, change, receipt number, stock movements', async () => {
    const before = await counts();
    const res = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [
        { productId: cola.id, quantityMilli: 2000 },
        { productId: chips.id, quantityMilli: 1000 },
        { productId: printing.id, quantityMilli: 3000 },
      ],
      payments: [{ method: 'cash', amountCents: 1000 }],
      clientRequestId: 'pos-sale-00001',
    });
    expect(res.status).toBe(201);
    firstSale = res.body;
    expect(firstSale).toMatchObject({
      status: 'completed',
      source: 'retail',
      receiptNo: `R-${YEAR}-000001`,
      subtotalCents: 570,
      discountCents: 0,
      totalCents: 570,
      paidCents: 1000,
      changeCents: 430,
      taxCents: 87, // 46 + 18 + 23
      cashierName: 'Kasa Cashier',
      itemCount: 3,
    });
    expect(firstSale.items.map((i) => [i.description, i.lineTotalCents, i.taxCents])).toEqual([
      ['Coca-Cola 0.5L', 300, 46],
      ['Chips 50g', 120, 18],
      ['Printing (per page)', 150, 23],
    ]);
    expect(firstSale.payments).toEqual([
      expect.objectContaining({ kind: 'sale', method: 'cash', amountCents: 1000 }),
    ]);
    expect(await stockOf(cola.id)).toBe(22_000);
    expect(await stockOf(chips.id)).toBe(9_000);
    const after = await counts();
    expect(after.sales - before.sales).toBe(1);
    expect(after.payments - before.payments).toBe(1);
    expect(after.movements - before.movements).toBe(2); // the service line has no stock

    // Retrying the same submission returns the same sale and sells nothing twice.
    const retry = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 2000 }],
      payments: [{ method: 'cash', amountCents: 300 }],
      clientRequestId: 'pos-sale-00001',
    });
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(firstSale.id);
    expect(await counts()).toEqual(after);
    expect(await stockOf(cola.id)).toBe(22_000);
  });

  it('rejects discounts without pos.discount, under-payment, card over-payment and insufficient stock atomically', async () => {
    const before = await counts();
    const discount = await call(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000, discountCents: 10 }],
      payments: [{ method: 'cash', amountCents: 140 }],
    });
    expect(discount.status).toBe(403);
    const under = await call(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 149 }],
    });
    expect(under.status).toBe(400);
    const cardOver = await call(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'card', amountCents: 200 }],
    });
    expect(cardOver.status).toBe(400);
    const tooMany = await call<{ error: { details: { code: string; availableMilli: number } } }>(
      cashier.token,
      'POST',
      '/sales',
      {
        items: [
          { productId: cola.id, quantityMilli: 1000 },
          { productId: chips.id, quantityMilli: 50_000 },
        ],
        payments: [{ method: 'cash', amountCents: 100_000 }],
      },
    );
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.details).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      availableMilli: 9_000,
    });
    expect(await counts()).toEqual(before); // nothing partially written
    expect(await stockOf(cola.id)).toBe(22_000);
  });

  it('applies authorised discounts and mixed payments', async () => {
    const res = await call<SaleDetail>(owner.token, 'POST', '/sales', {
      items: [
        { productId: cola.id, quantityMilli: 1000, discountCents: 10 },
        { productId: chips.id, quantityMilli: 1000 },
      ],
      discountCents: 20,
      payments: [
        { method: 'card', amountCents: 200, reference: 'POS-1234' },
        { method: 'cash', amountCents: 50 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      subtotalCents: 260,
      discountCents: 20,
      totalCents: 240,
      paidCents: 250,
      changeCents: 10,
    });
    expect(res.body.items[0]).toMatchObject({ discountCents: 10, lineTotalCents: 140 });
    expect(res.body.payments.map((p) => [p.method, p.amountCents, p.reference])).toEqual([
      ['card', 200, 'POS-1234'],
      ['cash', 50, null],
    ]);
    const authorised = await ctx.pool.query<{ discount_authorized_by: string | null }>(
      'SELECT discount_authorized_by FROM sales WHERE id = $1',
      [res.body.id],
    );
    expect(authorised.rows[0]!.discount_authorized_by).toBe(owner.user.id);
  });

  it('suspends a sale without touching stock, then completes or voids it', async () => {
    const stock = await stockOf(cola.id);
    const parked = await call<SaleDetail>(cashier.token, 'POST', '/sales/suspend', {
      items: [{ productId: cola.id, quantityMilli: 3000 }],
      notes: 'Table 4',
    });
    expect(parked.status).toBe(201);
    expect(parked.body).toMatchObject({
      status: 'suspended',
      receiptNo: null,
      totalCents: 450,
      notes: 'Table 4',
    });
    expect(await stockOf(cola.id)).toBe(stock);
    const list = await call<SalesListResponse>(cashier.token, 'GET', '/sales?status=suspended');
    expect(list.body.items.map((s) => s.id)).toEqual([parked.body.id]);

    const done = await call<SaleDetail>(
      cashier.token,
      'POST',
      `/sales/${parked.body.id}/complete`,
      {
        items: [
          { productId: cola.id, quantityMilli: 3000 },
          { productId: chips.id, quantityMilli: 1000 },
        ],
        payments: [{ method: 'cash', amountCents: 600 }],
      },
    );
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'completed', totalCents: 570, changeCents: 30 });
    expect(done.body.receiptNo).toMatch(new RegExp(`^R-${YEAR}-\\d{6}$`));
    expect(await stockOf(cola.id)).toBe(stock - 3000);
    expect(
      (
        await call(cashier.token, 'POST', `/sales/${parked.body.id}/complete`, {
          items: [{ productId: cola.id, quantityMilli: 1000 }],
          payments: [{ method: 'cash', amountCents: 150 }],
        })
      ).status,
    ).toBe(409);

    const parked2 = await call<SaleDetail>(cashier.token, 'POST', '/sales/suspend', {
      items: [{ productId: chips.id, quantityMilli: 1000 }],
    });
    expect((await call(cashier.token, 'POST', `/sales/${parked2.body.id}/void`)).status).toBe(204);
    expect(
      (await call<SaleDetail>(cashier.token, 'GET', `/sales/${parked2.body.id}`)).body.status,
    ).toBe('void');
  });

  it('refunds partially and fully with restock, refund numbers and refund payments', async () => {
    const asCashier = await call(cashier.token, 'POST', `/sales/${firstSale.id}/refund`, {
      items: [{ saleItemId: firstSale.items[0]!.id, quantityMilli: 1000 }],
      reason: 'Customer returned it',
    });
    expect(asCashier.status).toBe(403);

    const stock = await stockOf(cola.id);
    const partial = await call<SaleDetail>(owner.token, 'POST', `/sales/${firstSale.id}/refund`, {
      items: [{ saleItemId: firstSale.items[0]!.id, quantityMilli: 1000 }],
      reason: 'Customer returned it',
      restock: true,
    });
    expect(partial.status).toBe(200);
    expect(partial.body).toMatchObject({ status: 'partially_refunded', refundedCents: 150 });
    expect(partial.body.refunds[0]).toMatchObject({
      refundNo: `K-${YEAR}-000001`,
      totalCents: 150,
      method: 'cash',
      items: [{ saleItemId: firstSale.items[0]!.id, quantityMilli: 1000, amountCents: 150 }],
    });
    expect(partial.body.payments.filter((p) => p.kind === 'refund')).toHaveLength(1);
    expect(await stockOf(cola.id)).toBe(stock + 1000);

    const tooMuch = await call(owner.token, 'POST', `/sales/${firstSale.id}/refund`, {
      items: [{ saleItemId: firstSale.items[0]!.id, quantityMilli: 2000 }],
      reason: 'too much',
    });
    expect(tooMuch.status).toBe(409);

    const rest = await call<SaleDetail>(owner.token, 'POST', `/sales/${firstSale.id}/refund`, {
      items: [
        { saleItemId: firstSale.items[0]!.id, quantityMilli: 1000 },
        { saleItemId: firstSale.items[1]!.id, quantityMilli: 1000 },
        { saleItemId: firstSale.items[2]!.id, quantityMilli: 3000 },
      ],
      reason: 'Wrong order',
      restock: false,
    });
    expect(rest.body).toMatchObject({ status: 'refunded', refundedCents: 570 });
    expect(await stockOf(cola.id)).toBe(stock + 1000); // restock=false
    expect(
      (
        await call(owner.token, 'POST', `/sales/${firstSale.id}/refund`, {
          items: [{ saleItemId: firstSale.items[0]!.id, quantityMilli: 1 }],
          reason: 'again',
        })
      ).status,
    ).toBe(409);
  });

  it('adjusts stock through movements, flags low stock and lists the ledger', async () => {
    const asCashier = await call(cashier.token, 'POST', `/products/${chips.id}/stock`, {
      newStockMilli: 50_000,
      reason: 'count',
    });
    expect(asCashier.status).toBe(403);
    const counted = await call<ProductSummary>(owner.token, 'POST', `/products/${chips.id}/stock`, {
      type: 'stock_count',
      newStockMilli: 5_000,
      reason: 'Monthly count',
    });
    expect(counted.status).toBe(200);
    expect(counted.body.stockMilli).toBe(5_000);
    const damaged = await call<ProductSummary>(owner.token, 'POST', `/products/${chips.id}/stock`, {
      type: 'damaged',
      quantityMilliDelta: -6_000,
      reason: 'Water damage',
    });
    expect(damaged.status).toBe(409); // would go negative
    const low = await call<ProductSummary>(owner.token, 'PATCH', `/products/${chips.id}`, {
      minStockMilli: 5_000,
    });
    expect(low.body.lowStock).toBe(true);
    const lowList = await call<{ items: ProductSummary[] }>(
      owner.token,
      'GET',
      '/products?lowStock=true',
    );
    expect(lowList.body.items.map((p) => p.id)).toEqual([chips.id]);

    const ledger = await call<{ items: InventoryMovementSummary[]; total: number }>(
      owner.token,
      'GET',
      `/inventory/movements?productId=${chips.id}`,
    );
    expect(ledger.body.items.map((m) => m.movementType)).toEqual([
      'stock_count',
      'sale',
      'sale',
      'sale',
      'initial',
    ]);
    expect(ledger.body.items[0]).toMatchObject({
      quantityMilliDelta: -2_000,
      stockAfterMilli: 5_000,
      reason: 'Monthly count',
    });
  });

  it('renders receipt data, lists sales with totals and archives sold products instead of deleting them', async () => {
    const receipt = await call<ReceiptData>(cashier.token, 'GET', `/sales/${firstSale.id}/receipt`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.business.name).toBe('Test Arena');
    expect(receipt.body.sale.items).toHaveLength(3);
    expect(receipt.body).toMatchObject({ currency: 'EUR', widthMm: 80, isReprint: false });
    const reprint = await call<ReceiptData>(
      cashier.token,
      'GET',
      `/sales/${firstSale.id}/receipt?reprint=true`,
    );
    expect(reprint.body.isReprint).toBe(true);
    const jobs = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM print_jobs WHERE document_id = $1 AND is_reprint`,
      [firstSale.id],
    );
    expect(Number(jobs.rows[0]!.n)).toBe(1);

    const list = await call<SalesListResponse>(owner.token, 'GET', '/sales');
    expect(list.body.summary.count).toBe(list.body.items.length);
    expect(list.body.summary.totalCents).toBe(570 + 240 + 570);
    expect(list.body.summary.refundedCents).toBe(570);
    const byReceipt = await call<SalesListResponse>(
      owner.token,
      'GET',
      `/sales?q=${firstSale.receiptNo}`,
    );
    expect(byReceipt.body.items.map((s) => s.id)).toEqual([firstSale.id]);

    const archived = await call<{ archived: boolean }>(
      owner.token,
      'DELETE',
      `/products/${cola.id}`,
    );
    expect(archived.body).toEqual({ archived: true });
    const unused = await call<ProductSummary>(owner.token, 'POST', '/products', {
      name: 'Temp',
      sellingPriceCents: 1,
    });
    expect(
      (await call<{ archived: boolean }>(owner.token, 'DELETE', `/products/${unused.body.id}`))
        .body,
    ).toEqual({ archived: false });
    const sellArchived = await call(owner.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(sellArchived.status).toBe(409);
  });
});
