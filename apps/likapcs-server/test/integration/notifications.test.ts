/**
 * 0.34.0 — the server announces what the phone shows as notifications: a staff sign-in and a
 * product that a sale pushes under its minimum stock. Both reach only the admins whose role holds
 * `live.view`; the sale itself is announced as before (live tracking).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LoginResponse, ProductSummary, SaleDetail } from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

describe('server notifications', () => {
  let ctx: TestContext;
  let owner: LoginResponse;

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
        body: r.body ? (JSON.parse(r.body) as T) : (null as T),
      }));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    const created = await call(owner.token, 'POST', '/users', {
      username: 'kasa2',
      fullName: 'Vjollca Kasa',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    expect(created.status).toBe(201);
    const opened = await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 5000 });
    expect(opened.status).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('announces a staff sign-in to the admins who see live tracking', async () => {
    const spy = vi.spyOn(ctx.app.hub, 'broadcastToAdminsWith');
    await login(ctx.app, 'kasa2', 'Cashier123');
    const signed = spy.mock.calls.filter((c) => c[1] === 'staff.login');
    expect(signed).toHaveLength(1);
    expect(signed[0]![0]).toBe('live.view');
    expect(signed[0]![2]).toMatchObject({
      username: 'kasa2',
      fullName: 'Vjollca Kasa',
      via: 'web',
    });
    spy.mockRestore();
  });

  it('announces a product once, when a sale takes it to or under its minimum stock', async () => {
    const product = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Ujë 0.5L',
        sellingPriceCents: 100,
        purchaseCostCents: 50,
        initialStockMilli: 3000,
        minStockMilli: 2000,
      })
    ).body;
    const cashier = await login(ctx.app, 'kasa2', 'Cashier123');
    const spy = vi.spyOn(ctx.app.hub, 'broadcastToAdminsWith');

    // 3 → 1 (minimum 2): the sale crosses the minimum, so it is announced.
    const first = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: product.id, quantityMilli: 2000 }],
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(first.status).toBe(201);
    // 1 → 0.5: it was already under the minimum, so it is not announced again.
    const second = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: product.id, quantityMilli: 500 }],
      payments: [{ method: 'cash', amountCents: 50 }],
    });
    expect(second.status).toBe(201);

    const low = spy.mock.calls.filter((c) => c[1] === 'stock.low');
    expect(low).toHaveLength(1);
    expect(low[0]![0]).toBe('live.view');
    expect(low[0]![2]).toMatchObject({
      productId: product.id,
      stockMilli: 1000,
      minStockMilli: 2000,
    });
    spy.mockRestore();
  });
});
