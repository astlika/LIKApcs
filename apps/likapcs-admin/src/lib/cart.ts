/**
 * POS cart state (pure functions; the server recomputes everything on submission).
 * Quantities are milli-units, money is integer cents — identical to the server model.
 *
 * 0.19.0: a line is a catalogue product (stock, tax and price from the product row), an
 * off-inventory "free" line (a name and a price typed at the till, default tax, no stock), or a
 * "time" line (prepaid PC minutes sold now — the server prices it and creates a credit for the PC).
 * 0.36.0: or an "offer" line — products and PC minutes sold together at the offer's one price.
 * 0.36.1: an offer goes in with one click, like a product: the same offer again raises the
 * quantity of its line, and the stock rule counts what the offers in the cart take.
 */
import {
  computeSale,
  customerDiscountCents,
  type OfferSummary,
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

/** The most of one offer a sale holds (each unit is opened up into its own lines by the server). */
export const OFFER_MAX_UNITS = 50;

/**
 * 0.36.0: an offer — its products and its PC minutes at one price. The server opens the offer
 * up into its lines.
 * 0.36.1: one line per offer, in whole units; nothing is asked at the till. The PC minutes of an
 * offer wait at the desk as paid time and are given when a PC is started or gets more time.
 */
export interface OfferLine {
  kind: 'offer';
  key: string;
  offer: OfferSummary;
  /** Only for the tax preview: the server taxes each part of the offer at its own rate. */
  taxRateBp: number;
  /** Whole units only (1000 = one offer). */
  quantityMilli: number;
  /** An offer already is its price: it takes no line discount. */
  discountCents: 0;
}

export type CartLine = ProductLine | FreeLine | TimeLine | OfferLine;

/** Whether the cart holds an offer: such a sale needs the server and is never parked. */
export const hasOffer = (cart: Cart): boolean => cart.lines.some((l) => l.kind === 'offer');

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
  /**
   * 0.27.4: the products go to this PC's bill instead of a sale. Only product lines, whole units,
   * no extras and no discounts (see `pcBlocker`).
   */
  pc?: PcTarget | null;
}

export interface PcTarget {
  sessionId: string;
  label: string;
  /** Prepaid or already collected: the products are paid at the till, there is no later option. */
  billed: boolean;
}

/**
 * 0.34.0: an internet access package — each unit sold hands out one of its codes, when the sale
 * is paid at the till. (A product saved before 0.34.0 has no `kind`: it is an ordinary product.)
 */
export const isInternetAccess = (product: Pick<ProductSummary, 'kind'>): boolean =>
  product.kind === 'internet_access';

/** Whether the cart holds internet access: such a sale needs the server, and never goes to a PC. */
export const hasInternetAccess = (cart: Cart): boolean =>
  cart.lines.some((l) => l.kind === 'product' && isInternetAccess(l.product));

/** Why the cart cannot go to a PC's bill as it is (null: it can). */
export function pcBlocker(
  cart: Cart,
): 'notPc' | 'internet' | 'addons' | 'whole' | 'discount' | null {
  if (cart.lines.some((l) => l.kind !== 'product')) return 'notPc';
  // A PC's bill is paid later; an internet code is handed over when the sale is paid.
  if (hasInternetAccess(cart)) return 'internet';
  if (cart.lines.some((l) => l.kind === 'product' && l.addonIds.length > 0)) return 'addons';
  if (cart.lines.some((l) => l.kind === 'product' && l.quantityMilli % 1000 !== 0)) return 'whole';
  if (cart.discountCents > 0 || cart.lines.some((l) => l.kind === 'product' && l.discountCents > 0))
    return 'discount';
  return null;
}

/** The lines as the PC order endpoint takes them (whole units). */
export function pcItemsFromCart(cart: Cart): { productId: string; quantity: number }[] {
  return cart.lines.flatMap((l) =>
    l.kind === 'product' ? [{ productId: l.product.id, quantity: l.quantityMilli / 1000 }] : [],
  );
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
  if (l.kind === 'offer') return l.offer.name;
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

// ─── 0.33.4: stock at the till ────────────────────────────────────────────────
// A product that is tracked and may not go below zero cannot be put in the sale beyond its stock.
// Products that are not tracked, or are allowed below zero, are never limited. The server still
// decides at payment time (another till may have sold the last one meanwhile).

type StockFields = Pick<ProductSummary, 'trackStock' | 'allowNegativeStock' | 'stockMilli'>;

/** The most of this product a sale may hold (milli-units); null when it is not limited. */
export function stockLimitMilli(product: StockFields): number | null {
  if (!product.trackStock || product.allowNegativeStock) return null;
  return Math.max(0, product.stockMilli);
}

/** What one offer line takes of a product (milli-units): its quantity in the offer × the units. */
function offerLineTakes(line: OfferLine, productId: string): number {
  const units = line.quantityMilli / 1000;
  return line.offer.items.reduce(
    (sum, i) => (i.productId === productId ? sum + Math.round(i.quantityMilli * units) : sum),
    0,
  );
}

/**
 * Units of a product already in the cart: every line of it, with or without extras, and
 * (0.36.1) what the offers in the cart take of it.
 */
export function cartQuantityOf(cart: Cart, productId: string, exceptKey?: string): number {
  return cart.lines.reduce((sum, l) => {
    if (lineKey(l) === exceptKey) return sum;
    if (l.kind === 'product') return l.product.id === productId ? sum + l.quantityMilli : sum;
    if (l.kind === 'offer') return sum + offerLineTakes(l, productId);
    return sum;
  }, 0);
}

/** Why an addition was refused or cut: the product and what the stock still allows in total. */
export interface StockRefusal {
  productName: string;
  /** The product's stock (never below zero). */
  stockMilli: number;
  /** What this line may hold at most (the stock minus the other lines of the same product). */
  allowedMilli: number;
}

/**
 * `addToCart` with the stock rule: an addition that would pass the stock is refused whole (the cart
 * is returned unchanged) and `refused` says what is left.
 */
export function addToCartChecked(
  cart: Cart,
  product: ProductSummary,
  quantityMilli = 1000,
  addonIds: readonly string[] = [],
): { cart: Cart; refused: StockRefusal | null } {
  const limit = stockLimitMilli(product);
  if (limit !== null) {
    const inCart = cartQuantityOf(cart, product.id);
    if (inCart + quantityMilli > limit) {
      return {
        cart,
        refused: {
          productName: product.name,
          stockMilli: limit,
          allowedMilli: Math.max(0, limit - inCart),
        },
      };
    }
  }
  return { cart: addToCart(cart, product, quantityMilli, addonIds), refused: null };
}

/**
 * `setQuantity` with the stock rule: a quantity above the stock is cut to what the stock allows
 * (never below what the line already holds is NOT guaranteed: a stock that shrank cuts it too).
 */
export function setQuantityChecked(
  cart: Cart,
  key: string,
  quantityMilli: number,
): { cart: Cart; refused: StockRefusal | null } {
  const line = cart.lines.find((l) => lineKey(l) === key);
  // 0.34.0: internet access is sold by the piece — one code each — so a typed 1.5 becomes 2.
  if (line && line.kind === 'product' && isInternetAccess(line.product) && quantityMilli > 0) {
    quantityMilli = Math.max(1000, Math.round(quantityMilli / 1000) * 1000);
  }
  if (line && line.kind === 'offer') return setOfferQuantityChecked(cart, line, quantityMilli);
  if (!line || line.kind !== 'product' || quantityMilli <= line.quantityMilli) {
    return { cart: setQuantity(cart, key, quantityMilli), refused: null };
  }
  const limit = stockLimitMilli(line.product);
  if (limit === null) return { cart: setQuantity(cart, key, quantityMilli), refused: null };
  const allowed = Math.max(0, limit - cartQuantityOf(cart, line.product.id, key));
  if (quantityMilli <= allowed)
    return { cart: setQuantity(cart, key, quantityMilli), refused: null };
  // Never raise above the stock; keep what the line has when even that is more than allowed.
  const next = Math.max(
    Math.min(quantityMilli, allowed),
    Math.min(line.quantityMilli, quantityMilli),
  );
  return {
    cart: next === line.quantityMilli ? cart : setQuantity(cart, key, next),
    refused: { productName: line.product.name, stockMilli: limit, allowedMilli: allowed },
  };
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

const offerKey = (offerId: string): string => `offer:${offerId}`;

/**
 * Adds one offer (0.36.0) at the offer's price. 0.36.1: nothing is asked — the same offer again
 * raises the quantity of its line, and the line follows the offer as it is now.
 */
export function addOfferItem(cart: Cart, input: { offer: OfferSummary; taxRateBp: number }): Cart {
  const key = offerKey(input.offer.id);
  const idx = cart.lines.findIndex((l) => l.kind === 'offer' && l.key === key);
  if (idx < 0) {
    const line: OfferLine = {
      kind: 'offer',
      key,
      offer: input.offer,
      taxRateBp: input.taxRateBp,
      quantityMilli: 1000,
      discountCents: 0,
    };
    return { ...cart, lines: [...cart.lines, line] };
  }
  const lines = cart.lines.slice();
  const line = lines[idx] as OfferLine;
  lines[idx] = {
    ...line,
    offer: input.offer,
    quantityMilli: Math.min(OFFER_MAX_UNITS * 1000, line.quantityMilli + 1000),
  };
  return { ...cart, lines };
}

/**
 * The most units of an offer the cart may hold, counting everything else in the cart that takes
 * the same products: `units` (never above `OFFER_MAX_UNITS`) and, when the stock is what limits
 * it, the product that runs out first.
 */
function offerUnitsAllowed(
  cart: Cart,
  offer: OfferSummary,
  exceptKey?: string,
): { units: number; refusal: StockRefusal | null } {
  let units = OFFER_MAX_UNITS;
  let refusal: StockRefusal | null = null;
  for (const item of offer.items) {
    if (!item.stockLimited || item.stockMilli === null || item.quantityMilli <= 0) continue;
    const limit = Math.max(0, item.stockMilli);
    const left = Math.max(0, limit - cartQuantityOf(cart, item.productId, exceptKey));
    const covered = Math.floor(left / item.quantityMilli);
    if (covered < units) {
      units = covered;
      refusal = { productName: item.name, stockMilli: limit, allowedMilli: left };
    }
  }
  return { units, refusal };
}

/**
 * `addOfferItem` with the stock rule (0.36.1): one more offer is refused whole when a product of
 * it would pass its stock — counting the other lines of the cart that take the same product.
 * At `OFFER_MAX_UNITS` the cart simply stays as it is.
 */
export function addOfferChecked(
  cart: Cart,
  input: { offer: OfferSummary; taxRateBp: number },
): { cart: Cart; refused: StockRefusal | null } {
  const key = offerKey(input.offer.id);
  const held = cart.lines.find((l) => l.kind === 'offer' && l.key === key);
  const units = held ? held.quantityMilli / 1000 : 0;
  if (units >= OFFER_MAX_UNITS) return { cart, refused: null };
  // What the stock allows for this offer in all, the line it already has left aside.
  const allowed = offerUnitsAllowed(cart, input.offer, key);
  if (allowed.refusal && units + 1 > allowed.units) return { cart, refused: allowed.refusal };
  return { cart: addOfferItem(cart, input), refused: null };
}

/** A typed or stepped quantity of an offer line: whole units, never past the stock. */
function setOfferQuantityChecked(
  cart: Cart,
  line: OfferLine,
  quantityMilli: number,
): { cart: Cart; refused: StockRefusal | null } {
  if (quantityMilli <= 0) return { cart: removeLine(cart, line.key), refused: null };
  const wanted = Math.min(OFFER_MAX_UNITS, Math.max(1, Math.round(quantityMilli / 1000)));
  const held = line.quantityMilli / 1000;
  if (wanted <= held) return { cart: setQuantity(cart, line.key, wanted * 1000), refused: null };
  const allowed = offerUnitsAllowed(cart, line.offer, line.key);
  if (!allowed.refusal || wanted <= allowed.units)
    return { cart: setQuantity(cart, line.key, wanted * 1000), refused: null };
  // Never raise above what the stock allows; keep what the line has when even that is more.
  const next = Math.max(allowed.units, held);
  return {
    cart: next === held ? cart : setQuantity(cart, line.key, next * 1000),
    refused: allowed.refusal,
  };
}

export function setQuantity(cart: Cart, key: string, quantityMilli: number): Cart {
  if (quantityMilli <= 0) return removeLine(cart, key);
  return {
    ...cart,
    lines: cart.lines.map((l) => {
      if (lineKey(l) !== key || l.kind === 'time') return l;
      // An offer is sold whole: 1, 2, 3 …
      if (l.kind === 'offer')
        return {
          ...l,
          quantityMilli:
            Math.min(OFFER_MAX_UNITS, Math.max(1, Math.round(quantityMilli / 1000))) * 1000,
        };
      return { ...l, quantityMilli };
    }),
  };
}

export function setLineDiscount(cart: Cart, key: string, discountCents: number): Cart {
  return {
    ...cart,
    lines: cart.lines.map((l) =>
      lineKey(l) === key && l.kind !== 'offer'
        ? { ...l, discountCents: Math.max(0, discountCents) }
        : l,
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
    if (l.kind === 'offer') {
      // The offer's one price; the server shares it among the offer's own lines.
      return {
        unitPriceCents: l.offer.priceCents,
        quantityMilli: l.quantityMilli,
        discountCents: 0,
        taxRateBp: l.taxRateBp,
        priceIncludesTax: true,
      };
    }
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

/** One item of a sale request, as the cart sends it (`saleItemInputSchema`). */
export type CartRequestItem =
  | { productId: string; quantityMilli: number; discountCents: number; addonIds?: string[] }
  | { stationId?: string; holderName?: string; minutes: number; discountCents: number }
  | { offerId: string }
  | { description: string; unitPriceCents: number; quantityMilli: number; discountCents: number };

/** Request body for POST /sales or /sales/suspend (payments added by the caller). */
export function cartToRequest(cart: Cart) {
  return {
    items: cart.lines.flatMap((l): CartRequestItem[] => {
      if (l.kind === 'product') {
        return [
          {
            productId: l.product.id,
            quantityMilli: l.quantityMilli,
            discountCents: l.discountCents,
            ...(l.addonIds.length > 0 ? { addonIds: l.addonIds } : {}),
          },
        ];
      }
      if (l.kind === 'time') {
        return [
          {
            ...(l.stationId ? { stationId: l.stationId } : {}),
            ...(!l.stationId && l.holderName ? { holderName: l.holderName } : {}),
            minutes: l.minutes,
            discountCents: l.discountCents,
          },
        ];
      }
      if (l.kind === 'offer') {
        // One item per unit: the server opens each sold offer up into lines of its own. Without
        // a PC and without a name its minutes wait at the desk as paid time (0.36.1).
        const units = Math.max(1, Math.round(l.quantityMilli / 1000));
        return Array.from({ length: units }, () => ({ offerId: l.offer.id }));
      }
      return [
        {
          description: l.name,
          unitPriceCents: l.unitPriceCents,
          quantityMilli: l.quantityMilli,
          discountCents: l.discountCents,
        },
      ];
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
