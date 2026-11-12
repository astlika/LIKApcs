/**
 * Change the price of a bill that is already paid (`POST /sessions/:id/adjust-price`, 0.27.0).
 * A lower price gives the difference back (a `price_adjustment` refund; cash from the open shift);
 * a higher price takes the difference in. Refused: unpaid bills, closed sales, cash without a shift,
 * the same price, more back than was paid. Only pos.adjust_paid may do it; the admin role always keeps it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AdjustPriceResult,
  LoginResponse,
  PricingRuleSummary,
  RoleSummary,
  SaleSessionLink,
  SessionMutationResponse,
  SessionSummary,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);

describe('change the price of a paid bill', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let shiftId: string;
  const H = () => authHeader(owner.token);

  const call = <T>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app.inject({ method, url: `/api/v1${url}`, headers: H(), payload }).then((r) => ({
      status: r.statusCode,
      body: r.json<T>(),
    }));
  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    ctx.pool.query<T>(sql, params).then((r) => r.rows);

  const makeStation = async (number: number) =>
    (await call<StationSummary>('POST', '/stations', { number, name: `Arena ${number}` })).body;
  const startPrepaid = async (station: StationSummary, method: 'cash' | 'card') =>
    (
      await call<SessionMutationResponse>('POST', '/sessions', {
        stationId: station.id,
        billingMode: 'prepaid',
        minutes: 60,
        payments: [{ method, amountCents: 150 }],
      })
    ).body.session;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    const shift = await call<{ id: string }>('POST', '/cash/shifts/open', { openingCents: 5000 });
    expect(shift.status).toBe(201);
    shiftId = shift.body.id;
    expect(
      (
        await call<PricingRuleSummary>('POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 150,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('lowers a prepaid bill: the difference goes back as a price_adjustment refund from cash', async () => {
    const station = await makeStation(1);
    const session = await startPrepaid(station, 'cash');
    expect(session.saleId).toBeTruthy();

    const link = await call<{ link: SaleSessionLink | null }>(
      'GET',
      `/sessions/by-sale/${session.saleId}`,
    );
    expect(link.body.link).toMatchObject({
      sessionId: session.id,
      stationCode: station.code,
      billingMode: 'prepaid',
      finalPriceCents: 150,
      paidCents: 150,
    });

    const res = await call<AdjustPriceResult>('POST', `/sessions/${session.id}/adjust-price`, {
      mode: 'fixed',
      amountCents: 100,
      method: 'cash',
      reason: 'Test: ulje me kthim',
    });
    expect(res.status).toBe(200);
    expect(res.body.adjustment).toMatchObject({
      previousCents: 150,
      newCents: 100,
      deltaCents: -50,
      method: 'cash',
    });
    expect(res.body.adjustment.refundNo).toBeTruthy();
    expect(res.body.session.finalPriceCents).toBe(100);

    const refunds = await q<{ kind: string; total_cents: string; restock: boolean }>(
      'SELECT kind, total_cents::text, restock FROM refunds WHERE sale_id = $1',
      [session.saleId],
    );
    expect(refunds).toEqual([{ kind: 'price_adjustment', total_cents: '50', restock: false }]);

    const cash = await q<{ amount_cents: string }>(
      `SELECT amount_cents::text FROM cash_movements WHERE shift_id = $1 AND movement_type = 'refund'`,
      [shiftId],
    );
    expect(cash.map((r) => Number(r.amount_cents))).toEqual([-50]);

    const sale = await q<{ status: string; total_cents: string; refunded_cents: string }>(
      'SELECT status, total_cents::text, refunded_cents::text FROM sales WHERE id = $1',
      [session.saleId],
    );
    expect(sale[0]).toEqual({
      status: 'partially_refunded',
      total_cents: '150',
      refunded_cents: '50',
    });

    const after = await call<{ link: SaleSessionLink | null }>(
      'GET',
      `/sessions/by-sale/${session.saleId}`,
    );
    expect(after.body.link?.paidCents).toBe(100);
  });

  it('refuses the same price again', async () => {
    const station = await makeStation(2);
    const session = await startPrepaid(station, 'cash');
    const res = await call<{ error: { code: string } }>(
      'POST',
      `/sessions/${session.id}/adjust-price`,
      { mode: 'fixed', amountCents: 150, method: 'cash' },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('discount mode and a higher price: the difference is taken in on the same sale', async () => {
    const station = await makeStation(3);
    const session = await startPrepaid(station, 'card');
    const dec = await call<AdjustPriceResult>('POST', `/sessions/${session.id}/adjust-price`, {
      mode: 'discount',
      amountCents: 30,
      method: 'card',
    });
    expect(dec.status).toBe(200);
    expect(dec.body.adjustment).toMatchObject({ newCents: 120, deltaCents: -30 });

    const inc = await call<AdjustPriceResult>('POST', `/sessions/${session.id}/adjust-price`, {
      mode: 'fixed',
      amountCents: 200,
      method: 'card',
    });
    expect(inc.status).toBe(200);
    expect(inc.body.adjustment).toMatchObject({
      previousCents: 120,
      newCents: 200,
      deltaCents: 80,
    });

    const pays = await q<{ kind: string; amount_cents: string }>(
      'SELECT kind, amount_cents::text FROM payments WHERE sale_id = $1 ORDER BY created_at, id',
      [session.saleId],
    );
    expect(pays.map((p) => [p.kind, Number(p.amount_cents)])).toEqual([
      ['sale', 150],
      ['refund', 30],
      ['sale', 80],
    ]);
    const sale = await q<{ total_cents: string; refunded_cents: string }>(
      'SELECT total_cents::text, refunded_cents::text FROM sales WHERE id = $1',
      [session.saleId],
    );
    // total − refunded = what the bill now costs
    expect(Number(sale[0]!.total_cents) - Number(sale[0]!.refunded_cents)).toBe(200);
  });

  it('a fully given-back bill is marked refunded and can no longer be changed', async () => {
    const station = await makeStation(4);
    const session = await startPrepaid(station, 'cash');
    const zero = await call<AdjustPriceResult>('POST', `/sessions/${session.id}/adjust-price`, {
      mode: 'fixed',
      amountCents: 0,
      method: 'cash',
    });
    expect(zero.status).toBe(200);
    const sale = await q<{ status: string }>('SELECT status FROM sales WHERE id = $1', [
      session.saleId,
    ]);
    expect(sale[0]!.status).toBe('refunded');
    const again = await call<{ error: { message: string } }>(
      'POST',
      `/sessions/${session.id}/adjust-price`,
      { mode: 'fixed', amountCents: 10, method: 'card' },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('cannot be changed');
  });

  it('refuses cash with no open shift, and leaves the bill as it was', async () => {
    const station = await makeStation(5);
    const session = await startPrepaid(station, 'card');
    expect(
      (await call('POST', `/cash/shifts/${shiftId}/close`, { countedCashCents: 5000 })).status,
    ).toBe(200);

    const cashOut = await call<{ error: { code: string } }>(
      'POST',
      `/sessions/${session.id}/adjust-price`,
      { mode: 'fixed', amountCents: 100, method: 'cash' },
    );
    expect(cashOut.status).toBe(409);
    expect(cashOut.body.error.code).toBe('SHIFT_REQUIRED');

    const cashIn = await call('POST', `/sessions/${session.id}/adjust-price`, {
      mode: 'fixed',
      amountCents: 200,
      method: 'cash',
    });
    expect(cashIn.status).toBe(409);

    const cur = await call<SessionSummary>('GET', `/sessions/${session.id}`);
    expect(cur.body.finalPriceCents).toBe(150);

    // A card change does not need a shift.
    const card = await call<AdjustPriceResult>('POST', `/sessions/${session.id}/adjust-price`, {
      mode: 'fixed',
      amountCents: 100,
      method: 'card',
    });
    expect(card.status).toBe(200);
  });

  it('refuses a bill that is not paid yet', async () => {
    const station = await makeStation(6);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 60,
    });
    const res = await call<{ error: { message: string } }>(
      'POST',
      `/sessions/${started.body.session.id}/adjust-price`,
      { mode: 'fixed', amountCents: 50, method: 'card' },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('not paid yet');
  });

  it('a cashier without pos.adjust_paid is refused', async () => {
    const created = await call('POST', '/users', {
      username: 'cashier2',
      fullName: 'Cashier Two',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    expect(created.status).toBe(201);
    const cashier = await login(ctx.app, 'cashier2', 'Cashier123');
    const station = await makeStation(7);
    const session = await startPrepaid(station, 'card');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/adjust-price`,
      headers: authHeader(cashier.token),
      payload: { mode: 'fixed', amountCents: 100, method: 'card' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('the admin role always keeps pos.adjust_paid', async () => {
    const roles = (await call<RoleSummary[]>('GET', '/roles')).body;
    const admin = roles.find((r) => r.code === 'admin')!;
    expect(admin.permissions).toContain('pos.adjust_paid');
    const without = admin.permissions.filter((p) => p !== 'pos.adjust_paid');
    const res = await call<{ error: { message: string } }>(
      'PUT',
      `/roles/${admin.id}/permissions`,
      {
        permissions: without,
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('pos.adjust_paid');
  });

  it('a sale without PC time has no session link', async () => {
    const res = await call<{ link: SaleSessionLink | null }>(
      'GET',
      '/sessions/by-sale/00000000-0000-4000-8000-000000000000',
    );
    expect(res.body.link).toBeNull();
  });
});
