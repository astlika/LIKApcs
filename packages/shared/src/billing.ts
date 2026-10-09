/**
 * Gaming-session billing — pure integer arithmetic shared by the server (authoritative) and the
 * Admin app (quotes shown before confirming). No floating point anywhere: cents, seconds, minutes.
 *
 * Pricing rule evaluation uses the business time zone (settings `locale.timezone`), not the clock
 * of whichever machine runs the code.
 */
import { divRound, roundToIncrement, type Cents } from './money.js';

export type RoundingMode = 'up' | 'down' | 'nearest';

/** The subset of a pricing rule that determines a price (snapshotted on the session). */
export interface PricingTerms {
  rateCentsPerHour: Cents;
  /** Time is charged in blocks of this many minutes (1 = per minute). */
  billingIncrementMinutes: number;
  /** A session is never charged for less than this many minutes. */
  minimumMinutes: number;
  /** …nor for less than this amount. */
  minimumChargeCents: Cents;
  roundingMode: RoundingMode;
  /** Final amount is rounded to this increment (1 = cent, 10 = 10 cents, 50 = half euro). */
  roundingIncrementCents: Cents;
}

export const DEFAULT_PRICING_TERMS: PricingTerms = {
  rateCentsPerHour: 0,
  billingIncrementMinutes: 1,
  minimumMinutes: 0,
  minimumChargeCents: 0,
  roundingMode: 'up',
  roundingIncrementCents: 1,
};

function assertNonNegativeInt(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
}

/**
 * Seconds that count towards the bill: wall-clock time minus completed pauses minus the pause that
 * may still be running at `endedAt`.
 */
export function billableSeconds(input: {
  startedAt: Date | string | number;
  endedAt: Date | string | number;
  totalPausedSeconds: number;
  pausedAt?: Date | string | number | null;
}): number {
  const start = new Date(input.startedAt).getTime();
  const end = new Date(input.endedAt).getTime();
  assertNonNegativeInt(input.totalPausedSeconds, 'totalPausedSeconds');
  let paused = input.totalPausedSeconds;
  if (input.pausedAt) {
    // The pause still running at `endedAt` counts up to `endedAt` only.
    const pausedAt = Math.max(start, new Date(input.pausedAt).getTime());
    if (pausedAt < end) paused += Math.floor((end - pausedAt) / 1000);
  }
  const seconds = Math.floor((end - start) / 1000) - paused;
  return Math.max(0, seconds);
}

/** Minutes actually charged: rounded up to the billing increment, at least `minimumMinutes`. */
export function chargeableMinutes(seconds: number, terms: PricingTerms): number {
  assertNonNegativeInt(seconds, 'seconds');
  const increment = Math.max(1, Math.trunc(terms.billingIncrementMinutes));
  const rawMinutes = Math.ceil(seconds / 60);
  const blocks = Math.ceil(rawMinutes / increment);
  return Math.max(terms.minimumMinutes, blocks * increment);
}

/** Price for a duration in seconds under the given terms. */
export function priceForSeconds(seconds: number, terms: PricingTerms): Cents {
  const minutes = chargeableMinutes(seconds, terms);
  return priceForChargeableMinutes(minutes, terms);
}

/** Price for an already-rounded number of minutes (used for prepaid quotes). */
export function priceForChargeableMinutes(minutes: number, terms: PricingTerms): Cents {
  assertNonNegativeInt(minutes, 'minutes');
  assertNonNegativeInt(terms.rateCentsPerHour, 'rateCentsPerHour');
  const raw = Number(divRound(BigInt(terms.rateCentsPerHour) * BigInt(minutes), 60n));
  const rounded = roundToIncrement(raw, terms.roundingIncrementCents, terms.roundingMode);
  return Math.max(rounded, terms.minimumChargeCents);
}

/** Prepaid quote: the customer buys `minutes`; the billing increment and minimums still apply. */
export function quotePrepaidMinutes(minutes: number, terms: PricingTerms): Cents {
  assertNonNegativeInt(minutes, 'minutes');
  return priceForSeconds(minutes * 60, terms);
}

// ─── Rule selection ──────────────────────────────────────────────────────────

export interface PricingRuleLike extends PricingTerms {
  id: string;
  stationId: string | null;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  daysOfWeek: number[];
  /** 'HH:MM' or null for the whole day. */
  startTime: string | null;
  endTime: string | null;
  priority: number;
  isActive: boolean;
  /** 'YYYY-MM-DD' or null. */
  validFrom: string | null;
  validTo: string | null;
}

export interface LocalClock {
  /** 'YYYY-MM-DD' in the business time zone. */
  date: string;
  /** Minutes since local midnight. */
  minutesOfDay: number;
  /** ISO weekday 1–7. */
  isoWeekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Local date/time components of `at` in `timeZone` (IANA name), computed with Intl only. */
export function localClock(at: Date | string | number, timeZone: string): LocalClock {
  const date = new Date(at);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutesOfDay: hour * 60 + Number(get('minute')),
    isoWeekday: WEEKDAYS[get('weekday')] ?? 1,
  };
}

export function parseClockMinutes(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59) return null;
  return h * 60 + m;
}

/** Does the rule's weekday / time window / validity cover the given local instant? */
export function ruleAppliesAt(rule: PricingRuleLike, clock: LocalClock): boolean {
  if (!rule.isActive) return false;
  if (rule.validFrom && clock.date < rule.validFrom) return false;
  if (rule.validTo && clock.date > rule.validTo) return false;
  const start = parseClockMinutes(rule.startTime);
  const end = parseClockMinutes(rule.endTime);
  if (start === null || end === null || start === end) {
    return rule.daysOfWeek.includes(clock.isoWeekday);
  }
  if (start < end) {
    return (
      rule.daysOfWeek.includes(clock.isoWeekday) &&
      clock.minutesOfDay >= start &&
      clock.minutesOfDay < end
    );
  }
  // Window crosses midnight (e.g. 22:00–02:00): the evening part belongs to the rule's weekday,
  // the part after midnight to the following calendar day.
  if (clock.minutesOfDay >= start) return rule.daysOfWeek.includes(clock.isoWeekday);
  if (clock.minutesOfDay < end) {
    const previous = clock.isoWeekday === 1 ? 7 : clock.isoWeekday - 1;
    return rule.daysOfWeek.includes(previous);
  }
  return false;
}

/**
 * Pick the rule for a station at an instant: station-specific rules beat global ones, then the
 * highest priority wins, then the most recently defined (last in the list) — deterministic.
 */
export function selectPricingRule<R extends PricingRuleLike>(
  rules: readonly R[],
  stationId: string,
  clock: LocalClock,
): R | null {
  let best: R | null = null;
  let bestIndex = -1;
  rules.forEach((rule, index) => {
    if (rule.stationId !== null && rule.stationId !== stationId) return;
    if (!ruleAppliesAt(rule, clock)) return;
    if (!best) {
      best = rule;
      bestIndex = index;
      return;
    }
    const specific = (rule.stationId !== null ? 1 : 0) - (best.stationId !== null ? 1 : 0);
    if (
      specific > 0 ||
      (specific === 0 && rule.priority > best.priority) ||
      (specific === 0 && rule.priority === best.priority && index > bestIndex)
    ) {
      best = rule;
      bestIndex = index;
    }
  });
  return best;
}

export function termsOf(rule: PricingTerms): PricingTerms {
  return {
    rateCentsPerHour: rule.rateCentsPerHour,
    billingIncrementMinutes: rule.billingIncrementMinutes,
    minimumMinutes: rule.minimumMinutes,
    minimumChargeCents: rule.minimumChargeCents,
    roundingMode: rule.roundingMode,
    roundingIncrementCents: rule.roundingIncrementCents,
  };
}
