/**
 * Installment plans for pay-later debts (0.19.8). A debt with N installments gets N parts: the
 * amount is split in cents (the first parts take the extra cents, so 10.00 in 3 parts is
 * 3.34 + 3.33 + 3.33), and the parts fall due on the same day of each following month.
 */

/** Splits `totalCents` into `count` parts; the first `remainder` parts get one extra cent. */
export function splitInstallments(totalCents: number, count: number): number[] {
  if (!Number.isInteger(totalCents) || totalCents <= 0)
    throw new RangeError('Installments need a positive whole-cent amount');
  if (!Number.isInteger(count) || count < 1) throw new RangeError('Installments need a count ≥ 1');
  const base = Math.floor(totalCents / count);
  const extra = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Due date (`YYYY-MM-DD`) of part `index` (0 = the first part): the first date, then the same
 * day of each following month. A day that does not exist in a month (31 Jan → Feb) falls on the
 * last day of that month.
 */
export function installmentDueDate(firstIso: string, index: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(firstIso);
  if (!m) throw new RangeError(`Not a YYYY-MM-DD date: ${firstIso}`);
  const year = Number(m[1]);
  const month0 = Number(m[2]) - 1;
  const day = Number(m[3]);
  const total = month0 + index;
  const y = year + Math.floor(total / 12);
  const mo = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const d = Math.min(day, lastDay);
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
