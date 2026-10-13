/**
 * Orders from the PC + customer pause / resume (0.10.0).
 *
 * The owner curates a menu (`PUT /catalog/menu`), the PC fetches it with its device token only
 * while a session runs, sends an order (prices snapshotted, promo-aware), staff accept it
 * "pay now" (a real POS sale: receipt, stock, drawer) or "on the bill" (settled on the session's
 * receipt when it ends — also for prepaid sessions, on their own receipt), or reject it with a
 * reason the PC is told at once. A customer can pause / resume at the PC; a customer pause ends
 * by itself after `sessions.pause_max_minutes`; staff pauses never do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type ClientMenu,
  type LoginResponse,
  type ProductSummary,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type SaleDetail,
  type SessionMutationResponse,
  type SessionSummary,
  type StationOrder,
  type StationSummary,
} from '@likapcs/shared';
import { SERVER_VERSION } from '../../src/version.js';
import {
  authHeader,
  createTestContext,
  login,
  openSocket,
  runSetup,
  type TestContext,
} from '../helpers.js';

describe('orders from the PC + customer pause / resume', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let station: StationSummary;
  let deviceToken: string;
  let cola: ProductSummary;
  let chips: ProductSummary;
  let water: ProductSummary;
  let client: Awaited<ReturnType<typeof openSocket>>;
  let admin: Awaited<ReturnType<typeof openSocket>>;
  let wsUrl: string;

  const call = <T>(
    token: string | null,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: { ...(token ? authHeader(token) : {}), ...headers },
        payload: payload === undefined ? undefined : (payload as Record<string, unknown>),
      })
      .then((r) => ({ status: r.statusCode, body: r.body ? (r.json<T>() as T) : (null as T) }));

  type Err = { error?: { code: string; message: string } };
  const menu = () => call<ClientMenu>(deviceToken, 'GET', '/client/menu');
  const order = (body: Record<string, unknown>) =>
    call<StationOrder & Err>(deviceToken, 'POST', '/client/orders', body);
  const stationNow = () =>
    call<StationSummary[]>(owner.token, 'GET', '/stations').then((r) =>
      r.body.find((s) => s.id === station.id)!,
    );

  const expectMessage = async (
    socket: Awaited<ReturnType<typeof openSocket>>,
    type: string,
    where: (m: Record<string, unknown>) => boolean = () => true,
  ) => {
    const deadline = Date.now() + 5_000;
    const seen: string[] = [];
    while (Date.now() < deadline) {
      const msg = await socket.next(deadline - Date.now()).catch(() => null);
      if (!msg) break;
      if (msg.type === type && where(msg)) return msg;
      seen.push(JSON.stringify(msg).slice(0, 160));
    }
    throw new Error(`no ${type} message; saw: ${seen.join(' | ') || 'nothing'}`);
  };
  let heartbeat: NodeJS.Timeout | null = null;
  const keepAlive = (socket: Awaited<ReturnType<typeof openSocket>>) => {
    socket.socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; commandId?: string };
      if (msg.type === 'server.command' && msg.commandId)
        socket.send({ type: 'client.ack', commandId: msg.commandId, ok: true });
    });
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (socket.socket.readyState === socket.socket.OPEN)
        socket.send({ type: 'client.heartbeat', ts: new Date().toISOString(), locked: false });
    }, 2_000);
  };
  const expectOrderPush = (status: string, id?: string) =>
    expectMessage(client, 'server.order', (m) => {
      const o = m.order as { status: string; id: string };
      return o.status === status && (!id || o.id === id);
    }).then(
      (m) =>
        m.order as {
          id: string;
          status: string;
          reason: string | null;
          totalCents: number;
          items: { name: string; quantity: number }[];
        },
    );
  const expectAdminOrder = (status: string, id?: string) =>
    expectMessage(admin, 'server.event', (m) => {
      if (m.event !== 'order.changed') return false;
      const o = m.payload as StationOrder;
      return o.status === status && (!id || o.id === id);
    }).then((m) => m.payload as StationOrder);
  const expectCommand = (command: string) =>
    expectMessage(client, 'server.command', (m) => m.command === command);

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
    expect(
      (await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 2000 })).status,
    ).toBe(201);
    expect(
      (
        await call(owner.token, 'POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 120,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    const drinks = await call<{ id: string }>(owner.token, 'POST', '/catalog/categories', {
      name: 'Drinks',
    });
    const snacks = await call<{ id: string }>(owner.token, 'POST', '/catalog/categories', {
      name: 'Snacks',
    });
    const product = async (body: Record<string, unknown>) => {
      const r = await call<ProductSummary>(owner.token, 'POST', '/products', body);
      expect(r.status).toBe(201);
      return r.body;
    };
    cola = await product({
      name: 'Coca-Cola 0.5',
      sellingPriceCents: 150,
      purchaseCostCents: 80,
      categoryId: drinks.body.id,
      initialStockMilli: 10_000,
    });
    chips = await product({
      name: 'Chips',
      sellingPriceCents: 100,
      categoryId: snacks.body.id,
      initialStockMilli: 2_000,
    });
    water = await product({
      name: 'Water',
      sellingPriceCents: 80,
      categoryId: drinks.body.id,
      trackStock: false,
    });
    station = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 1, name: 'PC 1' })
    ).body;

    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    wsUrl = `ws://127.0.0.1:${port}`;
    const registrationSecret = randomBytes(32).toString('base64url');
    const reg = await call<RegisterDeviceResponse>(null, 'POST', '/client/register', {
      machineId: 'MACHINE-ORD-0001',
      hostname: 'pc1',
      osInfo: 'Windows 11',
      appVersion: SERVER_VERSION,
      registrationSecret,
    });
    await call(owner.token, 'POST', `/devices/${reg.body.registrationId}/approve`, {
      stationId: station.id,
    });
    const poll = await call<RegistrationPollResponse>(
      null,
      'GET',
      `/client/registration/${reg.body.registrationId}?secret=${registrationSecret}`,
    );
    deviceToken = poll.body.deviceToken!;
    client = await openSocket(`${wsUrl}/ws/client`);
    client.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId: 'MACHINE-ORD-0001',
    });
    const welcome = await client.next();
    expect(welcome.type).toBe('server.welcome');
    expect(welcome.orders).toEqual([]);
    expect((welcome.display as { orders: boolean; customerPause: boolean }).orders).toBe(true);
    expect((welcome.display as { orders: boolean; customerPause: boolean }).customerPause).toBe(
      true,
    );
    keepAlive(client);
    admin = await openSocket(`${wsUrl}/ws/admin`);
    admin.send({ type: 'admin.hello', token: owner.token, protocolVersion: PROTOCOL_VERSION });
    expect((await admin.next()).type).toBe('server.welcome');
  }, 30_000);

  afterAll(async () => {
    if (heartbeat) clearInterval(heartbeat);
    client?.socket.close();
    admin?.socket.close();
    await ctx.close();
  });

  // ─── Menu ─────────────────────────────────────────────────────────────────────

  it('the owner picks what the PCs may order; the list keeps the given order', async () => {
    expect(
      (await call(cashier.token, 'PUT', '/catalog/menu', { productIds: [cola.id] })).status,
    ).toBe(403);
    const set = await call<{ items: ProductSummary[] }>(owner.token, 'PUT', '/catalog/menu', {
      productIds: [chips.id, cola.id, water.id],
    });
    expect(set.status).toBe(200);
    expect(set.body.items.map((p) => p.name)).toEqual(['Chips', 'Coca-Cola 0.5', 'Water']);
    expect(set.body.items.every((p) => p.clientMenu)).toBe(true);
    const list = await call<{ items: ProductSummary[] }>(owner.token, 'GET', '/catalog/menu');
    expect(list.body.items.map((p) => p.id)).toEqual([chips.id, cola.id, water.id]);
    // A product can also be switched on its own (product dialog).
    const patched = await call<ProductSummary>(owner.token, 'PATCH', `/products/${water.id}`, {
      clientMenu: false,
    });
    expect(patched.body.clientMenu).toBe(false);
    const products = await call<{ items: ProductSummary[] }>(
      owner.token,
      'GET',
      '/products?menu=true&pageSize=100',
    );
    expect(products.body.items.map((p) => p.id).sort()).toEqual([chips.id, cola.id].sort());
  });

  it('the PC sees the menu on the locked screen (0.14.0) or, with the switch off, only while a session runs; prices are promo-aware; stock-outs stay visible', async () => {
    // Default: the locked screen may order — the menu is open, tagged "locked".
    const lockedOpen = await menu();
    expect(lockedOpen.status).toBe(200);
    expect(lockedOpen.body).toMatchObject({ enabled: true, reason: 'ok', context: 'locked' });
    expect(lockedOpen.body.items.length).toBeGreaterThan(0);
    // Switch off: browsing stays possible (items present), sending is refused.
    await call(owner.token, 'PATCH', '/settings', { 'orders.locked_screen': false });
    const locked = await menu();
    expect(locked.status).toBe(200);
    expect(locked.body).toMatchObject({ enabled: false, reason: 'no_session', context: 'locked' });
    expect(locked.body.items.length).toBeGreaterThan(0);
    const denied = await order({ items: [{ productId: cola.id, quantity: 1 }] });
    expect(denied.status).toBe(409);
    expect(denied.body.error?.code).toBe('no_session');

    // Promo on cola: the menu shows the promo and the regular price.
    expect(
      (
        await call(owner.token, 'POST', '/ads', {
          kind: 'product',
          productId: cola.id,
          promoPriceCents: 120,
        })
      ).status,
    ).toBe(201);
    const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
    });
    expect(started.status).toBe(201);
    await expectCommand('session.start');
    const open = await menu();
    expect(open.body.reason).toBe('ok');
    expect(open.body.categories.map((c) => c.name)).toEqual(['Drinks', 'Snacks']);
    const colaItem = open.body.items.find((i) => i.productId === cola.id)!;
    expect(colaItem).toMatchObject({ priceCents: 120, oldPriceCents: 150, available: true });
    expect(open.body.items.find((i) => i.productId === chips.id)).toMatchObject({
      priceCents: 100,
      oldPriceCents: null,
    });
    expect(open.body.items.some((i) => i.productId === water.id)).toBe(false);
    expect(open.body.context).toBe('session');
    await call(owner.token, 'PATCH', '/settings', { 'orders.locked_screen': true });
  });

  // ─── Order → reject ───────────────────────────────────────────────────────────

  it('an order is snapshotted, shown to the Admin at once and can be rejected with a reason', async () => {
    const sent = await order({
      items: [
        { productId: cola.id, quantity: 2 },
        { productId: chips.id, quantity: 1 },
      ],
      note: 'pa akull',
    });
    expect(sent.status).toBe(201);
    expect(sent.body.status).toBe('pending');
    expect(sent.body.totalCents).toBe(2 * 120 + 100);
    expect(sent.body.note).toBe('pa akull');
    expect(sent.body.items.map((i) => [i.name, i.quantityMilli, i.unitPriceCents])).toEqual([
      ['Coca-Cola 0.5', 2000, 120],
      ['Chips', 1000, 100],
    ]);
    const event = await expectAdminOrder('pending', sent.body.id);
    expect(event.stationCode).toBe(station.code);
    await expectOrderPush('pending', sent.body.id);
    expect((await stationNow()).orders).toEqual({ pending: 1, openCount: 0, openCents: 0 });

    const open = await call<{ items: StationOrder[] }>(owner.token, 'GET', '/orders?open=true');
    expect(open.body.items.map((o) => o.id)).toEqual([sent.body.id]);

    // Deciding orders = running sessions (`stations.control`): cashiers may, read-only roles not.
    await call(owner.token, 'POST', '/users', {
      username: 'llogari',
      fullName: 'Read Only',
      password: 'Reader123',
      roles: ['accountant'],
      mustChangePassword: false,
    });
    const reader = await login(ctx.app, 'llogari', 'Reader123');
    expect(
      (await call(reader.token, 'POST', `/orders/${sent.body.id}/reject`, { reason: 'x' })).status,
    ).toBe(403);
    const no = await call<StationOrder>(cashier.token, 'POST', `/orders/${sent.body.id}/reject`, {
      reason: 'Mbaroi Coca-Cola',
    });
    expect(no.status).toBe(200);
    expect(no.body.status).toBe('rejected');
    const push = await expectOrderPush('rejected', sent.body.id);
    expect(push.reason).toBe('Mbaroi Coca-Cola');
    expect((await stationNow()).orders.pending).toBe(0);
    // Nothing was sold.
    const sales = await call<{ items: unknown[] }>(owner.token, 'GET', '/sales?pageSize=5');
    expect(sales.body.items).toHaveLength(0);
    // Decided orders cannot be decided again.
    expect(
      (
        await call(owner.token, 'POST', `/orders/${sent.body.id}/accept`, {
          settlement: 'on_bill',
        })
      ).status,
    ).toBe(409);
  });

  // ─── Pay now ──────────────────────────────────────────────────────────────────

  it('accept "pay now" records a real POS sale at the snapshot price (stock, receipt, drawer)', async () => {
    const sent = await order({ items: [{ productId: cola.id, quantity: 1 }] });
    expect(sent.status).toBe(201);
    // Promo ends meanwhile — the customer still pays what the menu said.
    const ads = await call<{ items: { id: string }[] }>(owner.token, 'GET', '/ads');
    await call(owner.token, 'PATCH', `/ads/${ads.body.items[0]!.id}`, { enabled: false });

    const missing = await call<Err>(owner.token, 'POST', `/orders/${sent.body.id}/accept`, {
      settlement: 'pay_now',
    });
    expect(missing.status).toBe(400);
    const paid = await call<StationOrder>(owner.token, 'POST', `/orders/${sent.body.id}/accept`, {
      settlement: 'pay_now',
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('paid');
    expect(paid.body.settlement).toBe('pay_now');
    expect(paid.body.saleId).toBeTruthy();
    expect(paid.body.receiptNo).toBeTruthy();
    await expectOrderPush('paid', sent.body.id);
    const sale = await call<SaleDetail>(owner.token, 'GET', `/sales/${paid.body.saleId}`);
    expect(sale.body.totalCents).toBe(120);
    expect(sale.body.changeCents).toBe(80);
    expect(sale.body.items.map((i) => [i.productId, i.unitPriceCents])).toEqual([[cola.id, 120]]);
    const stock = await call<ProductSummary>(owner.token, 'GET', `/products/${cola.id}`);
    expect(stock.body.stockMilli).toBe(9_000);
  });

  // ─── On the bill → settled with the session ───────────────────────────────────

  let onBill: StationOrder;
  it('accept "on the bill" parks the order; the station and the session show the open amount', async () => {
    const sent = await order({ items: [{ productId: chips.id, quantity: 2 }] });
    expect(sent.status).toBe(201);
    const accepted = await call<StationOrder>(
      owner.token,
      'POST',
      `/orders/${sent.body.id}/accept`,
      { settlement: 'on_bill' },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('accepted');
    onBill = accepted.body;
    await expectOrderPush('accepted', sent.body.id);
    const s = await stationNow();
    expect(s.orders).toEqual({ pending: 0, openCount: 1, openCents: 200 });
    const session = await call<SessionSummary>(
      owner.token,
      'GET',
      `/sessions/${s.activeSession!.id}`,
    );
    expect(session.body.openOrdersCents).toBe(200);
    expect(session.body.openOrdersCount).toBe(1);
    // Stock is untouched until it is sold.
    expect(
      (await call<ProductSummary>(owner.token, 'GET', `/products/${chips.id}`)).body.stockMilli,
    ).toBe(2_000);
  });

  it('the customer can take back a pending order, not an accepted one', async () => {
    const sent = await order({ items: [{ productId: cola.id, quantity: 1 }] });
    const cancelled = await call<StationOrder>(
      deviceToken,
      'DELETE',
      `/client/orders/${sent.body.id}`,
    );
    expect(cancelled.body.status).toBe('cancelled');
    const again = await call<StationOrder>(deviceToken, 'DELETE', `/client/orders/${onBill.id}`);
    expect(again.body.status).toBe('accepted');
    const mine = await call<{ items: StationOrder[] }>(deviceToken, 'GET', '/client/orders');
    expect(mine.body.items.map((o) => o.status)).toEqual([
      'cancelled',
      'accepted',
      'paid',
      'rejected',
    ]);
  });

  it('the preparation check (0.13.0): scanned / manual lines are stored, the PC hears "on its way"', async () => {
    const line = onBill.items[0]!;
    expect(line.verifiedMilli).toBe(0);
    expect(line.verification).toBeNull();
    expect(onBill.preparedAt).toBeNull();
    // Only accepted orders are prepared.
    const mine = await call<{ items: StationOrder[] }>(deviceToken, 'GET', '/client/orders');
    const rejected = mine.body.items.find((o) => o.status === 'rejected')!;
    const no = await call<Err>(owner.token, 'POST', `/orders/${rejected.id}/prepare`, {
      items: [{ itemId: rejected.items[0]!.id, verifiedMilli: 1000, verification: 'manual' }],
    });
    expect(no.status).toBe(409);
    expect((no.body.error as { details?: { code?: string } } | undefined)?.details?.code).toBe(
      'not_accepted',
    );
    // A line of another order is refused.
    const wrong = await call<Err>(owner.token, 'POST', `/orders/${onBill.id}/prepare`, {
      items: [{ itemId: rejected.items[0]!.id, verifiedMilli: 1000, verification: 'scan' }],
    });
    expect(wrong.status).toBe(404);
    // Scanned twice → the exact quantity verified by scanner.
    const prepared = await call<StationOrder>(owner.token, 'POST', `/orders/${onBill.id}/prepare`, {
      items: [{ itemId: line.id, verifiedMilli: 2000, verification: 'scan' }],
    });
    expect(prepared.status).toBe(200);
    expect(prepared.body.preparedAt).not.toBeNull();
    expect(prepared.body.items[0]).toMatchObject({ verifiedMilli: 2000, verification: 'scan' });
    expect(prepared.body.status).toBe('accepted');
    const push = await expectMessage(client, 'server.order', (m) => {
      const o = m.order as { id: string; preparedAt: string | null };
      return o.id === onBill.id && o.preparedAt !== null;
    });
    expect((push.order as { status: string }).status).toBe('accepted');
    const audit = await call<{ items: { action: string; details: Record<string, unknown> }[] }>(
      owner.token,
      'GET',
      '/audit-logs?pageSize=20&action=order.prepare',
    );
    expect(audit.body.items[0]?.details).toMatchObject({
      lines: 1,
      scanned: 1,
      manual: 0,
      short: 0,
    });
    // Exactly once: a second pass is refused and the stored record stays.
    const again = await call<Err>(owner.token, 'POST', `/orders/${onBill.id}/prepare`, {
      items: [{ itemId: line.id, verifiedMilli: 2000, verification: 'manual' }],
    });
    expect(again.status).toBe(409);
    expect((again.body.error as { details?: { code?: string } } | undefined)?.details?.code).toBe(
      'already_prepared',
    );
    onBill = prepared.body;
  });

  it('ending a postpaid session settles the time and the open orders on one receipt', async () => {
    const s = await stationNow();
    const sessionId = s.activeSession!.id;
    const quote = await call<SessionSummary>(owner.token, 'GET', `/sessions/${sessionId}`);
    const due = quote.body.currentPriceCents + quote.body.openOrdersCents;
    // Too little: refused as a whole (nothing is billed).
    const short = await call<Err>(owner.token, 'POST', `/sessions/${sessionId}/end`, {
      payments: [{ method: 'cash', amountCents: Math.max(1, quote.body.currentPriceCents) }],
    });
    expect(short.status).toBe(400);
    const ended = await call<SessionMutationResponse>(
      owner.token,
      'POST',
      `/sessions/${sessionId}/end`,
      { payments: [{ method: 'cash', amountCents: due + 300 }] },
    );
    expect(ended.status).toBe(200);
    expect(ended.body.payment?.totalCents).toBe(due);
    const sale = await call<SaleDetail>(owner.token, 'GET', `/sales/${ended.body.session.saleId}`);
    expect(sale.body.totalCents).toBe(due);
    expect(sale.body.items.map((i) => i.productId)).toEqual([null, chips.id]);
    expect(sale.body.items[1]).toMatchObject({ quantityMilli: 2000, unitPriceCents: 100 });
    const billed = await call<StationOrder>(owner.token, 'GET', `/orders/${onBill.id}`);
    expect(billed.body.status).toBe('billed');
    expect(billed.body.saleId).toBe(ended.body.session.saleId);
    await expectOrderPush('billed', onBill.id);
    expect(
      (await call<ProductSummary>(owner.token, 'GET', `/products/${chips.id}`)).body.stockMilli,
    ).toBe(0);
    expect((await stationNow()).orders).toEqual({ pending: 0, openCount: 0, openCents: 0 });
  });

  it('a prepaid session with an order on the bill bills the order on its own receipt at the end', async () => {
    const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 60,
      payments: [{ method: 'cash', amountCents: 120 }],
    });
    expect(started.status).toBe(201);
    await expectCommand('session.start');
    const sent = await order({ items: [{ productId: cola.id, quantity: 3 }] });
    expect(sent.status).toBe(201);
    expect(sent.body.totalCents).toBe(450); // promo is off now
    await call(owner.token, 'POST', `/orders/${sent.body.id}/accept`, { settlement: 'on_bill' });
    const sessionId = started.body.session.id;
    const short = await call<Err>(owner.token, 'POST', `/sessions/${sessionId}/end`, {
      payments: [{ method: 'cash', amountCents: 400 }],
    });
    expect(short.status).toBe(400);
    const ended = await call<SessionMutationResponse>(
      owner.token,
      'POST',
      `/sessions/${sessionId}/end`,
      { payments: [{ method: 'cash', amountCents: 500 }] },
    );
    expect(ended.status).toBe(200);
    expect(ended.body.payment).toMatchObject({ totalCents: 450, changeCents: 50 });
    const settled = await call<StationOrder>(owner.token, 'GET', `/orders/${sent.body.id}`);
    expect(settled.body.status).toBe('billed');
    const sale = await call<SaleDetail>(owner.token, 'GET', `/sales/${settled.body.saleId}`);
    expect(sale.body.items.map((i) => [i.productId, i.quantityMilli])).toEqual([[cola.id, 3000]]);
    expect(
      (await call<ProductSummary>(owner.token, 'GET', `/products/${cola.id}`)).body.stockMilli,
    ).toBe(6_000);
  });

  it('an order on the bill can be paid at the desk or written off; orders can be switched off', async () => {
    const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
    });
    await expectCommand('session.start');
    const a = await order({ items: [{ productId: cola.id, quantity: 1 }] });
    const b = await order({ items: [{ productId: cola.id, quantity: 1 }] });
    await call(owner.token, 'POST', `/orders/${a.body.id}/accept`, { settlement: 'on_bill' });
    await call(owner.token, 'POST', `/orders/${b.body.id}/accept`, { settlement: 'on_bill' });
    const paid = await call<StationOrder>(owner.token, 'POST', `/orders/${a.body.id}/pay`, {
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('paid');
    expect(paid.body.settlement).toBe('on_bill');
    const voided = await call<StationOrder>(owner.token, 'POST', `/orders/${b.body.id}/void`, {
      reason: 'customer left',
    });
    expect(voided.body.status).toBe('void');
    expect((await stationNow()).orders.openCount).toBe(0);
    // Out of stock items cannot be ordered.
    const oos = await order({ items: [{ productId: chips.id, quantity: 1 }] });
    expect(oos.status).toBe(409);
    expect(oos.body.error?.code).toBe('out_of_stock');
    // Master switch.
    await call(owner.token, 'PATCH', '/settings', { 'orders.enabled': false });
    const off = await order({ items: [{ productId: cola.id, quantity: 1 }] });
    expect(off.status).toBe(403);
    expect(off.body.error?.code).toBe('orders_disabled');
    expect((await menu()).body.reason).toBe('disabled');
    await call(owner.token, 'PATCH', '/settings', { 'orders.enabled': true });
    // The session ends without open orders — a plain receipt.
    const ended = await call<SessionMutationResponse>(
      owner.token,
      'POST',
      `/sessions/${started.body.session.id}/end`,
      { payments: [{ method: 'cash', amountCents: 500 }] },
    );
    expect(ended.status).toBe(200);
  });

  // ─── Lock-screen orders (0.14.0) ──────────────────────────────────────────────

  it('a locked PC orders without a session: paid at the desk, or put on the bill once a session runs', async () => {
    expect((await stationNow()).activeSession).toBeNull();
    // No session: the order is created with session_id null, visible to the Admin and the PC.
    const sent = await order({ items: [{ productId: cola.id, quantity: 1 }] });
    expect(sent.status).toBe(201);
    expect(sent.body.sessionId).toBeNull();
    expect(sent.body.stationId).toBe(station.id);
    await expectMessage(
      admin,
      'server.event',
      (m) => m.event === 'order.changed' && (m.payload as { id: string }).id === sent.body.id,
    );
    const mine = await call<{ items: StationOrder[] }>(deviceToken, 'GET', '/client/orders');
    expect(mine.body.items.map((o) => o.id)).toContain(sent.body.id);
    // "On the bill" without a session is refused with a clear reason.
    const parked = await call<StationOrder & Err>(
      owner.token,
      'POST',
      `/orders/${sent.body.id}/accept`,
      {
        settlement: 'on_bill',
      },
    );
    expect(parked.status).toBe(409);
    expect((parked.body.error as { details?: { code?: string } } | undefined)?.details?.code).toBe(
      'session_ended',
    );
    // "Pay now" works like any desk sale.
    const paid = await call<StationOrder>(owner.token, 'POST', `/orders/${sent.body.id}/accept`, {
      settlement: 'pay_now',
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('paid');
    expect(paid.body.saleId).toBeTruthy();
    await expectOrderPush('paid', sent.body.id);

    // A second lock-screen order; a session starts in the meantime → "on the bill" attaches it.
    const second = await order({ items: [{ productId: cola.id, quantity: 1 }] });
    expect(second.status).toBe(201);
    expect(second.body.sessionId).toBeNull();
    const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
    });
    expect(started.status).toBe(201);
    await expectCommand('session.start');
    const attached = await call<StationOrder>(
      owner.token,
      'POST',
      `/orders/${second.body.id}/accept`,
      {
        settlement: 'on_bill',
      },
    );
    expect(attached.status).toBe(200);
    expect(attached.body.sessionId).toBe(started.body.session.id);
    expect((await stationNow()).orders.openCount).toBe(1);
    // The PC's list in session mode shows the attached order too.
    const inSession = await call<{ items: StationOrder[] }>(deviceToken, 'GET', '/client/orders');
    expect(inSession.body.items.map((o) => o.id)).toContain(second.body.id);
    // Ending the session settles the time and the attached order on one receipt.
    const ended = await call<SessionMutationResponse & Err>(
      owner.token,
      'POST',
      `/sessions/${started.body.session.id}/end`,
      { payments: [{ method: 'cash', amountCents: 10_000 }] },
    );
    expect(ended.status).toBe(200);
    await expectCommand('session.end');
    expect((await stationNow()).orders.openCount).toBe(0);
    const closed = await call<StationOrder>(owner.token, 'GET', `/orders/${second.body.id}`);
    expect(closed.body.status).toBe('billed');
  });

  // ─── Pause / resume from the PC ───────────────────────────────────────────────

  it('the customer pauses and resumes at the PC; who paused travels to the PC and the Admin', async () => {
    const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 30,
      payments: [{ method: 'cash', amountCents: 60 }],
    });
    await expectCommand('session.start');
    const sessionId = started.body.session.id;
    const paused = await call<SessionSummary>(deviceToken, 'POST', '/client/session-pause');
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('paused');
    expect(paused.body.pausedBy).toBe('customer');
    expect(paused.body.autoResumeAt).toBeTruthy();
    const cmd = await expectCommand('session.pause');
    expect((cmd.payload as { pausedBy: string }).pausedBy).toBe('customer');
    expect((await stationNow()).activeSession?.pausedBy).toBe('customer');
    // Idempotent.
    expect(
      (await call<SessionSummary>(deviceToken, 'POST', '/client/session-pause')).body.status,
    ).toBe('paused');
    const resumed = await call<SessionSummary>(deviceToken, 'POST', '/client/session-resume');
    expect(resumed.body.status).toBe('active');
    expect(resumed.body.pausedBy).toBeNull();
    const back = await expectCommand('session.resume');
    expect((back.payload as { by: string }).by).toBe('customer');

    // Staff pause: no auto-resume, the PC may still resume (default) …
    const staff = await call<SessionMutationResponse>(
      owner.token,
      'POST',
      `/sessions/${sessionId}/pause`,
    );
    expect(staff.body.session.pausedBy).toBe('staff');
    expect(staff.body.session.autoResumeAt).toBeNull();
    await expectCommand('session.pause');
    // … unless the owner switches customer resume off.
    await call(owner.token, 'PATCH', '/settings', { 'sessions.customer_resume': false });
    const refused = await call<Err>(deviceToken, 'POST', '/client/session-resume');
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe('resume_disabled');
    await call(owner.token, 'PATCH', '/settings', { 'sessions.customer_resume': true });
    expect(
      (await call<SessionSummary>(deviceToken, 'POST', '/client/session-resume')).body.status,
    ).toBe('active');
    await expectCommand('session.resume');
    await call(owner.token, 'PATCH', '/settings', { 'sessions.customer_pause': false });
    const noPause = await call<Err>(deviceToken, 'POST', '/client/session-pause');
    expect(noPause.status).toBe(403);
    expect(noPause.body.error?.code).toBe('pause_disabled');
    await call(owner.token, 'PATCH', '/settings', { 'sessions.customer_pause': true });
  });

  it('a customer pause ends by itself after sessions.pause_max_minutes; staff pauses never do', async () => {
    const s = await stationNow();
    const sessionId = s.activeSession!.id;
    const before = await call<SessionSummary>(owner.token, 'GET', `/sessions/${sessionId}`);
    const paused = await call<SessionSummary>(deviceToken, 'POST', '/client/session-pause');
    expect(paused.body.status).toBe('paused');
    await expectCommand('session.pause');
    const pausedAt = Date.parse(paused.body.pausedAt!);
    // 14 minutes later: still paused. 16 minutes later: resumed, back-dated to the 15-minute mark.
    await ctx.app.services.sessions.tick(new Date(pausedAt + 14 * 60_000));
    expect(
      (await call<SessionSummary>(owner.token, 'GET', `/sessions/${sessionId}`)).body.status,
    ).toBe('paused');
    await ctx.app.services.sessions.tick(new Date(pausedAt + 16 * 60_000));
    const after = await call<SessionSummary>(owner.token, 'GET', `/sessions/${sessionId}`);
    expect(after.body.status).toBe('active');
    expect(after.body.totalPausedSeconds - before.body.totalPausedSeconds).toBe(15 * 60);
    expect(Date.parse(after.body.endsAt!) - Date.parse(before.body.endsAt!)).toBe(15 * 60_000);
    const back = await expectCommand('session.resume');
    expect((back.payload as { by: string }).by).toBe('auto');

    // Staff pause is not bounded.
    await call(owner.token, 'POST', `/sessions/${sessionId}/pause`);
    await expectCommand('session.pause');
    await ctx.app.services.sessions.tick(new Date(Date.now() + 60 * 60_000));
    expect(
      (await call<SessionSummary>(owner.token, 'GET', `/sessions/${sessionId}`)).body.status,
    ).toBe('paused');
    await call(owner.token, 'POST', `/sessions/${sessionId}/resume`);
    await expectCommand('session.resume');
    await call(owner.token, 'POST', `/sessions/${sessionId}/end`, {});
  });
});
