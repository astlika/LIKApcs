/**
 * 0.36.0 — money on a session's bill that is not settled in one step:
 *
 * - a paid session takes more minutes "to pay at the end" (one PC or a batch), and those minutes
 *   reach the desk when the session ends — in full when the time ran out, by use when stopped early;
 * - the registered customer is set on a running session, so pay later works there;
 * - `POST /sessions/pay`: one receipt for several PCs, at any time — running sessions go on;
 * - nothing that was handed over gets lost: a cancelled session keeps its products on the list,
 *   and "pay all" takes every bill the list shows;
 * - "up to N minutes free" on a pricing rule.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  BulkMinutesResult,
  CollectStationResponse,
  CustomerOpenBills,
  CustomerSummary,
  LoginResponse,
  PaySessionsQuote,
  PaySessionsResponse,
  PricingRuleSummary,
  ProductSummary,
  ReceiptData,
  SessionMutationResponse,
  SessionQuoteResponse,
  SessionSummary,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const plusMinutes = (minutes: number, base: Date = T0) =>
  new Date(base.getTime() + minutes * 60_000);

type Err = { error?: { code: string; message: string } };
type Order = { id: string; status: string; customerId: string | null; totalCents: number };

describe('session bills: pay at the end, pay any time, one receipt', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let rule: PricingRuleSummary;
  let cola: ProductSummary;
  let arben: CustomerSummary;
  let clock = T0;
  let pcNumber = 0;

  const H = () => authHeader(owner.token);
  const call = <T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: H(), payload: payload as never })
      .then((r) => ({ status: r.statusCode, body: r.json<T>() }));
  const post = <T>(url: string, payload?: unknown) => call<T>('POST', url, payload);
  const get = <T>(url: string) => call<T>('GET', url).then((r) => r.body);
  const setClock = (date: Date) => {
    clock = date;
    vi.setSystemTime(date);
  };
  /** Every test starts later than the one before, so no session of an earlier test interferes. */
  const nextSlot = () => setClock(plusMinutes(600, clock));
  const expireDue = async () => {
    await ctx.app.services.sessions.tick();
    await ctx.app.services.sessions.tick();
  };
  const newPc = async () => {
    pcNumber += 1;
    return (
      await post<StationSummary>('/stations', { number: pcNumber, name: `Arena ${pcNumber}` })
    ).body;
  };
  const start = async (
    mode: 'prepaid' | 'endpay' | 'postpaid',
    minutes = 60,
    extra: Record<string, unknown> = {},
  ) => {
    const pc = await newPc();
    const res = await post<SessionMutationResponse>('/sessions', {
      stationId: pc.id,
      billingMode: mode,
      ...(mode === 'postpaid' ? {} : { minutes }),
      ...(mode === 'prepaid' ? { payments: [{ method: 'cash', amountCents: minutes * 2 }] } : {}),
      ...extra,
    });
    expect(res.status).toBe(201);
    return { pc, id: res.body.session.id };
  };
  const sessionOf = (id: string) => get<SessionSummary>(`/sessions/${id}`);
  const stationOf = (id: string) =>
    get<StationSummary[]>('/stations').then((all) => all.find((s) => s.id === id)!);
  const waiting = () =>
    get<{ items: SessionSummary[] }>('/sessions?awaitingPayment=true&pageSize=200').then((r) =>
      r.items.map((s) => s.id),
    );
  const addCola = async (sessionId: string, quantity = 1) => {
    const res = await post<Order>(`/sessions/${sessionId}/orders`, {
      items: [{ productId: cola.id, quantity }],
    });
    expect(res.status).toBe(201);
    return res.body;
  };
  const salesCount = async () =>
    Number(
      (await ctx.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sales')).rows[0]!.n,
    );
  const linesOf = async (saleId: string) =>
    (
      await ctx.pool.query<{ description: string; total: string; product: string | null }>(
        `SELECT description, line_total_cents::text AS total, product_id AS product
           FROM sale_items WHERE sale_id = $1 ORDER BY line_no`,
        [saleId],
      )
    ).rows.map((r) => ({ text: r.description, cents: Number(r.total), product: !!r.product }));
  const owedBy = (customerId: string) =>
    get<CustomerSummary>(`/customers/${customerId}`).then((c) => c.balanceDueCents);

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setClock(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect((await post('/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    // 2 cents a minute.
    const created = await post<PricingRuleSummary>('/pricing/rules', {
      name: 'Standard',
      rateCentsPerHour: 120,
      billingIncrementMinutes: 1,
    });
    expect(created.status).toBe(201);
    rule = created.body;
    const cat = await post<{ id: string }>('/catalog/categories', { name: 'Drinks' });
    cola = (
      await post<ProductSummary>('/products', {
        name: 'Kola',
        sellingPriceCents: 100,
        purchaseCostCents: 50,
        categoryId: cat.body.id,
        initialStockMilli: 100_000,
      })
    ).body;
    const customer = await post<CustomerSummary>('/customers', {
      name: 'Arben Gashi',
      creditLimitCents: 100_000,
    });
    expect(customer.status).toBe(201);
    arben = customer.body;
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  // ─── Minutes "to pay at the end" on a paid session ──────────────────────────────────────────

  it('a paid session takes minutes to pay at the end: no money now, the bill waits when it ends', async () => {
    nextSlot();
    const { pc, id } = await start('prepaid', 60);
    const before = await salesCount();
    const res = await post<SessionMutationResponse>(`/sessions/${id}/extend`, {
      minutes: 60,
      later: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.payment ?? null).toBeNull();
    expect(await salesCount()).toBe(before);
    expect(res.body.session).toMatchObject({
      billingMode: 'prepaid',
      status: 'active',
      plannedSeconds: 7200,
      // What was paid stays what was paid; the added hour is owed.
      quotedPriceCents: 120,
      dueCents: 120,
      awaitingPayment: false,
    });
    expect((await stationOf(pc.id)).activeSession).toMatchObject({ dueCents: 120 });
    expect(await waiting()).not.toContain(id);

    // The time runs out: the added hour is owed in full and reaches the desk.
    setClock(plusMinutes(121, clock));
    await expireDue();
    const ended = await sessionOf(id);
    expect(ended).toMatchObject({ status: 'expired', dueCents: 120, awaitingPayment: true });
    expect(await waiting()).toContain(id);
    expect((await stationOf(pc.id)).awaitingPayment).toEqual({ count: 1, amountCents: 120 });

    const paid = await post<SessionMutationResponse>(`/sessions/${id}/collect`, {
      payments: [{ method: 'cash', amountCents: 120 }],
    });
    expect(paid.status).toBe(200);
    expect(paid.body.payment).toMatchObject({ totalCents: 120 });
    expect(await linesOf(paid.body.payment!.saleId)).toEqual([
      { text: `${pc.code} · added minutes (paid at the end)`, cents: 120, product: false },
    ]);
    expect(await sessionOf(id)).toMatchObject({
      dueCents: 0,
      awaitingPayment: false,
      quotedPriceCents: 240,
    });
    expect(await waiting()).not.toContain(id);
    expect((await stationOf(pc.id)).awaitingPayment).toEqual({ count: 0, amountCents: 0 });
  });

  it('stopped early, only the time used beyond the paid part is owed', async () => {
    nextSlot();
    const used = await start('prepaid', 60);
    await post(`/sessions/${used.id}/extend`, { minutes: 60, later: true });
    // Ten minutes into the added hour.
    setClock(plusMinutes(70, clock));
    const stopped = await post<SessionMutationResponse>(`/sessions/${used.id}/end`, {});
    expect(stopped.status).toBe(200);
    expect(stopped.body.session).toMatchObject({
      status: 'completed',
      dueCents: 20,
      awaitingPayment: true,
    });

    nextSlot();
    const unused = await start('prepaid', 60);
    await post(`/sessions/${unused.id}/extend`, { minutes: 60, later: true });
    // Still inside the paid hour: nothing of the added hour was used.
    setClock(plusMinutes(30, clock));
    const early = await post<SessionMutationResponse>(`/sessions/${unused.id}/end`, {});
    expect(early.body.session).toMatchObject({ dueCents: 0, awaitingPayment: false });
    expect(await waiting()).not.toContain(unused.id);
  });

  it('stopping with a tender pays the added minutes and the products on one receipt', async () => {
    nextSlot();
    const { pc, id } = await start('prepaid', 60);
    await post(`/sessions/${id}/extend`, { minutes: 30, later: true });
    await addCola(id);
    setClock(plusMinutes(90, clock));
    // The time is up to the minute, the session still runs until the watcher looks.
    const stopped = await post<SessionMutationResponse>(`/sessions/${id}/end`, {
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(stopped.status).toBe(200);
    expect(stopped.body.payment).toMatchObject({ totalCents: 160, changeCents: 40 });
    expect(await linesOf(stopped.body.payment!.saleId)).toEqual([
      { text: `${pc.code} · added minutes (paid at the end)`, cents: 60, product: false },
      { text: 'Kola', cents: 100, product: true },
    ]);
    expect(stopped.body.session).toMatchObject({
      dueCents: 0,
      openOrdersCents: 0,
      awaitingPayment: false,
      quotedPriceCents: 180,
    });
  });

  it('taking minutes off gives the unpaid ones back first', async () => {
    nextSlot();
    const { id } = await start('prepaid', 60);
    await post(`/sessions/${id}/extend`, { minutes: 60, later: true });
    const half = await post<SessionMutationResponse>(`/sessions/${id}/remove-time`, {
      minutes: 30,
    });
    expect(half.status).toBe(200);
    expect(half.body.session).toMatchObject({ plannedSeconds: 5400, dueCents: 60 });
    const rest = await post<SessionMutationResponse>(`/sessions/${id}/remove-time`, {
      minutes: 40,
    });
    // The last 30 unpaid minutes and 10 paid ones: nothing is owed, nothing is given back.
    expect(rest.body.session).toMatchObject({
      plannedSeconds: 3000,
      dueCents: 0,
      quotedPriceCents: 120,
    });
  });

  it('pay later in the "+ minutes" window works with the customer picked there', async () => {
    nextSlot();
    const { id } = await start('prepaid', 60);
    const debtBefore = await owedBy(arben.id);
    // Without a customer the debt has nobody to go to.
    const nobody = await post<Err>(`/sessions/${id}/extend`, {
      minutes: 30,
      payments: [{ method: 'credit', amountCents: 60 }],
    });
    expect(nobody.status).toBe(400);
    const res = await post<SessionMutationResponse>(`/sessions/${id}/extend`, {
      minutes: 30,
      customerId: arben.id,
      payments: [{ method: 'credit', amountCents: 60 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.payment).toMatchObject({ totalCents: 60, creditCents: 60 });
    expect(res.body.session).toMatchObject({
      customerId: arben.id,
      customerName: 'Arben Gashi',
      dueCents: 0,
    });
    expect(await owedBy(arben.id)).toBe(debtBefore + 60);
  });

  it('a batch of PCs: minutes to pay at the end for every one, or on one name', async () => {
    nextSlot();
    const a = await start('prepaid', 60);
    const b = await start('prepaid', 60);
    const c = await start('endpay', 60);
    const before = await salesCount();
    const later = await post<BulkMinutesResult>('/sessions/bulk-minutes', {
      stationIds: [a.pc.id, b.pc.id, c.pc.id],
      minutes: 30,
      later: true,
    });
    expect(later.status).toBe(200);
    expect(later.body.totalCents).toBe(0);
    expect(later.body.skipped).toEqual([]);
    expect(later.body.applied.map((x) => [x.priceCents, x.laterCents])).toEqual([
      [0, 60],
      [0, 60],
      [0, 60],
    ]);
    expect(await salesCount()).toBe(before);
    expect((await sessionOf(a.id)).dueCents).toBe(60);
    expect((await sessionOf(b.id)).dueCents).toBe(60);
    // A pay-at-the-end session keeps one amount for its whole time.
    expect(await sessionOf(c.id)).toMatchObject({ billingMode: 'endpay', dueCents: 180 });

    // On one name: each paid PC gets its own receipt, the debts are the customer's.
    const debtBefore = await owedBy(arben.id);
    const onTab = await post<BulkMinutesResult>('/sessions/bulk-minutes', {
      stationIds: [a.pc.id, b.pc.id],
      minutes: 30,
      customerId: arben.id,
      payments: [{ method: 'credit', amountCents: 120 }],
    });
    expect(onTab.status).toBe(200);
    expect(onTab.body.totalCents).toBe(120);
    expect(await owedBy(arben.id)).toBe(debtBefore + 120);
    // The sessions keep their own (here: no) customer; the minutes "to pay at the end" still wait.
    expect(await sessionOf(a.id)).toMatchObject({ customerId: null, dueCents: 60 });
    // Pay later without a name is refused before anything moves.
    const nobody = await post<Err>('/sessions/bulk-minutes', {
      stationIds: [a.pc.id],
      minutes: 30,
      payments: [{ method: 'credit', amountCents: 60 }],
    });
    expect(nobody.status).toBe(400);
  });

  // ─── The registered customer of a running session ───────────────────────────────────────────

  it('sets, changes and clears the customer of a running session; the products follow', async () => {
    nextSlot();
    const { pc, id } = await start('prepaid', 60);
    const order = await addCola(id);
    expect(order.customerId).toBeNull();
    const set = await call<SessionSummary>('PATCH', `/sessions/${id}/customer`, {
      customerId: arben.id,
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ customerId: arben.id, customerName: 'Arben Gashi' });
    expect((await stationOf(pc.id)).activeSession).toMatchObject({
      customerId: arben.id,
      customerName: 'Arben Gashi',
    });
    expect((await get<Order>(`/orders/${order.id}`)).customerId).toBe(arben.id);
    // Products added from now on carry the name by themselves.
    expect((await addCola(id)).customerId).toBe(arben.id);

    const typed = await call<SessionSummary>('PATCH', `/sessions/${id}/customer`, {
      customerId: null,
      customerName: 'Beni',
    });
    expect(typed.body).toMatchObject({ customerId: null, customerName: 'Beni' });
    const cleared = await call<SessionSummary>('PATCH', `/sessions/${id}/customer`, {
      customerId: null,
    });
    expect(cleared.body).toMatchObject({ customerId: null, customerName: null });
    expect((await get<Order>(`/orders/${order.id}`)).customerId).toBeNull();

    const unknown = await call<Err>('PATCH', `/sessions/${id}/customer`, {
      customerId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.status).toBe(400);
    // A closed session keeps the name it had.
    setClock(plusMinutes(61, clock));
    await post(`/sessions/${id}/end`, { payments: [{ method: 'cash', amountCents: 200 }] });
    const closed = await call<Err>('PATCH', `/sessions/${id}/customer`, { customerId: arben.id });
    expect(closed.status).toBe(409);
  });

  // ─── One receipt for several PCs, at any time ───────────────────────────────────────────────

  it('pays several PCs on one receipt while they run; only open time is stopped', async () => {
    nextSlot();
    const withCola = await start('prepaid', 60); // owes a Kola
    await addCola(withCola.id);
    const atEnd = await start('endpay', 60); // owes its 120
    const open = await start('postpaid'); // owes its time so far
    const nothing = await start('prepaid', 60); // owes nothing
    setClock(plusMinutes(30, clock));

    const ids = [withCola.id, atEnd.id, open.id, nothing.id];
    const quote = await post<PaySessionsQuote>('/sessions/pay/quote', { sessionIds: ids });
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ timeCents: 180, ordersCents: 100, totalCents: 280 });
    expect(quote.body.skipped).toEqual([{ sessionId: nothing.id, reason: 'nothing_due' }]);
    const byId = new Map(quote.body.bills.map((b) => [b.sessionId, b]));
    expect(byId.get(withCola.id)).toMatchObject({ timeCents: 0, ordersCents: 100, running: true });
    expect(byId.get(atEnd.id)).toMatchObject({ timeCents: 120, running: true, stopped: false });
    expect(byId.get(open.id)).toMatchObject({ timeCents: 60, running: false, stopped: true });
    // A quote changes nothing.
    expect((await sessionOf(open.id)).status).toBe('active');

    // The money is counted for a while; the quoted instant is what gets billed.
    setClock(plusMinutes(2, clock));
    const before = await salesCount();
    const body = {
      sessionIds: ids,
      asOf: quote.body.asOf,
      payments: [{ method: 'cash', amountCents: 300 }],
      clientRequestId: 'pay-several-0001',
    };
    const paid = await post<PaySessionsResponse>('/sessions/pay', body);
    expect(paid.status).toBe(200);
    expect(paid.body.payment).toMatchObject({ totalCents: 280, paidCents: 300, changeCents: 20 });
    expect(paid.body.totalCents).toBe(280);
    expect(paid.body.bills).toHaveLength(3);
    expect(await salesCount()).toBe(before + 1);
    const lines = await linesOf(paid.body.payment!.saleId);
    expect(lines.map((l) => l.cents).sort((x, y) => x - y)).toEqual([60, 100, 120]);
    expect(lines.filter((l) => l.product)).toEqual([{ text: 'Kola', cents: 100, product: true }]);

    // The paid PC runs on, its bill is empty.
    expect(await sessionOf(withCola.id)).toMatchObject({ status: 'active', openOrdersCents: 0 });
    // Pay at the end, paid while it ran: a paid session from here on, on the same receipt.
    expect(await sessionOf(atEnd.id)).toMatchObject({
      status: 'active',
      billingMode: 'prepaid',
      dueCents: 0,
      quotedPriceCents: 120,
      saleId: paid.body.payment!.saleId,
    });
    // Open time was stopped at the quoted instant and billed in full.
    expect(await sessionOf(open.id)).toMatchObject({
      status: 'completed',
      billableSeconds: 1800,
      finalPriceCents: 60,
      saleId: paid.body.payment!.saleId,
      awaitingPayment: false,
    });
    expect(await sessionOf(nothing.id)).toMatchObject({ status: 'active', dueCents: 0 });

    // The same request again (a retry) takes nothing twice and answers the same receipt.
    const again = await post<PaySessionsResponse>('/sessions/pay', body);
    expect(again.status).toBe(200);
    expect(again.body.payment!.receiptNo).toBe(paid.body.payment!.receiptNo);
    expect(again.body.totalCents).toBe(280);
    expect(await salesCount()).toBe(before + 1);

    // Nothing left to pay on these PCs.
    const empty = await post<Err>('/sessions/pay', {
      sessionIds: [withCola.id, atEnd.id, nothing.id],
      payments: [],
    });
    expect(empty.status).toBe(409);
    expect(empty.body.error?.code).toBe('nothing_due');

    // The session that was paid while it ran simply ends when its time is up.
    setClock(plusMinutes(60, clock));
    await expireDue();
    expect(await sessionOf(atEnd.id)).toMatchObject({ status: 'expired', awaitingPayment: false });
    expect(await waiting()).not.toContain(atEnd.id);
  });

  it('open time can be paid so far and run on; the rest is owed at the end', async () => {
    nextSlot();
    const { id } = await start('postpaid');
    setClock(plusMinutes(30, clock));
    const paid = await post<PaySessionsResponse>('/sessions/pay', {
      sessionIds: [id],
      stopOpen: false,
      payments: [{ method: 'cash', amountCents: 60 }],
    });
    expect(paid.status).toBe(200);
    expect(paid.body.bills[0]).toMatchObject({ timeCents: 60, running: true, stopped: false });
    expect(await sessionOf(id)).toMatchObject({
      status: 'active',
      advanceCents: 60,
      dueCents: 0,
      billedAt: null,
    });
    // Money was taken: it cannot be cancelled "without charging" any more.
    expect((await post<Err>(`/sessions/${id}/cancel`, { reason: 'test' })).status).toBe(409);

    setClock(plusMinutes(30, clock));
    expect(await sessionOf(id)).toMatchObject({ currentPriceCents: 120, dueCents: 60 });
    const ended = await post<SessionMutationResponse>(`/sessions/${id}/end`, {
      payments: [{ method: 'cash', amountCents: 60 }],
    });
    expect(ended.status).toBe(200);
    // Only the second half hour is on the last receipt; the session cost 120 in all.
    expect(ended.body.payment).toMatchObject({ totalCents: 60 });
    expect(ended.body.session).toMatchObject({ finalPriceCents: 120, dueCents: 0 });
  });

  it('puts the bills of several ended PCs on one name: one receipt, one debt', async () => {
    nextSlot();
    const a = await start('endpay', 60);
    const b = await start('endpay', 30);
    await addCola(b.id);
    setClock(plusMinutes(61, clock));
    await expireDue();
    expect(await waiting()).toEqual(expect.arrayContaining([a.id, b.id]));
    const debtBefore = await owedBy(arben.id);
    const before = await salesCount();
    const paid = await post<PaySessionsResponse>('/sessions/pay', {
      sessionIds: [a.id, b.id],
      customerId: arben.id,
      payments: [{ method: 'credit', amountCents: 280 }],
    });
    expect(paid.status).toBe(200);
    expect(paid.body.payment).toMatchObject({ totalCents: 280, creditCents: 280 });
    expect(await salesCount()).toBe(before + 1);
    expect(await owedBy(arben.id)).toBe(debtBefore + 280);
    for (const id of [a.id, b.id]) {
      expect(await sessionOf(id)).toMatchObject({
        awaitingPayment: false,
        saleId: paid.body.payment!.saleId,
        dueCents: 0,
      });
    }
    expect(await waiting()).not.toEqual(expect.arrayContaining([a.id]));
  });

  it('spreads a discount over the time of the PCs and never over products', async () => {
    nextSlot();
    const a = await start('endpay', 60); // 120
    const b = await start('endpay', 30); // 60
    await addCola(b.id);
    setClock(plusMinutes(61, clock));
    await expireDue();
    const tooMuch = await post<Err>('/sessions/pay', {
      sessionIds: [a.id, b.id],
      discountCents: 181,
      payments: [{ method: 'cash', amountCents: 500 }],
    });
    expect(tooMuch.status).toBe(400);
    const paid = await post<PaySessionsResponse>('/sessions/pay', {
      sessionIds: [a.id, b.id],
      discountCents: 30,
      payments: [{ method: 'cash', amountCents: 250 }],
    });
    expect(paid.status).toBe(200);
    expect(paid.body.payment).toMatchObject({ totalCents: 250 });
    expect(await sessionOf(a.id)).toMatchObject({ finalPriceCents: 100, discountCents: 20 });
    expect(await sessionOf(b.id)).toMatchObject({ finalPriceCents: 50, discountCents: 10 });
  });

  it('the receipt of the sale just paid, and what a customer has open right now', async () => {
    nextSlot();
    const { pc, id } = await start('prepaid', 60, { customerId: arben.id });
    await addCola(id, 2);
    await post(`/sessions/${id}/extend`, { minutes: 30, later: true });
    const open = await get<CustomerOpenBills>(`/sessions/open-bills?customerId=${arben.id}`);
    const mine = open.bills.find((b) => b.session.id === id)!;
    expect(mine.session).toMatchObject({
      stationCode: pc.code,
      dueCents: 60,
      openOrdersCents: 200,
    });
    expect(mine.items).toEqual([
      { name: 'Kola', quantityMilli: 2000, lineTotalCents: 200, addedAt: expect.any(String) },
    ]);
    expect(open.totalCents).toBeGreaterThanOrEqual(260);
    // 0.40.0: the same drink taken again is a row of its own, with the time it was put on the bill.
    const again = await addCola(id, 1);
    const [first] = await ctx.pool
      .query<{ id: string }>(`SELECT id FROM station_orders WHERE session_id = $1 AND id <> $2`, [
        id,
        again.id,
      ])
      .then((r) => r.rows);
    await ctx.pool.query(
      `UPDATE station_orders SET requested_at = requested_at - interval '25 minutes',
              decided_at = decided_at - interval '25 minutes' WHERE id = $1`,
      [first!.id],
    );
    const twice = (
      await get<CustomerOpenBills>(`/sessions/open-bills?customerId=${arben.id}`)
    ).bills.find((b) => b.session.id === id)!;
    expect(twice.items.map((i) => [i.name, i.quantityMilli, i.lineTotalCents])).toEqual([
      ['Kola', 2000, 200],
      ['Kola', 1000, 100],
    ]);
    const [early, late] = twice.items.map((i) => Date.parse(i.addedAt));
    expect(late! - early!).toBeGreaterThan(24 * 60_000);
    expect(twice.session.openOrdersCents).toBe(300);
    // Paid at once, so the rest of this test sees the bill it expects.
    const settled = await post<Order>(`/orders/${again.id}/pay`, {
      payments: [{ method: 'cash', amountCents: 100 }],
    });
    expect(settled.status).toBe(200);

    // An extension paid now is its own sale: the "paid" window reads that receipt, not the first.
    const extended = await post<SessionMutationResponse>(`/sessions/${id}/extend`, {
      minutes: 15,
      payments: [{ method: 'cash', amountCents: 30 }],
    });
    const saleId = extended.body.payment!.saleId;
    const bySale = await call<ReceiptData>('GET', `/sessions/by-sale/${saleId}/receipt`);
    expect(bySale.status).toBe(200);
    expect(bySale.body.sale.id).toBe(saleId);
    expect(bySale.body.sale.totalCents).toBe(30);
    const own = await call<ReceiptData>('GET', `/sessions/${id}/receipt`);
    expect(own.body.sale.id).not.toBe(saleId);
    // A sale without a PC on it is not answered here (that is the POS's receipt).
    const pos = await post<{ id: string }>('/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 100 }],
    });
    expect(pos.status).toBe(201);
    expect((await call('GET', `/sessions/by-sale/${pos.body.id}/receipt`)).status).toBe(404);

    // Paid: nothing of this PC is open any more.
    const paid = await post<PaySessionsResponse>('/sessions/pay', {
      sessionIds: [id],
      payments: [{ method: 'cash', amountCents: 260 }],
    });
    expect(paid.body.payment).toMatchObject({ totalCents: 260 });
    const after = await get<CustomerOpenBills>(`/sessions/open-bills?customerId=${arben.id}`);
    expect(after.bills.find((b) => b.session.id === id)?.session).toMatchObject({
      dueCents: 0,
      openOrdersCents: 0,
    });
  });

  // ─── Nothing that was handed over gets lost ─────────────────────────────────────────────────

  it('a cancelled session keeps its products on the waiting list until they are paid', async () => {
    nextSlot();
    const { id } = await start('endpay', 60);
    await addCola(id, 2);
    const cancelled = await post<SessionMutationResponse>(`/sessions/${id}/cancel`, {
      reason: 'wrong PC',
    });
    expect(cancelled.status).toBe(200);
    expect(await sessionOf(id)).toMatchObject({
      status: 'cancelled',
      dueCents: 0,
      openOrdersCents: 200,
      awaitingPayment: true,
    });
    expect(await waiting()).toContain(id);
    const paid = await post<SessionMutationResponse>(`/sessions/${id}/collect`, {
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(paid.status).toBe(200);
    expect(paid.body.payment).toMatchObject({ totalCents: 200 });
    expect(await linesOf(paid.body.payment!.saleId)).toEqual([
      { text: 'Kola', cents: 200, product: true },
    ]);
    expect(await sessionOf(id)).toMatchObject({ awaitingPayment: false, openOrdersCents: 0 });
    // Nothing is left: a second collect is refused.
    expect((await post<Err>(`/sessions/${id}/collect`, { payments: [] })).status).toBe(409);
  });

  it('"pay all" takes every bill the waiting list shows, a paid PC with products too', async () => {
    nextSlot();
    const paidPc = await start('prepaid', 30);
    await addCola(paidPc.id);
    const added = await start('prepaid', 30);
    await post(`/sessions/${added.id}/extend`, { minutes: 30, later: true });
    const atEnd = await start('endpay', 30);
    setClock(plusMinutes(61, clock));
    await expireDue();
    const list = await waiting();
    expect(list).toEqual(expect.arrayContaining([paidPc.id, added.id, atEnd.id]));
    const all = await get<{ items: SessionSummary[] }>(
      '/sessions?awaitingPayment=true&pageSize=200',
    );
    const total = all.items.reduce((acc, s) => acc + s.dueCents + s.openOrdersCents, 0);
    const res = await post<CollectStationResponse>('/sessions/collect-all', {
      payments: [{ method: 'cash', amountCents: total }],
    });
    expect(res.status).toBe(200);
    expect(res.body.totalCents).toBe(total);
    expect(res.body.collected.map((c) => c.sessionId)).toEqual(
      expect.arrayContaining([paidPc.id, added.id, atEnd.id]),
    );
    expect(await waiting()).toEqual([]);
  });

  // ─── "Up to N minutes free" ────────────────────────────────────────────────────────────────

  it('free minutes: a short session costs nothing, a longer one pays its whole time', async () => {
    nextSlot();
    const updated = await call<PricingRuleSummary>('PATCH', `/pricing/rules/${rule.id}`, {
      freeMinutes: 3,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.freeMinutes).toBe(3);

    const short = await start('postpaid');
    setClock(plusMinutes(2, clock));
    expect((await sessionOf(short.id)).currentPriceCents).toBe(0);
    const salesBefore = await salesCount();
    const freeEnd = await post<SessionMutationResponse>(`/sessions/${short.id}/end`, {
      payments: [],
    });
    expect(freeEnd.status).toBe(200);
    // Nothing owed: closed without a receipt, and nothing waits at the desk.
    expect(freeEnd.body.payment ?? null).toBeNull();
    expect(freeEnd.body.session).toMatchObject({
      status: 'completed',
      finalPriceCents: 0,
      saleId: null,
      awaitingPayment: false,
    });
    expect(freeEnd.body.session.billedAt).not.toBeNull();
    expect(await salesCount()).toBe(salesBefore);

    const long = await start('postpaid');
    setClock(plusMinutes(4, clock));
    // Four minutes from the first one: 8 cents.
    expect((await sessionOf(long.id)).currentPriceCents).toBe(8);
    await post(`/sessions/${long.id}/end`, { payments: [{ method: 'cash', amountCents: 8 }] });

    // Pay at the end, left at once: nothing is owed.
    const left = await start('endpay', 60);
    setClock(plusMinutes(3, clock));
    const gone = await post<SessionMutationResponse>(`/sessions/${left.id}/end`, {});
    expect(gone.body.session).toMatchObject({ finalPriceCents: 0, awaitingPayment: false });
    expect(await waiting()).not.toContain(left.id);
    // … but a product on the bill is still owed.
    const drink = await start('endpay', 60);
    await addCola(drink.id);
    setClock(plusMinutes(2, clock));
    const owes = await post<SessionMutationResponse>(`/sessions/${drink.id}/end`, {});
    expect(owes.body.session).toMatchObject({
      finalPriceCents: 0,
      openOrdersCents: 100,
      awaitingPayment: true,
    });

    // "Paguaj" on an open-time PC inside its free minutes: stopped, nothing to pay, no receipt.
    const viaPay = await start('postpaid');
    setClock(plusMinutes(1, clock));
    const before = await salesCount();
    const stoppedFree = await post<PaySessionsResponse>('/sessions/pay', {
      sessionIds: [viaPay.id],
      payments: [],
    });
    expect(stoppedFree.status).toBe(200);
    expect(stoppedFree.body.payment).toBeNull();
    expect(stoppedFree.body.bills).toMatchObject([{ sessionId: viaPay.id, stopped: true }]);
    expect(await salesCount()).toBe(before);
    expect(await sessionOf(viaPay.id)).toMatchObject({
      status: 'completed',
      finalPriceCents: 0,
      saleId: null,
      awaitingPayment: false,
    });

    // Bought minutes are never free.
    const pc = await newPc();
    const quote = await post<SessionQuoteResponse>('/sessions/quote', {
      stationId: pc.id,
      billingMode: 'prepaid',
      minutes: 2,
    });
    expect(quote.body.priceCents).toBe(4);
    expect(quote.body.terms.freeMinutes).toBe(3);
  });
});
