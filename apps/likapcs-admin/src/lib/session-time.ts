/**
 * Pure helpers for live session timers in the Admin. The server is authoritative; these only
 * project the last fetched summary forward to the current wall clock between refreshes.
 */
import { priceForSeconds, type SessionSummary } from '@likapcs/shared';

export function formatHms(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

/** Live seconds for a session summary fetched at `fetchedAt`, projected to `now`. */
export function projectSession(
  session: Pick<SessionSummary, 'status' | 'billableSeconds' | 'endsAt' | 'pausedAt'>,
  fetchedAt: number,
  now: number,
): { elapsed: number; remaining: number | null } {
  const drift = session.status === 'active' ? Math.max(0, (now - fetchedAt) / 1000) : 0;
  const elapsed = session.billableSeconds + drift;
  let remaining: number | null = null;
  if (session.endsAt) {
    const reference = session.pausedAt ? new Date(session.pausedAt).getTime() : now;
    remaining = Math.max(0, (new Date(session.endsAt).getTime() - reference) / 1000);
  }
  return { elapsed, remaining };
}

/**
 * What the session is worth right now, by billing mode: open time (postpaid) is metered; end pay
 * is metered too but never above the reserved amount (ending early costs less, never more);
 * prepaid is simply what was paid.
 */
export function liveSessionPrice(
  session: Pick<SessionSummary, 'billingMode' | 'terms' | 'currentPriceCents'>,
  elapsedSeconds: number,
): number {
  if (session.billingMode === 'postpaid') return priceForSeconds(elapsedSeconds, session.terms);
  if (session.billingMode === 'endpay')
    return Math.min(priceForSeconds(elapsedSeconds, session.terms), session.currentPriceCents);
  return session.currentPriceCents;
}

/** Short label key for a billing mode (chips, badges, lists). */
export function billingModeKey(
  mode: SessionSummary['billingMode'],
): 'sessions.prepaidShort' | 'sessions.postpaidShort' | 'sessions.endPayShort' {
  if (mode === 'prepaid') return 'sessions.prepaidShort';
  if (mode === 'endpay') return 'sessions.endPayShort';
  return 'sessions.postpaidShort';
}
