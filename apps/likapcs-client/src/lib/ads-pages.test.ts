import { describe, expect, it } from 'vitest';
import type { ClientAdItem } from '@likapcs/shared';
import { buildPages } from './ads-pages';

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
