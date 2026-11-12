import { describe, expect, it } from 'vitest';
import type { TimeCreditSummary } from '@likapcs/shared';
import { assignCredits } from './time-credit-assign';

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
