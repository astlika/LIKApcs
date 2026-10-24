import type { SessionSummary } from '@likapcs/shared';
import { describe, expect, it } from 'vitest';
import {
  allPcsBills,
  awaitingAmountCents,
  multiBillPcs,
  pcGroups,
  payAllTotalCents,
} from './pay-all';

function bill(
  id: string,
  stationId: string | null,
  code: string,
  over: Partial<SessionSummary> = {},
) {
  return {
    id,
    stationId,
    stationCode: code,
    finalPriceCents: null,
    currentPriceCents: 1000,
    openOrdersCents: 0,
    ...over,
  } as SessionSummary;
}

describe('awaitingAmountCents', () => {
  it('uses the final price when it is set, else the running price, plus open order lines', () => {
    expect(awaitingAmountCents(bill('a', 's1', 'PC 1'))).toBe(1000);
    expect(awaitingAmountCents(bill('a', 's1', 'PC 1', { finalPriceCents: 800 }))).toBe(800);
    expect(awaitingAmountCents(bill('a', 's1', 'PC 1', { openOrdersCents: 250 }))).toBe(1250);
    expect(
      awaitingAmountCents(bill('a', 's1', 'PC 1', { finalPriceCents: 800, openOrdersCents: 50 })),
    ).toBe(850);
  });
});

describe('multiBillPcs', () => {
  it('groups by PC and keeps only PCs with two or more bills', () => {
    const groups = multiBillPcs([
      bill('a', 's1', 'PC 1'),
      bill('b', 's2', 'PC 2'),
      bill('c', 's1', 'PC 1'),
      bill('d', null, 'PC ?'),
    ]);
    expect(groups.map((g) => g.code)).toEqual(['PC 1']);
    expect(groups[0]?.bills.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('returns nothing when every PC has a single bill', () => {
    expect(multiBillPcs([bill('a', 's1', 'PC 1'), bill('b', 's2', 'PC 2')])).toEqual([]);
  });
});

describe('pcGroups and allPcsBills (0.19.5: collect all PCs)', () => {
  it('groups every PC with a bill, single-bill PCs included, in strip order', () => {
    const groups = pcGroups([
      bill('a', 's1', 'PC 1'),
      bill('b', 's2', 'PC 2'),
      bill('c', 's1', 'PC 1'),
      bill('d', null, 'PC ?'),
    ]);
    expect(groups.map((g) => [g.code, g.bills.length])).toEqual([
      ['PC 1', 2],
      ['PC 2', 1],
    ]);
  });

  it('the all-PCs group holds every bill that has a PC and no station id', () => {
    const all = allPcsBills([
      bill('a', 's1', 'PC 1'),
      bill('b', 's2', 'PC 2'),
      bill('d', null, 'PC ?'),
    ]);
    expect(all.stationId).toBeNull();
    expect(all.bills.map((s) => s.id)).toEqual(['a', 'b']);
    expect(payAllTotalCents(all.bills)).toBe(2000);
  });
});

describe('payAllTotalCents', () => {
  it('sums every bill at its current amount, including open orders', () => {
    const total = payAllTotalCents([
      bill('a', 's1', 'PC 1', { finalPriceCents: 800, openOrdersCents: 200 }),
      bill('b', 's1', 'PC 1', { currentPriceCents: 500 }),
    ]);
    expect(total).toBe(1500);
  });

  it('is zero for no bills', () => {
    expect(payAllTotalCents([])).toBe(0);
  });
});
