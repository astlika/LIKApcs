/**
 * POS cart state (pure functions; the server recomputes everything on submission).
 * Quantities are milli-units, money is integer cents — identical to the server model.
 */
import { computeSale, type ProductSummary, type SaleTotals } from '@likapcs/shared';

export interface CartLine {
  product: ProductSummary;
  quantityMilli: number;
  discountCents: number;
}

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

/** Adds a product; the same product merges into one line (quantity accumulates). */
export function addToCart(cart: Cart, product: ProductSummary, quantityMilli = 1000): Cart {
  const idx = cart.lines.findIndex((l) => l.product.id === product.id);
  if (idx < 0) {
    return { ...cart, lines: [...cart.lines, { product, quantityMilli, discountCents: 0 }] };
  }
  const lines = cart.lines.slice();
  lines[idx] = { ...lines[idx]!, quantityMilli: lines[idx]!.quantityMilli + quantityMilli };
  return { ...cart, lines };
}

export function setQuantity(cart: Cart, productId: string, quantityMilli: number): Cart {
  if (quantityMilli <= 0) return removeLine(cart, productId);
  return {
    ...cart,
    lines: cart.lines.map((l) => (l.product.id === productId ? { ...l, quantityMilli } : l)),
  };
}

export function setLineDiscount(cart: Cart, productId: string, discountCents: number): Cart {
  return {
    ...cart,
    lines: cart.lines.map((l) =>
      l.product.id === productId ? { ...l, discountCents: Math.max(0, discountCents) } : l,
    ),
  };
}

export function removeLine(cart: Cart, productId: string): Cart {
  return { ...cart, lines: cart.lines.filter((l) => l.product.id !== productId) };
}

/** Preview totals; invalid discounts are clamped so the preview never throws. */
export function cartTotals(cart: Cart): SaleTotals {
  const lines = cart.lines.map((l) => {
    const gross = Math.round((l.product.sellingPriceCents * l.quantityMilli) / 1000);
    return {
      unitPriceCents: l.product.sellingPriceCents,
      quantityMilli: l.quantityMilli,
      discountCents: Math.min(l.discountCents, gross),
      taxRateBp: l.product.taxRateBp,
      priceIncludesTax: l.product.priceIncludesTax,
    };
  });
  const subtotal = computeSale(lines, 0).subtotalCents;
  return computeSale(lines, Math.min(cart.discountCents, subtotal));
}

export function cartItemCount(cart: Cart): number {
  return cart.lines.reduce((n, l) => n + l.quantityMilli, 0) / 1000;
}

/** Request body for POST /sales or /sales/suspend (payments added by the caller). */
export function cartToRequest(cart: Cart) {
  return {
    items: cart.lines.map((l) => ({
      productId: l.product.id,
      quantityMilli: l.quantityMilli,
      discountCents: l.discountCents,
    })),
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
