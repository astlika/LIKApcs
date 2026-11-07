/**
 * Pure helper behind the bulk start of PCs with PC time that was sold at the till (0.20.9).
 *
 * Each selected PC gets at most one credit, and each credit goes to at most one PC:
 *  - a credit sold for a PC (`stationId` set) can only start that PC;
 *  - a credit sold without a PC (`stationId` null) can start any PC;
 *  - a PC with its own credit takes it first; the rest take the oldest free "any PC" credit.
 * Credits are expected oldest first (the server orders them by `createdAt`).
 *
 * Kept free of React so it can be unit tested.
 */
import type { TimeCreditSummary } from '@likapcs/shared';

export interface CreditTarget {
  id: string;
}

export interface CreditAssignment<T extends CreditTarget> {
  target: T;
  credit: TimeCreditSummary | null;
}

export function assignCredits<T extends CreditTarget>(
  targets: T[],
  credits: TimeCreditSummary[],
): CreditAssignment<T>[] {
  const usable = credits.filter((c) => c.minutesRemaining > 0);
  const taken = new Set<string>();
  const byTarget = new Map<string, TimeCreditSummary>();

  // First pass: credits sold for a specific PC.
  for (const target of targets) {
    const own = usable.find((c) => c.stationId === target.id && !taken.has(c.id));
    if (own) {
      taken.add(own.id);
      byTarget.set(target.id, own);
    }
  }
  // Second pass: the oldest free "any PC" credits, for the PCs still without one.
  const anyPc = usable.filter((c) => c.stationId === null);
  for (const target of targets) {
    if (byTarget.has(target.id)) continue;
    const free = anyPc.find((c) => !taken.has(c.id));
    if (free) {
      taken.add(free.id);
      byTarget.set(target.id, free);
    }
  }

  return targets.map((target) => ({ target, credit: byTarget.get(target.id) ?? null }));
}
