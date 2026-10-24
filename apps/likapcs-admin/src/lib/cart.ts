/**
 * POS cart state (pure functions; the server recomputes everything on submission).
 * Quantities are milli-units, money is integer cents — identical to the server model.
 *
 * 0.19.0: a line is a catalogue product (stock, tax and price from the product row), an
 * off-inventory "free" line (a name and a price typed at the till, default tax, no stock), or a
 * "time" line (prepaid PC minutes sold now — the server prices it and creates a credit for the PC).
 */
import {
  computeSale,
  customerDiscountCents,
  type ProductAddonSummary,
  type ProductSummary,
  type SaleTotals,
} from '@likapcs/shared';

export interface ProductLine {
  kind: 'product';
  product: ProductSummary;
  quantityMilli: number;
  discountCents: number;
  /** 0.19.1: the product's extras chosen for this line (sorted ids; empty when none). */
  addonIds: string[];
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

/** Prepaid PC time (0.19.0). One unit per line; the server re-quotes the price on submission. */
export interface TimeLine {
  kind: 'time';
  /** Stable key of this line: each addition is its own line (two PCs, or two bookings). */
  key: string;
  /** Null: sold without a PC (0.20.8) — the name holds the minutes, a PIN starts them at any PC. */
  stationId: string | null;
  stationCode: string | null;
  /** The name the minutes belong to (sold without a PC). */
  holderName: string | null;
  minutes: number;
  /** Gross price as quoted for the PC right now (includes tax, like the catalogue). */
  unitPriceCents: number;
  taxRateBp: number;
  /** Always one unit: PC time is sold per booking, its quantity is not editable. */
  quantityMilli: 1000;
  discountCents: number;
}

export type CartLine = ProductLine | FreeLine | TimeLine;

export interface Cart {
  lines: CartLine[];
  discountCents: number;
  customerId: string | null;
  notes: string;
  /** Idempotency key sent with the sale; regenerated when the cart is cleared. */
  clientRequestId: string;
  /**
   * Staff purchase (0.20.7): products at purchase cost, PC time free, no discounts or customer,
   * recorded as a stock outflow with no money taken. Undefined / false on a normal sale.
   */
  staff?: boolean;
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

/** Sorted, de-duplicated extra ids: the same set of extras always yields the same line key. */
export const normalizeAddonIds = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

/**
 * The line's key: the product id, or the free line's own key. A product line with extras gets
 * its own key, so "Tost" and "Tost + Kackavall" are separate lines and do not merge.
 */
export const lineKey = (l: CartLine): string => {
  if (l.kind !== 'product') return l.key;
  return l.addonIds.length > 0 ? `${l.product.id}|${l.addonIds.join(',')}` : l.product.id;
};

/** The extras of a product that are chosen (ids unknown to the product are ignored). */
export function chosenAddons(
  product: Pick<ProductSummary, 'addons'>,
  addonIds: readonly string[],
): ProductAddonSummary[] {
  const wanted = new Set(addonIds);
  return (product.addons ?? []).filter((a) => wanted.has(a.id));
}

/** Total price of the chosen extras for one unit. */
export function addonsCents(
  product: Pick<ProductSummary, 'addons'>,
  addonIds: readonly string[],
): number {
  return chosenAddons(product, addonIds).reduce((n, a) => n + a.priceCents, 0);
}

export const lineName = (l: CartLine): string => {
  if (l.kind === 'product') {
    const extras = chosenAddons(l.product, l.addonIds);
    return extras.length > 0
      ? [l.product.name, ...extras.map((a) => a.name)].join(' + ')
      : l.product.name;
  }
  if (l.kind === 'time')
    return l.stationCode
      ? `${l.stationCode} · ${l.minutes} min`
      : `PC time · ${l.minutes} min${l.holderName ? ` · ${l.holderName}` : ''}`;
  return l.name;
};

/**
 * Adds a product; the same product with the same extras merges into one line (quantity
 * accumulates). Different extras make a separate line.
 */
export function addToCart(
  cart: Cart,
  product: ProductSummary,
  quantityMilli = 1000,
  addonIds: readonly string[] = [],
): Cart {
  // Only the product's own extras can be chosen; an id it no longer has is dropped.
  const known = new Set((product.addons ?? []).map((a) => a.id));
  const ids = normalizeAddonIds(addonIds.filter((id) => known.has(id)));
  const key = ids.length > 0 ? `${product.id}|${ids.join(',')}` : product.id;
  const idx = cart.lines.findIndex((l) => l.kind === 'product' && lineKey(l) === key);
  if (idx < 0) {
    return {
      ...cart,
      lines: [
        ...cart.lines,
        { kind: 'product', product, quantityMilli, discountCents: 0, addonIds: ids },
      ],
    };
  }
  const lines = cart.lines.slice();
  const line = lines[idx]!;
  if (line.kind !== 'product') return cart;
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

/** Adds PC time (0.19.0): its own line, priced by the caller's quote for that PC. */
export function addTimeItem(
  cart: Cart,
  input: {
    stationId?: string | null;
    stationCode?: string | null;
    holderName?: string | null;
    minutes: number;
    unitPriceCents: number;
    taxRateBp: number;
  },
  newKey: () => string = newRequestId,
): Cart {
  const line: TimeLine = {
    kind: 'time',
    key: `time:${newKey()}`,
    stationId: input.stationId ?? null,
    stationCode: input.stationCode ?? null,
    holderName: input.holderName ?? null,
    minutes: input.minutes,
    unitPriceCents: input.unitPriceCents,
    taxRateBp: input.taxRateBp,
    quantityMilli: 1000,
    discountCents: 0,
  };
  return { ...cart, lines: [...cart.lines, line] };
}

export function setQuantity(cart: Cart, key: string, quantityMilli: number): Cart {
  if (quantityMilli <= 0) return removeLine(cart, key);
  return {
    ...cart,
    lines: cart.lines.map((l) =>
      lineKey(l) === key && l.kind !== 'time' ? { ...l, quantityMilli } : l,
    ),
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
  const staff = cart.staff === true;
  const lines = cart.lines.map((l) => {
    if (l.kind === 'free' || l.kind === 'time') {
      // Staff: PC time is free; a free item cannot be on a staff purchase (the toggle refuses it).
      const unit = staff && l.kind === 'time' ? 0 : l.unitPriceCents;
      const gross = Math.round((unit * l.quantityMilli) / 1000);
      return {
        unitPriceCents: unit,
        quantityMilli: l.quantityMilli,
        discountCents: staff ? 0 : Math.min(l.discountCents, gross),
        taxRateBp: l.taxRateBp,
        priceIncludesTax: true,
      };
    }
    if (staff) {
      // Staff pay the purchase cost: no promo, no add-ons, no discount.
      const unit = l.product.purchaseCostCents;
      return {
        unitPriceCents: unit,
        quantityMilli: l.quantityMilli,
        discountCents: 0,
        taxRateBp: l.product.taxRateBp,
        priceIncludesTax: l.product.priceIncludesTax,
      };
    }
    const unit = unitPriceOf(l.product) + addonsCents(l.product, l.addonIds);
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
  const explicit = staff ? 0 : Math.min(cart.discountCents, subtotal);
  const member = staff ? 0 : customerDiscountCents(subtotal, memberDiscountBp, explicit);
  return { ...computeSale(lines, member > 0 ? member : explicit), memberDiscount: member > 0 };
}

export function cartItemCount(cart: Cart): number {
  return cart.lines.reduce((n, l) => n + l.quantityMilli, 0) / 1000;
}

/** Request body for POST /sales or /sales/suspend (payments added by the caller). */
export function cartToRequest(cart: Cart) {
  return {
    items: cart.lines.map((l) => {
      if (l.kind === 'product') {
        return {
          productId: l.product.id,
          quantityMilli: l.quantityMilli,
          discountCents: l.discountCents,
          ...(l.addonIds.length > 0 ? { addonIds: l.addonIds } : {}),
        };
      }
      if (l.kind === 'time') {
        return {
          ...(l.stationId ? { stationId: l.stationId } : {}),
          ...(!l.stationId && l.holderName ? { holderName: l.holderName } : {}),
          minutes: l.minutes,
          discountCents: l.discountCents,
        };
      }
      return {
        description: l.name,
        unitPriceCents: l.unitPriceCents,
        quantityMilli: l.quantityMilli,
        discountCents: l.discountCents,
      };
    }),
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
