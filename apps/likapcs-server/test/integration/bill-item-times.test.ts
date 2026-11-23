/**
 * 0.40.0 — the time of each product on a PC's bill.
 *
 * A customer who plays takes a drink, later something to eat; all of it goes on the PC's bill and
 * is paid at the end. When the bill is questioned the desk has to see at what time each product
 * was put on it (to look at the camera recording of that minute): on the open bill, in the amounts
 * of the payment, and — after the payment — on the receipt, whose own time is the payment's.
 *
 * The clock is faked (Date only). The database stamps an order itself, so the tests set the
 * orders' times there: T0 + 5 min, + 40 min, … — never the minute of the payment.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SETTING_DEFAULTS,
  type DataExportJobStatus,
  type LoginResponse,
  type PaySessionsQuote,
  type PaySessionsResponse,
  type PricingRuleSummary,
  type ProductSummary,
  type ReceiptData,
  type SaleDetail,
  type SessionMutationResponse,
  type SessionSummary,
  type StationOrder,
  type StationSummary,
} from '@likapcs/shared';
import { loadMigrationFiles } from '../../src/db/migrate.js';
import { authHeader, createTestContext, runSetup, sleep, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
/** `minutes` after the start of the tests. */
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();

type Row = Record<string, unknown>;

describe('the time of each product on a PC bill', () => {
  let ctx: TestContext;
  let dataDir: string;
  let owner: LoginResponse;
  const H = () => authHeader(owner.token);

  const call = <T>(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method, url: `/api/v1${url}`, headers: H(), payload }).then((r) => ({
      status: r.statusCode,
      body: r.json<T>(),
    }));
  const q = <T extends Row>(sql: string, params: unknown[] = []) =>
    ctx.pool.query<T>(sql, params).then((r) => r.rows);

  const makeStation = async (number: number) =>
    (await call<StationSummary>('POST', '/stations', { number, name: `Arena ${number}` })).body;

  /** The desk puts products on a PC's bill; the order is then moved to the minute `minutes`. */
  const add = async (
    sessionId: string,
    items: { productId: string; quantity: number }[],
    minutes: number,
  ) => {
    const res = await call<StationOrder>('POST', `/sessions/${sessionId}/orders`, { items });
    expect(res.status).toBe(201);
    await q('UPDATE station_orders SET requested_at = $2, decided_at = $2 WHERE id = $1', [
      res.body.id,
      at(minutes),
    ]);
    return res.body;
  };
  const ordersOf = async (sessionId: string) => {
    const list = await call<{ items: StationOrder[] }>(
      'GET',
      `/orders?sessionId=${sessionId}&limit=200`,
    );
    expect(list.status).toBe(200);
    return list.body.items;
  };
  const linesOf = async (saleId: string) => {
    const sale = await call<SaleDetail>('GET', `/sales/${saleId}`);
    expect(sale.status).toBe(200);
    return sale.body;
  };
  /** What the lines of every sale hold in the database, to compare before and after. */
  const storedTimes = () =>
    q<{ id: string; added_at: Date | null }>(
      'SELECT id::text AS id, added_at FROM sale_items ORDER BY id',
    ).then((rows) => rows.map((r) => [r.id, r.added_at ? r.added_at.toISOString() : null]));

  let cola: ProductSummary;
  let chips: ProductSummary;
  /** The first PC: pay at the end, three product lines from two moments. */
  let sid: string;
  let firstSaleId: string;
  let firstReceiptNo: string;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-bill-times-'));
    ctx = await createTestContext({ dataDir });
    owner = await runSetup(ctx.app);
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    expect(
      (
        await call<PricingRuleSummary>('POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 150,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    cola = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Cola',
        sellingPriceCents: 200,
        trackStock: false,
      })
    ).body;
    chips = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Chips',
        sellingPriceCents: 150,
        trackStock: false,
      })
    ).body;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('an open bill says when each product was put on it, how, and by whom', async () => {
    const station = await makeStation(1);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 60,
    });
    expect(started.status).toBe(201);
    sid = started.body.session.id;

    // Two colas after five minutes; a cola and chips 35 minutes later.
    const first = await add(sid, [{ productId: cola.id, quantity: 2 }], 5);
    const second = await add(
      sid,
      [
        { productId: cola.id, quantity: 1 },
        { productId: chips.id, quantity: 1 },
      ],
      40,
    );

    const byId = new Map((await ordersOf(sid)).map((o) => [o.id, o]));
    expect(byId.size).toBe(2);
    expect(byId.get(first.id)).toMatchObject({
      status: 'accepted',
      settlement: 'on_bill',
      fromDevice: false,
      decidedAt: iso(5),
      decidedByName: 'Shop Owner',
      totalCents: 400,
    });
    expect(byId.get(second.id)).toMatchObject({
      status: 'accepted',
      fromDevice: false,
      decidedAt: iso(40),
      decidedByName: 'Shop Owner',
      totalCents: 350,
    });

    // The amounts of the payment list the products oldest first, each with its own time.
    vi.setSystemTime(at(50));
    const quote = await call<PaySessionsQuote>('POST', '/sessions/pay/quote', {
      sessionIds: [sid],
    });
    expect(quote.status).toBe(200);
    expect(quote.body.bills).toHaveLength(1);
    expect(quote.body.bills[0]!.items).toEqual([
      { name: 'Cola', quantityMilli: 2000, lineTotalCents: 400, addedAt: iso(5) },
      { name: 'Cola', quantityMilli: 1000, lineTotalCents: 200, addedAt: iso(40) },
      { name: 'Chips', quantityMilli: 1000, lineTotalCents: 150, addedAt: iso(40) },
    ]);
    expect(quote.body.ordersCents).toBe(750);
  });

  it('the receipt keeps the time of each product — not the time of the payment', async () => {
    vi.setSystemTime(at(55));
    expect((await call('POST', `/sessions/${sid}/end`, {})).status).toBe(200);
    const ended = (await call<SessionSummary>('GET', `/sessions/${sid}`)).body;
    expect(ended.openOrdersCents).toBe(750);
    const total = (ended.dueCents ?? 0) + ended.openOrdersCents;

    // The money is taken three minutes later.
    vi.setSystemTime(at(58));
    const collected = await call<SessionMutationResponse>('POST', `/sessions/${sid}/collect`, {
      payments: [{ method: 'cash', amountCents: total }],
    });
    expect(collected.status).toBe(200);
    firstSaleId = collected.body.payment!.saleId;
    firstReceiptNo = collected.body.payment!.receiptNo;

    const sale = await linesOf(firstSaleId);
    expect(sale.completedAt).toBe(iso(58));
    // The PC's time has no time of its own; every product has the minute it was put on the bill.
    // The same product taken twice stays two lines.
    expect(sale.items.map((i) => [i.productId, i.quantityMilli, i.addedAt])).toEqual([
      [null, 1000, null],
      [cola.id, 2000, iso(5)],
      [cola.id, 1000, iso(40)],
      [chips.id, 1000, iso(40)],
    ]);
    expect(sale.items.every((i) => i.addedAt !== sale.completedAt)).toBe(true);

    // The receipt that is printed, and the one printed again later from the sales list.
    const receipt = await call<ReceiptData>('GET', `/sessions/${sid}/receipt`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.sale.items.map((i) => i.addedAt)).toEqual([null, iso(5), iso(40), iso(40)]);
    vi.setSystemTime(at(600));
    const reprint = await call<ReceiptData>('GET', `/sales/${firstSaleId}/receipt?reprint=true`);
    expect(reprint.status).toBe(200);
    expect(reprint.body.sale.items.map((i) => i.addedAt)).toEqual([null, iso(5), iso(40), iso(40)]);

    // The orders stay with the session: paid now, on that receipt, still with their times.
    const orders = await ordersOf(sid);
    expect(orders.map((o) => o.status)).toEqual(['billed', 'billed']);
    expect(orders.map((o) => o.receiptNo)).toEqual([firstReceiptNo, firstReceiptNo]);
    expect(orders.map((o) => o.decidedAt).sort()).toEqual([iso(5), iso(40)]);
  });

  it('a bill paid in parts: each receipt carries the products it paid, with their times', async () => {
    vi.setSystemTime(at(700));
    const station = await makeStation(2);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 60,
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(started.status).toBe(201);
    const id = started.body.session.id;

    // A cola at minute 705, paid at 710 while the PC runs on.
    await add(id, [{ productId: cola.id, quantity: 1 }], 705);
    vi.setSystemTime(at(710));
    const quote = await call<PaySessionsQuote>('POST', '/sessions/pay/quote', { sessionIds: [id] });
    expect(quote.body.bills[0]!.items).toEqual([
      { name: 'Cola', quantityMilli: 1000, lineTotalCents: 200, addedAt: iso(705) },
    ]);
    const paid = await call<PaySessionsResponse>('POST', '/sessions/pay', {
      sessionIds: [id],
      asOf: quote.body.asOf,
      payments: [{ method: 'cash', amountCents: 200 }],
      clientRequestId: 'bill-times-part-0001',
    });
    expect(paid.status).toBe(200);
    const partOne = await linesOf(paid.body.payment!.saleId);
    expect(partOne.items.map((i) => [i.productId, i.addedAt])).toEqual([[cola.id, iso(705)]]);

    // Chips at 730, paid when the session is ended at 740.
    await add(id, [{ productId: chips.id, quantity: 1 }], 730);
    vi.setSystemTime(at(740));
    const ended = await call<SessionMutationResponse>('POST', `/sessions/${id}/end`, {
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(ended.status).toBe(200);
    const partTwo = await linesOf(ended.body.payment!.saleId);
    expect(partTwo.id).not.toBe(partOne.id);
    expect(partTwo.items.map((i) => [i.productId, i.addedAt])).toEqual([[chips.id, iso(730)]]);
  });

  it('several PCs on one receipt: each PC keeps the times of its own products', async () => {
    vi.setSystemTime(at(750));
    const ids: string[] = [];
    for (const number of [3, 4]) {
      const station = await makeStation(number);
      const started = await call<SessionMutationResponse>('POST', '/sessions', {
        stationId: station.id,
        billingMode: 'endpay',
        minutes: 60,
      });
      expect(started.status).toBe(201);
      ids.push(started.body.session.id);
    }
    const [a, b] = ids as [string, string];
    // The same product on both PCs at different minutes; the second PC takes it twice.
    await add(b, [{ productId: cola.id, quantity: 1 }], 752);
    await add(a, [{ productId: cola.id, quantity: 1 }], 755);
    await add(b, [{ productId: cola.id, quantity: 1 }], 761);
    vi.setSystemTime(at(770));
    const quote = await call<PaySessionsQuote>('POST', '/sessions/pay/quote', { sessionIds: ids });
    expect(quote.status).toBe(200);
    const billOf = (id: string) => quote.body.bills.find((x) => x.sessionId === id)!;
    expect(billOf(a).items.map((i) => i.addedAt)).toEqual([iso(755)]);
    expect(billOf(b).items.map((i) => i.addedAt)).toEqual([iso(752), iso(761)]);
    const paid = await call<PaySessionsResponse>('POST', '/sessions/pay', {
      sessionIds: ids,
      asOf: quote.body.asOf,
      payments: [{ method: 'cash', amountCents: quote.body.totalCents }],
      clientRequestId: 'bill-times-two-pcs-0001',
    });
    expect(paid.status).toBe(200);
    const sale = await linesOf(paid.body.payment!.saleId);
    const products = sale.items.filter((i) => i.productId);
    expect(products).toHaveLength(3);
    const timesOf = (id: string) =>
      products.filter((i) => i.gamingSessionId === id).map((i) => i.addedAt);
    expect(timesOf(a)).toEqual([iso(755)]);
    expect(timesOf(b)).toEqual([iso(752), iso(761)]);
    // The PC time of both has none.
    expect(sale.items.filter((i) => !i.productId).map((i) => i.addedAt)).toEqual([null, null]);
  });

  it('lists the products in the order they came onto the bill, not in the order they were asked for', async () => {
    vi.setSystemTime(at(772));
    const station = await makeStation(6);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 60,
    });
    const id = started.body.session.id;
    // The customer asks from the PC at minute 773; the desk accepts it only at minute 776 —
    // after it has itself put a Cola on the bill at minute 775.
    const fromPc = await add(id, [{ productId: chips.id, quantity: 1 }], 776);
    await q('UPDATE station_orders SET requested_at = $2 WHERE id = $1', [fromPc.id, at(773)]);
    await add(id, [{ productId: cola.id, quantity: 1 }], 775);
    vi.setSystemTime(at(778));
    const quote = await call<PaySessionsQuote>('POST', '/sessions/pay/quote', {
      sessionIds: [id],
    });
    expect(quote.body.bills[0]!.items.map((i) => [i.name, i.addedAt])).toEqual([
      ['Cola', iso(775)],
      ['Chips', iso(776)],
    ]);
    const paid = await call<PaySessionsResponse>('POST', '/sessions/pay', {
      sessionIds: [id],
      asOf: quote.body.asOf,
      payments: [{ method: 'cash', amountCents: quote.body.totalCents }],
      clientRequestId: 'bill-times-order-0001',
    });
    expect(paid.status).toBe(200);
    // The receipt keeps that order, each product with its time.
    const sale = await linesOf(paid.body.payment!.saleId);
    expect(sale.items.filter((i) => i.productId).map((i) => [i.description, i.addedAt])).toEqual([
      ['Cola', iso(775)],
      ['Chips', iso(776)],
    ]);
  });

  it('an order paid on its own at the desk keeps the time it was put on the bill', async () => {
    vi.setSystemTime(at(780));
    const station = await makeStation(5);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 60,
    });
    const id = started.body.session.id;
    const order = await call<StationOrder>('POST', `/sessions/${id}/orders`, {
      items: [{ productId: chips.id, quantity: 2 }],
    });
    expect(order.status).toBe(201);
    // It stood on the bill for twenty minutes (the database's own clock stamps and judges this).
    await q(
      `UPDATE station_orders SET requested_at = now() - interval '20 minutes',
              decided_at = now() - interval '20 minutes' WHERE id = $1`,
      [order.body.id],
    );
    const paid = await call<StationOrder>('POST', `/orders/${order.body.id}/pay`, {
      payments: [{ method: 'cash', amountCents: 300 }],
    });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: 'paid', settlement: 'on_bill' });
    const sale = await linesOf(paid.body.saleId!);
    expect(sale.items.map((i) => [i.productId, i.quantityMilli])).toEqual([[chips.id, 2000]]);
    expect(sale.items[0]!.addedAt).toBe(paid.body.decidedAt);
    expect(Date.parse(paid.body.settledAt!) - Date.parse(paid.body.decidedAt!)).toBeGreaterThan(
      19 * 60_000,
    );

    // Added and paid in one step on the same running PC: the sale's own time is the time.
    const atOnce = await call<StationOrder>('POST', `/sessions/${id}/orders`, {
      items: [{ productId: cola.id, quantity: 1 }],
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(atOnce.status).toBe(201);
    expect(atOnce.body).toMatchObject({ status: 'paid', settlement: 'on_bill' });
    expect((await linesOf(atOnce.body.saleId!)).items.map((i) => i.addedAt)).toEqual([null]);
    // The PC's bill holds neither any more.
    expect((await call<SessionSummary>('GET', `/sessions/${id}`)).body.openOrdersCents).toBe(0);
  });

  it('a product sold at the till has no time of its own: the time of the sale is its time', async () => {
    vi.setSystemTime(at(800));
    const sale = await call<SaleDetail>('POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.items.map((i) => i.addedAt)).toEqual([null]);

    // A product paid at once for a PC whose bill is closed is such a sale too.
    const atOnce = await call<StationOrder>('POST', `/sessions/${sid}/orders`, {
      items: [{ productId: chips.id, quantity: 1 }],
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(atOnce.status).toBe(201);
    expect(atOnce.body).toMatchObject({ status: 'paid', fromDevice: false });
    const paidNow = await linesOf(atOnce.body.saleId!);
    expect(paidNow.completedAt).toBe(iso(800));
    expect(paidNow.items.map((i) => i.addedAt)).toEqual([null]);
  });

  it('bills paid before this version get their times from their orders — only a certain pair', async () => {
    const migration = (await loadMigrationFiles(ctx.config.migrationsDir)).find(
      (m) => m.version === 65,
    )!;
    const backfill = migration.sql.slice(migration.sql.indexOf('WITH sale_lines'));
    expect(backfill).toContain('UPDATE sale_items');

    const written = await storedTimes();
    // 3 of the first bill + 2 of the bill paid in parts + 3 of the two PCs + 2 of the bill
    // with an order from the PC + 1 paid at the desk.
    expect(written.filter(([, time]) => time !== null)).toHaveLength(11);
    // As the lines were before 0.40.0: none has a time. The migration gives back the same times.
    await q('UPDATE sale_items SET added_at = NULL');
    await ctx.pool.query(backfill);
    expect(await storedTimes()).toEqual(written);

    // A line that no longer agrees with its order keeps no time rather than a guessed one; the
    // other lines of the same bill are not disturbed by it.
    await q('UPDATE sale_items SET added_at = NULL');
    await q('UPDATE sale_items SET quantity_milli = 3000 WHERE sale_id = $1 AND product_id = $2', [
      firstSaleId,
      chips.id,
    ]);
    await ctx.pool.query(backfill);
    const odd = await q<{ product_id: string | null; added_at: Date | null }>(
      'SELECT product_id, added_at FROM sale_items WHERE sale_id = $1 ORDER BY line_no',
      [firstSaleId],
    );
    expect(odd.map((l) => [l.product_id, l.added_at?.toISOString() ?? null])).toEqual([
      [null, null],
      [cola.id, iso(5)],
      [cola.id, iso(40)],
      [chips.id, null],
    ]);

    // Back as it was, for the tests that follow.
    await q('UPDATE sale_items SET quantity_milli = 1000 WHERE sale_id = $1 AND product_id = $2', [
      firstSaleId,
      chips.id,
    ]);
    await ctx.pool.query(backfill);
    expect(await storedTimes()).toEqual(written);
  });

  it('the data file for an AI names the time on the line as well', async () => {
    // The days are named: the faked clock of these tests runs ahead of the database's "today".
    const day = (minutes: number) =>
      new Intl.DateTimeFormat('sv-SE', {
        timeZone: SETTING_DEFAULTS['locale.timezone'],
        dateStyle: 'short',
      }).format(at(minutes));
    const started = await call<{ jobId: string }>('POST', '/reports/data-file', {
      formats: ['json'],
      from: day(-24 * 60),
      to: day(48 * 60),
    });
    expect(started.status).toBe(202);
    let status: DataExportJobStatus;
    for (;;) {
      status = (
        await call<DataExportJobStatus>('GET', `/reports/data-file/jobs/${started.body.jobId}`)
      ).body;
      if (status.state !== 'running') break;
      await sleep(10);
    }
    expect(status.error).toBeNull();
    const file = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/reports/data-file/${status.result!.id}/json/download`,
      headers: H(),
    });
    expect(file.statusCode).toBe(200);
    const data = JSON.parse(file.body) as Row;

    // Local time of the business, to the minute — as every other time of the file.
    const local = (minutes: number) =>
      new Intl.DateTimeFormat('sv-SE', {
        timeZone: SETTING_DEFAULTS['locale.timezone'],
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(at(minutes));
    const sale = (data['Shitjet'] as Row[]).find((r) => r['Nr'] === firstReceiptNo)!;
    const lines = sale['Artikujt'] as Row[];
    expect(lines.map((l) => l['Shtuar në faturën e PC-së'] ?? null)).toEqual([
      null,
      local(5),
      local(40),
      local(40),
    ]);
    expect(sale['Koha']).toBe(local(58));
    // The other products that stood on a bill have it too; nothing else of the file does.
    const all = (data['Shitjet'] as Row[]).flatMap((r) => (r['Artikujt'] as Row[]) ?? []);
    expect(all.filter((l) => l['Shtuar në faturën e PC-së'] !== undefined)).toHaveLength(11);
    expect(all.length).toBeGreaterThan(11);
  });
});
