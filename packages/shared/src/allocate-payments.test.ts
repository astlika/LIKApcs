import { describe, expect, it } from 'vitest';
import { allocatePayments } from './allocate-payments.js';

describe('allocatePayments (one tender step, many bills)', () => {
  it('gives each bill its own amount and returns the excess cash as change (not a payment)', () => {
    const out = allocatePayments([{ method: 'cash', amountCents: 1000 }], [300, 300, 300]);
    expect(out).toEqual([
      [{ method: 'cash', amountCents: 300 }],
      [{ method: 'cash', amountCents: 300 }],
      [{ method: 'cash', amountCents: 300 }],
    ]);
  });

  it('uses non-cash tenders first, then cash, splitting across bills', () => {
    const out = allocatePayments(
      [
        { method: 'cash', amountCents: 500 },
        { method: 'card', amountCents: 400, reference: 'T1' },
      ],
      [300, 300, 300],
    );
    expect(out).toEqual([
      [{ method: 'card', amountCents: 300, reference: 'T1' }],
      [
        { method: 'card', amountCents: 100, reference: 'T1' },
        { method: 'cash', amountCents: 200 },
      ],
      [{ method: 'cash', amountCents: 300 }],
    ]);
  });

  it('gives a zero bill no pieces', () => {
    expect(allocatePayments([{ method: 'cash', amountCents: 300 }], [0, 300])).toEqual([
      [],
      [{ method: 'cash', amountCents: 300 }],
    ]);
  });

  it('refuses tenders that do not cover the bills', () => {
    expect(() => allocatePayments([{ method: 'cash', amountCents: 500 }], [300, 300])).toThrow(
      /do not cover/,
    );
  });

  it('refuses non-integer or negative bills', () => {
    expect(() => allocatePayments([{ method: 'cash', amountCents: 500 }], [1.5])).toThrow(
      /Invalid bill/,
    );
  });
});
