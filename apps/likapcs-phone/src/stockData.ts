import type { InventoryMovementSummary, ProductSummary, PurchaseSummary } from '@likapcs/shared';
import { daysLeft, toUnits } from './stockView';

/**
 * Stock data helpers for the phone: searching without accents and with small typos, sales of the
 * last 30 days, the supplier names, the pause of stock alerts, the copy kept for offline reading and
 * the hand-over of a product to the sale screen. Pure except for localStorage and the hand-over.
 */

// ── Search ──────────────────────────────────────────────────────────────────

/** Lower case without accents: "Kafe më qumësht" → "kafe me qumesht". */
export const normalize = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const haystack = (p: ProductSummary): string =>
  normalize(
    [
      p.name,
      p.sku,
      p.categoryName ?? '',
      p.brand ?? '',
      p.storageLocation ?? '',
      p.variantLabel ?? '',
      ...p.barcodes.map((b) => b.barcode),
    ].join(' '),
  );

/** Edit distance, small strings only (typos are a few letters at most). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

const tokens = (s: string): string[] => s.split(/\s+/).filter(Boolean);

/** Every word typed must appear in the product (in any order). */
export function matchesExact(p: ProductSummary, q: string): boolean {
  const hay = haystack(p);
  return tokens(normalize(q)).every((t) => hay.includes(t));
}

/** A typo of up to one letter (two for longer words) is accepted. Used only when nothing matches exactly. */
export function matchesFuzzy(p: ProductSummary, q: string): boolean {
  const words = haystack(p)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens(normalize(q)).every((t) => {
    if (t.length < 4) return words.some((w) => w.startsWith(t) || w === t);
    const allowed = t.length >= 7 ? 2 : 1;
    return words.some(
      (w) => w.startsWith(t) || editDistance(w.slice(0, t.length + 1), t) <= allowed,
    );
  });
}

/** Exact matches first; if there are none, the typo-tolerant ones. */
export function searchProducts(list: ProductSummary[], q: string): ProductSummary[] {
  const term = q.trim();
  if (!term) return list;
  const exact = list.filter((p) => matchesExact(p, term));
  if (exact.length > 0 || term.length < 4) return exact;
  return list.filter((p) => matchesFuzzy(p, term));
}

// ── Sales of the last 30 days ───────────────────────────────────────────────

/** Units sold per product in the movements given (only `sale` rows, returns are not counted). */
export function soldByProduct(movements: InventoryMovementSummary[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of movements) {
    if (m.movementType !== 'sale' || m.quantityMilliDelta >= 0) continue;
    out.set(m.productId, (out.get(m.productId) ?? 0) + -m.quantityMilliDelta);
  }
  return out;
}

/** Days of stock left for one product from its sales in the last 30 days (null when it did not sell). */
export function daysLeftFor(p: ProductSummary, soldMilli: number | undefined): number | null {
  const sold = toUnits(soldMilli ?? 0);
  return daysLeft(p.stockMilli, sold / 30);
}

// ── Suppliers ───────────────────────────────────────────────────────────────

/** Supplier names from the purchases the phone can read (id → name). */
export function supplierNames(purchases: PurchaseSummary[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of purchases) out.set(p.supplierId, p.supplierName);
  return out;
}

// ── Pause of stock alerts ───────────────────────────────────────────────────

const SNOOZE_KEY = 'likapcs-phone-stock-snooze';

/** Pauses the stock alerts of this phone for some minutes (0 = turns the pause off). */
export function setSnooze(minutes: number, now = Date.now()): void {
  try {
    if (minutes <= 0) localStorage.removeItem(SNOOZE_KEY);
    else localStorage.setItem(SNOOZE_KEY, String(now + minutes * 60_000));
  } catch {
    /* not kept */
  }
}

/** The time the pause ends, in ms, or 0 when there is no pause. */
export function snoozeUntil(): number {
  try {
    const v = Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export const isStockSnoozed = (now = Date.now()): boolean => snoozeUntil() > now;

// ── Copy for offline reading ────────────────────────────────────────────────

const SNAP_KEY = 'likapcs-phone-stock-snapshot';

export function saveSnapshot(items: ProductSummary[]): void {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify({ savedAt: Date.now(), items }));
  } catch {
    /* too large or private mode: the screen just needs the connection */
  }
}

export function loadSnapshot(): { savedAt: number; items: ProductSummary[] } | null {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; items?: unknown };
    if (typeof parsed.savedAt !== 'number' || !Array.isArray(parsed.items)) return null;
    return { savedAt: parsed.savedAt, items: parsed.items as ProductSummary[] };
  } catch {
    return null;
  }
}

// ── Hand-over to the sale screen ────────────────────────────────────────────

let handoff: ProductSummary | null = null;

/** "Shit tani": the sale screen takes this product into its basket when it opens. */
export function handOffToSale(p: ProductSummary): void {
  handoff = p;
  window.dispatchEvent(new CustomEvent('likapcs:goto', { detail: 'pos' }));
}

export function takeHandoff(): ProductSummary | null {
  const p = handoff;
  handoff = null;
  return p;
}
