import type { SessionSummary } from '@likapcs/shared';

/** What a waiting bill costs right now: the final or running price, plus open order lines. */
export function awaitingAmountCents(s: SessionSummary): number {
  return (s.finalPriceCents ?? s.currentPriceCents) + s.openOrdersCents;
}

/** The bills waiting at one PC (pay all takes them in one step). */
export interface PcBills {
  stationId: string;
  code: string;
  bills: SessionSummary[];
}

/** PCs with two or more bills waiting, in the order the strip shows them. */
export function multiBillPcs(items: SessionSummary[]): PcBills[] {
  const byPc = new Map<string, PcBills>();
  for (const s of items) {
    if (!s.stationId) continue;
    const group = byPc.get(s.stationId) ?? {
      stationId: s.stationId,
      code: s.stationCode,
      bills: [],
    };
    group.bills.push(s);
    byPc.set(s.stationId, group);
  }
  return [...byPc.values()].filter((g) => g.bills.length >= 2);
}

/** The amount the pay-all tender must cover: every bill's current amount. */
export function payAllTotalCents(bills: SessionSummary[]): number {
  return bills.reduce((sum, s) => sum + awaitingAmountCents(s), 0);
}
