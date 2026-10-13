/**
 * Global search (Ctrl+K): document numbers in every spelling, customers by name / phone /
 * PC username, products by barcode, stations — each kind gated by the caller's permissions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CustomerSummary,
  InvoiceDetail,
  LoginResponse,
  ProductSummary,
  PurchaseDetail,
  SaleDetail,
  SearchResponse,
  StationSummary,
  SupplierSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

const YEAR = String(new Date().getFullYear());

describe('global search', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let accountant: LoginResponse;
  let cola: ProductSummary;
  let customer: CustomerSummary;
  let sale: SaleDetail;
  let refundNo: string;
  let invoice: InvoiceDetail;
  let purchase: PurchaseDetail;
  let station: StationSummary;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));
  const search = (token: string, q: string) =>
    call<SearchResponse>(token, 'GET', `/search?q=${encodeURIComponent(q)}`);
  const kinds = (res: SearchResponse) => [...new Set(res.hits.map((h) => h.kind))].sort();

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    for (const [username, roles] of [
      ['kasa', ['cashier']],
      ['konto', ['accountant']],
    ] as const) {
      expect(
        (
          await call(owner.token, 'POST', '/users', {
            username,
            fullName: `${username} user`,
            password: 'Password123',
            roles: [...roles],
            mustChangePassword: false,
          })
        ).status,
      ).toBe(201);
    }
    cashier = await login(ctx.app, 'kasa', 'Password123');
    accountant = await login(ctx.app, 'konto', 'Password123');
    await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 5000 });

    station = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 7, name: 'VIP 7' })
    ).body;
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Coca-Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 50_000,
        barcodes: [{ barcode: '5449000000996' }],
      })
    ).body;
    expect(cola.id).toBeDefined();
    customer = (
      await call<CustomerSummary>(owner.token, 'POST', '/customers', {
        name: 'Byte Solutions SH.P.K.',
        phone: '+383 44 123 456',
        email: 'office@byte.example',
        loginUsername: 'byte',
        loginPassword: '1234',
      })
    ).body;
    expect(customer.id).toBeDefined();
    sale = (
      await call<SaleDetail>(cashier.token, 'POST', '/sales', {
        customerId: customer.id,
        items: [{ productId: cola.id, quantityMilli: 4000 }],
        payments: [{ method: 'cash', amountCents: 600 }],
      })
    ).body;
    expect(sale.receiptNo).toBe(`R-${YEAR}-000001`);
    const refunded = await call<SaleDetail>(owner.token, 'POST', `/sales/${sale.id}/refund`, {
      items: [{ saleItemId: sale.items[0]!.id, quantityMilli: 1000 }],
      reason: 'Damaged bottle',
    });
    expect(refunded.status).toBe(200);
    refundNo = refunded.body.refunds[0]!.refundNo!;
    expect(refundNo).toBe(`K-${YEAR}-000001`);
    invoice = (
      await call<InvoiceDetail>(cashier.token, 'POST', '/invoices', {
        saleId: sale.id,
        customerId: customer.id,
        billingName: 'Byte Solutions SH.P.K.',
      })
    ).body;
    expect(invoice.invoiceNo).toBe(`F-${YEAR}-000001`);
    const supplier = (
      await call<SupplierSummary>(owner.token, 'POST', '/suppliers', { name: 'Pepsi Kosova' })
    ).body;
    purchase = (
      await call<PurchaseDetail>(owner.token, 'POST', '/purchases', {
        supplierId: supplier.id,
        supplierInvoiceNo: 'INV-77',
        items: [{ productId: cola.id, quantityMilli: 10_000, unitCostCents: 70 }],
        receiveNow: true,
      })
    ).body;
    expect(purchase.referenceNo).toBe(`B-${YEAR}-000001`);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('requires a signed-in user and at least one character', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/search?q=cola' });
    expect(anon.statusCode).toBe(401);
    expect((await search(owner.token, '')).status).toBe(400);
    expect((await call(owner.token, 'GET', '/search')).status).toBe(400);
  });

  it('finds a receipt by its number in every spelling and flags the exact one', async () => {
    for (const q of [`R-${YEAR}-000001`, 'r1', `R-${YEAR}-1`, `R${YEAR}000001`, ' r 1 ']) {
      const res = await search(owner.token, q);
      expect(res.status, q).toBe(200);
      expect(res.body.exact, q).toMatchObject({
        kind: 'sale',
        id: sale.id,
        receiptNo: `R-${YEAR}-000001`,
        totalCents: 600,
        customerName: 'Byte Solutions SH.P.K.',
      });
      expect(res.body.hits[0], q).toMatchObject({ kind: 'sale', id: sale.id });
    }
    // A bare counter is a search, not a jump: it lists the receipt but is not "exact".
    const bare = await search(owner.token, '1');
    expect(bare.body.exact).toBeNull();
    expect(bare.body.hits.some((h) => h.kind === 'sale' && h.id === sale.id)).toBe(true);
  });

  it('resolves refunds (K-), invoices (F-) and purchases (B-) to their records', async () => {
    const k = await search(owner.token, refundNo);
    expect(k.body.exact).toMatchObject({
      kind: 'refund',
      refundNo,
      saleId: sale.id,
      receiptNo: `R-${YEAR}-000001`,
      totalCents: 150,
    });
    const f = await search(owner.token, 'f1');
    expect(f.body.exact).toMatchObject({
      kind: 'invoice',
      id: invoice.id,
      invoiceNo: `F-${YEAR}-000001`,
      billingName: 'Byte Solutions SH.P.K.',
      saleId: sale.id,
    });
    const b = await search(owner.token, `b-${YEAR}-000001`);
    expect(b.body.exact).toMatchObject({
      kind: 'purchase',
      id: purchase.id,
      referenceNo: `B-${YEAR}-000001`,
      supplierName: 'Pepsi Kosova',
    });
    // The supplier's own invoice number is searchable too.
    const inv = await search(owner.token, 'INV-77');
    expect(inv.body.hits.some((h) => h.kind === 'purchase' && h.id === purchase.id)).toBe(true);
  });

  it('matches customers by name, phone and PC username; products by name and barcode; stations', async () => {
    for (const q of ['byte sol', '44 123', 'byte', 'office@byte']) {
      const res = await search(owner.token, q);
      expect(
        res.body.hits.find((h) => h.kind === 'customer'),
        q,
      ).toMatchObject({ id: customer.id, name: 'Byte Solutions SH.P.K.', loginUsername: 'byte' });
    }
    const byBarcode = await search(owner.token, '5449000000996');
    expect(byBarcode.body.hits.find((h) => h.kind === 'product')).toMatchObject({
      id: cola.id,
      name: 'Coca-Cola 0.5L',
      barcode: '5449000000996',
      sellingPriceCents: 150,
    });
    const byName = await search(owner.token, 'COLA');
    expect(byName.body.hits.find((h) => h.kind === 'product')).toMatchObject({ id: cola.id });
    for (const q of ['vip', 'PC 07', '7']) {
      const res = await search(owner.token, q);
      expect(
        res.body.hits.find((h) => h.kind === 'station'),
        q,
      ).toMatchObject({ id: station.id, code: 'PC 07', name: 'VIP 7', enabled: true });
    }
  });

  it('never leaks a kind the caller may not open', async () => {
    const all = await search(owner.token, 'a');
    expect(kinds(all.body)).toEqual(['customer', 'product']);
    const everything = await Promise.all(
      [`R-${YEAR}-000001`, refundNo, 'f1', 'b1', 'byte', 'cola', 'vip'].map((q) =>
        search(accountant.token, q),
      ),
    );
    const seen = new Set(everything.flatMap((r) => r.body.hits.map((h) => h.kind)));
    // Accountant: invoices/purchases/products/customers (finance) — never POS sales or stations.
    expect([...seen].sort()).toEqual(['customer', 'invoice', 'product', 'purchase']);
    expect(everything[0]!.body.exact).toBeNull();
    const cashierSees = new Set(
      (
        await Promise.all(
          [`R-${YEAR}-000001`, 'f1', 'b1', 'vip'].map((q) => search(cashier.token, q)),
        )
      ).flatMap((r) => r.body.hits.map((h) => h.kind)),
    );
    expect(cashierSees.has('sale')).toBe(true);
    expect(cashierSees.has('purchase')).toBe(false);
  });

  it('treats LIKE wildcards literally and caps each kind', async () => {
    expect((await search(owner.token, '%')).body.hits).toEqual([]);
    expect((await search(owner.token, '_')).body.hits).toEqual([]);
    for (let n = 1; n <= 8; n += 1) {
      await call(owner.token, 'POST', '/customers', { name: `Cap Test ${n}` });
    }
    const capped = await search(owner.token, 'cap test');
    expect(capped.body.hits.filter((h) => h.kind === 'customer')).toHaveLength(6);
    const wide = await call<SearchResponse>(owner.token, 'GET', '/search?q=cap%20test&limit=10');
    expect(wide.body.hits.filter((h) => h.kind === 'customer')).toHaveLength(8);
  });
});
