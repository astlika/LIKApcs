import type { InventoryMovementSummary, ProductSummary } from '@likapcs/shared';

/**
 * Stock screen logic for the phone: status of each product, filters, sorting, the order list,
 * the 30-day sales figures, the CSV export and the preferences kept on this phone.
 * Pure functions only, so the screen stays readable.
 */

export type StockStatus = 'out' | 'low' | 'ok' | 'plenty' | 'untracked';
export type StatusFilter = 'all' | 'order' | 'out' | 'low' | 'ok' | 'plenty';
export type SortKey =
  | 'name'
  | 'stock-asc'
  | 'stock-desc'
  | 'ratio'
  | 'value'
  | 'category'
  | 'updated'
  | 'speed'
  | 'days';
export type ViewMode = 'cards' | 'compact';
export type ActiveFilter = 'active' | 'inactive' | 'all';
export type BarcodeFilter = 'any' | 'with' | 'without';

export interface StockViewPrefs {
  view: ViewMode;
  sort: SortKey;
  status: StatusFilter;
  barcode: BarcodeFilter;
  active: ActiveFilter;
  categoryId: string;
  supplierId: string;
  showPrices: boolean;
  /** "Stok i shumtë" = at least this many times the minimum stock. */
  plentyMultiple: number;
  /** Products without a minimum are "plenty" from this many units. */
  plentyUnits: number;
}

export const DEFAULT_PREFS: StockViewPrefs = {
  view: 'cards',
  sort: 'name',
  status: 'all',
  barcode: 'any',
  active: 'active',
  categoryId: '',
  supplierId: '',
  showPrices: false,
  plentyMultiple: 5,
  plentyUnits: 20,
};

const PREFS_KEY = 'likapcs-phone-stock-view';
const RECENT_KEY = 'likapcs-phone-stock-recent';

export function loadPrefs(): StockViewPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw
      ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<StockViewPrefs>) }
      : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: StockViewPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode: the choice lasts for this visit */
  }
}

export function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list)
      ? list.filter((x): x is string => typeof x === 'string').slice(0, 6)
      : [];
  } catch {
    return [];
  }
}

/** Remembers a search, newest first, without repeats. */
export function pushRecent(term: string): string[] {
  const list = [term, ...loadRecent().filter((x) => x !== term)].slice(0, 6);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* not kept */
  }
  return list;
}

/** Stock in units (the server keeps thousandths). */
export const toUnits = (milli: number): number => milli / 1000;

export function statusOf(p: ProductSummary, prefs: StockViewPrefs): StockStatus {
  if (!p.trackStock) return 'untracked';
  if (p.stockMilli <= 0) return 'out';
  if (p.lowStock || (p.minStockMilli > 0 && p.stockMilli < p.minStockMilli)) return 'low';
  const plenty =
    p.minStockMilli > 0
      ? p.stockMilli >= p.minStockMilli * prefs.plentyMultiple
      : p.stockMilli >= prefs.plentyUnits * 1000;
  return plenty ? 'plenty' : 'ok';
}

export function matchesStatus(status: StockStatus, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'order') return status === 'out' || status === 'low';
  return status === filter;
}

export function matchesBarcode(p: ProductSummary, filter: BarcodeFilter): boolean {
  if (filter === 'any') return true;
  const has = p.barcodes.length > 0;
  return filter === 'with' ? has : !has;
}

/** Stock compared with the minimum: Infinity when there is no minimum (sorted last). */
export const stockRatio = (p: ProductSummary): number =>
  p.minStockMilli > 0 ? p.stockMilli / p.minStockMilli : Number.POSITIVE_INFINITY;

/** Value of the stock at the purchase price, in cents. */
export const stockValueCents = (p: ProductSummary): number =>
  Math.round((p.stockMilli / 1000) * p.purchaseCostCents);

/** `sold`: units sold per product in the last 30 days (for the speed and days-left sorts). */
export function sortProducts(
  list: ProductSummary[],
  sort: SortKey,
  sold: Map<string, number> = new Map(),
): ProductSummary[] {
  const byName = (a: ProductSummary, b: ProductSummary) => a.name.localeCompare(b.name, 'sq');
  const copy = [...list];
  switch (sort) {
    case 'name':
      return copy.sort(byName);
    case 'stock-asc':
      return copy.sort((a, b) => a.stockMilli - b.stockMilli || byName(a, b));
    case 'stock-desc':
      return copy.sort((a, b) => b.stockMilli - a.stockMilli || byName(a, b));
    case 'ratio':
      return copy.sort((a, b) => {
        const ra = stockRatio(a);
        const rb = stockRatio(b);
        if (ra === rb) return byName(a, b);
        return ra < rb ? -1 : 1;
      });
    case 'value':
      return copy.sort((a, b) => stockValueCents(b) - stockValueCents(a) || byName(a, b));
    case 'category':
      return copy.sort(
        (a, b) => (a.categoryName ?? '').localeCompare(b.categoryName ?? '', 'sq') || byName(a, b),
      );
    case 'updated':
      return copy.sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
      );
    case 'speed':
      return copy.sort((a, b) => (sold.get(b.id) ?? 0) - (sold.get(a.id) ?? 0) || byName(a, b));
    case 'days':
      return copy.sort((a, b) => {
        const da = daysLeft(a.stockMilli, toUnits(sold.get(a.id) ?? 0) / 30);
        const db = daysLeft(b.stockMilli, toUnits(sold.get(b.id) ?? 0) / 30);
        if (da === db) return byName(a, b);
        if (da === null) return 1;
        if (db === null) return -1;
        return da - db;
      });
  }
}

/** Units to order so the stock gets back to twice the minimum (at least one unit). Milli. */
export function suggestedOrderMilli(p: ProductSummary): number {
  const target = p.minStockMilli > 0 ? p.minStockMilli * 2 : 10_000;
  return Math.max(target - p.stockMilli, 1_000);
}

/** Days of stock left at the average daily sales of the last 30 days; null without sales. */
export function daysLeft(stockMilli: number, avgPerDay: number): number | null {
  if (avgPerDay <= 0) return null;
  return Math.max(0, Math.floor(toUnits(stockMilli) / avgPerDay));
}

export interface SalesDays {
  /** Units sold per day, oldest first, 30 entries. */
  days: number[];
  avgPerDay: number;
}

/** Sales of the last 30 days from the movements (only `sale` rows count). */
export function salesByDay(movements: InventoryMovementSummary[], now = Date.now()): SalesDays {
  const days = new Array<number>(30).fill(0);
  for (const m of movements) {
    if (m.movementType !== 'sale') continue;
    const age = Math.floor((now - new Date(m.createdAt).getTime()) / 86_400_000);
    if (age < 0 || age > 29) continue;
    days[29 - age] = (days[29 - age] ?? 0) + Math.max(0, -m.quantityMilliDelta) / 1000;
  }
  const total = days.reduce((a, b) => a + b, 0);
  return { days, avgPerDay: total / 30 };
}

/** The order list as plain text, one line per product. */
export function orderText(list: ProductSummary[]): string {
  return list.map((p) => `${p.name} — ${toUnits(suggestedOrderMilli(p))} ${p.unitCode}`).join('\n');
}

const csvCell = (value: string | number | null): string => {
  const text = value === null ? '' : String(value);
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** CSV of the products on screen, with a byte-order mark so Excel reads the letters. */
export function stockCsv(list: ProductSummary[], status: (p: ProductSummary) => string): string {
  const header = [
    'Produkti',
    'SKU',
    'Kategoria',
    'Stoku',
    'Minimumi',
    'Njësia',
    'Statusi',
    'Çmimi i shitjes',
    'Çmimi i blerjes',
  ];
  const rows = list.map((p) => [
    p.name,
    p.sku,
    p.categoryName ?? '',
    toUnits(p.stockMilli),
    toUnits(p.minStockMilli),
    p.unitCode,
    status(p),
    (p.sellingPriceCents / 100).toFixed(2).replace('.', ','),
    (p.purchaseCostCents / 100).toFixed(2).replace('.', ','),
  ]);
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(';'));
  return `\uFEFF${lines.join('\r\n')}`;
}

/** Stock by a product's variants is not known from the list alone; the label is shown instead. */
export const isLarge = (units: number): boolean => units >= 100;
