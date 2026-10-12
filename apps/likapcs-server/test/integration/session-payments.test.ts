/**
 * Session bills paid like POS sales: tenders with change, split cash + card, "pay later" on the
 * session's customer, the legacy single `paymentMethod`, and the money that must NOT move when a
 * tender is refused. The clock is faked (Date only) so prices are exact.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  CashStatusResponse,
  CustomerSummary,
  DebtSummary,
  LoginResponse,
  Paginated,
  ReceiptData,
  SaleDetail,
  SessionMutationResponse,
  SessionSummary,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);

describe('session payments', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let station: StationSummary;
  let arben: CustomerSummary;
  const H = () => authHeader(owner.token);
  const post = <T>(url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: H(), payload }).then((r) => ({
      status: r.statusCode,
      body: r.json<T>(),
    }));
  const get = <T>(url: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: H() }).then((r) => r.json<T>());
  const drawer = async () =>
    (await get<CashStatusResponse>('/cash/status')).current!.totals.expectedCashCents;
  const at = (date: Date) => vi.setSystemTime(date);
  const plusMinutes = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    station = (await post<StationSummary>('/stations', { number: 1, name: 'Arena 1' })).body;
    expect((await post('/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    expect(
      (
        await post('/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 300, // 5 cents a minute → 60 min = 3.00
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    arben = (
      await post<CustomerSummary>('/customers', { name: 'Arben Gashi', creditLimitCents: 500 })
    ).body;
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: H(),
      payload: { 'pos.credit_default_days': 3 },
    });
  }, 30_000);

  afterEach(() => at(T0));
  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('prepaid start with cash tendered above the price reports the change and banks the net cash', async () => {
    const before = await drawer();
    const res = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 60,
      payments: [{ method: 'cash', amountCents: 500 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({
      totalCents: 300,
      paidCents: 500,
      changeCents: 200,
      creditCents: 0,
      dueDate: null,
    });
    expect(res.body.payment!.receiptNo).toMatch(/^R-/);
    expect(await drawer()).toBe(before + 300);
    const sale = await get<SaleDetail>(`/sales/${res.body.payment!.saleId}`);
    expect(sale).toMatchObject({ source: 'gaming', paidCents: 500, changeCents: 200 });
    // Legacy single method still works as one exact tender.
    expect(
      (
        await post<SessionMutationResponse>(`/sessions/${res.body.session.id}/extend`, {
          minutes: 30,
          paymentMethod: 'cash',
        })
      ).body.payment,
    ).toMatchObject({ totalCents: 150, paidCents: 150, changeCents: 0 });
    expect(await drawer()).toBe(before + 450);
    // Ending a prepaid session bills nothing more.
    const ended = await post<SessionMutationResponse>(`/sessions/${res.body.session.id}/end`, {});
    expect(ended.status).toBe(200);
    expect(ended.body.payment).toBeNull();
    expect(await drawer()).toBe(before + 450);
  });

  it('refuses under-payment and pay-later without a customer; the session does not start', async () => {
    const before = await drawer();
    const under = await post('/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 60,
      payments: [{ method: 'cash', amountCents: 299 }],
    });
    expect(under.status).toBe(400);
    const noCustomer = await post('/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 60,
      payments: [{ method: 'credit', amountCents: 300 }],
    });
    expect(noCustomer.status).toBe(400);
    const live = await get<Paginated<SessionSummary>>('/sessions?status=active');
    expect(live.items.filter((s) => s.stationId === station.id)).toHaveLength(0);
    expect(await drawer()).toBe(before);
  });

  it('postpaid end: split cash + pay later opens a debt on the session customer within the limit', async () => {
    const start = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
      customerId: arben.id,
    });
    expect(start.status).toBe(201);
    expect(start.body.payment).toBeNull();
    at(plusMinutes(60)); // 3.00 owed
    const before = await drawer();
    const tooMuchCredit = await post(`/sessions/${start.body.session.id}/end`, {
      payments: [{ method: 'credit', amountCents: 600 }],
    });
    expect(tooMuchCredit.status).toBe(400); // credit above the total — no "change" on a debt
    const end = await post<SessionMutationResponse>(`/sessions/${start.body.session.id}/end`, {
      payments: [
        { method: 'cash', amountCents: 200 },
        { method: 'credit', amountCents: 100, dueDate: '2030-02-01' },
      ],
    });
    expect(end.status).toBe(200);
    expect(end.body.session.status).toBe('completed');
    expect(end.body.payment).toMatchObject({
      totalCents: 300,
      paidCents: 300,
      changeCents: 0,
      creditCents: 100,
      dueDate: '2030-02-01',
    });
    expect(await drawer()).toBe(before + 200);
    const debts = await get<Paginated<DebtSummary>>(`/debts?customerId=${arben.id}`);
    expect(debts.total).toBe(1);
    expect(debts.items[0]).toMatchObject({
      amountCents: 100,
      remainingCents: 100,
      dueDate: '2030-02-01',
      saleId: end.body.payment!.saleId,
    });
    expect((await get<CustomerSummary>(`/customers/${arben.id}`)).balanceDueCents).toBe(100);
    const sale = await get<SaleDetail>(`/sales/${end.body.payment!.saleId}`);
    expect(sale.debt).toMatchObject({ amountCents: 100, status: 'open' });
    expect(sale.payments.map((p) => p.method).sort()).toEqual(['cash', 'credit']);
  });

  it('stops the clock at the checkout time, bounded by the server, and attaches a walk-in customer', async () => {
    const blerta = (await post<CustomerSummary>('/customers', { name: 'Blerta Hoxha' })).body;
    const start = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
      customerName: 'walk-in',
    });
    expect(start.status).toBe(201);
    const sid = start.body.session.id;
    // Checkout opened at +60 min (3.00), money counted until +63 min: billed at the quoted 3.00.
    const stoppedSecondsAgo = 3 * 60;
    at(plusMinutes(63));
    const refusedStop = await post(`/sessions/${sid}/end`, {
      stoppedSecondsAgo,
      payments: [{ method: 'credit', amountCents: 300 }],
    });
    expect(refusedStop.status).toBe(400); // walk-in without a customer cannot pay later
    const end = await post<SessionMutationResponse>(`/sessions/${sid}/end`, {
      stoppedSecondsAgo,
      customerId: blerta.id,
      payments: [{ method: 'credit', amountCents: 300 }],
    });
    expect(end.status).toBe(200);
    expect(end.body.payment).toMatchObject({ totalCents: 300, creditCents: 100 * 3 });
    expect(end.body.session).toMatchObject({
      customerId: blerta.id,
      customerName: 'Blerta Hoxha',
      billableSeconds: 3600,
      finalPriceCents: 300,
    });
    expect(end.body.payment!.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); // pos.credit_default_days
    expect((await get<CustomerSummary>(`/customers/${blerta.id}`)).balanceDueCents).toBe(300);

    // The window is bounded: a stop 30 min back is clamped to 10 min before the request, and a
    // stop before the start is clamped to the start.
    const again = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
    });
    at(plusMinutes(63 + 60));
    const clamped = await post<SessionMutationResponse>(`/sessions/${again.body.session.id}/end`, {
      stoppedSecondsAgo: 30 * 60,
      payments: [{ method: 'cash', amountCents: 1000 }],
    });
    expect(clamped.status).toBe(200);
    expect(clamped.body.session.billableSeconds).toBe(50 * 60);
    expect(clamped.body.payment).toMatchObject({ totalCents: 250, changeCents: 750 });
    const third = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
    });
    at(plusMinutes(63 + 60 + 5));
    const early = await post<SessionMutationResponse>(`/sessions/${third.body.session.id}/end`, {
      stoppedSecondsAgo: 9 * 60,
      paymentMethod: 'cash',
    });
    expect(early.status).toBe(200);
    expect(early.body.session.billableSeconds).toBe(0);
    // Minimum charge rules may still bill something; whatever it is, the receipt exists and is
    // readable with stations.control alone.
    const receipt = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${third.body.session.id}/receipt`,
      headers: H(),
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json<ReceiptData>().sale.id).toBe(early.body.payment!.saleId);
  });

  it('pay later beyond the customer limit is refused and the session stays live', async () => {
    const start = await post<SessionMutationResponse>('/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
      customerId: arben.id,
    });
    expect(start.status).toBe(201);
    at(plusMinutes(120)); // 6.00 owed; limit 5.00, 1.00 already open
    const refused = await post(`/sessions/${start.body.session.id}/end`, {
      payments: [{ method: 'credit', amountCents: 600 }],
    });
    expect(refused.status).toBe(409);
    const still = await get<SessionSummary>(`/sessions/${start.body.session.id}`);
    expect(still.status).toBe('active');
    expect(still.billedAt).toBeNull();
    // Within the limit (4.00 credit + 2.00 cash) it goes through.
    const ok = await post<SessionMutationResponse>(`/sessions/${start.body.session.id}/end`, {
      payments: [
        { method: 'credit', amountCents: 400 },
        { method: 'cash', amountCents: 200 },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.payment!.creditCents).toBe(400);
    expect((await get<CustomerSummary>(`/customers/${arben.id}`)).balanceDueCents).toBe(500);
  });
});
