/**
 * Many PCs, ONE payment step (0.19.0): bulk start, bulk end and "collect all". Every PC is billed
 * by its own rule, the tenders are split across the bills, and a batch is one transaction — it
 * goes through whole or changes nothing. Also: a pay-at-the-end session that owes nothing is
 * closed for good instead of waiting in "to collect". The clock is faked (Date only).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  BulkSettleResult,
  BulkStartResult,
  CustomerSummary,
  LoginResponse,
  ProductSummary,
  SessionMutationResponse,
  SessionSummary,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);

describe('many PCs, one payment step', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let pcs: StationSummary[];
  let vip: StationSummary;
  let cola: ProductSummary;
  let arben: CustomerSummary;
  const H = () => authHeader(owner.token);

  const post = <T>(url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: H(), payload }).then((r) => ({
      status: r.statusCode,
      body: r.json<T>(),
    }));
  const get = <T>(url: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: H() }).then((r) => r.json<T>());
  const at = (date: Date) => vi.setSystemTime(date);
  const plusMinutes = (minutes: number, base: Date = T0) =>
    new Date(base.getTime() + minutes * 60_000);
  const num = async (sql: string, params: unknown[] = []) =>
    Number((await ctx.pool.query<{ n: string }>(sql, params)).rows[0]!.n);
  /** Everything money leaves behind — a refused batch must leave all of it untouched. */
  const money = async () => ({
    sales: await num(`SELECT count(*)::text AS n FROM sales`),
    salesTotal: await num(`SELECT COALESCE(sum(total_cents), 0)::text AS n FROM sales`),
    payments: await num(`SELECT count(*)::text AS n FROM payments`),
    paymentsTotal: await num(`SELECT COALESCE(sum(amount_cents), 0)::text AS n FROM payments`),
    cash: await num(
      `SELECT COALESCE(sum(amount_cents), 0)::text AS n FROM payments WHERE method = 'cash'`,
    ),
    debts: await num(`SELECT COALESCE(sum(amount_cents), 0)::text AS n FROM customer_debts`),
    sessions: await num(`SELECT count(*)::text AS n FROM gaming_sessions`),
  });
  const live = () =>
    get<StationSummary[]>('/stations').then((all) =>
      all
        .filter((s) => s.activeSession)
        .map((s) => s.code)
        .sort(),
    );
  const awaiting = () =>
    get<{ items: SessionSummary[]; total: number }>('/sessions?awaitingPayment=true');
  const ids = (list: StationSummary[]) => list.map((s) => s.id);
  /** What a waiting session owes at the desk: its time plus the orders still on its bill. */
  const due = (s: SessionSummary) => (s.finalPriceCents ?? 0) + s.openOrdersCents;
  /** Ends whatever still runs and settles whatever still waits, so tests stay independent. */
  const reset = async () => {
    const running = (await get<StationSummary[]>('/stations')).filter((s) => s.activeSession);
    if (running.length) {
      const bills = await post<BulkSettleResult>('/sessions/bulk-end', {
        stationIds: ids(running),
        preview: true,
      });
      const done = await post<BulkSettleResult>('/sessions/bulk-end', {
        stationIds: ids(running),
        payments: bills.body.totalCents
          ? [{ method: 'cash', amountCents: bills.body.totalCents }]
          : [],
      });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    }
    const waiting = (await awaiting()).items;
    if (waiting.length) {
      const total = waiting.reduce((a, s) => a + due(s), 0);
      const done = await post<BulkSettleResult>('/sessions/bulk-collect', {
        sessionIds: waiting.map((s) => s.id),
        payments: total ? [{ method: 'cash', amountCents: total }] : [],
      });
      expect(done.status).toBe(200);
    }
  };
  const orderOnBill = async (station: StationSummary, sessionId: string, cents: number) => {
    const known = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM station_devices WHERE station_id = $1`,
      [station.id],
    );
    const device = known.rows.length
      ? known
      : await ctx.pool.query<{ id: string }>(
          `INSERT INTO station_devices (station_id, machine_id, hostname, app_version, status, token_hash, registration_secret_hash, approved_at)
           VALUES ($1, $2, 'pc', '0.19.0', 'approved', $3, $4, now()) RETURNING id`,
          // Token hashes are unique per device: one fake device per PC needs its own.
          [
            station.id,
            `machine-bulk-${station.code}`,
            `token-${station.code}`,
            `secret-${station.code}`,
          ],
        );
    const order = await ctx.pool.query<{ id: string }>(
      `INSERT INTO station_orders (station_id, session_id, device_id, status, settlement, total_cents, decided_at, decided_by)
       VALUES ($1, $2, $3, 'accepted', 'on_bill', $4, now(), $5) RETURNING id`,
      [station.id, sessionId, device.rows[0]!.id, cents, owner.user.id],
    );
    await ctx.pool.query(
      `INSERT INTO station_order_items (order_id, product_id, name, quantity_milli, unit_price_cents, line_total_cents)
       VALUES ($1, $2, 'Cola', 1000, $3, $3)`,
      [order.rows[0]!.id, cola.id, cents],
    );
    return order.rows[0]!.id;
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    pcs = [];
    for (const number of [1, 2, 3])
      pcs.push((await post<StationSummary>('/stations', { number, name: `Arena ${number}` })).body);
    vip = (await post<StationSummary>('/stations', { number: 4, name: 'VIP' })).body;
    expect((await post('/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    // 1.50 / h everywhere, 3.00 / h on the VIP PC: a batch bills every PC by its own rule.
    expect(
      (
        await post('/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 150,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post('/pricing/rules', {
          name: 'VIP',
          stationId: vip.id,
          rateCentsPerHour: 300,
          billingIncrementMinutes: 1,
          priority: 10,
        })
      ).status,
    ).toBe(201);
    cola = (
      await post<ProductSummary>('/products', {
        name: 'Cola',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 50_000,
      })
    ).body;
    arben = (
      await post<CustomerSummary>('/customers', { name: 'Arben Gashi', creditLimitCents: 500 })
    ).body;
  }, 30_000);

  afterEach(async () => {
    await reset();
    at(T0);
  });
  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  // ─── Start ──────────────────────────────────────────────────────────────────

  it('starts every selected PC with one tender, each billed by its own rule', async () => {
    const before = await money();
    const res = await post<BulkStartResult>('/sessions/bulk-start', {
      stationIds: [...ids(pcs), vip.id],
      billingMode: 'prepaid',
      minutes: 60,
      // 3 × 1.50 + 3.00 = 7.50; the customer hands over a 10.
      payments: [{ method: 'cash', amountCents: 1000 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBe(false);
    expect(res.body.paidCents).toBe(750);
    expect(res.body.started.map((s) => [s.code, s.minutes, s.priceCents])).toEqual([
      [pcs[0]!.code, 60, 150],
      [pcs[1]!.code, 60, 150],
      [pcs[2]!.code, 60, 150],
      [vip.code, 60, 300],
    ]);
    expect(await live()).toHaveLength(4);
    const after = await money();
    // One receipt per PC; only the money of the bills is recorded — the change is the cashier's.
    expect(after.sales - before.sales).toBe(4);
    expect(after.salesTotal - before.salesTotal).toBe(750);
    expect(after.paymentsTotal - before.paymentsTotal).toBe(750);
    expect(after.cash - before.cash).toBe(750);
    const audit = await num(
      `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'station.bulk_start'`,
    );
    expect(audit).toBe(1);
  });

  it('refuses the whole start when the tender is short — no session, no money', async () => {
    const before = await money();
    const res = await post<{ error: { message: string; details?: { totalCents?: number } } }>(
      '/sessions/bulk-start',
      {
        stationIds: [...ids(pcs), vip.id],
        billingMode: 'prepaid',
        minutes: 60,
        payments: [{ method: 'cash', amountCents: 700 }],
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details?.totalCents).toBe(750);
    expect(await live()).toEqual([]);
    expect(await money()).toEqual(before);
  });

  it('refuses the start when the prices are not the ones the cashier saw', async () => {
    const before = await money();
    const res = await post<{ error: { details?: { code?: string; totalCents?: number } } }>(
      '/sessions/bulk-start',
      {
        stationIds: [...ids(pcs), vip.id],
        billingMode: 'prepaid',
        minutes: 60,
        // The dialog showed 6.00 (it knew nothing of the VIP price); the server says 7.50.
        expectedTotalCents: 600,
        payments: [{ method: 'cash', amountCents: 1000 }],
      },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ code: 'BILLS_CHANGED', totalCents: 750 });
    expect(await live()).toEqual([]);
    expect(await money()).toEqual(before);
  });

  it('refuses the whole start when one PC is busy, and says which one', async () => {
    const busy = await post<SessionMutationResponse>('/sessions', {
      stationId: pcs[1]!.id,
      billingMode: 'postpaid',
    });
    expect(busy.status).toBe(201);
    const before = await money();
    const res = await post<{ error: { message: string; details?: { stationCode?: string } } }>(
      '/sessions/bulk-start',
      {
        stationIds: ids(pcs),
        billingMode: 'prepaid',
        minutes: 30,
        payments: [{ method: 'cash', amountCents: 225 }],
      },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain(pcs[1]!.code);
    expect(res.body.error.details?.stationCode).toBe(pcs[1]!.code);
    expect(await live()).toEqual([pcs[1]!.code]);
    expect(await money()).toEqual(before);
  });

  it('rolls everything back when a later PC of the batch fails inside the transaction', async () => {
    // The tab covers 5.00; three PCs at 1.50 fit, the VIP bill on top does not: the batch stops
    // at the last PC — and the three sessions written before it must be gone too.
    const before = await money();
    const res = await post('/sessions/bulk-start', {
      stationIds: [...ids(pcs), vip.id],
      billingMode: 'prepaid',
      minutes: 60,
      customerId: arben.id,
      payments: [{ method: 'credit', amountCents: 750 }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await live()).toEqual([]);
    expect(await money()).toEqual(before);

    // Within the limit the same customer takes three PCs on the tab in one step.
    const ok = await post<BulkStartResult>('/sessions/bulk-start', {
      stationIds: ids(pcs),
      billingMode: 'prepaid',
      minutes: 60,
      customerId: arben.id,
      payments: [{ method: 'credit', amountCents: 450 }],
    });
    expect(ok.status).toBe(201);
    const after = await money();
    expect(after.debts - before.debts).toBe(450);
    expect(after.cash - before.cash).toBe(0);
    expect(await live()).toHaveLength(3);
    // Clear the tab again for the tests that follow.
    await ctx.pool.query(`UPDATE customers SET credit_limit_cents = 100000 WHERE id = $1`, [
      arben.id,
    ]);
  });

  it('answers a repeated batch with the sessions already started', async () => {
    const payload = {
      stationIds: ids(pcs),
      billingMode: 'prepaid',
      minutes: 60,
      payments: [{ method: 'cash', amountCents: 450 }],
      clientRequestId: 'batch-0001-abcdef',
    };
    const first = await post<BulkStartResult>('/sessions/bulk-start', payload);
    expect(first.status).toBe(201);
    const before = await money();
    const again = await post<BulkStartResult>('/sessions/bulk-start', payload);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.paidCents).toBe(450);
    expect(again.body.started.map((s) => s.sessionId).sort()).toEqual(
      first.body.started.map((s) => s.sessionId).sort(),
    );
    expect(await money()).toEqual(before);
  });

  it('lets exactly one of two overlapping batches through when they arrive together', async () => {
    const before = await money();
    const both = await Promise.all([
      post<BulkStartResult>('/sessions/bulk-start', {
        stationIds: ids(pcs),
        billingMode: 'prepaid',
        minutes: 60,
        payments: [{ method: 'cash', amountCents: 450 }],
      }),
      post<BulkStartResult>('/sessions/bulk-start', {
        stationIds: [pcs[2]!.id, pcs[1]!.id, vip.id],
        billingMode: 'prepaid',
        minutes: 60,
        payments: [{ method: 'cash', amountCents: 600 }],
      }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const won = both.find((r) => r.status === 201)!;
    // The winner is whole, the loser left nothing behind: no half-started floor, no stray money.
    expect(await live()).toEqual(won.body.started.map((s) => s.code).sort());
    const after = await money();
    expect(after.sessions - before.sessions).toBe(3);
    expect(after.sales - before.sales).toBe(3);
    expect(after.paymentsTotal - before.paymentsTotal).toBe(won.body.paidCents);
  });

  it('starts pay-at-the-end and open-time batches without taking money', async () => {
    const before = await money();
    const endpay = await post<BulkStartResult>('/sessions/bulk-start', {
      stationIds: [pcs[0]!.id, vip.id],
      billingMode: 'endpay',
      minutes: 60,
    });
    expect(endpay.status).toBe(201);
    expect(endpay.body.paidCents).toBe(0);
    expect(endpay.body.started.map((s) => s.priceCents)).toEqual([150, 300]);
    const open = await post<BulkStartResult>('/sessions/bulk-start', {
      stationIds: [pcs[1]!.id, pcs[2]!.id],
      billingMode: 'postpaid',
    });
    expect(open.status).toBe(201);
    expect(open.body.started.map((s) => s.minutes)).toEqual([null, null]);
    const after = await money();
    expect(after.sales).toBe(before.sales);
    expect(after.sessions - before.sessions).toBe(4);
  });

  // ─── End ────────────────────────────────────────────────────────────────────

  /** PC 1 prepaid (+ a cola on the bill), PC 2 open time, PC 3 pay at the end, VIP pay at the end. */
  const mixedFloor = async () => {
    const prepaid = await post<SessionMutationResponse>('/sessions', {
      stationId: pcs[0]!.id,
      billingMode: 'prepaid',
      minutes: 120,
      payments: [{ method: 'cash', amountCents: 300 }],
    });
    expect(prepaid.status).toBe(201);
    const open = await post<SessionMutationResponse>('/sessions', {
      stationId: pcs[1]!.id,
      billingMode: 'postpaid',
    });
    expect(open.status).toBe(201);
    const endpay = await post<BulkStartResult>('/sessions/bulk-start', {
      stationIds: [pcs[2]!.id, vip.id],
      billingMode: 'endpay',
      minutes: 120,
    });
    expect(endpay.status).toBe(201);
    const order = await orderOnBill(pcs[0]!, prepaid.body.session.id, 150);
    at(plusMinutes(60));
    return { order };
  };

  it('previews and ends a mixed selection with one split tender', async () => {
    const { order } = await mixedFloor();
    const all = [...ids(pcs), vip.id];
    const preview = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: all,
      preview: true,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toBe(true);
    // Prepaid: only its cola. Open time: 60 min × 1.50. Pay at the end: the used hour.
    expect(preview.body.done.map((b) => [b.code, b.billingMode, b.dueCents])).toEqual([
      [pcs[0]!.code, 'prepaid', 150],
      [pcs[1]!.code, 'postpaid', 150],
      [pcs[2]!.code, 'endpay', 150],
      [vip.code, 'endpay', 300],
    ]);
    expect(preview.body.totalCents).toBe(750);
    expect(await live()).toHaveLength(4); // a preview changes nothing

    const before = await money();
    const done = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: all,
      payments: [
        { method: 'card', amountCents: 400 },
        { method: 'cash', amountCents: 500 },
      ],
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      preview: false,
      totalCents: 750,
      paidCents: 750,
      awaitingCents: 0,
      skipped: [],
    });
    expect(done.body.done).toHaveLength(4);
    expect(await live()).toEqual([]);
    expect((await awaiting()).total).toBe(0);
    const after = await money();
    expect(after.sales - before.sales).toBe(4);
    expect(after.salesTotal - before.salesTotal).toBe(750);
    expect(after.paymentsTotal - before.paymentsTotal).toBe(750);
    // The card is used up first; cash covers the rest and nothing more.
    expect(after.cash - before.cash).toBe(350);
    expect(
      (await ctx.pool.query(`SELECT status FROM station_orders WHERE id = $1`, [order])).rows[0],
    ).toMatchObject({ status: 'billed' });
  });

  it('refuses the whole end when the tender is short — every session keeps running', async () => {
    await mixedFloor();
    const before = await money();
    const res = await post<{ error: { details?: { totalCents?: number } } }>('/sessions/bulk-end', {
      stationIds: [...ids(pcs), vip.id],
      payments: [{ method: 'cash', amountCents: 749 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details?.totalCents).toBe(750);
    expect(await live()).toHaveLength(4);
    expect(await money()).toEqual(before);
    // A card charged for more than the bills is refused too: only cash gives change.
    const over = await post('/sessions/bulk-end', {
      stationIds: [...ids(pcs), vip.id],
      payments: [{ method: 'card', amountCents: 800 }],
    });
    expect(over.status).toBe(400);
    expect(await live()).toHaveLength(4);
    expect(await money()).toEqual(before);
  });

  it('bills what the cashier was shown: the clock stands still from the preview', async () => {
    await mixedFloor();
    const all = [...ids(pcs), vip.id];
    const preview = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: all,
      preview: true,
    });
    expect(preview.body.totalCents).toBe(750);
    expect(preview.body.quotedAt).toBe(plusMinutes(60).toISOString());
    // The money is counted for three minutes; without the quote the bills would have grown.
    at(plusMinutes(63));
    const grown = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: all,
      preview: true,
    });
    expect(grown.body.totalCents).toBeGreaterThan(750);
    const before = await money();
    const done = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: all,
      sessionIds: preview.body.done.map((b) => b.sessionId),
      quotedAt: preview.body.quotedAt,
      expectedTotalCents: preview.body.totalCents,
      payments: [{ method: 'cash', amountCents: 750 }],
    });
    expect(done.status).toBe(200);
    expect(done.body.totalCents).toBe(750);
    const after = await money();
    expect(after.salesTotal - before.salesTotal).toBe(750);
    expect(after.cash - before.cash).toBe(750);
    // The sessions ended at the moment of the quote, not three minutes later.
    const ended = await ctx.pool.query<{ ended_at: Date }>(
      `SELECT ended_at FROM gaming_sessions WHERE id = ANY($1::uuid[]) AND billing_mode <> 'prepaid'`,
      [done.body.done.map((b) => b.sessionId)],
    );
    expect(ended.rows.map((r) => r.ended_at.toISOString())).toEqual([
      plusMinutes(60).toISOString(),
      plusMinutes(60).toISOString(),
      plusMinutes(60).toISOString(),
    ]);
  });

  it('refuses the batch when the amounts are not the ones the cashier saw', async () => {
    await mixedFloor();
    const all = [...ids(pcs), vip.id];
    const preview = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: all,
      preview: true,
    });
    // A cola lands on PC 2's bill while the cashier counts the money.
    const open = preview.body.done.find((b) => b.code === pcs[1]!.code)!;
    await orderOnBill(pcs[1]!, open.sessionId, 150);
    const before = await money();
    const res = await post<{ error: { details?: { code?: string; totalCents?: number } } }>(
      '/sessions/bulk-end',
      {
        stationIds: all,
        quotedAt: preview.body.quotedAt,
        expectedTotalCents: preview.body.totalCents,
        // Even with plenty of cash on the table: the cashier must see the new amount first.
        payments: [{ method: 'cash', amountCents: 2000 }],
      },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ code: 'BILLS_CHANGED', totalCents: 900 });
    expect(await live()).toHaveLength(4);
    expect(await money()).toEqual(before);

    // The stopped clock is bounded by the server: a quote from long ago bills ten minutes back
    // at most, and a quote "from the future" bills now.
    at(plusMinutes(90));
    const stale = await post<{ error: { details?: { code?: string; totalCents?: number } } }>(
      '/sessions/bulk-end',
      {
        stationIds: all,
        quotedAt: preview.body.quotedAt, // 30 minutes old
        expectedTotalCents: 900,
        payments: [{ method: 'cash', amountCents: 2000 }],
      },
    );
    expect(stale.status).toBe(409);
    // As of minute 80: open time 80 min (2.00) + cola 1.50, end pay 80 min (2.00 + 4.00), cola 1.50.
    expect(stale.body.error.details).toMatchObject({ code: 'BILLS_CHANGED', totalCents: 1100 });
    const future = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: all,
      quotedAt: plusMinutes(500).toISOString(),
      preview: true,
    });
    // As of minute 90 (now): 2.25 + 1.50, 2.25 + 4.50, 1.50.
    expect(future.body.totalCents).toBe(1200);
  });

  it('stops only the sessions the cashier was shown', async () => {
    const first = await post<BulkStartResult>('/sessions/bulk-start', {
      stationIds: [pcs[0]!.id],
      billingMode: 'postpaid',
    });
    expect(first.status).toBe(201);
    at(plusMinutes(60));
    const preview = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: ids(pcs),
      preview: true,
    });
    expect(preview.body.done.map((b) => b.code)).toEqual([pcs[0]!.code]);
    // Meanwhile a colleague starts PC 2 — it was not on the list the cashier looked at.
    const second = await post<SessionMutationResponse>('/sessions', {
      stationId: pcs[1]!.id,
      billingMode: 'postpaid',
    });
    expect(second.status).toBe(201);
    const done = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: ids(pcs),
      sessionIds: preview.body.done.map((b) => b.sessionId),
      quotedAt: preview.body.quotedAt,
      expectedTotalCents: preview.body.totalCents,
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(done.status).toBe(200);
    expect(done.body.done.map((b) => b.code)).toEqual([pcs[0]!.code]);
    expect(await live()).toEqual([pcs[1]!.code]);
  });

  it('stops without collecting: prepaid ends, pay-at-the-end waits, open time keeps running', async () => {
    await mixedFloor();
    const before = await money();
    const res = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: [...ids(pcs), vip.id],
      settle: 'later',
    });
    expect(res.status).toBe(200);
    // PC 1 has a cola on a prepaid bill and PC 2 runs on open time: both must be paid now.
    expect(res.body.skipped.map((s) => [s.code, s.reason]).sort()).toEqual([
      [pcs[0]!.code, 'needs_payment'],
      [pcs[1]!.code, 'needs_payment'],
    ]);
    expect(res.body.done.map((b) => b.code)).toEqual([pcs[2]!.code, vip.code]);
    expect(res.body).toMatchObject({ paidCents: 0, awaitingCents: 450 });
    expect(await live()).toEqual([pcs[0]!.code, pcs[1]!.code].sort());
    expect(await money()).toEqual(before);
    const waiting = await awaiting();
    expect(waiting.items.map(due).sort()).toEqual([150, 300]);
  });

  it('puts a batch on one customer tab and reports PCs with nothing running', async () => {
    await mixedFloor();
    const before = await money();
    const res = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: [pcs[1]!.id, pcs[2]!.id],
      customerId: arben.id,
      payments: [{ method: 'credit', amountCents: 300 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.paidCents).toBe(300);
    const after = await money();
    expect(after.debts - before.debts).toBe(300);
    expect(after.cash - before.cash).toBe(0);
    const owed = await num(
      `SELECT count(*)::text AS n FROM gaming_sessions WHERE customer_id = $1 AND id = ANY($2::uuid[])`,
      [arben.id, res.body.done.map((b) => b.sessionId)],
    );
    expect(owed).toBe(2);
    // The same PCs again: nothing runs there any more — reported, not billed twice.
    const again = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: [pcs[1]!.id, pcs[2]!.id],
      payments: [],
    });
    expect(again.status).toBe(200);
    expect(again.body.done).toEqual([]);
    expect(again.body.skipped.map((s) => s.reason)).toEqual([
      'no_active_session',
      'no_active_session',
    ]);
    expect(await money()).toEqual(after);
  });

  // ─── Collect ────────────────────────────────────────────────────────────────

  it('collects every waiting bill with one tender, exactly once', async () => {
    const started = await post<BulkStartResult>('/sessions/bulk-start', {
      stationIds: [pcs[0]!.id, pcs[1]!.id, vip.id],
      billingMode: 'endpay',
      minutes: 60,
    });
    expect(started.status).toBe(201);
    await orderOnBill(pcs[0]!, started.body.started[0]!.sessionId, 150);
    at(plusMinutes(61));
    await ctx.app.services.sessions.tick(new Date());
    expect(await live()).toEqual([]);
    const waiting = (await awaiting()).items;
    expect(waiting).toHaveLength(3);
    const sessionIds = waiting.map((s) => s.id);

    const preview = await post<BulkSettleResult>('/sessions/bulk-collect', {
      sessionIds,
      preview: true,
    });
    // 1.50 + the cola, 1.50, 3.00.
    expect(preview.body.totalCents).toBe(750);
    expect(preview.body.done.map((b) => b.dueCents)).toEqual([300, 150, 300]);

    const before = await money();
    const short = await post('/sessions/bulk-collect', {
      sessionIds,
      payments: [{ method: 'cash', amountCents: 500 }],
    });
    expect(short.status).toBe(400);
    expect(await money()).toEqual(before);
    expect((await awaiting()).total).toBe(3);

    const done = await post<BulkSettleResult>('/sessions/bulk-collect', {
      sessionIds,
      payments: [{ method: 'cash', amountCents: 1000 }],
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ totalCents: 750, paidCents: 750, skipped: [] });
    const after = await money();
    expect(after.sales - before.sales).toBe(3);
    expect(after.cash - before.cash).toBe(750);
    expect((await awaiting()).total).toBe(0);

    const again = await post<BulkSettleResult>('/sessions/bulk-collect', {
      sessionIds,
      payments: [{ method: 'cash', amountCents: 1000 }],
    });
    expect(again.status).toBe(200);
    expect(again.body.done).toEqual([]);
    expect(again.body.skipped.map((s) => s.reason)).toEqual([
      'not_collectable',
      'not_collectable',
      'not_collectable',
    ]);
    expect(await money()).toEqual(after);
  });

  // ─── Nothing owed → nothing waits ───────────────────────────────────────────

  it('closes a pay-at-the-end session that owes nothing instead of parking a 0.00 bill', async () => {
    const before = await money();
    const started = await post<SessionMutationResponse>('/sessions', {
      stationId: pcs[0]!.id,
      billingMode: 'endpay',
      minutes: 60,
      customerId: arben.id,
    });
    expect(started.status).toBe(201);
    // Wrong PC — stopped at once, before the first billing step.
    const ended = await post<SessionMutationResponse>(
      `/sessions/${started.body.session.id}/end`,
      {},
    );
    expect(ended.status).toBe(200);
    expect(ended.body.session).toMatchObject({
      status: 'completed',
      finalPriceCents: 0,
      awaitingPayment: false,
      saleId: null,
      billedAt: null,
    });
    expect((await awaiting()).total).toBe(0);
    const station = (await get<StationSummary[]>('/stations')).find((s) => s.id === pcs[0]!.id)!;
    expect(station.awaitingPayment?.count ?? 0).toBe(0);
    // No receipt for nothing.
    expect((await money()).sales).toBe(before.sales);

    // The same through a batch.
    const batch = await post<BulkStartResult>('/sessions/bulk-start', {
      stationIds: [pcs[1]!.id, pcs[2]!.id],
      billingMode: 'endpay',
      minutes: 60,
    });
    expect(batch.status).toBe(201);
    const stopped = await post<BulkSettleResult>('/sessions/bulk-end', {
      stationIds: [pcs[1]!.id, pcs[2]!.id],
      settle: 'later',
    });
    expect(stopped.body).toMatchObject({ totalCents: 0, awaitingCents: 0 });
    expect((await awaiting()).total).toBe(0);
    expect((await money()).sales).toBe(before.sales);
  });

  it('still parks a pay-at-the-end session that owes money, and one with only orders on it', async () => {
    const started = await post<BulkStartResult>('/sessions/bulk-start', {
      stationIds: [pcs[0]!.id, pcs[1]!.id],
      billingMode: 'endpay',
      minutes: 60,
    });
    expect(started.status).toBe(201);
    // PC 1: stopped at once but with a cola on the bill. PC 2: used for half an hour.
    await orderOnBill(pcs[0]!, started.body.started[0]!.sessionId, 150);
    const first = await post<SessionMutationResponse>(
      `/sessions/${started.body.started[0]!.sessionId}/end`,
      {},
    );
    expect(first.body.session).toMatchObject({ awaitingPayment: true, finalPriceCents: 0 });
    at(plusMinutes(30));
    const second = await post<SessionMutationResponse>(
      `/sessions/${started.body.started[1]!.sessionId}/end`,
      {},
    );
    expect(second.body.session).toMatchObject({ awaitingPayment: true, finalPriceCents: 75 });
    expect((await awaiting()).total).toBe(2);
  });
});
