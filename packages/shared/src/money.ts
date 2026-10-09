/**
 * Money utilities.
 *
 * RULES (see docs/architecture.md → "Money"):
 *  - All authoritative amounts are integers in MINOR units (cents for EUR).
 *  - Quantities are integers in MILLI units (1 piece = 1000, 0.5 kg = 500).
 *  - Percentages (tax, discounts) are integers in BASIS POINTS (18 % = 1800).
 *  - Rounding is always explicit and "half away from zero" (commercial rounding).
 *  - Binary floating point is NEVER used for authoritative totals.
 */

export type Cents = number;
export type QuantityMilli = number;
export type BasisPoints = number;

export const QUANTITY_SCALE = 1000;
export const BASIS_POINTS_SCALE = 10_000;

/** Largest magnitude we accept for a single monetary value (safe-integer guard). */
const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

export function assertCents(value: unknown, label = 'amount'): asserts value is Cents {
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > MAX_SAFE_CENTS) {
    throw new TypeError(
      `${label} must be an integer number of minor units, received ${String(value)}`,
    );
  }
}

export function assertQuantity(value: unknown, label = 'quantity'): asserts value is QuantityMilli {
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > MAX_SAFE_CENTS) {
    throw new TypeError(
      `${label} must be an integer number of milli-units, received ${String(value)}`,
    );
  }
}

/** Half-away-from-zero integer division: round(numerator / denominator). */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;
  const quotient = absNum / absDen;
  const remainder = absNum % absDen;
  const rounded = remainder * 2n >= absDen ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function toNumberChecked(value: bigint, label: string): number {
  if (value > BigInt(MAX_SAFE_CENTS) || value < -BigInt(MAX_SAFE_CENTS)) {
    throw new RangeError(`${label} overflows the safe integer range`);
  }
  return Number(value);
}

/** unitPrice (cents) × quantity (milli) → line total in cents, rounded half away from zero. */
export function multiplyByQuantity(unitCents: Cents, quantityMilli: QuantityMilli): Cents {
  assertCents(unitCents, 'unitCents');
  assertQuantity(quantityMilli, 'quantityMilli');
  return toNumberChecked(
    divRound(BigInt(unitCents) * BigInt(quantityMilli), BigInt(QUANTITY_SCALE)),
    'line total',
  );
}

/** amount × basisPoints / 10 000, rounded. Example: percentOf(1000, 1800) = 180. */
export function percentOf(amountCents: Cents, basisPoints: BasisPoints): Cents {
  assertCents(amountCents, 'amountCents');
  if (!Number.isInteger(basisPoints)) throw new TypeError('basisPoints must be an integer');
  return toNumberChecked(
    divRound(BigInt(amountCents) * BigInt(basisPoints), BigInt(BASIS_POINTS_SCALE)),
    'percentage',
  );
}

/**
 * Split a tax-INCLUSIVE gross amount into net + tax.
 * net = gross × 10000 / (10000 + rate), tax = gross − net.  The pair always sums to gross exactly.
 */
export function splitInclusiveTax(
  grossCents: Cents,
  rateBp: BasisPoints,
): { net: Cents; tax: Cents } {
  assertCents(grossCents, 'grossCents');
  const net = toNumberChecked(
    divRound(BigInt(grossCents) * BigInt(BASIS_POINTS_SCALE), BigInt(BASIS_POINTS_SCALE + rateBp)),
    'net',
  );
  return { net, tax: grossCents - net };
}

/** Add tax to a tax-EXCLUSIVE net amount. */
export function addExclusiveTax(
  netCents: Cents,
  rateBp: BasisPoints,
): { gross: Cents; tax: Cents } {
  const tax = percentOf(netCents, rateBp);
  return { gross: netCents + tax, tax };
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0n;
  for (const v of values) {
    assertCents(v);
    total += BigInt(v);
  }
  return toNumberChecked(total, 'sum');
}

/**
 * Round an amount to a monetary increment, e.g. roundToIncrement(1234, 50, 'up') = 1250.
 * Used by session billing (minimum charge / rounding rules) and cash rounding.
 */
export function roundToIncrement(
  amountCents: Cents,
  incrementCents: Cents,
  mode: 'up' | 'down' | 'nearest' = 'nearest',
): Cents {
  assertCents(amountCents, 'amountCents');
  if (!Number.isInteger(incrementCents) || incrementCents <= 0) {
    throw new RangeError('incrementCents must be a positive integer');
  }
  const amount = BigInt(amountCents);
  const inc = BigInt(incrementCents);
  const sign = amount < 0n ? -1n : 1n;
  const abs = amount < 0n ? -amount : amount;
  const remainder = abs % inc;
  let result: bigint;
  if (remainder === 0n) result = abs;
  else if (mode === 'down') result = abs - remainder;
  else if (mode === 'up') result = abs - remainder + inc;
  else result = remainder * 2n >= inc ? abs - remainder + inc : abs - remainder;
  return toNumberChecked(sign * result, 'rounded amount');
}

/**
 * Parse a user-typed decimal amount ("12,50", "12.5", "1 234,00") into cents without floats.
 * Returns null for invalid input. Accepts at most 2 fraction digits.
 */
export function parseMoneyInput(input: string): Cents | null {
  const cleaned = input.replace(/\s|€|EUR/gi, '').trim();
  if (!cleaned) return null;
  const match = /^(-)?(\d+)(?:[.,](\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const sign = match[1] ? -1 : 1;
  const whole = match[2] ?? '0';
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  return toNumberChecked(cents, 'parsed amount') * sign;
}

/** Parse a decimal quantity ("1", "0.5", "2,250") into milli-units (max 3 fraction digits). */
export function parseQuantityInput(input: string): QuantityMilli | null {
  const cleaned = input.replace(/\s/g, '').trim();
  const match = /^(-)?(\d+)(?:[.,](\d{1,3}))?$/.exec(cleaned);
  if (!match) return null;
  const sign = match[1] ? -1 : 1;
  const whole = match[2] ?? '0';
  const fraction = (match[3] ?? '').padEnd(3, '0');
  return toNumberChecked(BigInt(whole) * 1000n + BigInt(fraction), 'parsed quantity') * sign;
}

export interface MoneyFormatOptions {
  currency?: string; // ISO 4217
  locale?: 'en' | 'sq';
  showSymbol?: boolean;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  CHF: 'CHF',
  ALL: 'L',
};

/**
 * Format cents as a currency string. Deterministic (does not depend on Intl availability),
 * so receipts render identically on every machine.
 *   en: 1.234,50 → "€1,234.50"       sq: "1.234,50 €"
 */
export function formatMoney(cents: Cents, options: MoneyFormatOptions = {}): string {
  assertCents(cents, 'cents');
  const { currency = 'EUR', locale = 'en', showSymbol = true } = options;
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  const groupSep = locale === 'sq' ? '.' : ',';
  const decimalSep = locale === 'sq' ? ',' : '.';
  const wholeGrouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
  const number = `${wholeGrouped}${decimalSep}${fraction}`;
  if (!showSymbol) return `${negative ? '-' : ''}${number}`;
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const formatted =
    locale === 'sq' || symbol.length > 1 ? `${number} ${symbol}` : `${symbol}${number}`;
  return negative ? `-${formatted}` : formatted;
}

/** Format milli-quantity: 1000 → "1", 1500 → "1.5" (en) / "1,5" (sq). */
export function formatQuantity(quantityMilli: QuantityMilli, locale: 'en' | 'sq' = 'en'): string {
  assertQuantity(quantityMilli, 'quantityMilli');
  const negative = quantityMilli < 0;
  const abs = Math.abs(quantityMilli);
  const whole = Math.floor(abs / QUANTITY_SCALE);
  const fraction = String(abs % QUANTITY_SCALE)
    .padStart(3, '0')
    .replace(/0+$/, '');
  const decimalSep = locale === 'sq' ? ',' : '.';
  return `${negative ? '-' : ''}${whole}${fraction ? decimalSep + fraction : ''}`;
}
