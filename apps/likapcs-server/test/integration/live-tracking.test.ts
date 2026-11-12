/**
 * 0.31.0 — live tracking. Who may read the snapshot, what it adds up to after a cash sale and a
 * credit sale, the feed and the staff rows, and that a sale notification reaches only the admins
 * whose role holds `live.view`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  CashShiftDetail,
  CustomerSummary,
  LiveSale,
  LiveSnapshot,
  LoginResponse,
  ProductSummary,
  SaleDetail,
} from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';
import { RealtimeHub } from '../../src/realtime/hub.js';

describe('live tracking', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let admin: LoginResponse;
  let manager: LoginResponse;
  let cola: ProductSummary;
  let customer: CustomerSummary;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({
        status: r.statusCode,
        body: (r.headers['content-type'] ?? '').toString().includes('json')
          ? (JSON.parse(r.body) as T)
          : (null as T),
      }));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    for (const u of [
      { username: 'kasa', fullName: 'Arben Kasa', password: 'Cashier123', roles: ['cashier'] },
      { username: 'adm', fullName: 'Admin Live', password: 'Admin12345', roles: ['admin'] },
      { username: 'mgr', fullName: 'Menaxher', password: 'Manager123', roles: ['manager'] },
    ]) {
      const r = await call(owner.token, 'POST', '/users', { ...u, mustChangePassword: false });
      expect(r.status).toBe(201);
    }
    cashier = await login(ctx.app, 'kasa', 'Cashier123');
    admin = await login(ctx.app, 'adm', 'Admin12345');
    manager = await login(ctx.app, 'mgr', 'Manager123');
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Coca-Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 50_000,
      })
    ).body;
    customer = (
      await call<CustomerSummary>(owner.token, 'POST', '/customers', { name: 'Besnik Borxh' })
    ).body;
    const opened = await call<CashShiftDetail>(owner.token, 'POST', '/cash/shifts/open', {
      openingCents: 5000,
    });
    expect(opened.status).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('is open to owner and admin only, by the server (not only by the menu)', async () => {
    expect((await call(owner.token, 'GET', '/live/snapshot')).status).toBe(200);
    expect((await call(admin.token, 'GET', '/live/snapshot')).status).toBe(200);
    expect((await call(cashier.token, 'GET', '/live/snapshot')).status).toBe(403);
    expect((await call(manager.token, 'GET', '/live/snapshot')).status).toBe(403);
  });

  it('adds up the day after a cash sale and a credit sale, and announces each sale', async () => {
    const spy = vi.spyOn(ctx.app.hub, 'broadcastToAdminsWith');

    // Cash sale: 2 × 1.50 €, tendered 5.00 € → change 2.00 €, the drawer gets 3.00 €.
    const cash = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 2000 }],
      payments: [{ method: 'cash', amountCents: 500 }],
    });
    expect(cash.status).toBe(201);

    // Credit sale: 1 × 1.50 €, paid later by a named customer.
    const credit = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      customerId: customer.id,
      payments: [{ method: 'credit', amountCents: 150 }],
    });
    expect(credit.status).toBe(201);

    const announced = spy.mock.calls.filter((c) => c[1] === 'live.sale');
    expect(announced).toHaveLength(2);
    expect(announced[0]![0]).toBe('live.view');
    expect((announced[0]![2] as LiveSale).saleId).toBe(cash.body.id);
    expect((announced[1]![2] as LiveSale).saleId).toBe(credit.body.id);
    spy.mockRestore();

    const snap = (await call<LiveSnapshot>(admin.token, 'GET', '/live/snapshot')).body;
    expect(snap.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Drawer: 50.00 € opened, the cash sale brought 3.00 € net; the credit sale is not cash.
    expect(snap.drawer.open).toBe(true);
    expect(snap.drawer.openingCents).toBe(5000);
    expect(snap.drawer.expectedCents).toBe(5300);

    // Totals: turnover 4.50 € (VAT included), VAT 0.69 €, cost 2.70 € (3 bottles × 0.90 €),
    // gross profit 1.11 € (revenue without VAT minus cost), debt given 1.50 €.
    expect(snap.totals.turnoverCents).toBe(450);
    expect(snap.totals.salesCount).toBe(2);
    expect(snap.totals.grossProfitCents).toBe(111);
    expect(snap.totals.debtGivenCents).toBe(150);
    expect(snap.totals.debtCollectedCents).toBe(0);
    expect(snap.totals.lossCents).toBe(0);
    expect(snap.totals.incomplete).toBe(false);

    // Feed: newest first, with cashier, product, amount and profit.
    expect(snap.feed).toHaveLength(2);
    const [newest, older] = snap.feed as [LiveSale, LiveSale];
    expect(newest.saleId).toBe(credit.body.id);
    expect(newest.onCredit).toBe(true);
    expect(newest.customerName).toBe('Besnik Borxh');
    expect(newest.cashierName).toBe('Arben Kasa');
    expect(newest.totalCents).toBe(150);
    expect(newest.profitCents).toBe(37); // 1.50 − 0.23 VAT − 0.90 cost
    expect(newest.missingCost).toBe(false);
    expect(older.onCredit).toBe(false);
    expect(older.items[0]).toMatchObject({
      name: 'Coca-Cola 0.5L',
      quantityMilli: 2000,
      lineTotalCents: 300,
      profitCents: 74, // 3.00 − 0.46 VAT − 1.80 cost
      isTime: false,
    });

    // Staff: the cashier sold 450 cents in 2 sales.
    const arben = snap.staff.find((s) => s.name === 'Arben Kasa');
    expect(arben).toMatchObject({ salesCount: 2, salesCents: 450 });
    expect(arben!.lastSaleAt).not.toBeNull();

    // Top products: 3 bottles, 4.50 € gross, 1.11 € profit.
    expect(snap.topProducts[0]).toMatchObject({
      name: 'Coca-Cola 0.5L',
      quantityMilli: 3000,
      amountCents: 450,
      profitCents: 111,
    });
  });

  it('sends a sale only to admins whose role holds the permission', () => {
    const hub = new RealtimeHub();
    const make = (perms: string[]) => {
      const send = vi.fn();
      const socket = { readyState: 1, OPEN: 1, send } as unknown as import('ws').WebSocket;
      hub.attachAdmin({
        socket,
        userId: 'u',
        username: 'u',
        connectedAt: new Date(),
        permissions: new Set(perms),
      });
      return send;
    };
    const withLive = make(['live.view', 'reports.view']);
    const withoutLive = make(['reports.view']);

    hub.broadcastToAdminsWith('live.view', 'live.sale', { saleId: 'x' });

    expect(withLive).toHaveBeenCalledTimes(1);
    expect(withoutLive).not.toHaveBeenCalled();
    const sent = JSON.parse(withLive.mock.calls[0]![0] as string);
    expect(sent).toMatchObject({ type: 'server.event', event: 'live.sale', payload: { saleId: 'x' } });
  });
});
