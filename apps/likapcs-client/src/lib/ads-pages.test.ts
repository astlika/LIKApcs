import { describe, expect, it } from 'vitest';
import type { ClientAdAlbum, ClientAdItem, ClientDisplayConfig } from '@likapcs/shared';
import { buildPages, buildProgram, planAlbums } from './ads-pages';

function item(id: string, extra: Partial<ClientAdItem> = {}): ClientAdItem {
  return {
    id,
    kind: 'product',
    name: id.toUpperCase(),
    body: null,
    priceCents: 150,
    oldPriceCents: null,
    badge: null,
    imageUrl: null,
    categoryName: null,
    theme: null,
    durationSeconds: null,
    style: null,
    accent: null,
    cta: null,
    endsAt: null,
    weight: 1,
    videoUrl: null,
    ...extra,
  };
}

describe('slideshow pages (ads v2)', () => {
  const items = [item('a', { weight: 3 }), item('b'), item('c', { weight: 2 }), item('d')];

  it('single-slide layouts repeat weighted slides once per round, never back to back', () => {
    const pages = buildPages(items, 'card', 1, 10, false, 1);
    const ids = pages.map((p) => (p.kind === 'slide' ? p.item.id : '?'));
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'a', 'c', 'a']);
    for (let i = 1; i < ids.length; i += 1) expect(ids[i]).not.toBe(ids[i - 1]);
    expect(new Set(pages.map((p) => p.key)).size).toBe(pages.length);
  });

  it('grids ignore weights and show every item once per cycle', () => {
    const pages = buildPages(items, 'grid', 3, 10, false, 1);
    expect(pages.map((p) => p.kind)).toEqual(['grid', 'grid']);
    expect(pages.flatMap((p) => p.items.map((i) => i.id))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('shuffle is deterministic per seed and keeps every item', () => {
    const one = buildPages(items, 'grid', 10, 10, true, 42)[0]!.items.map((i) => i.id);
    const two = buildPages(items, 'grid', 10, 10, true, 42)[0]!.items.map((i) => i.id);
    const other = buildPages(items, 'grid', 10, 10, true, 7)[0]!.items.map((i) => i.id);
    expect(one).toEqual(two);
    expect([...one].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...other].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('menu layout builds price boards of products and alternates custom slides', () => {
    const list = [
      ...items,
      item('promo', { kind: 'custom', priceCents: null, name: 'Happy hour' }),
      item('e'),
    ];
    const pages = buildPages(list, 'menu', 1, 3, false, 1);
    expect(pages.map((p) => p.kind)).toEqual(['board', 'slide', 'board']);
    expect(pages[0]!.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(pages[2]!.items.map((i) => i.id)).toEqual(['d', 'e']);
    expect(pages[1]!.kind === 'slide' && pages[1]!.item.id).toBe('promo');
  });

  it('an empty list yields no pages', () => {
    expect(buildPages([], 'card', 1, 10, true, 3)).toEqual([]);
    expect(buildPages([], 'menu', 1, 10, false, 3)).toEqual([]);
  });
});

describe('albums (0.12.0): own look per album, played one after another', () => {
  const ads = {
    layout: 'card',
    grid: '2x2',
    imageFit: 'contain',
    caption: 'bottom',
    style: 'hero',
    intervalSeconds: 8,
    shuffle: false,
  } as ClientDisplayConfig['ads'];
  const album = (id: string, items: ClientAdItem[], look: Partial<ClientAdAlbum> = {}) =>
    ({
      id,
      name: id,
      layout: null,
      grid: null,
      imageFit: null,
      caption: null,
      style: null,
      intervalSeconds: null,
      shuffle: null,
      items,
      ...look,
    }) as ClientAdAlbum;
  const products = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => item(id));
  const photos = ['f1', 'f2'].map((id) => item(id, { kind: 'custom', priceCents: null }));

  it('a feed without albums (older server) is one album of the flat list with the defaults', () => {
    const plans = planAlbums(undefined, products, ads);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      key: 'loose',
      index: 0,
      layout: 'card',
      perPage: 1,
      imageFit: 'contain',
      caption: 'bottom',
      style: 'hero',
      intervalSeconds: 8,
      shuffle: false,
    });
    expect(planAlbums([], products, ads)[0]!.items).toBe(products);
    expect(planAlbums(undefined, [], ads)).toEqual([]);
  });

  it('resolves null look fields against the owner defaults; `full` defaults to the poster', () => {
    const plans = planAlbums(
      [
        album('grid', products, { layout: 'grid', grid: '3x2', intervalSeconds: 12 }),
        album('empty', []),
        album('photos', photos, { layout: 'full', imageFit: 'cover', caption: 'hidden' }),
        album('menu', products, { layout: 'menu', grid: '3x3', shuffle: true, style: 'split' }),
      ],
      [],
      ads,
    );
    expect(plans.map((p) => [p.key, p.index])).toEqual([
      ['grid', 0],
      ['photos', 1],
      ['menu', 2],
    ]);
    expect(plans[0]).toMatchObject({
      layout: 'grid',
      grid: { cols: 3, rows: 2 },
      perPage: 6,
      imageFit: 'contain',
      caption: 'bottom',
      style: 'hero',
      intervalSeconds: 12,
      shuffle: false,
    });
    expect(plans[1]).toMatchObject({
      layout: 'full',
      perPage: 1,
      imageFit: 'cover',
      caption: 'hidden',
      style: 'poster',
      intervalSeconds: 8,
    });
    expect(plans[2]).toMatchObject({
      layout: 'menu',
      boardPerPage: 18,
      style: 'split',
      shuffle: true,
    });
    // An interval below the minimum is lifted to 3 s.
    expect(
      planAlbums([album('x', photos, { intervalSeconds: 1 })], [], ads)[0]!.intervalSeconds,
    ).toBe(3);
  });

  it('the program plays album 1 completely, then album 2 — each page knows its album', () => {
    const plans = planAlbums(
      [
        album('grid', products, { layout: 'grid', grid: '2x2' }),
        album('photos', photos, { layout: 'full' }),
      ],
      [],
      ads,
    );
    const program = buildProgram(plans, 5);
    expect(program.map((p) => [p.kind, p.album.key, p.items.map((i) => i.id)])).toEqual([
      ['grid', 'grid', ['p1', 'p2', 'p3', 'p4']],
      ['grid', 'grid', ['p5']],
      ['slide', 'photos', ['f1']],
      ['slide', 'photos', ['f2']],
    ]);
    expect(new Set(program.map((p) => p.key)).size).toBe(program.length);
    expect(program.every((p) => p.key.startsWith(`${p.album.key}/`))).toBe(true);
  });

  it('shuffles inside an album only; the album order never changes', () => {
    const plans = planAlbums(
      [album('one', products, { shuffle: true }), album('two', photos, { shuffle: true })],
      [],
      ads,
    );
    const a = buildProgram(plans, 11).map((p) => p.album.key);
    expect(a).toEqual(['one', 'one', 'one', 'one', 'one', 'two', 'two']);
    const ids = (seed: number) =>
      buildProgram(plans, seed)
        .slice(0, 5)
        .map((p) => p.items[0]!.id);
    expect(ids(11)).toEqual(ids(11));
    expect([...ids(11)].sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
});
