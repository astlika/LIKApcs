import type { SalePaymentInput } from './dto.js';

/**
 * 0.18.1: splits the tenders of ONE payment step across several bills — a bulk PC start or a bulk
 * "+ minutes": one amount is handed over for N sessions while every PC is billed by its own
 * pricing rule. Each bill receives exactly its own amount; the only change is the cashier's
 * (cash handed over minus cash used), never a per-session one.
 *
 * Non-cash tenders are used up first, in the order given, then cash. Due dates / references
 * travel with each piece. Throws when the tenders do not cover the bills — the caller refuses
 * the whole step before any money or time moves.
 */
export function allocatePayments(
  payments: readonly SalePaymentInput[],
  bills: readonly number[],
): SalePaymentInput[][] {
  const pools = [
    ...payments.filter((p) => p.method !== 'cash'),
    ...payments.filter((p) => p.method === 'cash'),
  ].map((p) => ({ template: p, left: p.amountCents }));
  const total = bills.reduce((sum, b) => sum + b, 0);
  const tendered = payments.reduce((sum, p) => sum + p.amountCents, 0);
  if (tendered < total) throw new Error('Tenders do not cover the bills');
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
