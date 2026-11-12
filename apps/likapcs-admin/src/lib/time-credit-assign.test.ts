import { describe, expect, it } from 'vitest';
import type { TimeCreditSummary } from '@likapcs/shared';
import { assignCredits, planEach, planSplit } from './time-credit-assign';

const credit = (
  id: string,
  stationId: string | null,
  minutesRemaining = 60,
): TimeCreditSummary => ({
  id,
  stationId,
  stationCode: stationId,
  holderName: stationId ? null : `Holder ${id}`,
  minutesTotal: 60,
  minutesRemaining,
  saleId: `sale-${id}`,
  createdAt: '2026-10-19T10:00:00.000Z',
});

const pcs = [{ id: 'pc1' }, { id: 'pc2' }, { id: 'pc3' }];

describe('assignCredits', () => {
  it('gives each PC the credit that was sold for it', () => {
    const out = assignCredits(pcs, [credit('a', 'pc2'), credit('b', 'pc1')]);
    expect(out.map((x) => x.credit?.id ?? null)).toEqual(['b', 'a', null]);
  });

  it('fills the PCs without their own credit with the oldest any-PC credits', () => {
    const out = assignCredits(pcs, [credit('x', null), credit('y', null), credit('z', 'pc1')]);
    expect(out.map((x) => x.credit?.id ?? null)).toEqual(['z', 'x', 'y']);
  });

  it('never gives a PC-bound credit to another PC', () => {
    const out = assignCredits(pcs, [credit('a', 'pc3')]);
    expect(out.map((x) => x.credit?.id ?? null)).toEqual([null, null, 'a']);
  });

  it('uses each credit at most once', () => {
    const out = assignCredits(pcs, [credit('only', null)]);
    expect(out.filter((x) => x.credit).length).toBe(1);
    expect(out[0]!.credit?.id).toBe('only');
  });

  it('ignores credits with no minutes left', () => {
    const out = assignCredits(pcs, [credit('empty', 'pc1', 0), credit('ok', null)]);
    expect(out[0]!.credit?.id).toBe('ok');
  });

  it('returns every target, in order, even with no credits', () => {
    const out = assignCredits(pcs, []);
    expect(out.map((x) => x.target.id)).toEqual(['pc1', 'pc2', 'pc3']);
    expect(out.every((x) => x.credit === null)).toBe(true);
  });
});

describe('planEach and planSplit (0.33.4)', () => {
  it('planEach uses each credit whole, one per PC, and leaves the rest without minutes', () => {
    const rows = planEach(pcs, [credit('x', null, 60), credit('y', null, 90)]);
    expect(rows.map((r) => [r.target.id, r.credit?.id ?? null, r.minutes])).toEqual([
      ['pc1', 'x', 60],
      ['pc2', 'y', 90],
      ['pc3', null, 0],
    ]);
  });

  it('planSplit shares one payment equally over the whole group', () => {
    const five = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
    const plan = planSplit(five, [credit('group', null, 300)])!;
    expect(plan.minutesEach).toBe(60);
    expect(plan.leftoverMinutes).toBe(0);
    expect(plan.rows.map((r) => [r.target.id, r.credit?.id, r.minutes])).toEqual([
      ['a', 'group', 60],
      ['b', 'group', 60],
      ['c', 'group', 60],
      ['d', 'group', 60],
      ['e', 'group', 60],
    ]);
  });

  it('planSplit gives every PC the same minutes from several credits and keeps the remainder', () => {
    // 100 + 50 for three PCs: 50 each (two from the first credit, one from the second).
    const plan = planSplit(pcs, [credit('x', null, 100), credit('y', null, 50)])!;
    expect(plan.minutesEach).toBe(50);
    expect(plan.rows.map((r) => r.credit?.id)).toEqual(['x', 'x', 'y']);
    expect(plan.leftoverMinutes).toBe(0);
    // 100 for three PCs: 33 each, one minute stays on the credit.
    const odd = planSplit(pcs, [credit('x', null, 100)])!;
    expect(odd.minutesEach).toBe(33);
    expect(odd.leftoverMinutes).toBe(1);
  });

  it('planSplit ignores credits sold for one PC and answers null when nothing can be shared', () => {
    expect(planSplit(pcs, [credit('z', 'pc1', 600)])).toBeNull();
    expect(planSplit(pcs, [credit('x', null, 2)])).toBeNull();
    expect(planSplit([], [credit('x', null, 60)])).toBeNull();
  });
});
