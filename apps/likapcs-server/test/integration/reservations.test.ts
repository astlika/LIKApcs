/**
 * 0.32.0 — PC reservations: overlapping bookings are refused, the sweep releases a hold once its
 * tolerance has passed, cancel frees the PC, and the badges are saved per PC.
 *
 * 0.33.4 — a booking for later does not touch its PCs: no mark on the PC and no question before
 * its reminder time, and a session started there does not use up the booking. Inside the window
 * (reminder time → end of the tolerance) the PC asks (reservation_conflict); the booked customer
 * (`reservationId`, or the same customer record) uses up the hold; anyone else starts with
 * `ignoreReservation` and the booking keeps its PC. A booking can be changed (time, PCs, name).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

  const reservationOf = async (id: string) =>
    (
      await call<{ items: ReservationSummary[] }>(
        'GET',
        `/reservations?from=${encodeURIComponent(inHour(-180))}&to=${encodeURIComponent(inHour(600))}`,
      )
    ).body.items.find((r) => r.id === id)!;
  const pcOf = async (key: string) =>
    (await call<StationSummary>('GET', `/stations/${stations[key]!.id}`)).body;
  const endSession = async (id: string) =>
    expect((await call('POST', `/sessions/${id}/end`, { payments: [] })).status).toBe(200);

  it('a booking for later leaves the PC alone: no mark, no question, and a walk-in does not use it up', async () => {
    const created = await call<ReservationSummary>('POST', '/reservations', {
      stationIds: [stations.PC1!.id, stations.PC2!.id],
      startsAt: inHour(60),
      customerName: 'Besa',
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('scheduled');
    expect(created.body.toleranceMinutes).toBe(5);
    expect(created.body.remindMinutes).toBe(10);
    expect(Date.parse(created.body.startsAt) - Date.parse(created.body.remindAt)).toBe(10 * MINUTE);
    expect(created.body.stations.map((s) => s.state)).toEqual(['held', 'held']);

    // One hour before: the PC shows nothing of the booking.
    expect((await pcOf('PC1')).reservation).toBeNull();

    // A walk-in sits down without any confirmation…
    const walkIn = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: stations.PC1!.id,
      billingMode: 'postpaid',
    });
    expect(walkIn.status).toBe(201);
    // …and the booking still has both PCs.
    const after = await reservationOf(created.body.id);
    expect(after.status).toBe('scheduled');
    expect(after.stations.map((s) => s.state)).toEqual(['held', 'held']);
    await endSession(walkIn.body.session.id);
  });

  it('inside its window the PC asks; someone else starts with ignoreReservation and the booking keeps the PC', async () => {
    // Ten minutes ahead with the default reminder of 10 minutes: the window is open now.
    const created = await call<ReservationSummary>('POST', '/reservations', {
      stationIds: [stations.PC3!.id],
      startsAt: inHour(8),
      customerName: 'Dritan',
    });
    expect(created.status).toBe(201);
    const pc3 = await pcOf('PC3');
    expect(pc3.reservation?.reservationId).toBe(created.body.id);
    expect(pc3.reservation?.customerName).toBe('Dritan');

    const blocked = await call<unknown>('POST', '/sessions', {
      stationId: stations.PC3!.id,
      billingMode: 'postpaid',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.raw).toContain('reservation_conflict');

    const other = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: stations.PC3!.id,
      billingMode: 'postpaid',
      ignoreReservation: true,
    });
    expect(other.status).toBe(201);
    const kept = await reservationOf(created.body.id);
    expect(kept.stations[0]?.state).toBe('held');
    expect(['scheduled', 'active']).toContain(kept.status);

    // The booked customer turns out to be the one sitting there: the desk marks the PC as arrived.
    const arrived = await call<{ reservation: ReservationSummary; checkedIn: string[] }>(
      'POST',
      `/reservations/${created.body.id}/check-in`,
      {},
    );
    expect(arrived.status).toBe(200);
    expect(arrived.body.checkedIn).toEqual([stations.PC3!.id]);
    expect(arrived.body.reservation.status).toBe('completed');
    expect(arrived.body.reservation.stations[0]?.state).toBe('checked_in');
    expect((await pcOf('PC3')).reservation).toBeNull();
    await endSession(other.body.session.id);
  });

  it('the arrival of the booking (reservationId) uses up that PC only — early arrivals too', async () => {
    const booking = (await call<{ items: ReservationSummary[] }>('GET', '/reservations')).body.items.find(
      (r) => r.customerName === 'Besa',
    )!;
    // 50+ minutes early, no question asked: the desk says who it is.
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: stations.PC1!.id,
      billingMode: 'postpaid',
      customerName: 'Besa',
      reservationId: booking.id,
    });
    expect(started.status).toBe(201);
    const mine = await reservationOf(booking.id);
    expect(mine.stations.find((s) => s.stationId === stations.PC1!.id)?.state).toBe('checked_in');
    expect(mine.stations.find((s) => s.stationId === stations.PC2!.id)?.state).toBe('held');
    expect(mine.status).toBe('scheduled');

    // A reservation that does not keep the PC is refused, and nothing starts.
    const wrong = await call<unknown>('POST', '/sessions', {
      stationId: stations.PC4!.id,
      billingMode: 'postpaid',
      reservationId: booking.id,
    });
    expect(wrong.status).toBe(409);
    expect(wrong.raw).toContain('reservation_mismatch');
    expect((await pcOf('PC4')).activeSession).toBeNull();
    await endSession(started.body.session.id);
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

  it('the booked customer record: untouched hours before, used up inside the window', async () => {
    const booked = await call<ReservationSummary>('POST', '/reservations', {
      stationIds: [stations.PC3!.id],
      startsAt: inHour(120),
      customerId: customer.id,
      customerName: customer.name,
    });
    expect(booked.status).toBe(201);
    // Two hours early the same customer plays on that PC: an ordinary visit, the booking stays.
    const early = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: stations.PC3!.id,
      billingMode: 'postpaid',
      customerId: customer.id,
    });
    expect(early.status).toBe(201);
    expect((await reservationOf(booked.body.id)).stations[0]?.state).toBe('held');
    await endSession(early.body.session.id);

    // Moved to five minutes from now: inside the window the customer starts with no question.
    const moved = await call<ReservationSummary>('PATCH', `/reservations/${booked.body.id}`, {
      startsAt: inHour(5),
    });
    expect(moved.status).toBe(200);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: stations.PC3!.id,
      billingMode: 'postpaid',
      customerId: customer.id,
    });
    expect(started.status).toBe(201);
    const row = await reservationOf(booked.body.id);
    expect(row.status).toBe('completed');
    expect(row.stations[0]?.state).toBe('checked_in');
    await endSession(started.body.session.id);
  });

  it('changes a booking: time, PCs, name and reminder; an overlap is refused', async () => {
    const booked = await call<ReservationSummary>('POST', '/reservations', {
      stationIds: [stations.PC4!.id],
      startsAt: inHour(200),
      customerName: 'Grupi',
    });
    expect(booked.status).toBe(201);
    const changed = await call<ReservationSummary>('PATCH', `/reservations/${booked.body.id}`, {
      startsAt: inHour(240),
      stationIds: [stations.PC4!.id, stations.PC5!.id],
      customerName: 'Grupi i Artanit',
      phone: '044 123 456',
      remindMinutes: 30,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.customerName).toBe('Grupi i Artanit');
    expect(changed.body.phone).toBe('044 123 456');
    expect(changed.body.remindMinutes).toBe(30);
    expect(changed.body.stations.map((s) => `${s.number}:${s.state}`)).toEqual(['4:held', '5:held']);
    // PC 2 is kept by "Besa" at +60 min: moving this booking onto it at that time is refused.
    const clash = await call<unknown>('PATCH', `/reservations/${booked.body.id}`, {
      startsAt: inHour(62),
      stationIds: [stations.PC2!.id],
    });
    expect(clash.status).toBe(409);
    expect(clash.raw).toContain('reservation_overlap');
    // Dropping a PC frees it; the other stays.
    const fewer = await call<ReservationSummary>('PATCH', `/reservations/${booked.body.id}`, {
      stationIds: [stations.PC5!.id],
    });
    expect(fewer.body.stations.map((s) => s.number)).toEqual([5]);
    expect((await call('POST', `/reservations/${booked.body.id}/cancel`)).status).toBe(200);
    expect((await call('PATCH', `/reservations/${booked.body.id}`, { remindMinutes: 5 })).status).toBe(409);
    expect((await call('PATCH', `/reservations/${booked.body.id}`, {})).status).toBe(400);
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

  it('tells the PC once when a booking reaches its reminder time (0.33.4)', async () => {
    // A PC of its own: the other bookings of this file must not explain the message.
    const pc6 = (await call<StationSummary>('POST', '/stations', { number: 6, name: 'Arena 6' })).body;
    const booked = await call<ReservationSummary>('POST', '/reservations', {
      stationIds: [pc6.id],
      startsAt: inHour(300),
      customerName: 'Më vonë',
    });
    expect(booked.status).toBe(201);
    const told = vi.spyOn(ctx.app.services.stations, 'broadcastStation');
    const toldPc6 = () => told.mock.calls.filter(([stationId]) => stationId === pc6.id).length;
    try {
      // Hours before: the booking does not touch the PC and the sweep says nothing about it.
      await ctx.app.services.reservations.sweep();
      expect(toldPc6()).toBe(0);
      // Nine minutes before the start (the reminder is 10 minutes): the PC is told…
      const inside = new Date(Date.now() + 291 * MINUTE);
      await ctx.app.services.reservations.sweep(inside);
      expect(toldPc6()).toBe(1);
      // …and only once.
      await ctx.app.services.reservations.sweep(new Date(inside.getTime() + MINUTE));
      expect(toldPc6()).toBe(1);
    } finally {
      told.mockRestore();
    }
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
