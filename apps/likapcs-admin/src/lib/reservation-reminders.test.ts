import { describe, expect, it } from 'vitest';
import type { ReservationSummary } from '@likapcs/shared';
import {
  dueReservations,
  openReservationCount,
  pcOccupancy,
  reminderKey,
  untilLabel,
} from './reservation-reminders';

const START = Date.parse('2026-11-12T20:00:00.000Z');
const MIN = 60_000;

const booking = (over: Partial<ReservationSummary> = {}): ReservationSummary => ({
  id: 'r1',
  startsAt: new Date(START).toISOString(),
  toleranceMinutes: 5,
  windowEndsAt: new Date(START + 5 * MIN).toISOString(),
  remindMinutes: 10,
  remindAt: new Date(START - 10 * MIN).toISOString(),
  status: 'scheduled',
  customerId: null,
  customerName: 'Besa',
  phone: null,
  notes: null,
  stations: [
    { stationId: 'pc7', code: 'PC 07', number: 7, state: 'held' },
    { stationId: 'pc8', code: 'PC 08', number: 8, state: 'held' },
  ],
  createdByName: 'owner',
  createdAt: new Date(START - 120 * MIN).toISOString(),
  finishedAt: null,
  cancelledAt: null,
  ...over,
});

describe('dueReservations', () => {
  it('is silent before the reminder time: a booking for later reminds nobody', () => {
    expect(dueReservations([booking()], START - 11 * MIN)).toEqual([]);
  });

  it('reminds "soon" from the reminder time and "now" from the booked time until the tolerance ends', () => {
    const soon = dueReservations([booking()], START - 10 * MIN)[0]!;
    expect(soon.phase).toBe('soon');
    expect(soon.secondsToStart).toBe(600);
    expect(soon.waiting.map((s) => s.code)).toEqual(['PC 07', 'PC 08']);

    const now = dueReservations([booking({ status: 'active' })], START + 2 * MIN)[0]!;
    expect(now.phase).toBe('now');
    expect(now.secondsToStart).toBe(0);
    expect(now.secondsLeft).toBe(180);

    expect(dueReservations([booking({ status: 'active' })], START + 5 * MIN)).toEqual([]);
  });

  it('stops once every PC is taken, and for a cancelled or finished booking', () => {
    const allIn = booking({
      stations: [{ stationId: 'pc7', code: 'PC 07', number: 7, state: 'checked_in' }],
    });
    expect(dueReservations([allIn], START)).toEqual([]);
    expect(dueReservations([booking({ status: 'cancelled' })], START)).toEqual([]);
    expect(dueReservations([booking({ status: 'expired' })], START)).toEqual([]);
    // One PC taken: only the other still waits.
    const half = booking({
      stations: [
        { stationId: 'pc7', code: 'PC 07', number: 7, state: 'checked_in' },
        { stationId: 'pc8', code: 'PC 08', number: 8, state: 'held' },
      ],
    });
    expect(dueReservations([half], START)[0]!.waiting.map((s) => s.code)).toEqual(['PC 08']);
  });

  it('orders by the booked time and gives a moved booking a new key', () => {
    const later = booking({
      id: 'r2',
      startsAt: new Date(START + MIN).toISOString(),
      remindAt: new Date(START - 9 * MIN).toISOString(),
    });
    const due = dueReservations([later, booking()], START - 5 * MIN);
    expect(due.map((d) => d.reservation.id)).toEqual(['r1', 'r2']);
    expect(reminderKey(due[0]!)).toBe(`r1:soon:${new Date(START).toISOString()}`);
    expect(reminderKey(due[0]!)).not.toBe(reminderKey({ ...due[0]!, phase: 'now' }));
  });
});

describe('helpers', () => {
  it('counts the open bookings that still wait for someone', () => {
    expect(
      openReservationCount([
        booking(),
        booking({ id: 'x', status: 'cancelled' }),
        booking({
          id: 'y',
          stations: [{ stationId: 'p', code: 'PC 01', number: 1, state: 'checked_in' }],
        }),
      ]),
    ).toBe(1);
  });

  it('says whether a booked PC is free or in use', () => {
    expect(pcOccupancy(undefined)).toEqual({ busy: false, minutesLeft: null });
    expect(pcOccupancy({ activeSession: null })).toEqual({ busy: false, minutesLeft: null });
    expect(pcOccupancy({ activeSession: { remainingSeconds: 1500 } as never })).toEqual({
      busy: true,
      minutesLeft: 25,
    });
    expect(pcOccupancy({ activeSession: { remainingSeconds: null } as never })).toEqual({
      busy: true,
      minutesLeft: null,
    });
  });

  it('writes how far the booked time is', () => {
    expect(untilLabel(45)).toBe('45 s');
    expect(untilLabel(480)).toBe('8 min');
    expect(untilLabel(7500)).toBe('2 h 05 min');
    expect(untilLabel(7200)).toBe('2 h');
  });
});
