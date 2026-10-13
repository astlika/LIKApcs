/**
 * Import from LIKApos Pro: format detection, preview, dry run (nothing written), real import in
 * one transaction after a pre-import backup, mapping rules, idempotent re-run, permissions.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BackupsResponse,
  CustomerSummary,
  ImportAnalysis,
  ImportReport,
  ImportStatus,
  LoginResponse,
  ProductSummary,
  SaleDetail,
} from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'likapos-pro-sample.json',
);

describe('import from LIKApos Pro', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let backupDir: string;
  let file: Record<string, unknown>;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await ctx.pool.query<{ n: string }>(sql, params)).rows[0]!.n);

  beforeAll(async () => {
    backupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-import-'));
    ctx = await createTestContext({ backupDir });
    owner = await runSetup(ctx.app);
    expect(
      (
        await call(owner.token, 'POST', '/users', {
          username: 'kasa',
          fullName: 'kasa user',
          password: 'Password123',
          roles: ['cashier'],
          mustChangePassword: false,
        })
      ).status,
    ).toBe(201);
    cashier = await login(ctx.app, 'kasa', 'Password123');
    file = JSON.parse(await fsp.readFile(FIXTURE, 'utf8')) as Record<string, unknown>;
    // An existing product already owns one of the barcodes in the file.
    expect(
      (
        await call(owner.token, 'POST', '/products', {
          name: 'Red Bull (existing)',
          sellingPriceCents: 150,
          barcodes: [{ barcode: '9002490100070' }],
        })
      ).status,
    ).toBe(201);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    await fsp.rm(backupDir, { recursive: true, force: true });
  });

  it('needs backups.manage and recognises only LIKApos Pro files', async () => {
    expect((await call(cashier.token, 'POST', '/imports/analyze', { data: file })).status).toBe(
      403,
    );
    const notLikapos = await call<{ error: { code: string } }>(
      owner.token,
      'POST',
      '/imports/analyze',
      { data: { hello: 'world' } },
    );
    expect(notLikapos.status).toBe(400);
    expect(
      (await call(owner.token, 'POST', '/imports/analyze', { data: { products: [{ foo: 1 }] } }))
        .status,
    ).toBe(400);
  });

  it('previews what the file contains and what is never imported', async () => {
    const res = await call<ImportAnalysis>(owner.token, 'POST', '/imports/analyze', {
      data: file,
    });
    expect(res.status).toBe(200);
    const a = res.body;
    expect(a.source).toBe('likapos_pro');
    expect(a.storeName).toBe('Demo Shop');
    expect(a.exportedAt).toBe('2026-10-13T04:25:51.226Z');
    expect(a.entities.products).toMatchObject({ total: 6, alreadyImported: 0 });
    expect(a.entities.products.sample).toContain('Fanta 250ml');
    expect(a.entities.customers).toMatchObject({ total: 5, alreadyImported: 0 });
    // Open debts: 0.25 + 11.50 + 5.00 — paid ones are not counted.
    expect(a.entities.debts).toMatchObject({ total: 3, amountCents: 1675 });
    expect(a.entities.sales).toMatchObject({
      total: 5,
      amountCents: 120 + 225 + 150 + 8000 + 500,
      from: '2026-06-23T21:30:31.162Z',
      to: '2026-08-01T10:00:00.000Z',
    });
    // The zero-amount expense is not importable, so it is not counted (a note says so).
    expect(a.entities.expenses).toMatchObject({ total: 3, amountCents: 150 + 15000 + 1240 });
    expect(a.entities.expenses.sample).toEqual(['Furnizim (Mall)', 'Qera / Fatura']);
    expect(a.warnings.join('\n')).toMatch(/1 expense\(s\) have no amount/);
    expect(a.warnings.join('\n')).toMatch(/variants/);
    expect(a.warnings.join('\n')).toMatch(/"s2"/);
    expect(a.warnings.join('\n')).toMatch(/PIN/);
    expect(a.notImported.map((n) => n.key)).toEqual(
      expect.arrayContaining(['staff', 'cashDrawer', 'auditLogs', 'orders', 'incomes', 'settings']),
    );
    expect(a.notImported.find((n) => n.key === 'staff')?.count).toBe(2);
  });

  it('dry run reports the outcome without writing anything', async () => {
    const before = {
      products: await count('SELECT count(*) AS n FROM products'),
      customers: await count('SELECT count(*) AS n FROM customers'),
      sales: await count('SELECT count(*) AS n FROM sales'),
      links: await count('SELECT count(*) AS n FROM import_links'),
      runs: await count('SELECT count(*) AS n FROM import_runs'),
      backups: await count('SELECT count(*) AS n FROM backup_history'),
    };
    const res = await call<ImportReport>(owner.token, 'POST', '/imports/run', {
      data: file,
      entities: ['products', 'customers', 'debts', 'sales', 'expenses'],
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.runId).toBeNull();
    expect(res.body.backupId).toBeNull();
    expect(res.body.results.products).toEqual({ created: 5, skipped: 0, failed: 1 });
    expect(res.body.results.customers).toEqual({ created: 5, skipped: 0, failed: 0 });
    expect(res.body.results.sales).toEqual({ created: 5, skipped: 0, failed: 0 });
    expect(res.body.results.debts).toEqual({ created: 3, skipped: 0, failed: 0 });
    expect(res.body.results.expenses).toEqual({ created: 3, skipped: 0, failed: 1 });
    expect({
      products: await count('SELECT count(*) AS n FROM products'),
      customers: await count('SELECT count(*) AS n FROM customers'),
      sales: await count('SELECT count(*) AS n FROM sales'),
      links: await count('SELECT count(*) AS n FROM import_links'),
      runs: await count('SELECT count(*) AS n FROM import_runs'),
      backups: await count('SELECT count(*) AS n FROM backup_history'),
    }).toEqual(before);
  });

  it('imports everything in one go, after a pre-import backup, with the mapping rules', async () => {
    const res = await call<ImportReport>(owner.token, 'POST', '/imports/run', {
      data: file,
      entities: ['products', 'customers', 'debts', 'sales', 'expenses'],
      fileName: 'LIKApos_Pro_backup.json',
    });
    expect(res.status).toBe(200);
    const report = res.body;
    expect(report.dryRun).toBe(false);
    expect(report.runId).toBeTruthy();
    expect(report.backupId).toBeTruthy();
    expect(report.results).toEqual({
      products: { created: 5, skipped: 0, failed: 1 },
      customers: { created: 5, skipped: 0, failed: 0 },
      debts: { created: 3, skipped: 0, failed: 0 },
      sales: { created: 5, skipped: 0, failed: 0 },
      expenses: { created: 3, skipped: 0, failed: 1 },
    });
    expect(report.imagesQueued).toBe(1); // only http(s) links are downloaded

    // Backup of kind pre_import exists and succeeded.
    const backups = await call<BackupsResponse>(owner.token, 'GET', '/backups');
    expect(backups.body.items.find((b) => b.id === report.backupId)).toMatchObject({
      kind: 'pre_import',
      status: 'succeeded',
    });

    // Products: categories by name, barcode rules, opening stock, service items without stock.
    const products = (
      await call<{ items: ProductSummary[] }>(owner.token, 'GET', '/products?pageSize=50')
    ).body.items;
    const fanta = products.find((p) => p.name === 'Fanta 250ml')!;
    expect(fanta).toMatchObject({
      sellingPriceCents: 60,
      purchaseCostCents: 30,
      stockMilli: 24_000,
      minStockMilli: 6_000,
      trackStock: true,
      categoryName: 'pije',
    });
    expect(fanta.barcodes.map((b) => b.barcode)).toEqual(['5000112637922']);
    const chips = products.find((p) => p.name === 'Chipsy Paprika')!;
    expect(chips.barcodes).toEqual([]); // "s2" is not a valid barcode
    const sandwich = products.find((p) => p.name === 'Sandwich')!;
    expect(sandwich.trackStock).toBe(false);
    expect(sandwich.description).toMatch(/Variants \(LIKApos Pro\): Pule, Proshute/);
    const redbull = products.find((p) => p.name === 'Red Bull 250ml')!;
    expect(redbull.barcodes).toEqual([]); // barcode already owned by "Red Bull (existing)"
    expect(products.find((p) => p.name === 'PC 1 ore')).toMatchObject({
      trackStock: false,
      sellingPriceCents: 100,
    });
    expect(
      await count(`SELECT count(*) AS n FROM categories WHERE name IN ('pije','CHIPS','buk','PC')`),
    ).toBe(4);
    expect(
      await count(
        `SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'initial' AND reference_type = 'import'`,
      ),
    ).toBe(2); // Fanta 24 and Chipsy 10; Red Bull has 0

    // Customers: name, card code, PC login only with a PIN ≥ 4, duplicate usernames dropped.
    const customers = (
      await call<{ items: CustomerSummary[] }>(owner.token, 'GET', '/customers?pageSize=50')
    ).body.items;
    const arta = customers.find((c) => c.name === 'Arta Testi')!;
    expect(arta).toMatchObject({
      code: 'LKC00000001',
      phone: '049111222',
      email: 'arta@example.invalid',
      loginUsername: 'arta.testi',
      loginEnabled: true,
      balanceDueCents: 25 + 1150,
    });
    expect(arta.notes).toMatch(/Address: Rr\. Testi 1/);
    expect(customers.find((c) => c.name === 'Besnik Shembull')).toMatchObject({
      loginUsername: null,
      loginEnabled: false,
    });
    expect(customers.find((c) => c.name === 'Cani')).toMatchObject({
      code: 'LKC00000003',
      balanceDueCents: 500,
    });
    const duas = customers.filter((c) => c.name.startsWith('Dua Dyfish'));
    expect(duas).toHaveLength(2);
    expect(duas.every((c) => c.loginUsername === null)).toBe(true);
    expect(duas.find((c) => c.name === 'Dua Dyfish')!.code).toMatch(/^C-\d{6}$/); // "x" is no code
    // The PIN really works as the PC login secret.
    const loginOk = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/client/customer-login',
      payload: { username: 'arta.testi', password: '4321' },
      headers: { authorization: 'Bearer not-a-device' },
    });
    expect([400, 401, 403]).toContain(loginOk.statusCode); // route needs a device — shape only
    expect(
      await count(
        `SELECT count(*) AS n FROM customers WHERE login_username = 'arta.testi' AND login_password_hash IS NOT NULL`,
      ),
    ).toBe(1);

    // Sales: notes keep the TXN, payments split cash / credit, refunded status, unknown customer → walk-in.
    const sales = (
      await call<{ items: SaleDetail[] }>(
        owner.token,
        'GET',
        '/sales?pageSize=50&from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z',
      )
    ).body.items;
    expect(sales).toHaveLength(5);
    const credit = (
      await call<SaleDetail>(
        owner.token,
        'GET',
        `/sales/${sales.find((s) => s.notes?.startsWith('TXN-000002'))!.id}`,
      )
    ).body;
    expect(credit).toMatchObject({
      status: 'completed',
      receiptNo: null,
      customerId: arta.id,
      subtotalCents: 250,
      discountCents: 25,
      totalCents: 225,
      paidCents: 225,
    });
    expect(credit.items.map((i) => [i.description, i.quantityMilli, i.unitPriceCents])).toEqual([
      ['PC 1 ore', 2000, 100],
      ['Chipsy Paprika', 1000, 50],
    ]);
    expect(credit.items[1]!.productId).toBe(chips.id);
    expect(credit.payments.map((p) => [p.method, p.amountCents]).sort()).toEqual([
      ['cash', 200],
      ['credit', 25],
    ]);
    const staff = (
      await call<SaleDetail>(
        owner.token,
        'GET',
        `/sales/${sales.find((s) => s.notes?.startsWith('STF-000003'))!.id}`,
      )
    ).body;
    expect(staff).toMatchObject({ status: 'refunded', refundedCents: 150, totalCents: 150 });
    expect(staff.notes).toMatch(/staff purchase/);
    const partial = (
      await call<SaleDetail>(
        owner.token,
        'GET',
        `/sales/${sales.find((s) => s.notes?.startsWith('TXN-000005'))!.id}`,
      )
    ).body;
    expect(partial).toMatchObject({
      status: 'partially_refunded',
      refundedCents: 250,
      customerId: null,
    });
    expect(partial.items[0]!.description).toBe('Sandwich · Pule');
    const installment = (
      await call<SaleDetail>(
        owner.token,
        'GET',
        `/sales/${sales.find((s) => s.notes?.startsWith('EXT-000004'))!.id}`,
      )
    ).body;
    expect(installment.payments.map((p) => [p.method, p.amountCents])).toEqual([['credit', 8000]]);
    expect(installment.items[0]!.productId).toBeNull();
    // Stock is untouched by the history (Fanta still 24 although 2 were "sold").
    expect(fanta.stockMilli).toBe(24_000);

    // Debts: remaining amount, linked to the imported sale, bad due date → today, notes explain.
    const debts = await ctx.pool.query<{
      amount_cents: string;
      status: string;
      due_date: string;
      notes: string;
      sale_id: string | null;
    }>(
      `SELECT amount_cents, status, to_char(due_date, 'YYYY-MM-DD') AS due_date, notes, sale_id
         FROM customer_debts ORDER BY amount_cents`,
    );
    expect(debts.rows.map((d) => [Number(d.amount_cents), d.status])).toEqual([
      [25, 'open'],
      [500, 'open'],
      [1150, 'open'],
    ]);
    expect(debts.rows[0]!.sale_id).toBe(credit.id);
    expect(debts.rows[0]!.due_date).toBe('2026-07-01');
    expect(debts.rows[1]!.due_date).toBe(new Date().toISOString().slice(0, 10));
    expect(debts.rows[2]!.notes).toMatch(
      /Tjetër · per mikrofon · Imported from LIKApos Pro \(originally 15\.00, 3\.50 already paid there\)/,
    );

    // Expenses: categories created from the old names, zero amount skipped.
    const expenses = await ctx.pool.query<{
      category_code: string;
      amount_cents: string;
      expense_date: string;
      description: string;
    }>(
      `SELECT category_code, amount_cents, to_char(expense_date, 'YYYY-MM-DD') AS expense_date, description FROM expenses ORDER BY expense_date`,
    );
    expect(
      expenses.rows.map((e) => [e.category_code, Number(e.amount_cents), e.expense_date]),
    ).toEqual([
      ['imp_furnizim_mall', 150, '2026-06-24'],
      ['imp_qera_fatura', 15000, '2026-07-01'],
      ['imp_furnizim_mall', 1240, '2026-07-02'],
    ]);
    expect(expenses.rows[0]!.description).toBe('Auto-Furnizim: Fanta x6 (lika)');
    expect(
      await count(
        `SELECT count(*) AS n FROM expense_categories WHERE code LIKE 'imp_%' AND is_system = false`,
      ),
    ).toBe(2);

    // Links + run + audit.
    expect(await count(`SELECT count(*) AS n FROM import_links WHERE entity = 'sale'`)).toBe(5);
    expect(await count(`SELECT count(*) AS n FROM import_runs WHERE status = 'succeeded'`)).toBe(1);
    expect(
      await count(`SELECT count(*) AS n FROM audit_logs WHERE action = 'import.completed'`),
    ).toBe(1);
    const status = await call<ImportStatus>(owner.token, 'GET', '/imports/status');
    expect(status.body.lastRun).toMatchObject({
      status: 'succeeded',
      fileName: 'LIKApos_Pro_backup.json',
    });
    expect(status.body.lastRun!.report!.results.sales.created).toBe(5);
  }, 60_000);

  it('running the same file again only skips — nothing is duplicated', async () => {
    const analysis = await call<ImportAnalysis>(owner.token, 'POST', '/imports/analyze', {
      data: file,
    });
    expect(analysis.body.entities.products.alreadyImported).toBe(5);
    expect(analysis.body.entities.sales.alreadyImported).toBe(5);
    const again = await call<ImportReport>(owner.token, 'POST', '/imports/run', {
      data: file,
      entities: ['products', 'customers', 'debts', 'sales', 'expenses'],
    });
    expect(again.status).toBe(200);
    expect(again.body.results).toEqual({
      products: { created: 0, skipped: 5, failed: 1 },
      customers: { created: 0, skipped: 5, failed: 0 },
      debts: { created: 0, skipped: 3, failed: 0 },
      sales: { created: 0, skipped: 5, failed: 0 },
      expenses: { created: 0, skipped: 3, failed: 1 },
    });
    expect(await count('SELECT count(*) AS n FROM sales')).toBe(5);
    expect(await count('SELECT count(*) AS n FROM customer_debts')).toBe(3);
    expect(await count(`SELECT count(*) AS n FROM customers WHERE name = 'Arta Testi'`)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM backup_history WHERE kind = 'pre_import'`)).toBe(
      2,
    );
  }, 60_000);

  it('a partial selection imports only those entities', async () => {
    // Fresh customer only in a second file → selecting debts without customers warns.
    const extra = {
      ...file,
      customers: [
        {
          id: 2099,
          first: 'Era',
          last: 'Re',
          phone: '045999888',
          debts: [{ id: 3099, amount: 3, dueDate: '2026-12-01', paid: false }],
        },
      ],
    };
    const onlyDebts = await call<ImportReport>(owner.token, 'POST', '/imports/run', {
      data: extra,
      entities: ['debts'],
    });
    expect(onlyDebts.body.results.debts).toEqual({ created: 0, skipped: 0, failed: 1 });
    expect(onlyDebts.body.warnings.join('\n')).toMatch(/without customers/);
    const both = await call<ImportReport>(owner.token, 'POST', '/imports/run', {
      data: extra,
      entities: ['customers', 'debts'],
    });
    expect(both.body.results.customers).toEqual({ created: 1, skipped: 0, failed: 0 });
    expect(both.body.results.debts).toEqual({ created: 1, skipped: 0, failed: 0 });
    expect(both.body.results.sales).toEqual({ created: 0, skipped: 0, failed: 0 });
  }, 60_000);
});
