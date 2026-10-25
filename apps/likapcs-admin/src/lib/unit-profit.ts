/**
 * Profit on one piece, shown live in the product form. Same tax maths as a sale: when the shelf
 * price already includes VAT, the VAT is taken out of it; when it does not, the price is the net
 * amount and VAT is added at the till. Profit = net price − cost (VAT is never profit).
 */
import { percentOf, splitInclusiveTax, type BasisPoints, type Cents } from '@likapcs/shared';

export interface UnitProfit {
  priceCents: Cents;
  costCents: Cents;
  rateBp: BasisPoints;
  /** What the shop keeps before cost, without VAT. */
  netCents: Cents;
  /** VAT inside the price (inclusive) or added on top at the till (exclusive). */
  vatCents: Cents;
  profitCents: Cents;
  /** Profit as basis points of the net price; null when there is no net price. */
  marginBp: number | null;
}

export function unitProfit(input: {
  priceCents: Cents;
  costCents: Cents;
  rateBp: BasisPoints;
  priceIncludesTax: boolean;
}): UnitProfit {
  const { priceCents, costCents, rateBp, priceIncludesTax } = input;
  const netCents = priceIncludesTax ? splitInclusiveTax(priceCents, rateBp).net : priceCents;
  const vatCents = priceIncludesTax ? priceCents - netCents : percentOf(priceCents, rateBp);
  const profitCents = netCents - costCents;
  return {
    priceCents,
    costCents,
    rateBp,
    netCents,
    vatCents,
    profitCents,
    marginBp: netCents > 0 ? Math.round((profitCents * 10_000) / netCents) : null,
  };
}
