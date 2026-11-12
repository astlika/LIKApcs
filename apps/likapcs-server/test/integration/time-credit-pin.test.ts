/**
 * 0.20.8 — PC time sold without a PC. The till sells minutes to a name; the customer gets a
 * 4-digit PIN once. At any PC the name + PIN start the minutes left. Wrong PINs lock the credit
 * for a while. The price is the rule that applies to every PC (no PC is chosen at the till).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  LoginResponse,
  SaleDetail,
  SessionMutationResponse,
  StationSummary,
  TimeCreditSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = Math.floor(Date.now() / 60_000) * 60_000;

describe('PC time without a PC (name + PIN)', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let b: StationSummary;

  const call = <T>(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));

  const sellTime = (minutes: number, holderName?: string) =>
    call<SaleDetail>('POST', '/sales', {
      items: [{ minutes, ...(holderName ? { holderName } : {}) }],
      payments: [{ method: 'cash', amountCents: 100_000 }],
    });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0));
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    await call<StationSummary>('POST', '/stations', { number: 1, name: 'Arena 1' });
    b = (await call<StationSummary>('POST', '/stations', { number: 2, name: 'Arena 2' })).body;
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    // One rule for every PC (no stationId): the price a PC-less sale uses.
    await call('POST', '/pricing/rules', { name: 'Standard', rateCentsPerHour: 600 });
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('the quote without a PC is the rule for every PC', async () => {
    const quote = await call<{ minutes: number; priceCents: number }>(
      'GET',
      '/sales/time-quote?minutes=60',
    );
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ minutes: 60, priceCents: 600 });
  });

  it('a sale without a PC creates a credit for the name, with a PIN shown once', async () => {
    const sale = await sellTime(60, 'Arben');
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(600);
    const pins = (sale.body as unknown as { claimPins: { pin: string; holderName: string }[] })
      .claimPins;
    expect(pins).toHaveLength(1);
    expect(pins[0]!.pin).toMatch(/^\d{4}$/);
    expect(pins[0]!.holderName).toBe('Arben');

    const row = await ctx.pool.query<{ station_id: string | null; pin_hash: string | null }>(
      "SELECT station_id, pin_hash FROM time_credits WHERE holder_name = 'Arben'",
    );
    expect(row.rows[0]!.station_id).toBeNull();
    expect(row.rows[0]!.pin_hash).toMatch(/\S/);
    expect(row.rows[0]!.pin_hash).not.toContain(pins[0]!.pin);
  });

  it('with no name typed the credit is for "Klient"', async () => {
    const sale = await sellTime(30);
    const pins = (sale.body as unknown as { claimPins: { holderName: string }[] }).claimPins;
    expect(pins[0]!.holderName).toBe('Klient');
  });

  it('a name and PIN find the credit, the name in any letter case', async () => {
    const sale = await sellTime(45, 'Mimoza');
    const pin = (sale.body as unknown as { claimPins: { pin: string }[] }).claimPins[0]!.pin;
    const found = await ctx.app.services.timeCredits.findByPin('mimoza', pin);
    expect(found.minutesLeft).toBe(45);
  });

  it('a wrong PIN is refused the same way as an unknown name, and five of them lock it', async () => {
    const sale = await sellTime(20, 'Driton');
    const pin = (sale.body as unknown as { claimPins: { pin: string }[] }).claimPins[0]!.pin;
    const wrong = pin === '0000' ? '1111' : '0000';
    await expect(ctx.app.services.timeCredits.findByPin('Nobody', pin)).rejects.toThrow(
      'The name or the PIN is wrong',
    );
    for (let i = 0; i < 5; i++) {
      await expect(ctx.app.services.timeCredits.findByPin('Driton', wrong)).rejects.toThrow(
        'The name or the PIN is wrong',
      );
    }
    // Locked now: even the right PIN is refused until the lock time passes.
    await expect(ctx.app.services.timeCredits.findByPin('Driton', pin)).rejects.toThrow(
      'Too many wrong PINs',
    );
  });

  it('the desk can start the minutes on any PC with a credit that belongs to no PC', async () => {
    const listed = await call<{ credits: TimeCreditSummary[] }>(
      'GET',
      `/time-credits?stationId=${b.id}`,
    );
    const credit = listed.body.credits.find((c) => c.holderName === 'Mimoza');
    expect(credit).toBeDefined();
    expect(credit!.stationId).toBeNull();
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: b.id,
      billingMode: 'prepaid',
      minutes: 45,
      creditId: credit!.id,
    });
    expect(started.status).toBe(201);
    expect(started.body.session).toMatchObject({ billingMode: 'prepaid', plannedSeconds: 2700 });
  });

  it('a PC-less time line cannot be sold without minutes', async () => {
    const r = await call('POST', '/sales', {
      items: [{ holderName: 'X' }],
      payments: [{ method: 'cash', amountCents: 100_000 }],
    });
    expect(r.status).toBe(400);
  });
});
