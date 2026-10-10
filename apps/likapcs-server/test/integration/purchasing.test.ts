/**
 * Phase 7 — suppliers and purchases: stock in, weighted average cost, partial receipts, supplier
 * payments through the cash drawer, cancellation rules and permissions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CashShiftDetail,
  LoginResponse,
  ProductSummary,
  PurchaseDetail,
  PurchaseListResponse,
  SupplierSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

describe('suppliers & purchases', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let cola: ProductSummary;
  let chips: ProductSummary;
  let supplier: SupplierSummary;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({
        status: r.statusCode,
        body: (r.statusCode === 204 ? null : r.json()) as T,
      }));
  const product = async (id: string) =>
    (await call<ProductSummary>(owner.token, 'GET', `/products/${id}`)).body;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    await call(owner.token, 'POST', '/users', {
      username: 'kasa',
      fullName: 'Kasa Cashier',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    cashier = await login(ctx.app, 'kasa', 'Cashier123');
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Coca-Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 10_000, // 10 pcs @ 0.90
      })
    ).body;
    chips = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Chips 50g',
        sellingPriceCents: 120,
        purchaseCostCents: 60,
      })
    ).body;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('creates, searches and edits suppliers; names are unique; cashiers cannot see them', async () => {
    const created = await call<SupplierSummary>(owner.token, 'POST', '/suppliers', {
      name: 'Pepsi Kosova',
      phone: '+383 38 000 000',
      contactPerson: 'Arben',
    });
    expect(created.status).toBe(201);
    supplier = created.body;
    expect(supplier.isActive).toBe(true);
    expect(supplier.balanceDueCents).toBe(0);
    expect((await call(owner.token, 'POST', '/suppliers', { name: 'pepsi kosova' })).status).toBe(
      409,
    );
    const list = await call<SupplierSummary[]>(owner.token, 'GET', '/suppliers?q=peps');
    expect(list.body.map((s) => s.id)).toEqual([supplier.id]);
    const patched = await call<SupplierSummary>(owner.token, 'PATCH', `/suppliers/${supplier.id}`, {
      email: 'orders@pepsi.example',
      notes: 'Delivers on Tuesdays',
    });
    expect(patched.body.email).toBe('orders@pepsi.example');
    expect((await call(cashier.token, 'GET', '/suppliers')).status).toBe(403);
    expect((await call(cashier.token, 'GET', '/purchases')).status).toBe(403);
  });

  it('a received purchase books stock and moves the weighted average cost', async () => {
    const before = await product(cola.id);
    expect(before.stockMilli).toBe(10_000);
    expect(before.averageCostCents).toBe(90);

    const created = await call<PurchaseDetail>(owner.token, 'POST', '/purchases', {
      supplierId: supplier.id,
      supplierInvoiceNo: 'INV-77',
      items: [
        { productId: cola.id, quantityMilli: 30_000, unitCostCents: 70, taxRateBp: 1800 },
        { productId: chips.id, quantityMilli: 20_000, unitCostCents: 50 },
      ],
      additionalCostsCents: 300,
      receiveNow: true,
    });
    expect(created.status).toBe(201);
    const p = created.body;
    expect(p.referenceNo).toMatch(/^B-\d{4}-000001$/);
    expect(p.status).toBe('received');
    expect(p.paymentStatus).toBe('unpaid');
    expect(p.subtotalCents).toBe(30 * 70 + 20 * 50); // 2100 + 1000
    expect(p.taxCents).toBe(378); // 18 % of 2100
    expect(p.totalCents).toBe(3100 + 378 + 300);
    expect(p.items).toHaveLength(2);
    expect(p.items[0]!.quantityReceivedMilli).toBe(30_000);
    expect(p.receipts).toHaveLength(1);
    expect(p.receipts[0]!.items).toHaveLength(2);

    const after = await product(cola.id);
    expect(after.stockMilli).toBe(40_000);
    expect(after.purchaseCostCents).toBe(70);
    // (10 × 90 + 30 × 70) / 40 = 75
    expect(after.averageCostCents).toBe(75);
    const chipsAfter = await product(chips.id);
    expect(chipsAfter.stockMilli).toBe(20_000);
    expect(chipsAfter.averageCostCents).toBe(50);

    const movements = await ctx.pool.query<{ movement_type: string; quantity_milli_delta: string }>(
      `SELECT movement_type, quantity_milli_delta::text FROM inventory_movements
        WHERE reference_type = 'purchase' AND reference_id = $1 ORDER BY id`,
      [p.id],
    );
    expect(movements.rows).toHaveLength(2);
    expect(movements.rows.every((m) => m.movement_type === 'purchase_receipt')).toBe(true);

    // Received purchases can no longer be cancelled.
    expect((await call(owner.token, 'POST', `/purchases/${p.id}/cancel`, {})).status).toBe(409);
  });

  it('an ordered purchase is received in parts; the supplier balance follows', async () => {
    const created = await call<PurchaseDetail>(owner.token, 'POST', '/purchases', {
      supplierId: supplier.id,
      items: [{ productId: chips.id, quantityMilli: 10_000, unitCostCents: 40 }],
      receiveNow: false,
    });
    expect(created.status).toBe(201);
    const p = created.body;
    expect(p.status).toBe('ordered');
    expect((await product(chips.id)).stockMilli).toBe(20_000); // nothing booked yet

    const partial = await call<PurchaseDetail>(owner.token, 'POST', `/purchases/${p.id}/receive`, {
      items: [{ purchaseItemId: p.items[0]!.id, quantityMilli: 4_000 }],
      deliveryNoteNo: 'DN-1',
    });
    expect(partial.status).toBe(200);
    expect(partial.body.status).toBe('partially_received');
    expect((await product(chips.id)).stockMilli).toBe(24_000);
    // Over-receiving is refused.
    expect(
      (
        await call(owner.token, 'POST', `/purchases/${p.id}/receive`, {
          items: [{ purchaseItemId: p.items[0]!.id, quantityMilli: 7_000 }],
        })
      ).status,
    ).toBe(409);
    const rest = await call<PurchaseDetail>(owner.token, 'POST', `/purchases/${p.id}/receive`, {});
    expect(rest.body.status).toBe('received');
    expect(rest.body.items[0]!.quantityReceivedMilli).toBe(10_000);
    expect((await product(chips.id)).stockMilli).toBe(30_000);
    // Average: (20 × 50 + 4 × 40) / 24 = 48.33 → 48, then (24 × 48 + 6 × 40) / 30 = 46.4 → 46
    expect((await product(chips.id)).averageCostCents).toBe(46);
    expect((await call(owner.token, 'POST', `/purchases/${p.id}/receive`, {})).status).toBe(409);

    const s = await call<SupplierSummary>(owner.token, 'GET', `/suppliers/${supplier.id}`);
    expect(s.body.purchasesCount).toBe(2);
    expect(s.body.balanceDueCents).toBe(3778 + 400);
  });

  it('supplier payments: cash needs an open shift and leaves the drawer; overpayment is refused', async () => {
    const list = await call<PurchaseListResponse>(owner.token, 'GET', '/purchases?status=received');
    const first = list.body.items.find((p) => p.totalCents === 3778)!;
    expect(list.body.summary.dueCents).toBe(3778 + 400);

    const noShift = await call<{ error: { code: string } }>(
      owner.token,
      'POST',
      `/purchases/${first.id}/payments`,
      { method: 'cash', amountCents: 1000 },
    );
    expect(noShift.status).toBe(409);
    expect(noShift.body.error.code).toBe('SHIFT_REQUIRED');

    await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 10_000 });
    const cash = await call<PurchaseDetail>(
      owner.token,
      'POST',
      `/purchases/${first.id}/payments`,
      {
        method: 'cash',
        amountCents: 1000,
      },
    );
    expect(cash.status).toBe(201);
    expect(cash.body.paidCents).toBe(1000);
    expect(cash.body.paymentStatus).toBe('partial');
    expect(cash.body.payments[0]!.shiftId).not.toBeNull();
    const shift = await call<{ current: CashShiftDetail }>(owner.token, 'GET', '/cash/status');
    expect(shift.body.current.totals.expectedCashCents).toBe(9000);
    expect(
      shift.body.current.movements.some(
        (m) => m.type === 'supplier_payment' && m.amountCents === -1000,
      ),
    ).toBe(true);

    const tooMuch = await call(owner.token, 'POST', `/purchases/${first.id}/payments`, {
      method: 'bank_transfer',
      amountCents: 5000,
    });
    expect(tooMuch.status).toBe(400);
    const bank = await call<PurchaseDetail>(
      owner.token,
      'POST',
      `/purchases/${first.id}/payments`,
      {
        method: 'bank_transfer',
        amountCents: 2778,
        reference: 'TR-0099',
      },
    );
    expect(bank.body.paymentStatus).toBe('paid');
    expect(bank.body.payments).toHaveLength(2);
    // Bank payments never touch the drawer.
    const again = await call<{ current: CashShiftDetail }>(owner.token, 'GET', '/cash/status');
    expect(again.body.current.totals.expectedCashCents).toBe(9000);

    const s = await call<SupplierSummary>(owner.token, 'GET', `/suppliers/${supplier.id}`);
    expect(s.body.balanceDueCents).toBe(400);
  });

  it('only untouched purchases can be cancelled; inactive suppliers cannot be used', async () => {
    const draft = await call<PurchaseDetail>(owner.token, 'POST', '/purchases', {
      supplierId: supplier.id,
      items: [{ productId: cola.id, quantityMilli: 1_000, unitCostCents: 70 }],
      receiveNow: false,
    });
    const cancelled = await call<PurchaseDetail>(
      owner.token,
      'POST',
      `/purchases/${draft.body.id}/cancel`,
      {},
    );
    expect(cancelled.body.status).toBe('cancelled');
    expect(
      (await call(owner.token, 'POST', `/purchases/${draft.body.id}/receive`, {})).status,
    ).toBe(409);
    const filtered = await call<PurchaseListResponse>(
      owner.token,
      'GET',
      '/purchases?status=cancelled',
    );
    expect(filtered.body.items.map((p) => p.id)).toEqual([draft.body.id]);

    const off = await call<SupplierSummary>(owner.token, 'DELETE', `/suppliers/${supplier.id}`);
    expect(off.body.isActive).toBe(false);
    expect((await call<SupplierSummary[]>(owner.token, 'GET', '/suppliers')).body).toHaveLength(0);
    expect(
      (
        await call(owner.token, 'POST', '/purchases', {
          supplierId: supplier.id,
          items: [{ productId: cola.id, quantityMilli: 1_000, unitCostCents: 70 }],
        })
      ).status,
    ).toBe(409);
  });
});
