/**
 * POS cart state (pure functions; the server recomputes everything on submission).
 * Quantities are milli-units, money is integer cents — identical to the server model.
 *
 * 0.19.0: a line is either a catalogue product (stock, tax and price from the product row) or an
 * off-inventory \"free\" line — a name and a price typed at the till, default tax, no stock.
 */
import {
  computeSale,
  customerDiscountCents,
  type ProductSummary,
  type SaleTotals,
} from '@likapcs/shared';

export interface ProductLine {
  kind: 'product';
  product: ProductSummary;
  quantityMilli: number;
  discountCents: number;
}

export interface FreeLine {
  kind: 'free';
  /** Stable key of this line (free lines have no product id). */
  key: string;
  name: string;
  /** Gross unit price as typed (includes tax, like the catalogue). */
  unitPriceCents: number;
  /** The default tax rate at the moment the line was added (shown the same as the server). */
  taxRateBp: number;
  quantityMilli: number;
  discountCents: number;
}

export type CartLine = ProductLine | FreeLine;

export interface Cart {
  lines: CartLine[];
  discountCents: number;
  customerId: string | null;
  notes: string;
  /** Idempotency key sent with the sale; regenerated when the cart is cleared. */
  clientRequestId: string;
}

export const newRequestId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const emptyCart = (): Cart => ({
  lines: [],
  discountCents: 0,
  customerId: null,
  notes: '',
  clientRequestId: newRequestId(),
});

/** The line's key: the product id, or the free line's own key. */
export const lineKey = (l: CartLine): string => (l.kind === 'product' ? l.product.id : l.key);
export const lineName = (l: CartLine): string => (l.kind === 'product' ? l.product.name : l.name);

/** Adds a product; the same product merges into one line (quantity accumulates). */
export function addToCart(cart: Cart, product: ProductSummary, quantityMilli = 1000): Cart {
  const idx = cart.lines.findIndex((l) => l.kind === 'product' && l.product.id === product.id);
  if (idx < 0) {
    return {
      ...cart,
      lines: [...cart.lines, { kind: 'product', product, quantityMilli, discountCents: 0 }],
    };
  }
  const lines = cart.lines.slice();
  const line = lines[idx]!;
  lines[idx] = { ...line, quantityMilli: line.quantityMilli + quantityMilli };
  return { ...cart, lines };
}

/** Adds an off-inventory line (0.19.0). Every call is its own line — two lines may share a name. */
export function addFreeItem(
  cart: Cart,
  input: { name: string; unitPriceCents: number; taxRateBp: number; quantityMilli?: number },
  newKey: () => string = newRequestId,
): Cart {
  const line: FreeLine = {
    kind: 'free',
    key: `free:${newKey()}`,
    name: input.name.trim(),
    unitPriceCents: input.unitPriceCents,
    taxRateBp: input.taxRateBp,
    quantityMilli: input.quantityMilli ?? 1000,
    discountCents: 0,
  };
  return { ...cart, lines: [...cart.lines, line] };
}

export function setQuantity(cart: Cart, key: string, quantityMilli: number): Cart {
  if (quantityMilli <= 0) return removeLine(cart, key);
  return {
    ...cart,
    lines: cart.lines.map((l) => (lineKey(l) === key ? { ...l, quantityMilli } : l)),
  };
}

export function setLineDiscount(cart: Cart, key: string, discountCents: number): Cart {
  return {
    ...cart,
    lines: cart.lines.map((l) =>
      lineKey(l) === key ? { ...l, discountCents: Math.max(0, discountCents) } : l,
    ),
  };
}

export function removeLine(cart: Cart, key: string): Cart {
  return { ...cart, lines: cart.lines.filter((l) => lineKey(l) !== key) };
}

/** What one unit costs right now: a live promo (Admin › Ads) or the regular price. */
export function unitPriceOf(
  product: Pick<ProductSummary, 'sellingPriceCents' | 'promoPriceCents'>,
): number {
  const promo = product.promoPriceCents;
  return promo !== null && promo !== undefined && promo < product.sellingPriceCents
    ? promo
    : product.sellingPriceCents;
}

/**
 * Preview totals; invalid discounts are clamped so the preview never throws. `memberDiscountBp`
 * mirrors the server rule: a customer's default discount applies only when no explicit sale
 * discount was entered (see `customerDiscountCents` in the shared package).
 */
export function cartTotals(
  cart: Cart,
  memberDiscountBp = 0,
): SaleTotals & { memberDiscount: boolean } {
  const lines = cart.lines.map((l) => {
    if (l.kind === 'free') {
      const gross = Math.round((l.unitPriceCents * l.quantityMilli) / 1000);
      return {
        unitPriceCents: l.unitPriceCents,
        quantityMilli: l.quantityMilli,
        discountCents: Math.min(l.discountCents, gross),
        taxRateBp: l.taxRateBp,
        priceIncludesTax: true,
      };
    }
    const unit = unitPriceOf(l.product);
    const gross = Math.round((unit * l.quantityMilli) / 1000);
    return {
      unitPriceCents: unit,
      quantityMilli: l.quantityMilli,
      discountCents: Math.min(l.discountCents, gross),
      taxRateBp: l.product.taxRateBp,
      priceIncludesTax: l.product.priceIncludesTax,
    };
  });
  const subtotal = computeSale(lines, 0).subtotalCents;
  const explicit = Math.min(cart.discountCents, subtotal);
  const member = customerDiscountCents(subtotal, memberDiscountBp, explicit);
  return { ...computeSale(lines, member > 0 ? member : explicit), memberDiscount: member > 0 };
}

export function cartItemCount(cart: Cart): number {
  return cart.lines.reduce((n, l) => n + l.quantityMilli, 0) / 1000;
}

/** Request body for POST /sales or /sales/suspend (payments added by the caller). */
export function cartToRequest(cart: Cart) {
  return {
    items: cart.lines.map((l) =>
      l.kind === 'product'
        ? {
            productId: l.product.id,
            quantityMilli: l.quantityMilli,
            discountCents: l.discountCents,
          }
        : {
            description: l.name,
            unitPriceCents: l.unitPriceCents,
            quantityMilli: l.quantityMilli,
            discountCents: l.discountCents,
          },
    ),
    discountCents: cart.discountCents,
    customerId: cart.customerId,
    notes: cart.notes.trim() || undefined,
    clientRequestId: cart.clientRequestId,
  };
}

/**
 * Barcode-scanner (keyboard wedge) detection: scanners type the whole code within a few
 * milliseconds and finish with Enter. Returns the code when the buffered burst looks like a scan.
 */
export class ScanBuffer {
  private chars: { ch: string; at: number }[] = [];
  constructor(
    private readonly maxGapMs = 60,
    private readonly minLength = 4,
  ) {}

  /** Feed a printable key; call `flush()` on Enter. */
  push(ch: string, at = Date.now()): void {
    const last = this.chars[this.chars.length - 1];
    if (last && at - last.at > this.maxGapMs) this.chars = [];
    this.chars.push({ ch, at });
  }

  flush(at = Date.now()): string | null {
    const chars = this.chars;
    this.chars = [];
    if (chars.length < this.minLength) return null;
    const last = chars[chars.length - 1]!;
    if (at - last.at > this.maxGapMs * 3) return null;
    const first = chars[0]!;
    // Average inter-key gap of a human is > 60 ms; scanners are < 20 ms.
    const avgGap = (last.at - first.at) / Math.max(1, chars.length - 1);
    return avgGap <= this.maxGapMs ? chars.map((c) => c.ch).join('') : null;
  }
}
