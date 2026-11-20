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

// ─── 0.33.4: one plan for the whole selection ────────────────────────────────

/** What one PC of the selection starts with: its paid minutes, or nothing (it takes the chosen time). */
export interface CreditPlanRow<T extends CreditTarget> {
  target: T;
  credit: TimeCreditSummary | null;
  /** Minutes taken from `credit` for this PC (0 without a credit). */
  minutes: number;
}

/** One credit per PC, each used whole (the rule of `assignCredits`). */
export function planEach<T extends CreditTarget>(
  targets: T[],
  credits: TimeCreditSummary[],
): CreditPlanRow<T>[] {
  return assignCredits(targets, credits).map((a) => ({
    target: a.target,
    credit: a.credit,
    minutes: a.credit?.minutesRemaining ?? 0,
  }));
}

/**
 * The paid minutes shared equally over every PC of the selection: one payment at the till for a
 * whole group ("300 min" for five PCs → 60 min each). Only credits usable at any PC are shared.
 * Every PC gets the same minutes: the largest number the credits can give to all of them (a session
 * draws from one credit, so a credit serves as many PCs as it has whole shares). What does not
 * divide stays on the credit. Null when the credits cannot give every PC at least one minute.
 */
export function planSplit<T extends CreditTarget>(
  targets: T[],
  credits: TimeCreditSummary[],
): { rows: CreditPlanRow<T>[]; minutesEach: number; leftoverMinutes: number } | null {
  const shared = credits.filter((c) => c.stationId === null && c.minutesRemaining > 0);
  const n = targets.length;
  if (n === 0 || shared.length === 0) return null;
  const serves = (m: number) =>
    shared.reduce((sum, c) => sum + Math.floor(c.minutesRemaining / m), 0);
  // The best share is always "a credit divided by a whole number of PCs".
  const candidates = new Set<number>();
  for (const c of shared) {
    for (let k = 1; k <= n; k += 1) {
      const m = Math.floor(c.minutesRemaining / k);
      if (m >= 1) candidates.add(m);
    }
  }
  const minutesEach = [...candidates].sort((a, b) => b - a).find((m) => serves(m) >= n);
  if (!minutesEach) return null;
  const rows: CreditPlanRow<T>[] = [];
  let next = 0;
  for (const credit of shared) {
    let shares = Math.floor(credit.minutesRemaining / minutesEach);
    while (shares > 0 && next < n) {
      rows.push({ target: targets[next]!, credit, minutes: minutesEach });
      next += 1;
      shares -= 1;
    }
  }
  const total = shared.reduce((sum, c) => sum + c.minutesRemaining, 0);
  return { rows, minutesEach, leftoverMinutes: total - minutesEach * n };
}

// ─── 0.36.1: paid minutes the desk cannot tell apart are shown once ───────────

/** Paid minutes as one choice in a start / "add time" window: the oldest of its kind, and how many wait. */
export interface CreditGroup {
  credit: TimeCreditSummary;
  count: number;
}

/**
 * Credits that look the same to the desk — the same PC (or any PC), the same offer, the same name
 * and the same minutes — as one entry, in the order given (oldest first). Three offers sold at the
 * till are one choice "× 3", and using it takes the oldest.
 */
export function groupCredits(credits: readonly TimeCreditSummary[]): CreditGroup[] {
  const groups = new Map<string, CreditGroup>();
  for (const credit of credits) {
    if (credit.minutesRemaining <= 0) continue;
    const key = [
      credit.stationId ?? '',
      credit.offerName ?? '',
      credit.holderName ?? '',
      credit.minutesRemaining,
    ].join('\u0000');
    const known = groups.get(key);
    if (known) known.count += 1;
    else groups.set(key, { credit, count: 1 });
  }
  return [...groups.values()];
}

/** The name a credit is shown under besides its minutes: whose it is, unless it is the generic one. */
export function creditHolder(credit: Pick<TimeCreditSummary, 'holderName'>): string | null {
  const name = credit.holderName?.trim() ?? '';
  return name && name.toLowerCase() !== 'klient' ? name : null;
}
