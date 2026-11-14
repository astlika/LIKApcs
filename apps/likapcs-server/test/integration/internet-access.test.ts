/**
 * 0.34.0 — internet access: Wi-Fi codes sold at the till as products. A package is a product whose
 * stock is its unused codes. Codes are pasted in bulk; each unit sold hands out the oldest unused
 * one, once, and it stays on the sale. The tests below hold the rules that keep a code from being
 * sold twice, lost, or handed out without a sale.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BackupSummary,
  InternetAccessCheckResult,
  InternetAccessCodeSummary,
  InternetAccessLoadResult,
  InternetAccessPackageSummary,
  InternetAccessRemoveResult,
  InventoryMovementSummary,
  LoginResponse,
  Paginated,
  ProductSummary,
  ReceiptData,
  SaleDetail,
  SessionMutationResponse,
  StationSummary,
  SupplierSummary,
  SyncSalesResponse,
} from '@likapcs/shared';
import {
  OWNER,
  authHeader,
  createTestContext,
  login,
  runSetup,
  type TestContext,
} from '../helpers.js';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

describe('internet access codes', () => {
  let ctx: TestContext;
  let backupDir: string;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let hour: ProductSummary;
  let day: ProductSummary;
  let cola: ProductSummary;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({ status: r.statusCode, body: (r.statusCode === 204 ? null : r.json()) as T }));

  const product = async (id: string) =>
    (await call<ProductSummary>(owner.token, 'GET', `/products/${id}`)).body;
  const codesOf = async (productId: string, status?: 'available' | 'sold') =>
    (
      await call<Paginated<InternetAccessCodeSummary>>(
        owner.token,
        'GET',
        `/internet-access/codes?productId=${productId}&pageSize=500${status ? `&status=${status}` : ''}`,
      )
    ).body.items;
  const packageOf = async (productId: string) =>
    (
      await call<{ items: InternetAccessPackageSummary[] }>(
        owner.token,
        'GET',
        '/internet-access/packages',
      )
    ).body.items.find((p) => p.product.id === productId)!;
  /** The stock and the unused codes of a package, which must always be the same number. */
  const level = async (productId: string) => {
    const [p, unused] = await Promise.all([product(productId), codesOf(productId, 'available')]);
    expect(p.stockMilli).toBe(unused.length * 1000);
    return unused.length;
  };
  const load = (body: Record<string, unknown>, token = owner.token) =>
    call<InternetAccessLoadResult & ErrorBody>(token, 'POST', '/internet-access/load', body);
  const sell = (
    items: { productId: string; quantityMilli: number; discountCents?: number }[],
    amountCents: number,
    extra: Record<string, unknown> = {},
    token = cashier.token,
  ) =>
    call<SaleDetail & ErrorBody>(token, 'POST', '/sales', {
      items: items.map((i) => ({ discountCents: 0, addonIds: [], ...i })),
      payments: [{ method: 'cash', amountCents }],
      accessCodes: true,
      ...extra,
    });
  const batch = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(3, '0')}`);

  beforeAll(async () => {
    backupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-internet-'));
    ctx = await createTestContext(
      { backupDir },
      process.env.DEBUG_LOG ? { logger: { level: 'error' } } : {},
    );
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
    expect(
      (await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 2000 })).status,
    ).toBe(201);
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Cola',
        sellingPriceCents: 150,
        initialStockMilli: 10_000,
      })
    ).body;
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
    await fsp.rm(backupDir, { recursive: true, force: true });
  });

  it('creates a package together with its codes; the stock is the number of codes', async () => {
    const res = await load({
      package: { name: 'Internet 1h', sellingPriceCents: 100, lowAtCodes: 3 },
      codes: batch('H1', 6),
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.added).toBe(6);
    expect(res.body.fresh).toBe(6);
    expect(res.body.waiting).toEqual([]);
    expect(res.body.soldBefore).toEqual([]);
    expect(res.body.batchId).toMatch(/^[0-9a-f-]{36}$/);
    hour = res.body.package.product;
    expect(hour).toMatchObject({
      name: 'Internet 1h',
      kind: 'internet_access',
      sellingPriceCents: 100,
      stockMilli: 6000,
      minStockMilli: 3000,
      trackStock: true,
      allowNegativeStock: false,
      unitCode: 'pc',
      clientMenu: false,
      lowStock: false,
    });
    expect(hour.sku).toMatch(/^SKU-\d{6}$/);
    expect(res.body.package).toMatchObject({ availableCodes: 6, soldCodes: 0, lastSoldAt: null });

    // It is an ordinary product for the till: listed with the others, and on its own by kind.
    const all = await call<Paginated<ProductSummary>>(owner.token, 'GET', '/products?pageSize=200');
    expect(all.body.items.map((p) => [p.name, p.kind])).toEqual(
      expect.arrayContaining([
        ['Cola', 'standard'],
        ['Internet 1h', 'internet_access'],
      ]),
    );
    const onlyAccess = await call<Paginated<ProductSummary>>(
      owner.token,
      'GET',
      '/products?kind=internet_access',
    );
    expect(onlyAccess.body.items.map((p) => p.name)).toEqual(['Internet 1h']);

    // The load is a stock movement of its own kind, so the history says what happened.
    const moves = await call<Paginated<InventoryMovementSummary>>(
      owner.token,
      'GET',
      `/inventory/movements?productId=${hour.id}`,
    );
    expect(moves.body.items.map((m) => [m.movementType, m.quantityMilliDelta])).toEqual([
      ['codes_loaded', 6000],
    ]);
    // Kept in the order they were pasted: that is the order they are sold in.
    expect((await codesOf(hour.id)).map((c) => [c.code, c.status])).toEqual(
      batch('H1', 6).map((code) => [code, 'available']),
    );
  });

  it('adds codes to an existing package and a second package of its own', async () => {
    const more = await load({ productId: hour.id, codes: batch('H2', 4) });
    expect(more.status).toBe(200);
    expect(more.body).toMatchObject({ created: false, added: 4 });
    expect(await level(hour.id)).toBe(10);

    const second = await load({
      package: { name: 'Internet 1 ditë', sellingPriceCents: 300 },
      codes: batch('D1', 3),
    });
    expect(second.status).toBe(201);
    day = second.body.package.product;
    expect(day.minStockMilli).toBe(10_000); // the default "running low" level: 10 codes
    expect(day.lowStock).toBe(true);

    // Cheapest first: 1h before a day.
    const list = await call<{ items: InternetAccessPackageSummary[] }>(
      cashier.token,
      'GET',
      '/internet-access/packages',
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((p) => [p.product.name, p.availableCodes])).toEqual([
      ['Internet 1h', 10],
      ['Internet 1 ditë', 3],
    ]);

    // Two packages with one name could not be told apart on the till.
    const twin = await load({
      package: { name: 'internet 1H', sellingPriceCents: 100 },
      codes: ['TWIN-001'],
    });
    expect(twin.status).toBe(409);
    expect(twin.body.error.details).toMatchObject({ code: 'ACCESS_PACKAGE_EXISTS' });
    expect((await codesOf(hour.id)).some((c) => c.code === 'TWIN-001')).toBe(false);
  });

  it('never loads a code twice: a list pasted again adds nothing', async () => {
    const check = await call<InternetAccessCheckResult>(
      owner.token,
      'POST',
      '/internet-access/check',
      { codes: ['H1-001', 'D1-002', 'NEW-001'] },
    );
    expect(check.status).toBe(200);
    expect(check.body.fresh).toBe(1);
    expect(check.body.soldBefore).toEqual([]);
    expect(check.body.waiting.map((k) => [k.code, k.productName, k.soldAt])).toEqual([
      ['H1-001', 'Internet 1h', null],
      ['D1-002', 'Internet 1 ditë', null],
    ]);
    expect(await level(hour.id)).toBe(10); // a check changes nothing

    const again = await load({
      productId: hour.id,
      codes: [...batch('H1', 6), 'H3-001', 'D1-001'],
    });
    expect(again.status).toBe(200);
    expect(again.body.added).toBe(1); // only H3-001 is new; D1-001 waits in the other package
    expect(again.body.waiting).toHaveLength(7);
    expect(await level(hour.id)).toBe(11);
    expect(await level(day.id)).toBe(3);

    const nothingNew = await load({ productId: hour.id, codes: batch('H1', 6) });
    expect(nothingNew.status).toBe(200);
    expect(nothingNew.body).toMatchObject({ added: 0, batchId: null });
    expect(await level(hour.id)).toBe(11);
  });

  it('checks every pasted code and asks for a package or a product, never both', async () => {
    expect((await load({ productId: hour.id, codes: ['ab'] })).status).toBe(400); // too short
    expect((await load({ productId: hour.id, codes: ['has space'] })).status).toBe(400);
    expect((await load({ productId: hour.id, codes: [] })).status).toBe(400);
    expect((await load({ codes: ['ABCD-1'] })).status).toBe(400);
    expect(
      (
        await load({
          productId: hour.id,
          package: { name: 'X', sellingPriceCents: 1 },
          codes: ['ABCD-1'],
        })
      ).status,
    ).toBe(400);
    const notAccess = await load({ productId: cola.id, codes: ['ABCD-1'] });
    expect(notAccess.status).toBe(409);
    expect(notAccess.body.error.details).toMatchObject({ code: 'NOT_INTERNET_ACCESS' });
    expect(await level(hour.id)).toBe(11);
  });

  it('only who manages the products sees or changes the codes', async () => {
    expect((await call(cashier.token, 'GET', '/internet-access/codes')).status).toBe(403);
    expect(
      (await call(cashier.token, 'POST', '/internet-access/check', { codes: ['H1-001'] })).status,
    ).toBe(403);
    expect((await load({ productId: hour.id, codes: ['SNEAK-1'] }, cashier.token)).status).toBe(
      403,
    );
    expect(
      (
        await call(cashier.token, 'POST', '/internet-access/remove', {
          productId: hour.id,
          all: true,
          reason: 'no',
        })
      ).status,
    ).toBe(403);
    expect((await call(cashier.token, 'GET', '/internet-access/packages')).status).toBe(200);
    expect(await level(hour.id)).toBe(11);
  });

  it('a sale hands out the oldest unused codes, one per unit, and keeps them on the sale', async () => {
    const res = await sell([{ productId: hour.id, quantityMilli: 2000 }], 200);
    expect(res.status).toBe(201);
    const sale = res.body;
    expect(sale.totalCents).toBe(200);
    expect(sale.items).toHaveLength(1);
    expect(sale.items[0]).toMatchObject({
      description: 'Internet 1h',
      quantityMilli: 2000,
      accessCodes: ['H1-001', 'H1-002'],
    });
    expect(await level(hour.id)).toBe(9);

    // The codes stay with the sale: a later read, the receipt and a reprint all show them.
    const later = await call<SaleDetail>(cashier.token, 'GET', `/sales/${sale.id}`);
    expect(later.body.items[0]!.accessCodes).toEqual(['H1-001', 'H1-002']);
    const receipt = await call<ReceiptData>(cashier.token, 'GET', `/sales/${sale.id}/receipt`);
    expect(receipt.body.sale.items[0]!.accessCodes).toEqual(['H1-001', 'H1-002']);
    const reprint = await call<ReceiptData>(
      cashier.token,
      'GET',
      `/sales/${sale.id}/receipt?reprint=true`,
    );
    expect(reprint.body.isReprint).toBe(true);
    expect(reprint.body.sale.items[0]!.accessCodes).toEqual(['H1-001', 'H1-002']);

    // The owner's list says which sale each code left with, and who sold it.
    const sold = await codesOf(hour.id, 'sold');
    expect(sold.map((c) => c.code).sort()).toEqual(['H1-001', 'H1-002']);
    expect(sold[0]).toMatchObject({
      status: 'sold',
      saleId: sale.id,
      receiptNo: sale.receiptNo,
      soldByName: 'Kasa Cashier',
    });
    expect(sold[0]!.soldAt).toBeTruthy();
    expect(await packageOf(hour.id)).toMatchObject({ availableCodes: 9, soldCodes: 2 });

    // Finding a code a customer complains about: by the code itself, across packages.
    const found = await call<Paginated<InternetAccessCodeSummary>>(
      owner.token,
      'GET',
      '/internet-access/codes?q=H1-002',
    );
    expect(found.body.items.map((c) => [c.code, c.receiptNo])).toEqual([
      ['H1-002', sale.receiptNo],
    ]);

    const moves = await call<Paginated<InventoryMovementSummary>>(
      owner.token,
      'GET',
      `/inventory/movements?productId=${hour.id}&type=sale`,
    );
    expect(moves.body.items.map((m) => m.quantityMilliDelta)).toEqual([-2000]);
  });

  it('sells internet access next to ordinary products; other lines carry no code', async () => {
    const res = await sell(
      [
        { productId: cola.id, quantityMilli: 2000 },
        { productId: day.id, quantityMilli: 1000 },
      ],
      1000,
    );
    expect(res.status).toBe(201);
    expect(res.body.totalCents).toBe(600);
    expect(res.body.changeCents).toBe(400);
    expect(res.body.items.map((i) => [i.description, i.accessCodes])).toEqual([
      ['Cola', []],
      ['Internet 1 ditë', ['D1-001']],
    ]);
    expect(await level(day.id)).toBe(2);
  });

  it('the same request sent twice sells once and answers with the same codes', async () => {
    const body = { clientRequestId: 'internet-retry-0001' };
    const first = await sell([{ productId: hour.id, quantityMilli: 1000 }], 100, body);
    expect(first.status).toBe(201);
    expect(first.body.items[0]!.accessCodes).toEqual(['H1-003']);
    const again = await sell([{ productId: hour.id, quantityMilli: 1000 }], 100, body);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.items[0]!.accessCodes).toEqual(['H1-003']);
    expect(await level(hour.id)).toBe(8);
  });

  it('gives each line its own codes when a package is on the sale twice', async () => {
    const res = await sell(
      [
        { productId: hour.id, quantityMilli: 2000 },
        { productId: cola.id, quantityMilli: 1000 },
        { productId: hour.id, quantityMilli: 1000 },
      ],
      450,
      {},
      owner.token,
    );
    expect(res.status).toBe(201);
    expect(res.body.items.map((i) => i.accessCodes)).toEqual([
      ['H1-004', 'H1-005'],
      [],
      ['H1-006'],
    ]);
    expect(await level(hour.id)).toBe(5);
  });

  it('refuses a till that cannot show the code, and takes nothing', async () => {
    const before = await level(hour.id);
    const sales = await ctx.pool.query('SELECT count(*) FROM sales');
    const res = await call<ErrorBody>(cashier.token, 'POST', '/sales', {
      items: [{ productId: hour.id, quantityMilli: 1000, discountCents: 0, addonIds: [] }],
      payments: [{ method: 'cash', amountCents: 100 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({
      code: 'ACCESS_CODES_NOT_SHOWN',
      productName: 'Internet 1h',
    });
    expect(await level(hour.id)).toBe(before);
    expect((await ctx.pool.query('SELECT count(*) FROM sales')).rows).toEqual(sales.rows);
  });

  it('sells whole codes only, and never more than there are', async () => {
    const half = await sell([{ productId: hour.id, quantityMilli: 1500 }], 150);
    expect(half.status).toBe(400);
    expect(half.body.error.details).toMatchObject({ code: 'ACCESS_CODES_WHOLE' });

    const tooMany = await sell([{ productId: hour.id, quantityMilli: 6000 }], 600);
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.details).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      productName: 'Internet 1h',
      availableMilli: 5000,
      requestedMilli: 6000,
    });
    // Across two lines of the same package as well.
    const split = await sell(
      [
        { productId: hour.id, quantityMilli: 3000 },
        { productId: hour.id, quantityMilli: 3000 },
      ],
      600,
    );
    expect(split.status).toBe(409);
    expect(split.body.error.details).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await level(hour.id)).toBe(5);
    expect((await codesOf(hour.id, 'available'))[0]!.code).toBe('H2-001'); // none was taken
  });

  it('a parked sale takes no code until it is paid', async () => {
    const parked = await call<SaleDetail>(cashier.token, 'POST', '/sales/suspend', {
      items: [{ productId: hour.id, quantityMilli: 1000, discountCents: 0, addonIds: [] }],
    });
    expect(parked.status).toBe(201);
    expect(parked.body.status).toBe('suspended');
    expect(parked.body.items[0]!.accessCodes).toEqual([]);
    expect(await level(hour.id)).toBe(5);

    const body = {
      items: [{ productId: hour.id, quantityMilli: 1000, discountCents: 0, addonIds: [] }],
      payments: [{ method: 'cash', amountCents: 100 }],
    };
    const blind = await call<ErrorBody>(
      cashier.token,
      'POST',
      `/sales/${parked.body.id}/complete`,
      body,
    );
    expect(blind.status).toBe(409);
    expect(blind.body.error.details).toMatchObject({ code: 'ACCESS_CODES_NOT_SHOWN' });
    expect(await level(hour.id)).toBe(5);

    const paid = { ...body, accessCodes: true, clientRequestId: 'internet-parked-0001' };
    const done = await call<SaleDetail>(
      cashier.token,
      'POST',
      `/sales/${parked.body.id}/complete`,
      paid,
    );
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.items[0]!.accessCodes).toEqual(['H2-001']);
    expect(await level(hour.id)).toBe(4);

    // The answer was lost on the way and the till sends the same request again: it gets the sale
    // it already completed, with the same code — nothing is sold twice.
    const again = await call<SaleDetail>(
      cashier.token,
      'POST',
      `/sales/${parked.body.id}/complete`,
      paid,
    );
    expect(again.status).toBe(200);
    expect(again.body.receiptNo).toBe(done.body.receiptNo);
    expect(again.body.items[0]!.accessCodes).toEqual(['H2-001']);
    expect(await level(hour.id)).toBe(4);
    // A different request for a sale that is already completed is still refused.
    const other = await call<ErrorBody>(
      cashier.token,
      'POST',
      `/sales/${parked.body.id}/complete`,
      {
        ...paid,
        clientRequestId: 'internet-parked-0002',
      },
    );
    expect(other.status).toBe(409);
    expect(await level(hour.id)).toBe(4);
  });

  it('is never sold offline: the customer would leave without a code', async () => {
    const res = await call<SyncSalesResponse>(owner.token, 'POST', '/sales/sync', {
      sales: [
        {
          clientRequestId: 'internet-offline-0001',
          items: [{ productId: hour.id, quantityMilli: 1000, discountCents: 0, addonIds: [] }],
          discountCents: 0,
          customerId: null,
          payments: [{ method: 'cash', amountCents: 100 }],
          accessCodes: true,
          offline: {
            deviceCode: 'PC2',
            localNumber: 'PC2-000001',
            createdAt: new Date().toISOString(),
            unitPrices: [{ productId: hour.id, unitPriceCents: 100 }],
          },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({
      status: 'failed',
      saleId: null,
      error: { code: 'OFFLINE_ACCESS_CODES' },
    });
    expect(await level(hour.id)).toBe(4);
  });

  it('keeps the stock tied to the codes: no hand adjustment, purchase, staff purchase or PC bill', async () => {
    const adjust = await call<ErrorBody>(owner.token, 'POST', `/products/${hour.id}/stock`, {
      type: 'adjustment',
      quantityMilliDelta: 5000,
      reason: 'found some',
    });
    expect(adjust.status).toBe(409);
    expect(adjust.body.error.details).toMatchObject({ code: 'INTERNET_ACCESS_STOCK' });
    const count = await call<ErrorBody>(owner.token, 'POST', `/products/${hour.id}/stock`, {
      type: 'stock_count',
      newStockMilli: 0,
      reason: 'count',
    });
    expect(count.status).toBe(409);

    const supplier = await call<SupplierSummary>(owner.token, 'POST', '/suppliers', {
      name: 'Hotspot',
    });
    expect(supplier.status).toBe(201);
    const purchase = await call<ErrorBody>(owner.token, 'POST', '/purchases', {
      supplierId: supplier.body.id,
      items: [{ productId: hour.id, quantityMilli: 10_000, unitCostCents: 10 }],
      receiveNow: true,
    });
    expect(purchase.status).toBe(409);
    expect(purchase.body.error.details).toMatchObject({ code: 'INTERNET_ACCESS_STOCK' });

    const staff = await call<ErrorBody>(owner.token, 'POST', '/staff-purchases', {
      items: [{ productId: hour.id, quantityMilli: 1000 }],
    });
    expect(staff.status).toBe(409);
    expect(staff.body.error.details).toMatchObject({ code: 'INTERNET_ACCESS_TILL_ONLY' });

    // Not on the PC menu, and not on a PC's bill (paid later — the code is handed over on payment).
    const menu = await call<ErrorBody>(owner.token, 'PUT', '/catalog/menu', {
      productIds: [hour.id],
    });
    expect(menu.status).toBe(409);
    expect(menu.body.error.details).toMatchObject({ code: 'INTERNET_ACCESS_TILL_ONLY' });
    expect(
      (
        await call(owner.token, 'POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 120,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    const pc = await call<StationSummary>(owner.token, 'POST', '/stations', {
      number: 1,
      name: 'Arena 1',
    });
    const session = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: pc.body.id,
      billingMode: 'postpaid',
    });
    expect(session.status).toBeLessThan(300);
    const onBill = await call<ErrorBody>(
      owner.token,
      'POST',
      `/sessions/${session.body.session.id}/orders`,
      { items: [{ productId: hour.id, quantity: 1 }] },
    );
    expect(onBill.status).toBe(409);
    expect(onBill.body.error.details).toMatchObject({ code: 'INTERNET_ACCESS_TILL_ONLY' });

    expect(await level(hour.id)).toBe(4);
    const moves = await call<Paginated<InventoryMovementSummary>>(
      owner.token,
      'GET',
      `/inventory/movements?productId=${hour.id}&pageSize=200`,
    );
    expect(new Set(moves.body.items.map((m) => m.movementType))).toEqual(
      new Set(['codes_loaded', 'sale']),
    );
  });

  it('lets the name and the price change, but not what makes it a package', async () => {
    const renamed = await call<ProductSummary>(owner.token, 'PATCH', `/products/${hour.id}`, {
      name: 'Internet 1 orë',
      sellingPriceCents: 120,
      minStockMilli: 2000,
      // The product form sends the whole product back: unchanged values are fine.
      trackStock: true,
      allowNegativeStock: false,
      unitCode: 'pc',
      clientMenu: false,
      parentId: null,
      variantLabel: null,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      name: 'Internet 1 orë',
      sellingPriceCents: 120,
      kind: 'internet_access',
    });
    for (const patch of [
      { trackStock: false },
      { allowNegativeStock: true },
      { unitCode: 'kg' },
      { clientMenu: true },
      { parentId: cola.id, variantLabel: 'M' },
    ]) {
      const res = await call<ErrorBody>(owner.token, 'PATCH', `/products/${hour.id}`, patch);
      expect(res.status, JSON.stringify(patch)).toBe(409);
      expect(res.body.error.details).toMatchObject({ code: 'INTERNET_ACCESS_SHAPE' });
    }
    const asVariant = await call<ErrorBody>(owner.token, 'PATCH', `/products/${cola.id}`, {
      parentId: hour.id,
      variantLabel: 'M',
    });
    expect(asVariant.status).toBe(400);
    hour = await product(hour.id);
    expect(hour).toMatchObject({ trackStock: true, allowNegativeStock: false, unitCode: 'pc' });

    const sale = await sell([{ productId: hour.id, quantityMilli: 1000 }], 120);
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(120);
    expect(sale.body.items[0]).toMatchObject({
      description: 'Internet 1 orë',
      accessCodes: ['H2-002'],
    });
    expect(await level(hour.id)).toBe(3);
  });

  it('gives the money back on a refund, but a handed-out code never returns to the stock', async () => {
    const sale = await sell([{ productId: hour.id, quantityMilli: 2000 }], 240);
    expect(sale.status).toBe(201);
    expect(sale.body.items[0]!.accessCodes).toEqual(['H2-003', 'H2-004']);
    expect(await level(hour.id)).toBe(1);

    const refund = await call<SaleDetail>(owner.token, 'POST', `/sales/${sale.body.id}/refund`, {
      items: [{ saleItemId: sale.body.items[0]!.id, quantityMilli: 1000 }],
      reason: 'code did not work',
      restock: true,
    });
    expect(refund.status).toBe(200);
    expect(refund.body.status).toBe('partially_refunded');
    expect(refund.body.refundedCents).toBe(120);
    expect(refund.body.items[0]).toMatchObject({
      refundedMilli: 1000,
      accessCodes: ['H2-003', 'H2-004'],
    });
    expect(await level(hour.id)).toBe(1); // not put back on sale
    expect((await codesOf(hour.id, 'sold')).filter((c) => c.saleId === sale.body.id)).toHaveLength(
      2,
    );

    // An ordinary product on the same kind of refund does go back on the shelf.
    const mixed = await sell(
      [
        { productId: cola.id, quantityMilli: 1000 },
        { productId: hour.id, quantityMilli: 1000 },
      ],
      270,
    );
    expect(mixed.status).toBe(201);
    const colaBefore = (await product(cola.id)).stockMilli;
    const both = await call<SaleDetail>(owner.token, 'POST', `/sales/${mixed.body.id}/refund`, {
      items: mixed.body.items.map((i) => ({ saleItemId: i.id, quantityMilli: 1000 })),
      reason: 'changed mind',
      restock: true,
    });
    expect(both.status).toBe(200);
    expect(both.body.status).toBe('refunded');
    expect((await product(cola.id)).stockMilli).toBe(colaBefore + 1000);
    expect(await level(hour.id)).toBe(0);
    expect((await product(hour.id)).lowStock).toBe(true);
  });

  it('refuses the sale when the codes have run out, naming the package', async () => {
    const res = await sell([{ productId: hour.id, quantityMilli: 1000 }], 120);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      productName: 'Internet 1 orë',
      availableMilli: 0,
    });
  });

  it('loads a code that was sold before only when told the system issued it again', async () => {
    const check = await call<InternetAccessCheckResult>(
      owner.token,
      'POST',
      '/internet-access/check',
      { codes: ['H1-001', 'H9-001'] },
    );
    expect(check.body.fresh).toBe(1);
    expect(check.body.waiting).toEqual([]);
    expect(check.body.soldBefore.map((k) => [k.code, k.productName])).toEqual([
      ['H1-001', 'Internet 1 orë'],
    ]);
    expect(check.body.soldBefore[0]!.soldAt).toBeTruthy();

    const careful = await load({ productId: hour.id, codes: ['H1-001', 'H9-001'] });
    expect(careful.body.added).toBe(1);
    expect(careful.body.soldBefore.map((k) => k.code)).toEqual(['H1-001']);
    expect(await level(hour.id)).toBe(1);

    const allowed = await load({
      productId: hour.id,
      codes: ['H1-001', 'H9-001'],
      allowSoldBefore: true,
    });
    expect(allowed.body.added).toBe(1); // H9-001 already waits; H1-001 is taken back in
    expect(allowed.body.waiting.map((k) => k.code)).toEqual(['H9-001']);
    expect(await level(hour.id)).toBe(2);
    // The old sale keeps its code; the new copy is a code of its own.
    const copies = (await codesOf(hour.id)).filter((c) => c.code === 'H1-001');
    expect(copies.map((c) => c.status).sort()).toEqual(['available', 'sold']);
    // And even then it is never loaded a second time while it waits.
    const twice = await load({ productId: hour.id, codes: ['H1-001'], allowSoldBefore: true });
    expect(twice.body.added).toBe(0);
    expect(await level(hour.id)).toBe(2);
  });

  it('removes unused codes — chosen ones, one load, or all — and never a sold one', async () => {
    const loaded = await load({ productId: hour.id, codes: batch('R1', 5) });
    expect(loaded.body.added).toBe(5);
    const other = await load({ productId: hour.id, codes: batch('R2', 3) });
    expect(await level(hour.id)).toBe(10);
    const remove = (body: Record<string, unknown>) =>
      call<InternetAccessRemoveResult & ErrorBody>(owner.token, 'POST', '/internet-access/remove', {
        productId: hour.id,
        reason: 'wrong paste',
        ...body,
      });

    const unused = await codesOf(hour.id, 'available');
    const sold = await codesOf(hour.id, 'sold');
    const pick = unused.filter((c) => c.code === 'R1-001' || c.code === 'R1-002');
    // A sold code among the chosen ones is simply left alone.
    const chosen = await remove({ ids: [...pick.map((c) => c.id), sold[0]!.id] });
    expect(chosen.status).toBe(200);
    expect(chosen.body.removed).toBe(2);
    expect(chosen.body.package.availableCodes).toBe(8);
    expect(await level(hour.id)).toBe(8);
    expect((await codesOf(hour.id, 'sold')).length).toBe(sold.length);

    const wholeLoad = await remove({ batchId: other.body.batchId });
    expect(wholeLoad.body.removed).toBe(3);
    expect(await level(hour.id)).toBe(5);

    // Only sold codes chosen: nothing to remove, and it says so.
    const none = await remove({ ids: [sold[0]!.id] });
    expect(none.status).toBe(409);
    expect(none.body.error.details).toMatchObject({ code: 'ACCESS_CODES_NONE_UNUSED' });
    expect((await remove({})).status).toBe(400);
    expect((await remove({ all: true, batchId: other.body.batchId })).status).toBe(400);
    expect((await remove({ all: true, reason: 'x' })).status).toBe(400);

    const all = await remove({ all: true });
    expect(all.body.removed).toBe(5);
    expect(await level(hour.id)).toBe(0);
    expect((await codesOf(hour.id, 'sold')).length).toBe(sold.length);

    const moves = await call<Paginated<InventoryMovementSummary>>(
      owner.token,
      'GET',
      `/inventory/movements?productId=${hour.id}&type=codes_removed`,
    );
    expect(moves.body.items.map((m) => [m.quantityMilliDelta, m.reason])).toEqual([
      [-5000, 'wrong paste'],
      [-3000, 'wrong paste'],
      [-2000, 'wrong paste'],
    ]);
    // A removed code can be loaded again later.
    const back = await load({ productId: hour.id, codes: ['R1-001'] });
    expect(back.body.added).toBe(1);
    expect(await level(hour.id)).toBe(1);
  });

  it('never hands the same code to two tills selling at the same moment', async () => {
    const loaded = await load({ productId: day.id, codes: batch('RACE', 6) });
    expect(loaded.body.added).toBe(6);
    const before = await level(day.id); // 2 older ones + 6
    expect(before).toBe(8);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        sell(
          [{ productId: day.id, quantityMilli: 1000 }],
          300,
          {},
          i % 2 ? owner.token : cashier.token,
        ),
      ),
    );
    const done = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status !== 201);
    expect(done).toHaveLength(8);
    expect(refused).toHaveLength(4);
    for (const r of refused) {
      expect(r.status).toBe(409);
      expect(r.body.error.details).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    }
    const handedOut = done.flatMap((r) => r.body.items[0]!.accessCodes);
    expect(handedOut).toHaveLength(8);
    expect(new Set(handedOut).size).toBe(8);
    expect([...handedOut].sort()).toEqual(['D1-002', 'D1-003', ...batch('RACE', 6)].sort());
    expect(await level(day.id)).toBe(0);
  });

  it('loads thousands of codes in one paste', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => `BULK${String(i).padStart(5, '0')}`);
    const res = await load({
      package: { name: 'Internet 2h', sellingPriceCents: 150 },
      codes: many,
    });
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(5000);
    expect(res.body.package.product.stockMilli).toBe(5_000_000);
    const sale = await sell([{ productId: res.body.package.product.id, quantityMilli: 3000 }], 450);
    expect(sale.body.items[0]!.accessCodes).toEqual(['BULK00000', 'BULK00001', 'BULK00002']);
    expect((await load({ productId: hour.id, codes: Array(5001).fill('TOO-MANY') })).status).toBe(
      400,
    );
  }, 60_000);

  it('the database itself refuses a stock and codes that drift apart, or a sold code that changes', async () => {
    const drift = async (sql: string, params: unknown[]) => {
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql, params);
        await client.query('COMMIT');
        return null;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return (err as { constraint?: string }).constraint ?? String(err);
      } finally {
        client.release();
      }
    };
    expect(
      await drift('UPDATE products SET stock_milli = stock_milli + 1000 WHERE id = $1', [hour.id]),
    ).toBe('internet_access_stock_matches_codes');
    expect(
      await drift(
        `INSERT INTO internet_access_codes (product_id, code, batch_id) VALUES ($1, 'DRIFT-1', gen_random_uuid())`,
        [hour.id],
      ),
    ).toBe('internet_access_stock_matches_codes');
    expect(
      await drift(
        `DELETE FROM internet_access_codes WHERE product_id = $1 AND status = 'available'`,
        [hour.id],
      ),
    ).toBe('internet_access_stock_matches_codes');
    expect(
      await drift(
        `UPDATE internet_access_codes SET code = 'CHANGED' WHERE product_id = $1 AND status = 'sold'`,
        [hour.id],
      ),
    ).toBe('internet_access_codes_sold_is_final');
    expect(
      await drift(`DELETE FROM internet_access_codes WHERE product_id = $1 AND status = 'sold'`, [
        hour.id,
      ]),
    ).toBe('internet_access_codes_sold_is_final');
    expect(
      await drift(
        `INSERT INTO internet_access_codes (product_id, code, batch_id) VALUES ($1, 'COLA-1', gen_random_uuid())`,
        [cola.id],
      ),
    ).toBe('internet_access_codes_product_kind');
    expect(
      await drift(`UPDATE products SET allow_negative_stock = true WHERE id = $1`, [hour.id]),
    ).toBe('products_internet_access_shape');
    // The same code cannot wait to be sold twice, whatever the package.
    expect(
      await drift(
        `WITH up AS (UPDATE products SET stock_milli = stock_milli + 1000 WHERE id = $1)
         INSERT INTO internet_access_codes (product_id, code, batch_id) VALUES ($1, 'R1-001', gen_random_uuid())`,
        [day.id],
      ),
    ).toBe('internet_access_codes_available_idx');
    expect(await level(hour.id)).toBe(1);
  });

  it('archives a package instead of deleting it, and an archived one is not sold', async () => {
    const res = await call<{ archived: boolean }>(owner.token, 'DELETE', `/products/${day.id}`);
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);
    expect((await product(day.id)).isActive).toBe(false);
    expect((await codesOf(day.id, 'sold')).length).toBeGreaterThan(0); // the history stays
    const loaded = await load({ productId: day.id, codes: ['ARCH-001'] });
    expect(loaded.body.added).toBe(1);
    const sale = await sell([{ productId: day.id, quantityMilli: 1000 }], 300);
    expect(sale.status).toBe(409);
    expect(await level(day.id)).toBe(1);

    // A package that never held a code is simply deleted.
    const empty = await load({
      package: { name: 'Internet provë', sellingPriceCents: 10 },
      codes: [],
    });
    expect(empty.status).toBe(201);
    expect(empty.body).toMatchObject({ added: 0, batchId: null });
    const gone = await call<{ archived: boolean }>(
      owner.token,
      'DELETE',
      `/products/${empty.body.package.product.id}`,
    );
    expect(gone.body.archived).toBe(false);
  });

  it('writes what happened to the codes into the audit log, without the codes themselves', async () => {
    const rows = await ctx.pool.query<{ action: string; details: Record<string, unknown> }>(
      `SELECT action, details FROM audit_logs
        WHERE action LIKE 'internet_access.%' OR (action = 'sale.completed' AND details ? 'accessCodes')
        ORDER BY occurred_at, id`,
    );
    const actions = new Set(rows.rows.map((r) => r.action));
    expect(actions).toEqual(
      new Set(['internet_access.codes.loaded', 'internet_access.codes.removed', 'sale.completed']),
    );
    expect(
      rows.rows.find((r) => r.action === 'internet_access.codes.loaded')!.details,
    ).toMatchObject({ added: 6, pasted: 6, packageCreated: true });
    expect(JSON.stringify(rows.rows)).not.toMatch(/H1-00\d|RACE-00\d|BULK0/);
  });

  it('survives a backup and a restore with every code where it was', async () => {
    const before = {
      hour: await codesOf(hour.id),
      day: await codesOf(day.id),
      stock: (await product(hour.id)).stockMilli,
    };
    const backup = await call<BackupSummary>(owner.token, 'POST', '/backups', {});
    expect(backup.status).toBe(201);
    // Something changes after the backup, and the restore takes it back.
    const sale = await sell([{ productId: hour.id, quantityMilli: 1000 }], 120, {}, owner.token);
    expect(sale.status).toBe(201);
    expect(await level(hour.id)).toBe(0);

    const restored = await call(owner.token, 'POST', `/backups/${backup.body.id}/restore`, {
      password: OWNER.password,
      confirm: true,
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(await codesOf(hour.id)).toEqual(before.hour);
    expect(await codesOf(day.id)).toEqual(before.day);
    expect((await product(hour.id)).stockMilli).toBe(before.stock);
    expect(await level(hour.id)).toBe(1);
    // And it still sells: the next code, once.
    const again = await sell([{ productId: hour.id, quantityMilli: 1000 }], 120, {}, owner.token);
    expect(again.status).toBe(201);
    expect(again.body.items[0]!.accessCodes).toEqual(sale.body.items[0]!.accessCodes);
    expect(await level(hour.id)).toBe(0);
  }, 60_000);
});
