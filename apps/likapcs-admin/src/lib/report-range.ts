/** The date ranges the Reports page and the data file offer: today, this week, this month … */
export type RangePreset = 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth' | 'custom';

/** A type alias, not an interface: it is passed as the query of a request. */
export type DateRange = { from: string; to: string };

/** A local calendar date as `YYYY-MM-DD`. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The range of a preset as of `now`; `custom` gives today (the caller keeps its own dates). */
export function presetRange(p: RangePreset, now: Date = new Date()): DateRange {
  const today = isoDate(now);
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: isoDate(y), to: isoDate(y) };
    }
    case 'week': {
      const d = new Date(now);
      const day = (d.getDay() + 6) % 7; // Monday = 0
      d.setDate(d.getDate() - day);
      return { from: isoDate(d), to: today };
    }
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'lastMonth': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: isoDate(first), to: isoDate(last) };
    }
    default:
      return { from: today, to: today };
  }
}
