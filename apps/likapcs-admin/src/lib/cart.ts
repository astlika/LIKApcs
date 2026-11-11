/**
 * POS cart state (pure functions; the server recomputes everything on submission).
 * Quantities are milli-units, money is integer cents — identical to the server model.
 */
import {
  computeSale,
  customerDiscountCents,
  type ProductSummary,
  type SaleTotals,
} from '@likapcs/shared';

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

// ─── Stock ceiling ─────────────────────────────────────────────────────────────
type StockFacts = Pick<ProductSummary, 'trackStock' | 'allowNegativeStock' | 'stockMilli'>;

/**
 * The most of a product one sale may hold. `null` = no ceiling: its stock is not tracked, or the
 * owner ticked "allow selling without stock" on that very product (Products › edit). Every other
 * product stops at what is on the shelf — the rule the server enforces when the sale completes
 * (`INSUFFICIENT_STOCK`), applied here already so the cashier is told while adding, not at payment.
 */
export function stockLimitMilli(product: StockFacts): number | null {
  if (!product.trackStock || product.allowNegativeStock) return null;
  return Math.max(0, product.stockMilli);
}

export function quantityInCart(cart: Cart, productId: string): number {
  return cart.lines.find((l) => l.product.id === productId)?.quantityMilli ?? 0;
}

export interface AddResult {
  cart: Cart;
  /** False when the product did not fit: the cart is returned unchanged. */
  added: boolean;
  /** The ceiling that applied (null = none). */
  limitMilli: number | null;
}

/**
 * `addToCart` that respects the shelf: when the line would hold more than the stock, nothing is
 * added. The line keeps the newest product facts it was given (stock moves while a sale is open).
 */
export function addWithinStock(
  cart: Cart,
  product: ProductSummary,
  quantityMilli = 1000,
): AddResult {
  const limitMilli = stockLimitMilli(product);
  if (limitMilli !== null && quantityInCart(cart, product.id) + quantityMilli > limitMilli)
    return { cart, added: false, limitMilli };
  const next = addToCart(cart, product, quantityMilli);
  return {
    cart: {
      ...next,
      lines: next.lines.map((l) => (l.product.id === product.id ? { ...l, product } : l)),
    },
    added: true,
    limitMilli,
  };
}

/**
 * `setQuantity` that respects the shelf: a quantity above the stock is cut down to it
 * (`clampedToMilli` says so; 0 removes the line, exactly like `setQuantity`).
 */
export function setQuantityWithinStock(
  cart: Cart,
  productId: string,
  quantityMilli: number,
): { cart: Cart; clampedToMilli: number | null } {
  const line = cart.lines.find((l) => l.product.id === productId);
  const limitMilli = line ? stockLimitMilli(line.product) : null;
  if (limitMilli !== null && quantityMilli > limitMilli)
    return { cart: setQuantity(cart, productId, limitMilli), clampedToMilli: limitMilli };
  return { cart: setQuantity(cart, productId, quantityMilli), clampedToMilli: null };
}

/**
 * Lines holding more than the shelf has — a parked sale resumed after the stock was sold, or a
 * product another cashier sold meanwhile. The sale cannot complete until they are lowered.
 */
export function overStockLines(cart: Cart): CartLine[] {
  return cart.lines.filter((l) => {
    const limit = stockLimitMilli(l.product);
    return limit !== null && l.quantityMilli > limit;
  });
}

/**
 * Replaces the product facts of the cart lines with newer ones (the POS list refreshes after every
 * sale). Returns the same cart object when nothing relevant changed, so it is safe in an effect.
 */
export function refreshCartProducts(cart: Cart, fresh: readonly ProductSummary[]): Cart {
  if (!cart.lines.length || !fresh.length) return cart;
  const byId = new Map(fresh.map((p) => [p.id, p]));
  let changed = false;
  const lines = cart.lines.map((l) => {
    const p = byId.get(l.product.id);
    if (
      !p ||
      (p.stockMilli === l.product.stockMilli &&
        p.trackStock === l.product.trackStock &&
        p.allowNegativeStock === l.product.allowNegativeStock)
    )
      return l;
    changed = true;
    return {
      ...l,
      product: {
        ...l.product,
        stockMilli: p.stockMilli,
        trackStock: p.trackStock,
        allowNegativeStock: p.allowNegativeStock,
        lowStock: p.lowStock,
      },
    };
  });
  return changed ? { ...cart, lines } : cart;
}

/** The server said how much is really left (409 `INSUFFICIENT_STOCK`): remember it on the line. */
export function withKnownStock(cart: Cart, productId: string, stockMilli: number): Cart {
  return {
    ...cart,
    lines: cart.lines.map((l) =>
      l.product.id === productId ? { ...l, product: { ...l.product, stockMilli } } : l,
    ),
  };
}

/**
 * Preview totals; invalid discounts are clamped so the preview never throws. `memberDiscountBp`
 * mirrors the server rule: a customer's default discount applies only when no explicit sale
 * discount was entered (see `customerDiscountCents` in the shared package).
 */
/** What one unit costs right now: a live promo (Admin › Ads) or the regular price. */
export function unitPriceOf(
  product: Pick<ProductSummary, 'sellingPriceCents' | 'promoPriceCents'>,
): number {
  const promo = product.promoPriceCents;
  return promo !== null && promo !== undefined && promo < product.sellingPriceCents
    ? promo
    : product.sellingPriceCents;
}

export function cartTotals(
  cart: Cart,
  memberDiscountBp = 0,
): SaleTotals & { memberDiscount: boolean } {
  const lines = cart.lines.map((l) => {
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
