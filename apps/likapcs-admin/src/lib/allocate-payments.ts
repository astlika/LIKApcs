import type { SalePaymentInput } from '@likapcs/shared';

/**
 * Splits the tenders of one payment step across several bills — a bulk PC start: one amount is
 * handed over for N sessions while every PC is billed by its own pricing rule.
 *
 * Non-cash tenders (balance, pay later, card) are used up first, in the order given, then cash,
 * so every bill receives exactly its own amount and the only change is the cashier's (cash handed
 * over minus cash used) — never a per-session one. Due dates / references travel with each piece.
 * Throws when the tenders do not cover the bills (the tender panel prevents that; this is the
 * last line of defence before money moves).
 */
export function allocatePayments(
  payments: readonly SalePaymentInput[],
  bills: readonly number[],
): SalePaymentInput[][] {
  const pools = [
    ...payments.filter((p) => p.method !== 'cash'),
    ...payments.filter((p) => p.method === 'cash'),
  ].map((p) => ({ template: p, left: p.amountCents }));
  return bills.map((bill) => {
    if (!Number.isInteger(bill) || bill < 0) throw new Error(`Invalid bill amount ${bill}`);
    const pieces: SalePaymentInput[] = [];
    let due = bill;
    for (const pool of pools) {
      if (due === 0) break;
      const take = Math.min(due, pool.left);
      if (take <= 0) continue;
      pieces.push({ ...pool.template, amountCents: take });
      pool.left -= take;
      due -= take;
    }
    if (due > 0) throw new Error('Tenders do not cover the bills');
    return pieces;
  });
}
