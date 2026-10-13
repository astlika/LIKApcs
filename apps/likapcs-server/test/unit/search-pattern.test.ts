import { describe, expect, it } from 'vitest';
import { documentPattern } from '../../src/services/search.js';

describe('documentPattern — how typed text reads as a document number', () => {
  it('understands the full number, with or without dashes, in any case', () => {
    for (const q of ['R-2026-000123', 'r-2026-000123', 'R2026000123', ' r 2026 000123 ']) {
      expect(documentPattern(q), q).toEqual({
        like: 'R-2026-%000123',
        prefix: 'R',
        tail: '%-000123',
        exactNo: 'R-2026-000123',
      });
    }
  });

  it('pads a short counter after the prefix and year', () => {
    expect(documentPattern('R-2026-1')).toEqual({
      like: 'R-2026-%1',
      prefix: 'R',
      tail: '%-000001',
      exactNo: 'R-2026-000001',
    });
  });

  it('prefix + counter ("k12") narrows to that kind and ranks the counter first', () => {
    expect(documentPattern('k12')).toEqual({
      like: 'K-%%12',
      prefix: 'K',
      tail: '%-000012',
      exactNo: null,
    });
  });

  it('a bare number searches every kind but is never exact', () => {
    expect(documentPattern('7')).toEqual({
      like: '%-%7',
      prefix: null,
      tail: '%-000007',
      exactNo: null,
    });
  });

  it('free text becomes a literal contains-search with LIKE wildcards escaped', () => {
    expect(documentPattern('cola')).toEqual({
      like: '%COLA%',
      prefix: null,
      tail: null,
      exactNo: 'COLA',
    });
    expect(documentPattern('50%_x').like).toBe('%50\\%\\_X%');
    // A lone prefix or a dash is not a document.
    expect(documentPattern('R-').prefix).toBeNull();
    expect(documentPattern('B').prefix).toBeNull();
  });
});
