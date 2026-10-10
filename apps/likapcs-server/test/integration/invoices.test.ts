/**
 * Phase 7 — invoices: gap-free F-numbers, one live invoice per sale, buyer snapshot, print
 * logging, void + re-issue, permissions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CustomerSummary,
  InvoiceData,
  InvoiceDetail,
  InvoicesListResponse,
  LoginResponse,
  ProductSummary,
  SaleDetail,
} from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

const YEAR = String(new Date().getFullYear());

describe('invoices', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let accountant: LoginResponse;
  let cola: ProductSummary;
  let customer: CustomerSummary;
  let sale: SaleDetail;
  let suspended: SaleDetail;
  let invoice: InvoiceDetail;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));

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
    await call(owner.token, 'PATCH', '/settings', {
      'business.name': 'Arena Gaming',
      'business.tax_id': '811223344',
      'business.address': 'Rr. Adem Jashari 12',
      'business.city': 'Mitrovicë',
      'printing.invoice_bank_details': 'ProCredit Bank · XK05 1234 5678 9012 3456',
      'printing.invoice_footer': 'Payment within the due date. Thank you!',
      'printing.invoice_due_days': 14,
    });
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Coca-Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 50_000,
      })
    ).body;
    customer = (
      await call<CustomerSummary>(owner.token, 'POST', '/customers', {
        name: 'Byte Solutions SH.P.K.',
        phone: '+383 44 000 000',
        email: 'office@byte.example',
      })
    ).body;
    sale = (
      await call<SaleDetail>(cashier.token, 'POST', '/sales', {
        items: [{ productId: cola.id, quantityMilli: 4000 }],
        payments: [{ method: 'card', amountCents: 600 }],
      })
    ).body;
    expect(sale.status).toBe('completed');
    suspended = (
      await call<SaleDetail>(cashier.token, 'POST', '/sales/suspend', {
        items: [{ productId: cola.id, quantityMilli: 1000 }],
      })
    ).body;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('issues a numbered invoice with a buyer snapshot and the default payment term', async () => {
    const created = await call<InvoiceDetail>(cashier.token, 'POST', '/invoices', {
      saleId: sale.id,
      customerId: customer.id,
      billingName: 'Byte Solutions SH.P.K.',
      billingTaxId: '600112233',
      billingAddress: 'Rr. UÇK 5, Prishtinë',
      billingEmail: 'office@byte.example',
      notes: 'PO 2026-17',
    });
    expect(created.status).toBe(201);
    invoice = created.body;
    expect(invoice).toMatchObject({
      invoiceNo: `F-${YEAR}-000001`,
      status: 'issued',
      saleId: sale.id,
      receiptNo: sale.receiptNo,
      customerId: customer.id,
      billingName: 'Byte Solutions SH.P.K.',
      billingTaxId: '600112233',
      totalCents: 600,
      printCount: 0,
      issuedByName: 'kasa user',
    });
    expect(invoice.sale.items).toHaveLength(1);
    const dueMs =
      new Date(invoice.dueAt!).getTime() - new Date(invoice.issuedAt).setUTCHours(0, 0, 0, 0);
    expect(Math.round(dueMs / 86_400_000)).toBe(14);

    // The sale now carries its live invoice.
    const s = await call<SaleDetail>(owner.token, 'GET', `/sales/${sale.id}`);
    expect(s.body.invoiceNo).toBe(`F-${YEAR}-000001`);
    expect(s.body.invoiceId).toBe(invoice.id);
  });

  it('refuses a second live invoice, suspended sales and unknown customers', async () => {
    const dup = await call<{ error: { code: string; details: { invoiceNo: string } } }>(
      owner.token,
      'POST',
      '/invoices',
      { saleId: sale.id, billingName: 'Someone else' },
    );
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('INVOICE_EXISTS');
    expect(dup.body.error.details.invoiceNo).toBe(`F-${YEAR}-000001`);

    const notCompleted = await call(owner.token, 'POST', '/invoices', {
      saleId: suspended.id,
      billingName: 'Walk-in',
    });
    expect(notCompleted.status).toBe(409);

    const badCustomer = await call(owner.token, 'POST', '/invoices', {
      saleId: suspended.id,
      customerId: '00000000-0000-4000-8000-000000000000',
      billingName: 'Walk-in',
    });
    expect([400, 409]).toContain(badCustomer.status);
  });

  it('renders the document with business details and logs prints (reprints audited)', async () => {
    const first = await call<InvoiceData>(
      accountant.token,
      'GET',
      `/invoices/${invoice.id}/document`,
    );
    expect(first.status).toBe(200);
    expect(first.body.isReprint).toBe(false);
    expect(first.body.business).toMatchObject({
      name: 'Arena Gaming',
      taxId: '811223344',
      city: 'Mitrovicë',
      bankDetails: 'ProCredit Bank · XK05 1234 5678 9012 3456',
      footer: 'Payment within the due date. Thank you!',
    });
    expect(first.body.invoice.printCount).toBe(1);
    expect(first.body.sale.items[0]).toMatchObject({
      description: 'Coca-Cola 0.5L',
      quantityMilli: 4000,
    });
    expect(first.body.currency).toBe('EUR');

    const second = await call<InvoiceData>(owner.token, 'GET', `/invoices/${invoice.id}/document`);
    expect(second.body.isReprint).toBe(true);
    expect(second.body.invoice.printCount).toBe(2);
    const jobs = await ctx.pool.query<{ is_reprint: boolean }>(
      `SELECT is_reprint FROM print_jobs WHERE document_type = 'invoice' AND document_id = $1 ORDER BY id`,
      [invoice.id],
    );
    expect(jobs.rows).toEqual([{ is_reprint: false }, { is_reprint: true }]);
    const audit = await ctx.pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE entity_type = 'invoice' AND entity_id = $1 ORDER BY id`,
      [invoice.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['invoice.created', 'invoice.reprinted']);
  });

  it('lists, filters and totals invoices', async () => {
    const all = await call<InvoicesListResponse>(accountant.token, 'GET', '/invoices');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(1);
    expect(all.body.summary).toEqual({ count: 1, totalCents: 600 });
    const byName = await call<InvoicesListResponse>(owner.token, 'GET', '/invoices?q=byte');
    expect(byName.body.items).toHaveLength(1);
    const none = await call<InvoicesListResponse>(owner.token, 'GET', '/invoices?q=nothing-here');
    expect(none.body.items).toHaveLength(0);
    const byCustomer = await call<InvoicesListResponse>(
      owner.token,
      'GET',
      `/invoices?customerId=${customer.id}&status=issued`,
    );
    expect(byCustomer.body.items[0]!.invoiceNo).toBe(`F-${YEAR}-000001`);
  });

  it('voids an invoice (number kept) and allows a replacement with the next number', async () => {
    const short = await call(owner.token, 'POST', `/invoices/${invoice.id}/void`, { reason: 'x' });
    expect(short.status).toBe(400);
    const voided = await call<InvoiceDetail>(owner.token, 'POST', `/invoices/${invoice.id}/void`, {
      reason: 'Wrong buyer tax id',
    });
    expect(voided.status).toBe(200);
    expect(voided.body).toMatchObject({
      status: 'void',
      invoiceNo: `F-${YEAR}-000001`,
      voidReason: 'Wrong buyer tax id',
      voidedByName: 'Shop Owner',
    });
    expect(
      (await call(owner.token, 'POST', `/invoices/${invoice.id}/void`, { reason: 'again' })).status,
    ).toBe(409);
    const s = await call<SaleDetail>(owner.token, 'GET', `/sales/${sale.id}`);
    expect(s.body.invoiceNo).toBeNull();

    const replacement = await call<InvoiceDetail>(owner.token, 'POST', '/invoices', {
      saleId: sale.id,
      billingName: 'Byte Solutions SH.P.K.',
      billingTaxId: '600112244',
      dueDays: 0,
    });
    expect(replacement.status).toBe(201);
    expect(replacement.body.invoiceNo).toBe(`F-${YEAR}-000002`);
    expect(replacement.body.dueAt).toBe(replacement.body.issuedAt.slice(0, 10));
    const list = await call<InvoicesListResponse>(owner.token, 'GET', '/invoices');
    expect(list.body.total).toBe(2);
    expect(list.body.summary.totalCents).toBe(600); // void invoices are not counted
  });

  it('enforces permissions: accountants read, cashiers issue, nobody without invoices.view', async () => {
    expect(
      (await call(accountant.token, 'POST', '/invoices', { saleId: sale.id, billingName: 'x' }))
        .status,
    ).toBe(403);
    expect(
      (await call(accountant.token, 'POST', `/invoices/${invoice.id}/void`, { reason: 'nope!' }))
        .status,
    ).toBe(403);
    expect((await call(cashier.token, 'GET', '/invoices')).status).toBe(200);
    await call(owner.token, 'POST', '/users', {
      username: 'depo',
      fullName: 'Depo Inventory',
      password: 'Password123',
      roles: ['inventory'],
      mustChangePassword: false,
    });
    const inventory = await login(ctx.app, 'depo', 'Password123');
    expect((await call(inventory.token, 'GET', '/invoices')).status).toBe(403);
  });
});
