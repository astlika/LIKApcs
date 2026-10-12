/**
 * Customer wallet (0.11.0): money paid in advance and spent on sales, session bills and debts;
 * the balance ledger; the account statement (every receipt with how it was paid, debts and their
 * repayments, wallet entries); what the PC may see (`/client/customer`, `server.customer`).
 * Money assertions are exact integers; drawer effects are checked after every move.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type CashStatusResponse,
  type ClientCustomerInfo,
  type CustomerStatement,
  type CustomerSummary,
  type DebtPaymentResult,
  type DebtSummary,
  type LoginResponse,
  type Paginated,
  type ProductSummary,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type RoleSummary,
  type SaleDetail,
  type SessionMutationResponse,
  type StationSummary,
  type WalletEntry,
  type WalletMutationResult,
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

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };

describe('customer wallet & account statement', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let accountant: LoginResponse;
  let cola: ProductSummary;
  let lika: CustomerSummary;
  let station: StationSummary;
  let deviceToken: string;
  let client: Awaited<ReturnType<typeof openSocket>>;
  let heartbeat: NodeJS.Timeout | null = null;
  let walletSaleId: string;
  let creditSaleReceipt: string | null;

  const call = <T>(
    token: string | null,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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
      .then((r) => ({ status: r.statusCode, body: (r.statusCode === 204 ? null : r.json()) as T }));
  const drawer = async () =>
    (await call<CashStatusResponse>(owner.token, 'GET', '/cash/status')).body.current!.totals
      .expectedCashCents;
  const customer = async () =>
    (await call<CustomerSummary>(owner.token, 'GET', `/customers/${lika.id}`)).body;
  const sell = (token: string, customerId: string | null, payments: Record<string, unknown>[]) =>
    call<SaleDetail>(token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 2000 }], // 2 × 1.50 = 3.00
      customerId,
      payments,
    });
  const entries = async () =>
    (await call<Paginated<WalletEntry>>(owner.token, 'GET', `/customers/${lika.id}/wallet`)).body
      .items;
  const errorOf = (body: unknown) => (body as ErrorBody).error;
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

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    for (const [username, roles] of [
      ['kasa', ['cashier']],
      ['konto', ['accountant']],
    ] as const) {
      expect(
        (
          await call(owner.token, 'POST', '/users', {
            username,
            fullName: username,
            password: 'Pass-1234',
            roles,
            mustChangePassword: false,
          })
        ).status,
      ).toBe(201);
    }
    cashier = await login(ctx.app, 'kasa', 'Pass-1234');
    accountant = await login(ctx.app, 'konto', 'Pass-1234');
    expect(
      (await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 2000 })).status,
    ).toBe(201);
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Coca-Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 100_000,
      })
    ).body;
    lika = (
      await call<CustomerSummary>(owner.token, 'POST', '/customers', {
        name: 'Lika',
        loginUsername: 'lika',
        loginPassword: '1234',
      })
    ).body;
    expect(lika.walletBalanceCents).toBe(0);
    expect(
      (
        await call(owner.token, 'POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 300,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    station = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 1, name: 'PC 1' })
    ).body;

    // A paired PC with a live socket, like the real client (acks commands, heartbeats).
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const registrationSecret = randomBytes(32).toString('base64url');
    const reg = await call<RegisterDeviceResponse>(null, 'POST', '/client/register', {
      machineId: 'MACHINE-WALLET-1',
      hostname: 'PC1',
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
    client = await openSocket(`ws://127.0.0.1:${port}/ws/client`);
    client.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId: 'MACHINE-WALLET-1',
    });
    expect((await client.next()).type).toBe('server.welcome');
    client.socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; commandId?: string };
      if (msg.type === 'server.command' && msg.commandId)
        client.send({ type: 'client.ack', commandId: msg.commandId, ok: true });
    });
    heartbeat = setInterval(() => {
      if (client.socket.readyState === client.socket.OPEN)
        client.send({ type: 'client.heartbeat', ts: new Date().toISOString(), locked: true });
    }, 2_000);
  }, 30_000);

  afterAll(async () => {
    if (heartbeat) clearInterval(heartbeat);
    client?.socket.close();
    await ctx.close();
  });

  // ─── Permissions ───────────────────────────────────────────────────────────────

  it('seeds wallet.topup for cashiers and wallet.refund for managers and up', async () => {
    const roles = (await call<RoleSummary[]>(owner.token, 'GET', '/roles')).body;
    const perms = (code: string) => roles.find((r) => r.code === code)!.permissions;
    expect(perms('cashier')).toContain('wallet.topup');
    expect(perms('cashier')).not.toContain('wallet.refund');
    expect(perms('manager')).toContain('wallet.refund');
    expect(perms('accountant')).not.toContain('wallet.topup');
    const denied = await call(accountant.token, 'POST', `/customers/${lika.id}/wallet/topup`, {
      amountCents: 100,
    });
    expect(denied.status).toBe(403);
  });

  // ─── Money in ──────────────────────────────────────────────────────────────────

  it('a cashier takes 10.00 in advance (20.00 tendered → 10.00 change); the drawer banks the net', async () => {
    const before = await drawer();
    const r = await call<WalletMutationResult>(
      cashier.token,
      'POST',
      `/customers/${lika.id}/wallet/topup`,
      { amountCents: 1000, tenderedCents: 2000, note: 'për javën' },
    );
    expect(r.status).toBe(201);
    expect(r.body.changeCents).toBe(1000);
    expect(r.body.customer.walletBalanceCents).toBe(1000);
    expect(r.body.entry).toMatchObject({
      type: 'wallet_topup',
      amountCents: 1000,
      balanceAfterCents: 1000,
      note: 'për javën',
      createdByName: 'kasa',
    });
    expect(await drawer()).toBe(before + 1000);
    const payments = await ctx.pool.query<{ kind: string; method: string; amount_cents: number }>(
      `SELECT kind, method, amount_cents FROM payments WHERE customer_id = $1 AND kind = 'wallet_topup'`,
      [lika.id],
    );
    expect(payments.rows).toEqual([{ kind: 'wallet_topup', method: 'cash', amount_cents: 1000 }]);
    const audit = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'wallet.topup' AND entity_id = $1`,
      [lika.id],
    );
    expect(Number(audit.rows[0]!.n)).toBe(1);
  });

  it('rejects a top-up with less cash than the amount, zero amounts and unknown customers', async () => {
    const short = await call(cashier.token, 'POST', `/customers/${lika.id}/wallet/topup`, {
      amountCents: 500,
      tenderedCents: 400,
    });
    expect(short.status).toBe(400);
    expect(errorOf(short.body).details?.field).toBe('tenderedCents');
    expect(
      (
        await call(cashier.token, 'POST', `/customers/${lika.id}/wallet/topup`, {
          amountCents: 0,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          cashier.token,
          'POST',
          `/customers/00000000-0000-4000-8000-000000000000/wallet/topup`,
          { amountCents: 100 },
        )
      ).status,
    ).toBe(404);
    expect((await customer()).walletBalanceCents).toBe(1000);
  });

  // ─── Spending at the POS ───────────────────────────────────────────────────────

  it('a POS sale paid entirely from the balance moves no cash and writes a wallet_payment with the receipt', async () => {
    const before = await drawer();
    const r = await sell(cashier.token, lika.id, [{ method: 'wallet', amountCents: 300 }]);
    expect(r.status).toBe(201);
    walletSaleId = r.body.id;
    expect(r.body.paidCents).toBe(300);
    expect(r.body.changeCents).toBe(0);
    expect(r.body.payments.map((p) => p.method)).toEqual(['wallet']);
    expect(await drawer()).toBe(before);
    expect((await customer()).walletBalanceCents).toBe(700);
    const [latest] = await entries();
    expect(latest).toMatchObject({
      type: 'wallet_payment',
      amountCents: -300,
      balanceAfterCents: 700,
      referenceType: 'sale',
      referenceId: walletSaleId,
      receiptNo: r.body.receiptNo,
    });
  });

  it('splits balance + cash: 5.00 from the wallet, 5.00 cash tendered on a 7.00 sale → 3.00 change', async () => {
    const before = await drawer();
    const r = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [
        { productId: cola.id, quantityMilli: 4000 },
        { productId: cola.id, quantityMilli: 666 },
      ], // 6.00 + 1.00 = 7.00
      customerId: lika.id,
      payments: [
        { method: 'wallet', amountCents: 500 },
        { method: 'cash', amountCents: 500 },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.totalCents).toBe(700);
    expect(r.body.paidCents).toBe(1000);
    expect(r.body.changeCents).toBe(300);
    expect(await drawer()).toBe(before + 200);
    expect((await customer()).walletBalanceCents).toBe(200);
  });

  it('refuses to overspend: 409 wallet_insufficient with the real balance, and the sale rolls back', async () => {
    const salesBefore = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sales`,
    );
    const r = await sell(cashier.token, lika.id, [{ method: 'wallet', amountCents: 300 }]);
    expect(r.status).toBe(409);
    expect(errorOf(r.body).code).toBe('wallet_insufficient');
    expect(errorOf(r.body).details?.balanceCents).toBe(200);
    const salesAfter = await ctx.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM sales`);
    expect(salesAfter.rows[0]!.n).toBe(salesBefore.rows[0]!.n);
    expect((await customer()).walletBalanceCents).toBe(200);
  });

  it('a balance tender without a customer is a 400 wallet_needs_customer', async () => {
    const r = await sell(cashier.token, null, [{ method: 'wallet', amountCents: 300 }]);
    expect(r.status).toBe(400);
    expect(errorOf(r.body).code).toBe('wallet_needs_customer');
  });

  // ─── Session bills & debts ─────────────────────────────────────────────────────

  it('a prepaid session can be paid from the balance; the PC is told the new balance', async () => {
    expect(
      (
        await call(owner.token, 'POST', `/customers/${lika.id}/wallet/topup`, {
          amountCents: 300,
        })
      ).status,
    ).toBe(201);
    const before = await drawer();
    const start = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 60, // 3.00
      customerId: lika.id,
      payments: [{ method: 'wallet', amountCents: 300 }],
    });
    expect(start.status).toBe(201);
    expect(start.body.payment?.totalCents).toBe(300);
    expect(await drawer()).toBe(before);
    expect((await customer()).walletBalanceCents).toBe(200);
    // The PC plays on Lika's account now: a top-up at the desk is pushed to it.
    const topUp = await call(owner.token, 'POST', `/customers/${lika.id}/wallet/topup`, {
      amountCents: 100,
    });
    expect(topUp.status).toBe(201);
    // (The start itself already pushed 200 — the balance after paying the hour.)
    const push = await expectMessage(
      client,
      'server.customer',
      (m) => (m.customer as ClientCustomerInfo).walletBalanceCents === 300,
    );
    expect(push.customer).toMatchObject({ name: 'Lika', balanceDueCents: 0 });
    // …and it may ask for it directly (device token, no customer login needed).
    const mine = await call<{ customer: ClientCustomerInfo | null }>(
      null,
      'GET',
      '/client/customer',
      undefined,
      { authorization: `Bearer ${deviceToken}` },
    );
    expect(mine.status).toBe(200);
    expect(mine.body.customer).toMatchObject({
      id: lika.id,
      walletBalanceCents: 300,
      balanceDueCents: 0,
    });
    expect(
      (await call(owner.token, 'POST', `/sessions/${start.body.session.id}/end`, {})).status,
    ).toBe(200);
  });

  it('the customer login reports the balance; without a session the PC sees no customer', async () => {
    const login = await call<{ customer: ClientCustomerInfo }>(
      null,
      'POST',
      '/client/customer-login',
      { username: 'lika', password: '1234' },
      { authorization: `Bearer ${deviceToken}` },
    );
    expect(login.status).toBe(200);
    expect(login.body.customer.walletBalanceCents).toBe(300);
    const none = await call<{ customer: ClientCustomerInfo | null }>(
      null,
      'GET',
      '/client/customer',
      undefined,
      { authorization: `Bearer ${deviceToken}` },
    );
    expect(none.body.customer).toBeNull();
  });

  it('a debt can be repaid from the balance (no cash moves) and the statement links both', async () => {
    const credit = await sell(owner.token, lika.id, [{ method: 'credit', amountCents: 300 }]);
    expect(credit.status).toBe(201);
    creditSaleReceipt = credit.body.receiptNo;
    expect((await customer()).balanceDueCents).toBe(300);
    const before = await drawer();
    const paid = await call<DebtPaymentResult>(
      cashier.token,
      'POST',
      `/customers/${lika.id}/debts/pay`,
      { amountCents: 300, method: 'wallet' },
    );
    expect(paid.status).toBe(200);
    expect(paid.body.customer.balanceDueCents).toBe(0);
    expect(paid.body.debts[0]!.status).toBe('paid');
    expect(await drawer()).toBe(before);
    expect((await customer()).walletBalanceCents).toBe(0);
    const [latest] = await entries();
    expect(latest).toMatchObject({
      type: 'wallet_payment',
      amountCents: -300,
      balanceAfterCents: 0,
      referenceType: 'debt_payment',
    });
    const over = await call(cashier.token, 'POST', `/customers/${lika.id}/debts/pay`, {
      amountCents: 100,
      method: 'wallet',
    });
    expect(over.status).toBe(409); // no open debt any more
  });

  it('a refund to the balance credits the wallet instead of the drawer', async () => {
    const sale = (await call<SaleDetail>(owner.token, 'GET', `/sales/${walletSaleId}`)).body;
    const before = await drawer();
    const r = await call<SaleDetail>(owner.token, 'POST', `/sales/${walletSaleId}/refund`, {
      items: [{ saleItemId: sale.items[0]!.id, quantityMilli: 1000 }],
      reason: 'warm bottle',
      restock: false,
      method: 'wallet',
    });
    expect(r.status).toBe(200);
    expect(r.body.refundedCents).toBe(150);
    expect(await drawer()).toBe(before);
    expect((await customer()).walletBalanceCents).toBe(150);
    const [latest] = await entries();
    expect(latest).toMatchObject({
      type: 'wallet_refund',
      amountCents: 150,
      balanceAfterCents: 150,
      referenceType: 'refund',
    });
  });

  // ─── Money out ─────────────────────────────────────────────────────────────────

  it('paying a balance out needs wallet.refund, cannot exceed the balance and leaves the drawer', async () => {
    const denied = await call(cashier.token, 'POST', `/customers/${lika.id}/wallet/withdraw`, {
      amountCents: 100,
      reason: 'leaving town',
    });
    expect(denied.status).toBe(403);
    const over = await call(owner.token, 'POST', `/customers/${lika.id}/wallet/withdraw`, {
      amountCents: 500,
      reason: 'leaving town',
    });
    expect(over.status).toBe(409);
    expect(errorOf(over.body).code).toBe('wallet_insufficient');
    const before = await drawer();
    const ok = await call<WalletMutationResult>(
      owner.token,
      'POST',
      `/customers/${lika.id}/wallet/withdraw`,
      { amountCents: 100, reason: 'leaving town' },
    );
    expect(ok.status).toBe(201);
    expect(ok.body.customer.walletBalanceCents).toBe(50);
    expect(ok.body.entry).toMatchObject({ type: 'wallet_withdrawal', amountCents: -100 });
    expect(await drawer()).toBe(before - 100);
    const shift = (await call<CashStatusResponse>(owner.token, 'GET', '/cash/status')).body.current!
      .totals;
    expect(shift.walletTopUpsCents).toBe(1400);
    expect(shift.walletRefundsCents).toBe(100);
  });

  // ─── Statement ─────────────────────────────────────────────────────────────────

  it('the statement lists every receipt with its tenders, debts with their state, repayments and wallet moves', async () => {
    // One more credit sale that stays open, so "unpaid" has something to show.
    const open = await sell(owner.token, lika.id, [{ method: 'credit', amountCents: 300 }]);
    expect(open.status).toBe(201);
    const r = await call<CustomerStatement>(
      owner.token,
      'GET',
      `/customers/${lika.id}/statement?pageSize=50`,
    );
    expect(r.status).toBe(200);
    const s = r.body;
    expect(s.customer.id).toBe(lika.id);
    const ats = s.items.map((e) => e.at);
    expect([...ats].sort().reverse()).toEqual(ats); // newest first
    const kinds = s.items.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'sale',
        'refund',
        'debt_payment',
        'wallet_topup',
        'wallet_withdrawal',
      ]),
    );
    expect(s.total).toBe(s.items.length);

    const walletSale = s.items.find((e) => e.saleId === walletSaleId && e.kind === 'sale')!;
    expect(walletSale.paid).toEqual({
      cashCents: 0,
      walletCents: 300,
      creditCents: 0,
      otherCents: 0,
    });
    expect(walletSale.description).toContain('Coca-Cola');
    expect(walletSale.debt).toBeNull();
    expect(walletSale.createdByName).toBe('kasa');

    const split = s.items.find((e) => e.kind === 'sale' && e.amountCents === 700)!;
    expect(split.paid).toEqual({ cashCents: 200, walletCents: 500, creditCents: 0, otherCents: 0 });

    const sessionBill = s.items.find((e) => e.kind === 'sale' && e.stationCode)!;
    expect(sessionBill.stationCode).toBe(station.code);
    expect(sessionBill.paid.walletCents).toBe(300);

    const settledCredit = s.items.find(
      (e) => e.kind === 'sale' && e.receiptNo === creditSaleReceipt,
    )!;
    expect(settledCredit.paid.creditCents).toBe(300);
    expect(settledCredit.debt).toMatchObject({ status: 'paid', remainingCents: 0 });
    expect(settledCredit.debt!.settledAt).toBeTruthy();

    const stillOpen = s.items.find((e) => e.kind === 'sale' && e.saleId === open.body.id)!;
    expect(stillOpen.debt).toMatchObject({ status: 'open', remainingCents: 300 });

    const repayment = s.items.find((e) => e.kind === 'debt_payment')!;
    expect(repayment.amountCents).toBe(300);
    expect(repayment.paid.walletCents).toBe(300);
    expect(repayment.settles).toEqual([
      expect.objectContaining({ receiptNo: creditSaleReceipt, amountCents: 300 }),
    ]);

    const refund = s.items.find((e) => e.kind === 'refund')!;
    expect(refund).toMatchObject({ amountCents: 150, saleId: walletSaleId });
    expect(refund.paid.walletCents).toBe(150);

    const topUps = s.items.filter((e) => e.kind === 'wallet_topup');
    expect(topUps.map((e) => e.amountCents).sort()).toEqual([100, 1000, 300].sort());
    expect(topUps.find((e) => e.amountCents === 1000)!.note).toBe('për javën');
    expect(s.items.find((e) => e.kind === 'wallet_withdrawal')).toMatchObject({
      amountCents: 100,
      note: 'leaving town',
    });

    expect(s.totals).toMatchObject({
      receiptsCount: 5,
      spentCents: 300 - 150 + 700 + 300 + 300 + 300,
      paidCashCents: 200,
      paidWalletCents: 300 + 500 + 300,
      onCreditCents: 600,
      debtPaidCents: 300,
      debtOpenCents: 300,
      walletTopUpsCents: 1400,
    });
    expect(s.totals.firstVisitAt).toBeTruthy();

    // Filters and paging.
    const unpaid = (
      await call<CustomerStatement>(
        owner.token,
        'GET',
        `/customers/${lika.id}/statement?filter=unpaid`,
      )
    ).body;
    expect(unpaid.items.map((e) => e.saleId)).toEqual([open.body.id]);
    const payments = (
      await call<CustomerStatement>(
        owner.token,
        'GET',
        `/customers/${lika.id}/statement?filter=payments`,
      )
    ).body;
    expect(payments.items.map((e) => e.kind)).toEqual(['debt_payment']);
    const wallet = (
      await call<CustomerStatement>(
        owner.token,
        'GET',
        `/customers/${lika.id}/statement?filter=wallet`,
      )
    ).body;
    expect(wallet.items.every((e) => e.kind.startsWith('wallet_') || e.paid.walletCents > 0)).toBe(
      true,
    );
    expect(wallet.items.length).toBe(4 + 3 + 1 + 1); // 3 top-ups + withdrawal, 3 wallet sales + repayment, refund
    const page2 = (
      await call<CustomerStatement>(
        owner.token,
        'GET',
        `/customers/${lika.id}/statement?page=2&pageSize=3`,
      )
    ).body;
    expect(page2.items.map((e) => e.key)).toEqual(s.items.slice(3, 6).map((e) => e.key));
    expect(page2.total).toBe(s.total);
    const future = (
      await call<CustomerStatement>(
        owner.token,
        'GET',
        `/customers/${lika.id}/statement?from=2999-01-01`,
      )
    ).body;
    expect(future.items).toEqual([]);
    expect(future.total).toBe(0);
    // Read-only staff can read it; nobody without customers.view can.
    expect((await call(accountant.token, 'GET', `/customers/${lika.id}/statement`)).status).toBe(
      200,
    );
  });

  // ─── Master switch ─────────────────────────────────────────────────────────────

  it('wallet.enabled = false stops top-ups and balance tenders (403 wallet_disabled)', async () => {
    expect(
      (await call(owner.token, 'PATCH', '/settings', { 'wallet.enabled': false })).status,
    ).toBe(200);
    const topUp = await call(owner.token, 'POST', `/customers/${lika.id}/wallet/topup`, {
      amountCents: 100,
    });
    expect(topUp.status).toBe(403);
    expect(errorOf(topUp.body).code).toBe('wallet_disabled');
    const sale = await sell(owner.token, lika.id, [
      { method: 'wallet', amountCents: 50 },
      { method: 'cash', amountCents: 250 },
    ]);
    expect(sale.status).toBe(403);
    expect(errorOf(sale.body).code).toBe('wallet_disabled');
    expect((await customer()).walletBalanceCents).toBe(50);
    expect((await call(owner.token, 'PATCH', '/settings', { 'wallet.enabled': true })).status).toBe(
      200,
    );
    const debts = (
      await call<Paginated<DebtSummary>>(owner.token, 'GET', `/debts?customerId=${lika.id}`)
    ).body;
    expect(debts.items.filter((d) => d.status === 'open')).toHaveLength(1);
  });
});
