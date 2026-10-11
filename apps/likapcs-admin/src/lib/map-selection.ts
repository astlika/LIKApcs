/**
 * Pure helpers behind the stations-map multi-selection (marquee, Ctrl/Shift+click) and the
 * bulk-command summaries. Kept free of React/DOM so they can be unit tested.
 */

export interface SelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Display order of the map: one array per zone group (sorted by zone, no-zone last). */
export function mapOrder<T extends { zone?: string | null }>(
  stations: T[],
  groupByZone: boolean,
): T[][] {
  if (!groupByZone) return [stations];
  const map = new Map<string | null, T[]>();
  for (const s of stations) {
    const key = s.zone?.trim() || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a ?? '\uffff').localeCompare(b ?? '\uffff'))
    .map(([, items]) => items);
}

/** Ids between the anchor and `id` (inclusive, display order); null when either is not shown. */
export function rangeIds(order: readonly { id: string }[], anchorId: string, id: string) {
  const a = order.findIndex((s) => s.id === anchorId);
  const b = order.findIndex((s) => s.id === id);
  if (a < 0 || b < 0) return null;
  const [from, to] = a < b ? [a, b] : [b, a];
  return order.slice(from, to + 1).map((s) => s.id);
}

/** Ctrl+click: add or remove one id; the anchor moves to the clicked PC or the last one left. */
export function toggleId(
  selected: readonly string[],
  id: string,
): { ids: string[]; anchor: string | null } {
  if (selected.includes(id)) {
    const ids = selected.filter((x) => x !== id);
    return { ids, anchor: ids[ids.length - 1] ?? null };
  }
  return { ids: [...selected, id], anchor: id };
}

/** Union that keeps the original order (first occurrence wins). */
export function unionIds(base: readonly string[], extra: readonly string[]): string[] {
  return [...new Set([...base, ...extra])];
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): SelectionRect {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  };
}

/** True when the two boxes touch or overlap (edges count, so a thin marquee still selects). */
export function intersects(a: SelectionRect, b: SelectionRect): boolean {
  return a.right >= b.left && a.left <= b.right && a.bottom >= b.top && a.top <= b.bottom;
}

/** Outcome of one command sent to one PC of a multi-selection. */
export interface BulkOutcome<T extends { code: string } = { code: string }> {
  station: T;
  ok: boolean;
  error?: string;
}

/** Human summary of a bulk command: how many succeeded, how many failed and which. */
export function summarizeBulk<T extends { code: string }>(
  results: readonly BulkOutcome<T>[],
): { ok: number; failed: number; failedCodes: string[] } {
  const failed = results.filter((r) => !r.ok);
  return {
    ok: results.length - failed.length,
    failed: failed.length,
    failedCodes: failed.map((r) => r.station.code),
  };
}
