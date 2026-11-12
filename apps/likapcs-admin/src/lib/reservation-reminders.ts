/**
 * 0.33.4 — when a reservation is due, as plain functions (no React). A booking does not mark its
 * PCs any more; instead the desk gets a reminder that stays on the screen until someone answers it:
 * first at the booking's reminder time ("soon"), again at the booked time ("now"). A reminder ends
 * by itself when every PC of the booking is taken, the booking is cancelled, or its tolerance ends.
 */
import type { ReservationSummary, StationSummary } from '@likapcs/shared';

export type ReminderPhase = 'soon' | 'now';

export interface DueReservation {
  reservation: ReservationSummary;
  phase: ReminderPhase;
  /** Seconds until the booked time; 0 once it has come. */
  secondsToStart: number;
  /** Seconds until the PCs are released (end of the tolerance). */
  secondsLeft: number;
  /** The PCs that still wait for the customer. */
  waiting: ReservationSummary['stations'];
}

const isOpen = (r: ReservationSummary) => r.status === 'scheduled' || r.status === 'active';

/** The reservations the desk must be reminded of at `now`, the earliest first. */
export function dueReservations(
  items: readonly ReservationSummary[],
  now: number,
): DueReservation[] {
  const due: DueReservation[] = [];
  for (const reservation of items) {
    if (!isOpen(reservation)) continue;
    const waiting = reservation.stations.filter((s) => s.state === 'held');
    if (waiting.length === 0) continue;
    const start = Date.parse(reservation.startsAt);
    const end = Date.parse(reservation.windowEndsAt);
    const remindAt = Date.parse(reservation.remindAt);
    if (now < remindAt || now >= end) continue;
    due.push({
      reservation,
      phase: now < start ? 'soon' : 'now',
      secondsToStart: Math.max(0, Math.ceil((start - now) / 1000)),
      secondsLeft: Math.max(0, Math.ceil((end - now) / 1000)),
      waiting,
    });
  }
  return due.sort((a, b) => a.reservation.startsAt.localeCompare(b.reservation.startsAt));
}

/** One key per booking, phase and booked time: a booking that is moved reminds again. */
export function reminderKey(d: Pick<DueReservation, 'reservation' | 'phase'>): string {
  return `${d.reservation.id}:${d.phase}:${d.reservation.startsAt}`;
}

/** Open bookings that still wait for someone (the number on the Reservations button). */
export function openReservationCount(items: readonly ReservationSummary[]): number {
  return items.filter((r) => isOpen(r) && r.stations.some((s) => s.state === 'held')).length;
}

/** What a booked PC is doing right now, for the reminder: free, or in use (and for how long). */
export function pcOccupancy(station: Pick<StationSummary, 'activeSession'> | undefined): {
  busy: boolean;
  minutesLeft: number | null;
} {
  const live = station?.activeSession;
  if (!live) return { busy: false, minutesLeft: null };
  return {
    busy: true,
    minutesLeft: live.remainingSeconds === null ? null : Math.ceil(live.remainingSeconds / 60),
  };
}

/** "2 h 05 min" / "8 min" / "45 s": how far the booked time is. */
export function untilLabel(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
}
