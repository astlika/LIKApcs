import { describe, expect, it } from 'vitest';
import {
  SETTING_DEFAULTS,
  SETTING_KEYS,
  SETTING_SCHEMAS,
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
