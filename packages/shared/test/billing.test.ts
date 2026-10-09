import { describe, expect, it } from 'vitest';
import {
  billableSeconds,
  chargeableMinutes,
  localClock,
  priceForSeconds,
  quotePrepaidMinutes,
  ruleAppliesAt,
  selectPricingRule,
  type PricingRuleLike,
  type PricingTerms,
} from '../src/billing.js';

const perMinute: PricingTerms = {
  rateCentsPerHour: 150, // 1.50 €/h
  billingIncrementMinutes: 1,
  minimumMinutes: 0,
  minimumChargeCents: 0,
  roundingMode: 'up',
  roundingIncrementCents: 1,
};

describe('billableSeconds', () => {
  it('subtracts completed pauses and a pause still running at the end', () => {
    const startedAt = '2026-10-09T10:00:00Z';
    expect(
      billableSeconds({ startedAt, endedAt: '2026-10-09T11:00:00Z', totalPausedSeconds: 0 }),
    ).toBe(3600);
    expect(
      billableSeconds({ startedAt, endedAt: '2026-10-09T11:00:00Z', totalPausedSeconds: 600 }),
    ).toBe(3000);
    expect(
      billableSeconds({
        startedAt,
        endedAt: '2026-10-09T11:00:00Z',
        totalPausedSeconds: 600,
        pausedAt: '2026-10-09T10:50:00Z',
      }),
    ).toBe(2400);
  });
  it('never goes negative and ignores a pause stamped before the start', () => {
    expect(
      billableSeconds({
        startedAt: '2026-10-09T10:00:00Z',
        endedAt: '2026-10-09T10:00:30Z',
        totalPausedSeconds: 60,
      }),
    ).toBe(0);
    expect(
      billableSeconds({
        startedAt: '2026-10-09T10:00:00Z',
        endedAt: '2026-10-09T10:10:00Z',
        totalPausedSeconds: 0,
        pausedAt: '2026-10-09T09:00:00Z',
      }),
    ).toBe(0);
  });
});

describe('chargeableMinutes / priceForSeconds', () => {
  it('charges per started minute by default', () => {
    expect(chargeableMinutes(0, perMinute)).toBe(0);
    expect(chargeableMinutes(1, perMinute)).toBe(1);
    expect(chargeableMinutes(60, perMinute)).toBe(1);
    expect(chargeableMinutes(61, perMinute)).toBe(2);
    expect(priceForSeconds(3600, perMinute)).toBe(150);
    expect(priceForSeconds(1800, perMinute)).toBe(75);
    expect(priceForSeconds(60, perMinute)).toBe(3); // 150/60 = 2.5 → half up → 3
  });
  it('applies billing increments, minimum minutes and minimum charge', () => {
    const terms: PricingTerms = {
      ...perMinute,
      rateCentsPerHour: 200,
      billingIncrementMinutes: 15,
      minimumMinutes: 30,
      minimumChargeCents: 120,
    };
    expect(chargeableMinutes(5 * 60, terms)).toBe(30); // minimum 30 minutes
    expect(chargeableMinutes(31 * 60, terms)).toBe(45); // next 15-minute block
    expect(priceForSeconds(31 * 60, terms)).toBe(150); // 45 min × 2.00 €/h
    expect(priceForSeconds(60, terms)).toBe(120); // 30 min = 1.00 € but minimum charge 1.20 €
  });
  it('rounds the final amount to the configured increment', () => {
    const terms: PricingTerms = { ...perMinute, rateCentsPerHour: 170, roundingIncrementCents: 10 };
    // 23 minutes × 1.70 €/h = 65.166… → 65 cents → up to the next 10 cents
    expect(priceForSeconds(23 * 60, { ...terms, roundingMode: 'up' })).toBe(70);
    expect(priceForSeconds(23 * 60, { ...terms, roundingMode: 'down' })).toBe(60);
    expect(priceForSeconds(23 * 60, { ...terms, roundingMode: 'nearest' })).toBe(70);
    expect(priceForSeconds(23 * 60, { ...terms, roundingIncrementCents: 50 })).toBe(100);
  });
  it('never uses floating point for the rate × minutes product', () => {
    // 0.1 + 0.2 style trap: 1 cent/hour × 3 minutes = 0.05 cents → 0; 7 cents/h × 51 min = 5.95 → 6
    expect(priceForSeconds(180, { ...perMinute, rateCentsPerHour: 1 })).toBe(0);
    expect(priceForSeconds(51 * 60, { ...perMinute, rateCentsPerHour: 7 })).toBe(6);
    expect(quotePrepaidMinutes(90, perMinute)).toBe(225);
  });
  it('rejects invalid inputs loudly', () => {
    expect(() => priceForSeconds(-1, perMinute)).toThrow(RangeError);
    expect(() => priceForSeconds(1.5, perMinute)).toThrow(RangeError);
    expect(() => priceForSeconds(60, { ...perMinute, rateCentsPerHour: 1.5 })).toThrow(RangeError);
  });
});

describe('pricing rule selection', () => {
  const base = { ...perMinute, isActive: true, validFrom: null, validTo: null, priority: 0 };
  const allDay: PricingRuleLike = {
    ...base,
    id: 'all-day',
    stationId: null,
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    startTime: null,
    endTime: null,
  };
  const happyHour: PricingRuleLike = {
    ...base,
    id: 'happy',
    stationId: null,
    rateCentsPerHour: 100,
    daysOfWeek: [1, 2, 3, 4, 5],
    startTime: '14:00',
    endTime: '17:00',
    priority: 10,
  };
  const nightOwl: PricingRuleLike = {
    ...base,
    id: 'night',
    stationId: null,
    rateCentsPerHour: 80,
    daysOfWeek: [5, 6], // Friday and Saturday nights
    startTime: '22:00',
    endTime: '02:00',
    priority: 5,
  };
  const vipStation: PricingRuleLike = {
    ...base,
    id: 'vip',
    stationId: 'st-vip',
    rateCentsPerHour: 300,
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    startTime: null,
    endTime: null,
  };
  const rules = [allDay, happyHour, nightOwl, vipStation];
  const tz = 'Europe/Belgrade';

  it('computes the local clock in the business time zone', () => {
    // 2026-10-09 is a Friday; 20:30 UTC = 22:30 CEST
    const clock = localClock('2026-10-09T20:30:00Z', tz);
    expect(clock).toEqual({ date: '2026-10-09', minutesOfDay: 22 * 60 + 30, isoWeekday: 5 });
  });
  it('prefers station-specific rules, then priority', () => {
    const friday15 = localClock('2026-10-09T13:00:00Z', tz); // 15:00 local, Friday
    expect(selectPricingRule(rules, 'st-1', friday15)?.id).toBe('happy');
    expect(selectPricingRule(rules, 'st-vip', friday15)?.id).toBe('vip');
    const sunday15 = localClock('2026-10-11T13:00:00Z', tz);
    expect(selectPricingRule(rules, 'st-1', sunday15)?.id).toBe('all-day');
  });
  it('handles windows that cross midnight on the correct weekday', () => {
    expect(ruleAppliesAt(nightOwl, localClock('2026-10-09T21:00:00Z', tz))).toBe(true); // Fri 23:00
    expect(ruleAppliesAt(nightOwl, localClock('2026-10-09T23:30:00Z', tz))).toBe(true); // Sat 01:30 (Friday night)
    expect(ruleAppliesAt(nightOwl, localClock('2026-10-11T23:30:00Z', tz))).toBe(false); // Mon 01:30 (Sunday night)
    expect(ruleAppliesAt(nightOwl, localClock('2026-10-10T12:00:00Z', tz))).toBe(false); // Sat 14:00
  });
  it('respects validity dates and inactive rules', () => {
    const limited = { ...happyHour, validFrom: '2026-11-01', validTo: null };
    expect(ruleAppliesAt(limited, localClock('2026-10-09T13:00:00Z', tz))).toBe(false);
    expect(
      ruleAppliesAt({ ...happyHour, isActive: false }, localClock('2026-10-09T13:00:00Z', tz)),
    ).toBe(false);
    expect(selectPricingRule([], 'st-1', localClock(Date.now(), tz))).toBeNull();
  });
});
