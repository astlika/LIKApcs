import { describe, expect, it } from 'vitest';
import {
  CLIENT_ADS_GRIDS,
  CLIENT_ADS_LAYOUTS,
  CLIENT_WIDGET_SIZES,
  adsGridSize,
} from '@likapcs/shared';
import { SCREEN_VIEWS } from './screen-views';

describe('SCREEN_VIEWS (0.19.1 screen presets)', () => {
  it('has ten views, unique ids, ids that match their resolution', () => {
    expect(SCREEN_VIEWS).toHaveLength(10);
    const ids = SCREEN_VIEWS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of SCREEN_VIEWS) {
      expect(v.id).toBe(`${v.width}x${v.height}`);
    }
  });

  it('uses only values the settings schema accepts', () => {
    for (const v of SCREEN_VIEWS) {
      expect(CLIENT_WIDGET_SIZES).toContain(v.widget);
      expect(CLIENT_ADS_LAYOUTS).toContain(v.layout);
      expect(CLIENT_ADS_GRIDS).toContain(v.grid);
    }
  });

  it('has grid cell counts that match the grid string', () => {
    for (const v of SCREEN_VIEWS) {
      expect(v.grid).toMatch(/^\d+x\d+$/);
      const { cols, rows } = adsGridSize(v.grid);
      expect(cols * rows).toBe(
        v.grid
          .split('x')
          .map(Number)
          .reduce((a, b) => a * b, 1),
      );
      expect(cols).toBeGreaterThan(0);
      expect(rows).toBeGreaterThan(0);
    }
  });

  it('keeps every grid within the 25-product limit of the largest preset', () => {
    for (const v of SCREEN_VIEWS) {
      const { cols, rows } = adsGridSize(v.grid);
      expect(cols * rows).toBeLessThanOrEqual(25);
    }
  });

  it('gives the 4K view the 5x5 grid', () => {
    const big = SCREEN_VIEWS.find((v) => v.id === '3840x2160');
    expect(big?.grid).toBe('5x5');
    expect(big?.widget).toBe('large');
  });
});
