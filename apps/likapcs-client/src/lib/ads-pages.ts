/**
 * Page sequence of the lock-screen slideshow (pure, unit-tested; see AdsSlideshow.tsx).
 */
import type { ClientAdItem, ClientDisplayConfig } from '@likapcs/shared';

export type AdsPage =
  | { key: string; kind: 'slide'; item: ClientAdItem; items: ClientAdItem[] }
  | { key: string; kind: 'grid'; items: ClientAdItem[] }
  | { key: string; kind: 'board'; items: ClientAdItem[] };

/** Small deterministic PRNG so both layers (and re-renders) agree on one shuffled order. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(list: T[], seed: number): T[] {
  const out = [...list];
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * The page sequence for a layout. Weights only apply to single-slide pages: a weight-2 slide
 * appears once per "round", rounds are concatenated, so repeats are spread out evenly and never
 * adjacent (unless it is the only slide). Grids and boards show each item once per cycle.
 */
export function buildPages(
  items: ClientAdItem[],
  layout: ClientDisplayConfig['ads']['layout'],
  perPage: number,
  boardPerPage: number,
  shuffle: boolean,
  seed: number,
): AdsPage[] {
  const ordered = shuffle ? shuffled(items, seed) : items;
  if (layout === 'grid')
    return chunk(ordered, perPage).map((slice, i) => ({
      key: `g${i}:${slice.map((s) => s.id).join(',')}`,
      kind: 'grid',
      items: slice,
    }));
  if (layout === 'menu') {
    const products = ordered.filter((i) => i.kind === 'product' && i.priceCents !== null);
    const others = ordered.filter((i) => !(i.kind === 'product' && i.priceCents !== null));
    const boards: AdsPage[] = chunk(products, boardPerPage).map((slice, i) => ({
      key: `b${i}:${slice.map((s) => s.id).join(',')}`,
      kind: 'board',
      items: slice,
    }));
    const slides: AdsPage[] = others.map((item) => ({
      key: `s:${item.id}`,
      kind: 'slide',
      item,
      items: [item],
    }));
    // Boards and free slides alternate; whichever list is longer trails at the end.
    const pages: AdsPage[] = [];
    const n = Math.max(boards.length, slides.length);
    for (let i = 0; i < n; i += 1) {
      if (boards[i]) pages.push(boards[i]!);
      if (slides[i]) pages.push(slides[i]!);
    }
    return pages;
  }
  const pages: AdsPage[] = [];
  const maxWeight = ordered.reduce((m, i) => Math.max(m, i.weight || 1), 1);
  for (let round = 0; round < maxWeight; round += 1)
    for (const item of ordered)
      if ((item.weight || 1) > round)
        pages.push({ key: `s:${item.id}#${round}`, kind: 'slide', item, items: [item] });
  return pages;
}
