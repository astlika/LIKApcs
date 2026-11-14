import { describe, expect, it } from 'vitest';
import {
  ACCESS_CODES_MAX_PER_LOAD,
  internetPackageName,
  isAccessCode,
  parseAccessCodes,
} from '../src/access-codes.js';
import { internetAccessLoadSchema, internetAccessRemoveSchema } from '../src/dto.js';

describe('parseAccessCodes', () => {
  it('reads one code per line, in the order they were pasted', () => {
    const text = 'kT7m-Qx2P\nA9bc-44Zr\r\n  ZZ11-yy22  \n\n';
    expect(parseAccessCodes(text)).toEqual({
      codes: ['kT7m-Qx2P', 'A9bc-44Zr', 'ZZ11-yy22'],
      repeated: [],
      invalid: [],
      pieces: 3,
    });
  });

  it('reads 75 pasted codes as 75', () => {
    const list = Array.from({ length: 75 }, (_, i) => `WIFI${String(i).padStart(4, '0')}`);
    const parsed = parseAccessCodes(list.join('\n'));
    expect(parsed.codes).toEqual(list);
    expect(parsed.pieces).toBe(75);
  });

  it('reads a row copied from a spreadsheet: tabs, commas, semicolons, spaces', () => {
    expect(parseAccessCodes('AAAA1\tBBBB2, CCCC3;DDDD4  EEEE5').codes).toEqual([
      'AAAA1',
      'BBBB2',
      'CCCC3',
      'DDDD4',
      'EEEE5',
    ]);
  });

  it('drops the quotes of a CSV export and characters that cannot be seen', () => {
    expect(parseAccessCodes('"AAAA1"\n\'BBBB2\'\n\uFEFFCCCC3\u200B\nDD\u00ADDD4').codes).toEqual([
      'AAAA1',
      'BBBB2',
      'CCCC3',
      'DDDD4',
    ]);
  });

  it('keeps each code once and says which ones were repeated', () => {
    const parsed = parseAccessCodes('AAAA1\nBBBB2\nAAAA1\nAAAA1\nCCCC3\nBBBB2');
    expect(parsed.codes).toEqual(['AAAA1', 'BBBB2', 'CCCC3']);
    expect(parsed.repeated).toEqual(['AAAA1', 'BBBB2']);
    expect(parsed.pieces).toBe(6);
  });

  it('treats upper and lower case as different codes, and changes nothing inside a code', () => {
    const parsed = parseAccessCodes('abcd1\nABCD1\nAb-Cd_1.x');
    expect(parsed.codes).toEqual(['abcd1', 'ABCD1', 'Ab-Cd_1.x']);
    expect(parsed.repeated).toEqual([]);
  });

  it('leaves out what is not a code (list numbers, a piece too long) and names it', () => {
    const long = 'x'.repeat(65);
    const parsed = parseAccessCodes(`1. AAAA1\n2. BBBB2\n${long}\nab`);
    expect(parsed.codes).toEqual(['AAAA1', 'BBBB2']);
    expect(parsed.invalid).toEqual(['1.', '2.', long, 'ab']);
    expect(parsed.pieces).toBe(6);
  });

  it('does not take the numbers of a long numbered list for codes', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `${i + 1}. CODE${1000 + i}`);
    const parsed = parseAccessCodes(lines.join('\n'));
    expect(parsed.codes).toHaveLength(120);
    expect(parsed.codes[99]).toBe('CODE1099');
    expect(parsed.invalid).toContain('100.');
    expect(parseAccessCodes('100) AAAA1\n101: BBBB2').codes).toEqual(['AAAA1', 'BBBB2']);
  });

  it('shortens a very long invalid piece when it names it', () => {
    const parsed = parseAccessCodes('y'.repeat(300));
    expect(parsed.invalid[0]).toHaveLength(78);
    expect(parsed.invalid[0]!.endsWith('…')).toBe(true);
  });

  it('gives nothing for an empty paste', () => {
    expect(parseAccessCodes('  \n\t\n')).toEqual({
      codes: [],
      repeated: [],
      invalid: [],
      pieces: 0,
    });
  });
});

describe('isAccessCode', () => {
  it('accepts 4 to 64 visible characters without separators', () => {
    for (const ok of ['1234', 'abCD-12_x.9', 'ë€ç4', 'x'.repeat(64)]) {
      expect(isAccessCode(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      '123',
      'a b c d',
      'a,bcd',
      'a;bcd',
      'ab\ncd',
      'x'.repeat(65),
      'ab\u200Bcd',
    ]) {
      expect(isAccessCode(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('internetPackageName', () => {
  it('names a package from its length', () => {
    expect(internetPackageName('1h')).toBe('Internet 1h');
    expect(internetPackageName('  2   orë ')).toBe('Internet 2 orë');
  });
  it('keeps a name that already says what it is', () => {
    expect(internetPackageName('Internet 1 ditë')).toBe('Internet 1 ditë');
    expect(internetPackageName('WiFi 24h')).toBe('WiFi 24h');
    expect(internetPackageName('wi-fi 1h')).toBe('wi-fi 1h');
    expect(internetPackageName('   ')).toBe('');
  });
});

describe('internet access request schemas', () => {
  const productId = '6f1d2c1e-8a55-4c77-9d57-2d6b8c6f0a11';
  it('a load takes an existing package or a new one, never both and never neither', () => {
    expect(internetAccessLoadSchema.safeParse({ productId, codes: ['AAAA1'] }).success).toBe(true);
    const fresh = internetAccessLoadSchema.parse({
      package: { name: ' Internet 1h ', sellingPriceCents: 100 },
      codes: [],
    });
    expect(fresh.package).toEqual({
      name: 'Internet 1h',
      sellingPriceCents: 100,
      categoryId: null,
      lowAtCodes: 10,
    });
    expect(fresh.allowSoldBefore).toBe(false);
    expect(internetAccessLoadSchema.safeParse({ codes: ['AAAA1'] }).success).toBe(false);
    expect(
      internetAccessLoadSchema.safeParse({
        productId,
        package: { name: 'X', sellingPriceCents: 1 },
        codes: ['AAAA1'],
      }).success,
    ).toBe(false);
    // An existing package needs at least one code; a new one may start empty.
    expect(internetAccessLoadSchema.safeParse({ productId, codes: [] }).success).toBe(false);
  });

  it('a load refuses a piece that is not a code, and more codes than one paste may hold', () => {
    expect(internetAccessLoadSchema.safeParse({ productId, codes: ['a b'] }).success).toBe(false);
    const full = Array.from({ length: ACCESS_CODES_MAX_PER_LOAD }, (_, i) => `C${1000 + i}`);
    expect(internetAccessLoadSchema.safeParse({ productId, codes: full }).success).toBe(true);
    expect(
      internetAccessLoadSchema.safeParse({ productId, codes: [...full, 'ONE-MORE'] }).success,
    ).toBe(false);
  });

  it('a removal names exactly one thing to remove, with a reason', () => {
    const base = { productId, reason: 'wrong paste' };
    expect(internetAccessRemoveSchema.safeParse({ ...base, ids: [1, 2] }).success).toBe(true);
    expect(internetAccessRemoveSchema.safeParse({ ...base, batchId: productId }).success).toBe(
      true,
    );
    expect(internetAccessRemoveSchema.safeParse({ ...base, all: true }).success).toBe(true);
    expect(internetAccessRemoveSchema.safeParse(base).success).toBe(false);
    expect(internetAccessRemoveSchema.safeParse({ ...base, ids: [1], all: true }).success).toBe(
      false,
    );
    expect(internetAccessRemoveSchema.safeParse({ ...base, ids: [] }).success).toBe(false);
    expect(
      internetAccessRemoveSchema.safeParse({ productId, all: true, reason: 'x' }).success,
    ).toBe(false);
  });
});
