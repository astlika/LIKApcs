import type { SessionSummary } from '@likapcs/shared';

/** What a waiting bill costs right now: the final or running price, plus open order lines. */
export function awaitingAmountCents(s: SessionSummary): number {
  return (s.finalPriceCents ?? s.currentPriceCents) + s.openOrdersCents;
}

/**
 * The bills waiting at one PC (pay all takes them in one step). `stationId` is null for the
 * whole-strip group: every waiting bill at every PC (0.19.5).
 */
export interface PcBills {
  stationId: string | null;
  code: string;
  bills: SessionSummary[];
}

/** Every PC with at least one bill waiting, in the order the strip shows them. */
export function pcGroups(items: SessionSummary[]): PcBills[] {
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
  return [...byPc.values()];
}

/** PCs with two or more bills waiting, in the order the strip shows them. */
export function multiBillPcs(items: SessionSummary[]): PcBills[] {
  return pcGroups(items).filter((g) => g.bills.length >= 2);
}

/** Every waiting bill at every PC, for the one-step "collect all" (0.19.5). */
export function allPcsBills(items: SessionSummary[]): PcBills {
  return {
    stationId: null,
    code: '',
    bills: items.filter((s) => s.stationId),
  };
}

/** The amount the pay-all tender must cover: every bill's current amount. */
export function payAllTotalCents(bills: SessionSummary[]): number {
  return bills.reduce((sum, s) => sum + awaitingAmountCents(s), 0);
}
