/**
 * 0.36.0 — offers: products and PC minutes sold together at one price ("Coca-Cola + 60 min").
 *
 * An offer is a recipe, not a product: selling it puts each of its products and its PC time on
 * the sale as ordinary lines, so stock, cost, tax, the time credit, refunds and every report work
 * as they always did. Only the prices of those lines differ — together they cost the offer's
 * price, shared among them by what each costs outside the offer (`shareOfferPrice`).
 *
 * Pure helpers and the request shapes; the server keeps the offers (`OffersService`).
 */
import { z } from 'zod';
import { multiplyByQuantity } from './money.js';
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
  createdAt: string;
  updatedAt: string;
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
 * the offer's name and price (what the customer bought), its content listed under it.
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
  return rows;
}
