/**
 * Restore of a database that was really used. The tables reference each other in a circle
 * (a session points at the time credit it was started from, the credit at the sale line it was
 * sold on, the sale line at the session it bills), so no order of the tables puts every parent
 * before its children. A backup with a refund, a PC order or a session started from prepaid time
 * must still come back whole.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BackupSummary,
  LoginResponse,
  ProductSummary,
  RestoreResult,
  SaleDetail,
  SessionMutationResponse,
  StationOrder,
  StationSummary,
  TimeCreditSummary,
} from '@likapcs/shared';
import { OWNER, authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('restore of a used database', () => {
  let ctx: TestContext;
  let backupDir: string;
  let owner: LoginResponse;

  const call = <T>(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({
        status: r.statusCode,
        body: (r.statusCode === 204 ? null : r.json()) as T,
        text: r.body,
      }));
  const rowsOf = async (table: string) =>
    Number(
      (await ctx.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]!.n,
    );

  beforeAll(async () => {
    backupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-restore-order-'));
    ctx = await createTestContext(
      { backupDir },
      process.env.DEBUG_LOG ? { logger: { level: 'error' } } : {},
    );
    owner = await runSetup(ctx.app);
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    expect(
      (
        await call('POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 600,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
    await fsp.rm(backupDir, { recursive: true, force: true });
  });

  it('brings back refunds, PC orders and sessions started from prepaid time', async () => {
    const cola = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Cola',
        sellingPriceCents: 150,
        initialStockMilli: 20_000,
      })
    ).body;
    const pc1 = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'Arena 1' }))
      .body;
    const pc2 = (await call<StationSummary>('POST', '/stations', { number: 2, name: 'Arena 2' }))
      .body;

    // A sale with a refund: refund_items → sale_items.
    const sale = await call<SaleDetail>('POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 2000, discountCents: 0, addonIds: [] }],
      payments: [{ method: 'cash', amountCents: 300 }],
    });
    expect(sale.status).toBe(201);
    const refund = await call<SaleDetail>('POST', `/sales/${sale.body.id}/refund`, {
      items: [{ saleItemId: sale.body.items[0]!.id, quantityMilli: 1000 }],
      reason: 'returned',
      restock: true,
    });
    expect(refund.status).toBe(200);

    // A PC order on a running session's bill: station_order_items → station_orders.
    const session = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: pc1.id,
      billingMode: 'postpaid',
    });
    expect(session.status).toBe(201);
    const order = await call<StationOrder>('POST', `/sessions/${session.body.session.id}/orders`, {
      items: [{ productId: cola.id, quantity: 2 }],
    });
    expect(order.status, order.text).toBeLessThan(300);

    // PC time sold at the till, then a session started from it: the circle itself
    // (gaming_sessions → time_credits → sale_items → gaming_sessions).
    const time = await call<SaleDetail>('POST', '/sales', {
      items: [{ stationId: pc2.id, minutes: 60 }],
      payments: [{ method: 'cash', amountCents: 100_000 }],
    });
    expect(time.status).toBe(201);
    const credit = (
      await call<{ credits: TimeCreditSummary[] }>('GET', `/time-credits?stationId=${pc2.id}`)
    ).body.credits[0]!;
    const fromCredit = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: pc2.id,
      billingMode: 'prepaid',
      minutes: 60,
      creditId: credit.id,
    });
    expect(fromCredit.status).toBe(201);

    const tables = [
      'sales',
      'sale_items',
      'refunds',
      'refund_items',
      'gaming_sessions',
      'time_credits',
      'station_orders',
      'station_order_items',
      'inventory_movements',
      'payments',
    ];
    const before: Record<string, number> = {};
    for (const t of tables) before[t] = await rowsOf(t);
    expect(before.refund_items).toBe(1);
    expect(before.station_order_items).toBe(1);
    expect(before.time_credits).toBe(1);
    expect(
      await rowsOf('gaming_sessions WHERE time_credit_id IS NOT NULL'),
      'a session started from a credit',
    ).toBe(1);

    const backup = await call<BackupSummary>('POST', '/backups', {});
    expect(backup.status).toBe(201);
    // Something more happens, and the restore takes it back.
    expect(
      (
        await call('POST', '/sales', {
          items: [{ productId: cola.id, quantityMilli: 1000, discountCents: 0, addonIds: [] }],
          payments: [{ method: 'cash', amountCents: 150 }],
        })
      ).status,
    ).toBe(201);

    const restored = await call<RestoreResult>('POST', `/backups/${backup.body.id}/restore`, {
      password: OWNER.password,
      confirm: true,
    });
    expect(restored.status, restored.text).toBe(200);
    const after: Record<string, number> = {};
    for (const t of tables) after[t] = await rowsOf(t);
    expect(after).toEqual(before);
    expect(await rowsOf('gaming_sessions WHERE time_credit_id IS NOT NULL')).toBe(1);

    // The restored database is whole: every reference points at a row that exists.
    const broken = await ctx.pool.query<{ n: string }>(
      `SELECT (
         (SELECT count(*) FROM refund_items ri LEFT JOIN sale_items si ON si.id = ri.sale_item_id WHERE si.id IS NULL)
       + (SELECT count(*) FROM station_order_items oi LEFT JOIN station_orders o ON o.id = oi.order_id WHERE o.id IS NULL)
       + (SELECT count(*) FROM gaming_sessions g LEFT JOIN time_credits tc ON tc.id = g.time_credit_id
           WHERE g.time_credit_id IS NOT NULL AND tc.id IS NULL)
       + (SELECT count(*) FROM time_credits tc LEFT JOIN sale_items si ON si.id = tc.sale_item_id WHERE si.id IS NULL)
       )::text AS n`,
    );
    expect(broken.rows[0]!.n).toBe('0');
    // And it keeps working: the session that was running can still take an order.
    const more = await call<StationOrder>('POST', `/sessions/${session.body.session.id}/orders`, {
      items: [{ productId: cola.id, quantity: 1 }],
    });
    expect(more.status, more.text).toBeLessThan(300);
  }, 60_000);
});
