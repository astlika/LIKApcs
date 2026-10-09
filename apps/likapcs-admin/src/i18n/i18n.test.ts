import { describe, expect, it } from 'vitest';
import { en } from './en';
import { sq } from './sq';

type Dict = Record<string, unknown>;

function flatten(dict: Dict, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else if (value && typeof value === 'object')
      for (const [k, v] of flatten(value as Dict, path)) out.set(k, v);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n dictionaries', () => {
  const enFlat = flatten(en);
  const sqFlat = flatten(sq);

  it('albanian dictionary has exactly the same keys as english', () => {
    const missing = [...enFlat.keys()].filter((k) => !sqFlat.has(k));
    const extra = [...sqFlat.keys()].filter((k) => !enFlat.has(k));
    expect(missing, `missing in sq: ${missing.join(', ')}`).toEqual([]);
    expect(extra, `unexpected in sq: ${extra.join(', ')}`).toEqual([]);
  });

  it('no translation is empty', () => {
    for (const [key, value] of [...enFlat, ...sqFlat]) expect(value.trim(), key).not.toBe('');
  });

  it('interpolation placeholders match between languages', () => {
    for (const [key, value] of enFlat) {
      expect(placeholders(sqFlat.get(key) ?? ''), key).toEqual(placeholders(value));
    }
  });

  it('dictionaries contain at least the Phase 1 sections', () => {
    for (const section of [
      'app',
      'common',
      'nav',
      'topbar',
      'auth',
      'setup',
      'dashboard',
      'stations',
      'employees',
      'audit',
      'settings',
      'palette',
    ]) {
      expect(en).toHaveProperty(section);
    }
  });
});
