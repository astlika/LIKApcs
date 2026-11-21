import { describe, expect, it } from 'vitest';
import { FOLD_TABLE, foldText, sqlFold } from '../../src/db/fold.js';

describe('foldText — typed text without capitals and accents (0.36.1)', () => {
  it('pairs every accented letter with one plain letter (translate() pairs by position)', () => {
    const from = [...FOLD_TABLE.from];
    const to = [...FOLD_TABLE.to];
    expect(to).toHaveLength(from.length);
    expect(new Set(from).size).toBe(from.length);
    // Plain letters only on the right side, and never a quote that would break the SQL literal.
    expect(FOLD_TABLE.to).toMatch(/^[A-Za-z]+$/);
    expect(FOLD_TABLE.from).not.toContain("'");
  });

  it('folds Albanian letters in either case', () => {
    expect(foldText('Çaj')).toBe('caj');
    expect(foldText('çaj')).toBe('caj');
    expect(foldText('ÇOKOLLATË')).toBe('cokollate');
    expect(foldText('Ujë 0.5l')).toBe('uje 0.5l');
    expect(foldText('Sanduiç')).toBe('sanduic');
  });

  it('folds the other accented Latin letters and leaves the rest alone', () => {
    expect(foldText('Müller Café Šljiva Ülker İçecek')).toBe('muller cafe sljiva ulker icecek');
    expect(foldText('Coca-Cola 0.33L')).toBe('coca-cola 0.33l');
    expect(foldText('SKU-000123')).toBe('sku-000123');
    // A letter typed as a base letter plus a combining mark is the same letter.
    expect(foldText('C\u0327aj')).toBe('caj');
  });

  it('wraps an expression for the database', () => {
    expect(sqlFold('p.name')).toBe(
      `lower(translate(p.name, '${FOLD_TABLE.from}', '${FOLD_TABLE.to}'))`,
    );
  });
});
