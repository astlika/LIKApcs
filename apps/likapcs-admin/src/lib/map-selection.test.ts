import { describe, expect, it } from 'vitest';
import {
  intersects,
  mapOrder,
  normalizeRect,
  rangeIds,
  summarizeBulk,
  toggleId,
  unionIds,
} from './map-selection';

const s = (id: string, zone: string | null = null) => ({ id, zone });

describe('mapOrder', () => {
  it('keeps the server order when zones are not grouped', () => {
    const list = [s('a', 'VIP'), s('b'), s('c', 'Hall')];
    expect(mapOrder(list, false)).toEqual([list]);
  });
  it('groups by zone alphabetically with no-zone last', () => {
    const list = [s('a', 'VIP'), s('b'), s('c', 'Hall'), s('d', ' VIP ')];
    expect(mapOrder(list, true).map((g) => g.map((x) => x.id))).toEqual([['c'], ['a', 'd'], ['b']]);
  });
});

describe('rangeIds / toggleId / unionIds', () => {
  const order = [s('1'), s('2'), s('3'), s('4'), s('5')];
  it('selects the inclusive range in either direction', () => {
    expect(rangeIds(order, '2', '4')).toEqual(['2', '3', '4']);
    expect(rangeIds(order, '4', '2')).toEqual(['2', '3', '4']);
    expect(rangeIds(order, '3', '3')).toEqual(['3']);
  });
  it('returns null when the anchor is not on the map (zone filter changed)', () => {
    expect(rangeIds(order, 'x', '2')).toBeNull();
  });
  it('toggles an id and moves the anchor sensibly', () => {
    expect(toggleId(['1', '2'], '3')).toEqual({ ids: ['1', '2', '3'], anchor: '3' });
    expect(toggleId(['1', '2', '3'], '2')).toEqual({ ids: ['1', '3'], anchor: '3' });
    expect(toggleId(['1'], '1')).toEqual({ ids: [], anchor: null });
  });
  it('unions without duplicates, base order first', () => {
    expect(unionIds(['2', '1'], ['1', '3'])).toEqual(['2', '1', '3']);
  });
});

describe('marquee geometry', () => {
  it('normalises a drag in any direction', () => {
    expect(normalizeRect(50, 60, 10, 20)).toEqual({ left: 10, top: 20, right: 50, bottom: 60 });
  });
  it('hits tiles the box touches, not those beside it', () => {
    const box = normalizeRect(0, 0, 100, 100);
    expect(intersects(box, { left: 90, top: 90, right: 150, bottom: 150 })).toBe(true);
    expect(intersects(box, { left: 100, top: 0, right: 120, bottom: 20 })).toBe(true); // edge
    expect(intersects(box, { left: 101, top: 0, right: 120, bottom: 20 })).toBe(false);
    expect(intersects(box, { left: 0, top: 101, right: 20, bottom: 120 })).toBe(false);
  });
});

describe('summarizeBulk', () => {
  it('counts successes and lists the PCs that failed', () => {
    expect(
      summarizeBulk([
        { station: { code: 'PC 01' }, ok: true },
        { station: { code: 'PC 02' }, ok: false, error: 'offline' },
        { station: { code: 'PC 03' }, ok: false },
      ]),
    ).toEqual({ ok: 1, failed: 2, failedCodes: ['PC 02', 'PC 03'] });
    expect(summarizeBulk([])).toEqual({ ok: 0, failed: 0, failedCodes: [] });
  });
});
