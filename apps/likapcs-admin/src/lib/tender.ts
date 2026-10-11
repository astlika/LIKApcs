/**
 * Cash tender suggestions for the payment dialogs.
 *
 * Cashiers rarely type the amount handed over: they tap the note or coin they were given. The
 * old POS offered a fixed 5 / 10 / 20 / 50 row, which is useless for a 0.20 € chewing gum paid
 * with a 50 cent coin or a 2.50 € bill paid with a 5 € note. `suggestTenders` derives the
 * plausible hand-overs from the total instead: every euro denomination from 50 cent to 50 € the
 * customer could hand over on its own, plus the "round" amounts a customer assembles from a few
 * pieces (2.50 → 3, 4, 5; 7.30 → 7.50, 8, 10). Amounts are integer cents — never floats.
 */

/** Euro denominations customers hand over, 50 cent to 50 € (cents). */
export const EURO_TENDER_STEPS = [50, 100, 200, 500, 1000, 2000, 5000] as const;

/**
 * Plausible tendered amounts strictly above `totalCents`, ascending, at most `max` of them. The
 * exact amount is not included — the dialog shows it as its own "Exact" chip.
 *
 * For every step the total is rounded up to the next multiple of that step; a result equal to
 * the total (already a multiple) is dropped. So 1.00 € yields 2, 5, 10, 20, 50 (never 1.50),
 * 0.20 € yields 0.50, 1, 2, 5, 10, 20, and 2.50 € yields 3, 4, 5, 10, 20, 50. Above 50 € the
 * next multiple of 50 € keeps a 100 € note reachable (60 → 100).
 */
export function suggestTenders(totalCents: number, max = 6): number[] {
  if (!Number.isFinite(totalCents) || totalCents <= 0) return [];
  const total = Math.round(totalCents);
  const out = new Set<number>();
  for (const step of EURO_TENDER_STEPS) {
    const rounded = Math.ceil(total / step) * step;
    if (rounded > total) out.add(rounded);
  }
  return [...out].sort((a, b) => a - b).slice(0, max);
}
