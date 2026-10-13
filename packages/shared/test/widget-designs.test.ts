import { describe, expect, it } from 'vitest';
import { CLIENT_WIDGET_STYLES } from '../src/settings.js';
import { WIDGET_DESIGNS, widgetDesign, widgetFootprint } from '../src/widget-designs.js';

describe('widget designs (0.13.0)', () => {
  it('offers thirteen looks and every setting value has exactly one spec', () => {
    expect(CLIENT_WIDGET_STYLES).toHaveLength(13);
    expect(WIDGET_DESIGNS.map((d) => d.id).sort()).toEqual([...CLIENT_WIDGET_STYLES].sort());
    expect(new Set(WIDGET_DESIGNS.map((d) => d.id)).size).toBe(WIDGET_DESIGNS.length);
  });

  it('keeps the two original ids so stored settings stay valid', () => {
    expect(CLIENT_WIDGET_STYLES).toContain('detailed');
    expect(CLIENT_WIDGET_STYLES).toContain('minimal');
    expect(widgetDesign('detailed').transparent).toBe(false);
  });

  it('grows with the footprint size and never produces an empty window', () => {
    for (const d of WIDGET_DESIGNS) {
      const { small, normal, large } = d.footprint;
      expect(small.width).toBeGreaterThan(0);
      expect(small.height).toBeGreaterThan(0);
      expect(normal.width).toBeGreaterThanOrEqual(small.width);
      expect(normal.height).toBeGreaterThanOrEqual(small.height);
      expect(large.width).toBeGreaterThanOrEqual(normal.width);
      expect(large.height).toBeGreaterThanOrEqual(normal.height);
    }
  });

  it('falls back to the classic card for ids this build does not know', () => {
    expect(widgetDesign('hologram').id).toBe('detailed');
    expect(widgetDesign(null).id).toBe('detailed');
    expect(widgetFootprint('ring', 'bogus')).toEqual(widgetDesign('ring').footprint.normal);
    expect(widgetFootprint('dot', 'large')).toEqual(widgetDesign('dot').footprint.large);
  });

  it('"minutes only" designs never show money', () => {
    expect(widgetDesign('minutes').money).toBe('none');
    expect(widgetDesign('dot').money).toBe('none');
  });
});
