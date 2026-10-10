/**
 * Sale arithmetic shared by the POS (preview) and the server (authoritative).
 *
 * All amounts are integer cents, quantities are integer milli-units. The server recomputes every
 * sale from database prices with exactly these functions; the Admin only previews.
 *
 * Model (matches the `sales` / `sale_items` tables):
 *   line gross       = unit price × quantity                 (gross = tax-inclusive, as displayed)
 *   line total       = line gross − line discount             → sale_items.line_total_cents
 *   subtotal         = Σ line totals                          → sales.subtotal_cents
 *   sale discount    = discount on the whole sale             → sales.discount_cents
 *   total            = subtotal − sale discount               → sales.total_cents
 *   tax              = Σ tax contained in each line's share of the total (sale discount is
 *                      allocated to the lines proportionally, largest remainder) → sales.tax_cents
 */
import {
  addExclusiveTax,
  multiplyByQuantity,
  percentOf,
  splitInclusiveTax,
  type BasisPoints,
  type Cents,
} from './money.js';

export interface SaleLineInput {
  /** Unit price as stored on the product. */
  unitPriceCents: Cents;
  quantityMilli: number;
  /** Whole-line discount in cents (0 when absent). */
  discountCents?: Cents;
  taxRateBp: number;
  /** false → the unit price is net and tax is added on top (line gross includes it). */
  priceIncludesTax?: boolean;
}

export interface SaleLineComputed {
  /** Gross unit price actually charged (tax included), after adding tax to net prices. */
  unitPriceCents: Cents;
  quantityMilli: number;
  grossCents: Cents;
  discountCents: Cents;
  lineTotalCents: Cents;
  /** Share of the sale-level discount attributed to this line (for tax only). */
  allocatedSaleDiscountCents: Cents;
  taxRateBp: number;
  taxCents: Cents;
  netCents: Cents;
}

export interface SaleTotals {
  lines: SaleLineComputed[];
  subtotalCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
}

export class SaleMathError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_quantity' | 'invalid_discount' | 'invalid_price',
  ) {
    super(message);
    this.name = 'SaleMathError';
  }
}

/** Splits `amount` over `weights` proportionally with integer cents (largest remainder method). */
export function allocateProportionally(amount: Cents, weights: readonly Cents[]): Cents[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (amount === 0 || weights.length === 0) return weights.map(() => 0);
  if (totalWeight <= 0) {
    // Nothing to weigh by: give everything to the first line.
    return weights.map((_, i) => (i === 0 ? amount : 0));
  }
  const raw = weights.map((w) => (amount * w) / totalWeight);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = amount - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i]! += 1;
    remainder -= 1;
  }
  return floors;
}

export function computeSale(
  lines: readonly SaleLineInput[],
  saleDiscountCents: Cents = 0,
): SaleTotals {
  if (!Number.isInteger(saleDiscountCents) || saleDiscountCents < 0) {
    throw new SaleMathError('Sale discount must be a non-negative integer', 'invalid_discount');
  }
  const partial = lines.map((line) => {
    if (!Number.isInteger(line.quantityMilli) || line.quantityMilli <= 0) {
      throw new SaleMathError(
        'Quantity must be a positive integer (milli units)',
        'invalid_quantity',
      );
    }
    if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
      throw new SaleMathError('Unit price must be a non-negative integer', 'invalid_price');
    }
    const includesTax = line.priceIncludesTax ?? true;
    const unitGross = includesTax
      ? line.unitPriceCents
      : addExclusiveTax(line.unitPriceCents, line.taxRateBp).gross;
    const grossCents = multiplyByQuantity(unitGross, line.quantityMilli);
    const discountCents = line.discountCents ?? 0;
    if (!Number.isInteger(discountCents) || discountCents < 0 || discountCents > grossCents) {
      throw new SaleMathError(
        'Line discount must be between 0 and the line amount',
        'invalid_discount',
      );
    }
    return {
      unitPriceCents: unitGross,
      quantityMilli: line.quantityMilli,
      grossCents,
      discountCents,
      lineTotalCents: grossCents - discountCents,
      taxRateBp: line.taxRateBp,
    };
  });
  const subtotalCents = partial.reduce((a, l) => a + l.lineTotalCents, 0);
  if (saleDiscountCents > subtotalCents) {
    throw new SaleMathError('Sale discount exceeds the subtotal', 'invalid_discount');
  }
  const allocation = allocateProportionally(
    saleDiscountCents,
    partial.map((l) => l.lineTotalCents),
  );
  const computed: SaleLineComputed[] = partial.map((l, i) => {
    const charged = l.lineTotalCents - allocation[i]!;
    const { net, tax } = splitInclusiveTax(charged, l.taxRateBp);
    return { ...l, allocatedSaleDiscountCents: allocation[i]!, taxCents: tax, netCents: net };
  });
  return {
    lines: computed,
    subtotalCents,
    discountCents: saleDiscountCents,
    taxCents: computed.reduce((a, l) => a + l.taxCents, 0),
    totalCents: subtotalCents - saleDiscountCents,
  };
}

export interface PaymentInput {
  method: 'cash' | 'card' | 'bank_transfer' | 'wallet' | 'credit' | 'other';
  amountCents: Cents;
}

/**
 * Validates tendered payments against the total. Only cash can be over-tendered (change is given
 * back in cash); every other method must be covered exactly by the remaining balance.
 */
export function settlePayments(
  totalCents: Cents,
  payments: readonly PaymentInput[],
): { paidCents: Cents; changeCents: Cents } {
  let nonCash = 0;
  let cash = 0;
  for (const p of payments) {
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) {
      throw new SaleMathError('Payment amounts must be positive integers', 'invalid_price');
    }
    if (p.method === 'cash') cash += p.amountCents;
    else nonCash += p.amountCents;
  }
  if (nonCash > totalCents) {
    throw new SaleMathError('Non-cash payments exceed the total', 'invalid_price');
  }
  const paidCents = cash + nonCash;
  if (paidCents < totalCents) {
    throw new SaleMathError('Payments do not cover the total', 'invalid_price');
  }
  return { paidCents, changeCents: paidCents - totalCents };
}

/**
 * Refund amount for part of a line: the line's charged amount (after all discounts) in proportion
 * to the quantity returned, never exceeding what is still refundable.
 */
export function refundAmountForQuantity(
  line: { lineTotalCents: Cents; allocatedSaleDiscountCents: Cents; quantityMilli: number },
  refundedSoFarCents: Cents,
  quantityMilli: number,
): Cents {
  const charged = line.lineTotalCents - line.allocatedSaleDiscountCents;
  const raw = Math.round((charged * quantityMilli) / line.quantityMilli);
  return Math.min(raw, charged - refundedSoFarCents);
}

/**
 * Sale-level discount owed to a customer with a default discount (`customers.discount_bp`).
 * Applied by the server only when the cashier did not enter an explicit sale discount — the
 * larger of the two is never combined, so a 10 % member cannot stack a manual €1 on top.
 * The Admin uses the same function for its live preview.
 */
export function customerDiscountCents(
  subtotalCents: Cents,
  discountBp: BasisPoints,
  explicitSaleDiscountCents: Cents = 0,
): Cents {
  if (explicitSaleDiscountCents > 0 || discountBp <= 0 || subtotalCents <= 0) return 0;
  return Math.min(subtotalCents, percentOf(subtotalCents, discountBp));
}
