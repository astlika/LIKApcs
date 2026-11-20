/**
 * 0.36.0 — offers: products and PC minutes sold together at one price ("Coca-Cola + 60 min").
 *
 * An offer is a recipe, not a product: selling it puts each of its products and its PC time on
 * the sale as ordinary lines, so stock, cost, tax, the time credit, refunds and every report work
 * as they always did. Only the prices of those lines differ — together they cost the offer's
 * price, shared among them by what each costs outside the offer (`shareOfferPrice`).
 *
 * 0.36.1: what an offer earns (`offerProfit`: its price without VAT, less what its products cost
 * to buy), how many of it the stock covers (`offerStockUnits`), and what it has sold so far.
 *
 * Pure helpers and the request shapes; the server keeps the offers (`OffersService`).
 */
import { z } from 'zod';
import { multiplyByQuantity, splitInclusiveTax } from './money.js';
import { allocateProportionally } from './sale-math.js';
import type { SaleItemSummary } from './dto.js';

/** Products one offer can hold. */
export const OFFER_MAX_PRODUCTS = 10;

/** `POST /offers`, `PUT /offers/:id`: the whole offer (its products replace the old ones). */
export const offerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** What the customer pays for all of it, tax included. */
    priceCents: z.number().int().min(0).max(100_000_000),
    /** PC minutes in the offer; 0 = products only. */
    minutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .default(0),
    items: z
      .array(
        z.object({
          productId: z.string().uuid(),
          quantityMilli: z.number().int().min(1).max(1_000_000),
        }),
      )
      .max(OFFER_MAX_PRODUCTS)
      .default([]),
    isActive: z.boolean().default(true),
  })
  .refine((o) => o.minutes > 0 || o.items.length > 0, {
    message: 'An offer needs at least one product or PC minutes',
    path: ['items'],
  })
  .refine((o) => new Set(o.items.map((i) => i.productId)).size === o.items.length, {
    message: 'A product can be in an offer only once',
    path: ['items'],
  });
export type OfferInput = z.infer<typeof offerInputSchema>;

/** `PATCH /offers/:id`: on or off the till. */
export const offerActiveSchema = z.object({ isActive: z.boolean() });

/**
 * `POST /offers/preview` (0.36.1): an offer as it stands in the form — what it would earn and what
 * its parts cost outside it. Nothing is saved; the price may still be missing.
 */
export const offerPreviewSchema = z.object({
  priceCents: z.number().int().min(0).max(100_000_000).default(0),
  minutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(0),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantityMilli: z.number().int().min(1).max(1_000_000),
      }),
    )
    .max(OFFER_MAX_PRODUCTS)
    .default([]),
});
export type OfferPreviewInput = z.infer<typeof offerPreviewSchema>;

export interface OfferItemSummary {
  productId: string;
  name: string;
  quantityMilli: number;
  unitCode: string;
  /** What one unit costs outside the offer right now (a live promo or the regular price), tax included. */
  unitPriceCents: number;
  /** The product can be sold in this quantity now: active, and in stock when its stock may not go below zero. */
  available: boolean;
  imageUrl: string | null;
  /** 0.36.1: what is on the shelf now; null when the product does not count its stock. */
  stockMilli: number | null;
  /** 0.36.1: the stock is counted and may not go below zero — the till never sells past it. */
  stockLimited: boolean;
  /** 0.36.1: the product's VAT rate (its tax category, or the business default). */
  taxRateBp: number;
  /**
   * 0.36.1: what one unit costs to buy, in mills — the average purchase cost, else the purchase
   * cost of the product (what a sale books as its cost). 0 when none is recorded.
   */
  unitCostMills: number;
}

/** 0.36.1: what ONE sale of an offer earns. VAT is never profit (as in the product form). */
export interface OfferProfit {
  /** The offer's price without the VAT inside it. */
  netCents: number;
  /** The VAT inside the price: each part of the offer at its own rate. */
  vatCents: number;
  /** What its products cost to buy. PC time has no purchase cost. */
  costCents: number;
  /** `netCents − costCents`. */
  profitCents: number;
  /** Products of the offer with no purchase cost recorded: the profit counts them as free. */
  missingCost: string[];
}

/** 0.36.1: what an offer has sold so far, refunds taken off. */
export interface OfferSold {
  /** How many times it was sold (an offer whose every line was refunded is not counted). */
  count: number;
  /** What the customers paid for it. */
  revenueCents: number;
  /** Revenue without VAT, less the cost of its products (the cost booked on each sale). */
  profitCents: number;
}

export interface OfferSummary {
  id: string;
  name: string;
  priceCents: number;
  minutes: number;
  isActive: boolean;
  items: OfferItemSummary[];
  /** What its products cost outside the offer (PC time is not counted: its price depends on the PC). */
  productsCents: number;
  /** Every product of it can be sold right now. */
  available: boolean;
  /**
   * 0.36.1: how many times the stock of its products covers it now (the product that runs out
   * first decides); null when none of its products counts its stock.
   */
  stockUnits: number | null;
  /** 0.36.1: what one sale of it earns; null for who may not see costs and reports. */
  profit: OfferProfit | null;
  /** 0.36.1: what it has sold so far; null for who may not see costs and reports. */
  sold: OfferSold | null;
  createdAt: string;
  updatedAt: string;
}

/** `POST /offers/preview`: the offer in the form, priced and costed, before it is saved. */
export interface OfferPreview {
  items: OfferItemSummary[];
  /** What its products cost outside the offer, tax included. */
  productsCents: number;
  /** What its PC minutes cost outside the offer right now (0 without minutes or without a price rule). */
  timeCents: number;
  stockUnits: number | null;
  profit: OfferProfit;
}

const wholeOrDecimal = (quantityMilli: number): string =>
  quantityMilli % 1000 === 0 ? String(quantityMilli / 1000) : (quantityMilli / 1000).toFixed(3);

/** "2× Coca-Cola + Tost + 60 min": the name an offer gets until one is typed. */
export function offerDefaultName(
  items: readonly { name: string; quantityMilli: number }[],
  minutes: number,
): string {
  const parts = items
    .filter((i) => i.name.trim().length > 0)
    .map((i) =>
      i.quantityMilli === 1000
        ? i.name.trim()
        : `${wholeOrDecimal(i.quantityMilli)}× ${i.name.trim()}`,
    );
  if (minutes > 0) parts.push(`${minutes} min`);
  return parts.join(' + ').slice(0, 80);
}

/**
 * Shares an offer's price among its lines by what each of them costs outside the offer (largest
 * remainder: the shares always add up to the price). Lines that cost nothing outside the offer
 * get nothing; when none of them costs anything the first line carries the whole price.
 */
export function shareOfferPrice(priceCents: number, normalCents: readonly number[]): number[] {
  return allocateProportionally(
    priceCents,
    normalCents.map((n) => Math.max(0, n)),
  );
}

/**
 * The unit price and the line discount that make a line of `quantityMilli` cost exactly
 * `shareCents`. One unit: the share itself. Several units whose share does not divide evenly:
 * the unit price is rounded up and the few cents too many come off as the line's discount.
 */
export function offerLinePrice(
  shareCents: number,
  quantityMilli: number,
): { unitPriceCents: number; discountCents: number } {
  const unitPriceCents = Math.ceil((shareCents * 1000) / quantityMilli);
  return {
    unitPriceCents,
    discountCents: multiplyByQuantity(unitPriceCents, quantityMilli) - shareCents,
  };
}

/** One part of an offer for `offerProfit`: a product line, or the PC time. */
export interface OfferProfitPart {
  /** What the part costs outside the offer, tax included (the weight of its share). */
  normalCents: number;
  taxRateBp: number;
  /** What it costs to buy (0 for PC time). */
  costCents: number;
}

/**
 * What one sale of an offer earns (0.36.1). The price is shared among the parts exactly as a sale
 * shares it (`shareOfferPrice`), the VAT is taken out of each share at the part's own rate, and
 * the cost of the products comes off what is left.
 */
export function offerProfit(
  priceCents: number,
  parts: readonly OfferProfitPart[],
): Omit<OfferProfit, 'missingCost'> {
  const shares = shareOfferPrice(
    priceCents,
    parts.map((p) => p.normalCents),
  );
  let netCents = parts.length === 0 ? priceCents : 0;
  let costCents = 0;
  for (const [i, part] of parts.entries()) {
    netCents += splitInclusiveTax(shares[i]!, part.taxRateBp).net;
    costCents += part.costCents;
  }
  return {
    netCents,
    vatCents: priceCents - netCents,
    costCents,
    profitCents: netCents - costCents,
  };
}

/**
 * How many times the stock covers an offer (0.36.1): the product that runs out first decides.
 * Null when none of its products counts its stock; never below zero.
 */
export function offerStockUnits(
  items: readonly Pick<OfferItemSummary, 'quantityMilli' | 'stockMilli'>[],
): number | null {
  let units: number | null = null;
  for (const item of items) {
    if (item.stockMilli === null || item.quantityMilli <= 0) continue;
    const covered = Math.max(0, Math.floor(item.stockMilli / item.quantityMilli));
    units = units === null ? covered : Math.min(units, covered);
  }
  return units;
}

/** One priced row of a receipt: a sale line, or the lines of one offer together. */
export interface ReceiptRow {
  key: string;
  description: string;
  /** The lines an offer was sold as ("Coca-Cola", "PC05 · 60 min"); empty for a plain line. */
  parts: string[];
  quantityMilli: number;
  unitPriceCents: number;
  discountCents: number;
  lineTotalCents: number;
}

/**
 * The rows a receipt shows: every sale line as it is, and the lines of one offer as ONE row with
 * the offer's name and price (what the customer bought), its content listed under it. The same
 * offer bought several times is one row with its count (0.36.1).
 */
export function receiptRows(items: readonly SaleItemSummary[]): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  const offers = new Map<number, ReceiptRow>();
  for (const item of items) {
    const offer = item.offer ?? null;
    if (!offer) {
      rows.push({
        key: `line:${item.id}`,
        description: item.description,
        parts: [],
        quantityMilli: item.quantityMilli,
        unitPriceCents: item.unitPriceCents,
        discountCents: item.discountCents,
        lineTotalCents: item.lineTotalCents,
      });
      continue;
    }
    const part =
      item.productId && item.quantityMilli !== 1000
        ? `${wholeOrDecimal(item.quantityMilli)}× ${item.description}`
        : item.description;
    const row = offers.get(offer.group);
    if (row) {
      row.parts.push(part);
      row.unitPriceCents += item.lineTotalCents;
      row.lineTotalCents += item.lineTotalCents;
      continue;
    }
    const created: ReceiptRow = {
      key: `offer:${offer.group}`,
      description: offer.name,
      parts: [part],
      quantityMilli: 1000,
      unitPriceCents: item.lineTotalCents,
      discountCents: 0,
      lineTotalCents: item.lineTotalCents,
    };
    offers.set(offer.group, created);
    rows.push(created);
  }
  // 0.36.1: the same offer bought several times with the same content is ONE row with its count
  // ("2 × 3.00"). Offers that differ in anything (another PC, another price) stay apart.
  const merged: ReceiptRow[] = [];
  const seen = new Map<string, ReceiptRow>();
  for (const row of rows) {
    if (!row.key.startsWith('offer:')) {
      merged.push(row);
      continue;
    }
    const same = [row.description, row.unitPriceCents, ...row.parts].join('\u0000');
    const first = seen.get(same);
    if (first) {
      first.quantityMilli += row.quantityMilli;
      first.lineTotalCents += row.lineTotalCents;
      continue;
    }
    seen.set(same, row);
    merged.push(row);
  }
  return merged;
}
