import { describe, expect, it } from 'vitest';
import {
  CLIENT_ADS_GRIDS,
  CLIENT_DISPLAY_SETTING_KEYS,
  PUBLIC_SETTING_KEYS,
  SETTING_DEFAULTS,
  SETTING_KEYS,
  SETTING_SCHEMAS,
  adsGridSize,
  clientDisplayFromSettings,
  validateSettingsPatch,
} from '../src/settings.js';

describe('settings schema', () => {
  it('every default satisfies its own schema', () => {
    for (const key of SETTING_KEYS) {
      const result = SETTING_SCHEMAS[key].safeParse(SETTING_DEFAULTS[key]);
      expect(result.success, `default for ${key}`).toBe(true);
    }
  });

  it('accepts valid patches and rejects unknown keys / invalid values', () => {
    expect(
      validateSettingsPatch({ 'business.name': 'Arena X', 'tax.default_rate_bp': 800 }),
    ).toEqual({
      'business.name': 'Arena X',
      'tax.default_rate_bp': 800,
    });
    expect(() => validateSettingsPatch({ 'nope.key': 1 })).toThrow();
    expect(() => validateSettingsPatch({ 'tax.default_rate_bp': 12.5 })).toThrow();
    expect(() => validateSettingsPatch({ 'locale.default_language': 'de' })).toThrow();
    expect(() => validateSettingsPatch('x')).toThrow();
  });
});

describe('client screen options (0018)', () => {
  it('grid presets resolve to columns × rows', () => {
    expect(CLIENT_ADS_GRIDS.map(adsGridSize)).toEqual([
      { cols: 2, rows: 2 },
      { cols: 3, rows: 2 },
      { cols: 4, rows: 2 },
      { cols: 3, rows: 3 },
      { cols: 4, rows: 3 },
      { cols: 4, rows: 4 },
    ]);
  });

  it('validates every screen option and rejects out-of-range values', () => {
    expect(
      validateSettingsPatch({
        'client.ads_grid': '4x3',
        'client.ads_fullscreen': true,
        'client.ads_show_clock': false,
        'client.ads_caption': 'hidden',
        'client.ads_image_fit': 'cover',
        'client.ads_background': 'gold',
        'client.ads_ticker_text': '  Happy hour 18:00 – 20:00  ',
      }),
    ).toEqual({
      'client.ads_grid': '4x3',
      'client.ads_fullscreen': true,
      'client.ads_show_clock': false,
      'client.ads_caption': 'hidden',
      'client.ads_image_fit': 'cover',
      'client.ads_background': 'gold',
      'client.ads_ticker_text': 'Happy hour 18:00 – 20:00',
    });
    expect(() => validateSettingsPatch({ 'client.ads_grid': '5x5' })).toThrow();
    expect(() => validateSettingsPatch({ 'client.ads_caption': 'left' })).toThrow();
    expect(() => validateSettingsPatch({ 'client.ads_background': 'neon' })).toThrow();
    expect(() => validateSettingsPatch({ 'client.ads_ticker_text': 'x'.repeat(201) })).toThrow();
    expect(() => validateSettingsPatch({ 'client.ads_fullscreen': 'yes' })).toThrow();
  });

  it('every screen option travels to the PCs (display keys) and is readable by any staff', () => {
    const screenKeys = SETTING_KEYS.filter((k) => k.startsWith('client.ads_'));
    expect(screenKeys.length).toBe(21);
    for (const key of screenKeys) {
      expect(CLIENT_DISPLAY_SETTING_KEYS, key).toContain(key);
      expect(PUBLIC_SETTING_KEYS, key).toContain(key);
    }
    const display = clientDisplayFromSettings({
      ...SETTING_DEFAULTS,
      'client.ads_grid': '3x3',
      'client.ads_fullscreen': true,
      'client.ads_show_status': false,
      'client.ads_ticker_text': 'Tournament Saturday',
    });
    expect(display.ads).toMatchObject({
      grid: '3x3',
      fullscreen: true,
      showClock: true,
      showBrand: true,
      showStation: true,
      showStatus: false,
      showCategory: true,
      showProgress: true,
      imageFit: 'contain',
      caption: 'bottom',
      motion: true,
      background: 'midnight',
      tickerText: 'Tournament Saturday',
    });
  });
});

describe('0.10.0 — pause, orders and ads v2 settings', () => {
  it('defaults: customers may pause / resume, a customer pause ends after 15 min, orders on', () => {
    expect(SETTING_DEFAULTS['sessions.customer_pause']).toBe(true);
    expect(SETTING_DEFAULTS['sessions.customer_resume']).toBe(true);
    expect(SETTING_DEFAULTS['sessions.pause_max_minutes']).toBe(15);
    expect(SETTING_DEFAULTS['orders.enabled']).toBe(true);
    expect(SETTING_DEFAULTS['orders.settlement']).toBe('ask');
    expect(SETTING_DEFAULTS['client.ads_style']).toBe('hero');
  });
  it('travels to the PCs: pause rules, orders switch, ads style / shuffle / countdown', () => {
    for (const key of [
      'sessions.customer_pause',
      'sessions.customer_resume',
      'sessions.pause_max_minutes',
      'orders.enabled',
      'orders.allow_note',
      'client.ads_style',
      'client.ads_shuffle',
      'client.ads_promo_countdown',
    ] as const)
      expect(CLIENT_DISPLAY_SETTING_KEYS, key).toContain(key);
    const display = clientDisplayFromSettings({
      ...SETTING_DEFAULTS,
      'sessions.customer_pause': false,
      'sessions.pause_max_minutes': 0,
      'orders.enabled': false,
      'client.ads_style': 'split',
      'client.ads_shuffle': true,
    });
    expect(display).toMatchObject({
      customerPause: false,
      customerResume: true,
      pauseMaxMinutes: 0,
      orders: false,
      ordersNote: true,
    });
    expect(display.ads).toMatchObject({ style: 'split', shuffle: true, promoCountdown: true });
  });
  it('rejects a pause limit beyond 4 hours and an unknown settlement mode', () => {
    expect(() => validateSettingsPatch({ 'sessions.pause_max_minutes': 241 })).toThrow();
    expect(() => validateSettingsPatch({ 'orders.settlement': 'later' })).toThrow();
    expect(validateSettingsPatch({ 'orders.settlement': 'on_bill' })).toEqual({
      'orders.settlement': 'on_bill',
    });
  });
});
