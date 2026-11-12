import { describe, expect, it } from 'vitest';
import {
  CLIENT_LAYOUT_SETTING_KEYS,
  SETTING_DEFAULTS,
  applyStationLook,
  checkLayoutSettings,
  clientDisplayFromSettings,
  compactLook,
  stationLookSchema,
  wallpaperPath,
} from './index.js';

const house = () => clientDisplayFromSettings({ ...SETTING_DEFAULTS });

describe('per-PC look (0.20.0)', () => {
  it('a PC without overrides keeps the house display, theme included', () => {
    const display = house();
    expect(applyStationLook(display, {}, null)).toEqual({ ...display, wallpaperUrl: null });
    expect(display.widgetTheme).toBe('indigo');
  });

  it('overrides replace only the fields they name', () => {
    const display = house();
    const out = applyStationLook(
      display,
      { widgetTheme: 'emerald', widgetSize: 'small', adsEnabled: false },
      '/api/v1/files/wallpapers/x.png',
    );
    expect(out.widgetTheme).toBe('emerald');
    expect(out.widgetSize).toBe('small');
    expect(out.ads.enabled).toBe(false);
    expect(out.widgetPosition).toBe(display.widgetPosition);
    expect(out.widgetStyle).toBe(display.widgetStyle);
    expect(out.ads.layout).toBe(display.ads.layout);
    expect(out.wallpaperUrl).toBe('/api/v1/files/wallpapers/x.png');
  });

  it('null overrides mean "use the house value"', () => {
    const display = house();
    const out = applyStationLook(display, { widgetSize: null, adsEnabled: null }, null);
    expect(out.widgetSize).toBe(display.widgetSize);
    expect(out.ads.enabled).toBe(display.ads.enabled);
  });

  it('the look schema is strict and checks every value', () => {
    expect(stationLookSchema.safeParse({ widgetTheme: 'sky' }).success).toBe(true);
    expect(stationLookSchema.safeParse({ widgetTheme: 'neon' }).success).toBe(false);
    expect(stationLookSchema.safeParse({ widgetColour: 'red' }).success).toBe(false);
    expect(stationLookSchema.safeParse({ adsEnabled: 'yes' }).success).toBe(false);
  });

  it('compactLook drops nulls so the stored JSON holds only real overrides', () => {
    expect(compactLook({ widgetSize: null, widgetTheme: 'rose', adsEnabled: undefined })).toEqual({
      widgetTheme: 'rose',
    });
  });

  it('wallpaper paths sit under the public files route', () => {
    expect(wallpaperPath('abc.png')).toBe('/api/v1/files/wallpapers/abc.png');
  });
});

describe('layout presets (0.20.0)', () => {
  it('only customer-screen layout keys are allowed in a preset', () => {
    expect(CLIENT_LAYOUT_SETTING_KEYS).toContain('client.widget_theme');
    expect(CLIENT_LAYOUT_SETTING_KEYS.every((k) => k.startsWith('client.'))).toBe(true);
    expect(CLIENT_LAYOUT_SETTING_KEYS).not.toContain('business.name');
    const check = checkLayoutSettings({ 'business.name': 'X' });
    expect(check.ok).toBe(false);
  });

  it('keeps valid values and rejects bad ones, with the offending key', () => {
    const good = checkLayoutSettings({
      'client.widget_theme': 'violet',
      'client.widget_size': 'small',
    });
    expect(good).toEqual({
      ok: true,
      settings: { 'client.widget_theme': 'violet', 'client.widget_size': 'small' },
    });
    const bad = checkLayoutSettings({ 'client.widget_theme': 'neon' });
    expect(bad).toMatchObject({ ok: false, key: 'client.widget_theme' });
  });

  it('refuses an empty preset and a non-object', () => {
    expect(checkLayoutSettings({}).ok).toBe(false);
    expect(checkLayoutSettings(null).ok).toBe(false);
    expect(checkLayoutSettings([]).ok).toBe(false);
  });
});
