/**
 * Page sequence of the ads slideshow (pure, unit-tested). Shared by LIKApcs-Client (lock screen,
 * `AdsSlideshow.tsx`) and the Admin's customer display (0.16.0, `display/DisplayAds.tsx`), so a
 * PC and the counter screen play exactly the same program for the same feed.
 *
 * 0.12.0: the slides come in *albums* (`ClientAdAlbum`), each with its own look. The program the
 * PC plays is the concatenation of every album's pages — album 1 completely, then album 2, … —
 * and loops. Every page remembers the album plan it belongs to, so the slideshow renders a grid
 * page and a full-photo page back to back with the right layout each.
 */
import {
  adsGridSize,
  type ClientAdsCaption,
  type ClientAdsImageFit,
  type ClientAdsLayout,
  type ClientAdsStyle,
} from './settings.js';
import type { ClientAdAlbum, ClientAdItem, ClientDisplayConfig } from './protocol.js';

/** One album with every look option resolved against the owner's defaults. */
export interface AlbumPlan {
  /** Album id, or `loose` for the slides that are in no album. */
  key: string;
  name: string;
  index: number;
  layout: ClientAdsLayout;
  grid: { cols: number; rows: number };
  /** Items per grid page / rows per menu board page. */
  perPage: number;
  boardPerPage: number;
  imageFit: ClientAdsImageFit;
  caption: ClientAdsCaption;
  /** Default style of single-slide pages (a slide's own style still wins). */
  style: ClientAdsStyle;
  intervalSeconds: number;
  shuffle: boolean;
  items: ClientAdItem[];
}

/** A page before it is attached to its album (what `buildPages` yields). */
export type BarePage =
  | { key: string; kind: 'slide'; item: ClientAdItem; items: ClientAdItem[] }
  | { key: string; kind: 'grid'; items: ClientAdItem[] }
  | { key: string; kind: 'board'; items: ClientAdItem[] };
export type AdsPage = BarePage & { album: AlbumPlan };

/**
 * Resolve the feed's albums against the display settings. A feed without `albums` (server older
 * than 0.12) becomes one album of the flat list — exactly the pre-album behaviour. Empty albums
 * are dropped.
 */
export function planAlbums(
  albums: ClientAdAlbum[] | null | undefined,
  items: ClientAdItem[],
  ads: ClientDisplayConfig['ads'],
): AlbumPlan[] {
  const source: ClientAdAlbum[] = albums?.length
    ? albums
    : [
        {
          id: null,
          name: '',
          layout: null,
          grid: null,
          imageFit: null,
          caption: null,
          style: null,
          intervalSeconds: null,
          shuffle: null,
          items,
        },
      ];
  return source
    .filter((album) => album.items.length > 0)
    .map((album, index) => {
      const layout = album.layout ?? ads.layout;
      const grid = adsGridSize(album.grid ?? ads.grid);
      // `full` ("big photo") keeps meaning edge-to-edge pictures: its default style is the
      // poster (as before 0.10.0) unless the album says otherwise.
      const style = album.style ?? (layout === 'full' ? 'poster' : (ads.style ?? 'hero'));
      return {
        key: album.id ?? 'loose',
        name: album.name,
        index,
        layout,
        grid,
        perPage: layout === 'grid' ? grid.cols * grid.rows : 1,
        // A board row is one line of text: more fit than picture cells (2×2 → 10, 3×3 → 18).
        boardPerPage: grid.cols * Math.max(5, grid.rows * 2),
        imageFit: album.imageFit ?? ads.imageFit,
        caption: album.caption ?? ads.caption,
        style,
        intervalSeconds: Math.max(3, album.intervalSeconds ?? ads.intervalSeconds),
        shuffle: album.shuffle ?? ads.shuffle,
        items: album.items,
      };
    });
}

/** The whole program: every album's pages in album order (each album shuffled on its own). */
export function buildProgram(plans: AlbumPlan[], seed: number): AdsPage[] {
  return plans.flatMap((plan) =>
    buildPages(
      plan.items,
      plan.layout,
      plan.perPage,
      plan.boardPerPage,
      plan.shuffle,
      seed + plan.index * 7919,
    ).map((page) => ({ ...page, key: `${plan.key}/${page.key}`, album: plan })),
  );
}

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
): BarePage[] {
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
    const boards: BarePage[] = chunk(products, boardPerPage).map((slice, i) => ({
      key: `b${i}:${slice.map((s) => s.id).join(',')}`,
      kind: 'board',
      items: slice,
    }));
    const slides: BarePage[] = others.map((item) => ({
      key: `s:${item.id}`,
      kind: 'slide',
      item,
      items: [item],
    }));
    // Boards and free slides alternate; whichever list is longer trails at the end.
    const pages: BarePage[] = [];
    const n = Math.max(boards.length, slides.length);
    for (let i = 0; i < n; i += 1) {
      if (boards[i]) pages.push(boards[i]!);
      if (slides[i]) pages.push(slides[i]!);
    }
    return pages;
  }
  const pages: BarePage[] = [];
  const maxWeight = ordered.reduce((m, i) => Math.max(m, i.weight || 1), 1);
  for (let round = 0; round < maxWeight; round += 1)
    for (const item of ordered)
      if ((item.weight || 1) > round)
        pages.push({ key: `s:${item.id}#${round}`, kind: 'slide', item, items: [item] });
  return pages;
}
