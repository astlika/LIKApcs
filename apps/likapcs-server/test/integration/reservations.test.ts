/**
 * 0.32.0 — PC reservations. A held PC asks before a session starts (reservation_conflict), the
 * booked customer starts it straight away, a confirmed start uses the hold, overlapping bookings
 * are refused, the sweep releases a hold once its tolerance has passed, cancel frees the PC, and
 * the badges are saved per PC.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CustomerSummary,
  DashboardSummary,
  LoginResponse,
  ReservationSummary,
  SessionMutationResponse,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const MINUTE = 60_000;

describe('PC reservations', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let customer: CustomerSummary;
  const stations: Record<string, StationSummary> = {};

  const call = <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload: payload as object })
      .then((r) => ({
        status: r.statusCode,
        body: r.body ? (JSON.parse(r.body) as T) : (null as T),
        raw: r.body,
      }));

  const inHour = (minutes: number) => new Date(Date.now() + minutes * MINUTE).toISOString();

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    const shift = await call('POST', '/cash/shifts/open', { openingCents: 5000 });
    expect(shift.status).toBe(201);
    for (const n of [1, 2, 3, 4, 5]) {
      stations[`PC${n}`] = (
        await call<StationSummary>('POST', '/stations', { number: n, name: `Arena ${n}` })
      ).body;
    }
    customer = (await call<CustomerSummary>('POST', '/customers', { name: 'Ardit Rezervues' })).body;
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('holds the booked PCs, shows the hold on each PC, and refuses a start without confirmation', async () => {
    const created = await call<ReservationSummary>('POST', '/reservations', {
      stationIds: [stations.PC1!.id, stations.PC2!.id],
      startsAt: inHour(60),
      customerName: 'Besa',
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('scheduled');
    expect(created.body.toleranceMinutes).toBe(5);
    expect(created.body.stations.map((s) => s.state)).toEqual(['held', 'held']);

    const pc1 = (await call<StationSummary>('GET', `/stations/${stations.PC1!.id}`)).body;
    expect(pc1.reservation?.reservationId).toBe(created.body.id);
    expect(pc1.reservation?.customerName).toBe('Besa');

    const blocked = await call<unknown>('POST', '/sessions', {
      stationId: stations.PC1!.id,
      billingMode: 'postpaid',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.raw).toContain('reservation_conflict');
  });

  it('starts the session when the staff confirms, and uses up that PC hold only', async () => {
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: stations.PC1!.id,
      billingMode: 'postpaid',
      ignoreReservation: true,
    });
    expect(started.status).toBe(201);

    const reservations = await call<{ items: ReservationSummary[] }>('GET', '/reservations');
    const mine = reservations.body.items.find(
      (r) => r.customerName === 'Besa',
    )!;
    expect(mine.stations.find((s) => s.stationId === stations.PC1!.id)?.state).toBe('checked_in');
    expect(mine.stations.find((s) => s.stationId === stations.PC2!.id)?.state).toBe('held');
    expect(mine.status).toBe('scheduled');

    const pc1 = (await call<StationSummary>('GET', `/stations/${stations.PC1!.id}`)).body;
    expect(pc1.reservation).toBeNull();
  });

  it('refuses a second booking that overlaps a PC still held', async () => {
    const overlap = await call<unknown>('POST', '/reservations', {
      stationIds: [stations.PC2!.id],
      startsAt: inHour(61),
      customerName: 'Tjetri',
    });
    expect(overlap.status).toBe(409);
    expect(overlap.raw).toContain('reservation_overlap');
  });

  it('lets the booked customer start without confirmation', async () => {
    const booked = await call<ReservationSummary>('POST', '/reservations', {
      stationIds: [stations.PC3!.id],
      startsAt: inHour(120),
      customerId: customer.id,
      customerName: customer.name,
    });
    expect(booked.status).toBe(201);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: stations.PC3!.id,
      billingMode: 'postpaid',
      customerId: customer.id,
    });
    expect(started.status).toBe(201);
    const list = await call<{ items: ReservationSummary[] }>('GET', '/reservations');
    const row = list.body.items.find((r) => r.id === booked.body.id)!;
    expect(row.status).toBe('completed');
    expect(row.stations[0]?.state).toBe('checked_in');
  });

  it('releases a hold once its tolerance has passed, and expires the reservation', async () => {
    const soon = await call<ReservationSummary>('POST', '/reservations', {
      stationIds: [stations.PC4!.id],
      startsAt: inHour(2),
      toleranceMinutes: 3,
      customerName: 'Nuk erdhi',
    });
    expect(soon.status).toBe(201);
    // Two minutes after the booked start + 3 minutes of tolerance: the hold is over.
    await ctx.app.services.reservations.sweep(new Date(Date.now() + 2 * 60 * MINUTE + 4 * MINUTE));
    const list = await call<{ items: ReservationSummary[] }>(
      'GET',
      `/reservations?from=${encodeURIComponent(inHour(-180))}&to=${encodeURIComponent(inHour(600))}`,
    );
    const row = list.body.items.find(
      (r) => r.id === soon.body.id,
    )!;
    expect(row.status).toBe('expired');
    expect(row.stations[0]?.state).toBe('released');
    const pc4 = (await call<StationSummary>('GET', `/stations/${stations.PC4!.id}`)).body;
    expect(pc4.reservation).toBeNull();
  });

  it('cancels a booking, frees its PCs, and refuses a second cancel', async () => {
    const booked = await call<ReservationSummary>('POST', '/reservations', {
      stationIds: [stations.PC5!.id],
      startsAt: inHour(90),
      customerName: 'Anulohet',
    });
    expect(booked.status).toBe(201);
    const cancelled = await call<ReservationSummary>('POST', `/reservations/${booked.body.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    const pc5 = (await call<StationSummary>('GET', `/stations/${stations.PC5!.id}`)).body;
    expect(pc5.reservation).toBeNull();
    const again = await call<unknown>('POST', `/reservations/${booked.body.id}/cancel`);
    expect(again.status).toBe(409);
  });

  it('changes the tolerance of an open reservation', async () => {
    const booked = await call<ReservationSummary>('POST', '/reservations', {
      stationIds: [stations.PC5!.id],
      startsAt: inHour(95),
      customerName: 'Tolerancë',
    });
    const changed = await call<ReservationSummary>('PATCH', `/reservations/${booked.body.id}`, {
      toleranceMinutes: 12,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.toleranceMinutes).toBe(12);
    expect(changed.body.windowEndsAt > changed.body.startsAt).toBe(true);
  });

  it('saves the badges per PC, and the dashboard counts the product units sold', async () => {
    const badged = await call<StationSummary>('PUT', `/stations/${stations.PC2!.id}/badges`, {
      badges: ['vip', 'premium', 'vip'],
    });
    expect(badged.status).toBe(200);
    expect(badged.body.badges).toEqual(['vip', 'premium']);
    const bad = await call<unknown>('PUT', `/stations/${stations.PC2!.id}/badges`, {
      badges: ['gaming-king'],
    });
    expect(bad.status).toBe(400);

    const dash = await call<DashboardSummary>('GET', '/dashboard/summary');
    expect(dash.body.productUnitsSold).toBe(0);
  });
});
