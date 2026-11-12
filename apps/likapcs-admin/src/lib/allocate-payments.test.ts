import { describe, expect, it } from 'vitest';
import { allocatePayments } from './allocate-payments';

describe('allocatePayments (bulk PC start)', () => {
  it('gives every bill exactly its own cash amount; the rest is the cashier’s change', () => {
    const out = allocatePayments([{ method: 'cash', amountCents: 1000 }], [300, 300, 300]);
    expect(out).toEqual([
      [{ method: 'cash', amountCents: 300 }],
      [{ method: 'cash', amountCents: 300 }],
      [{ method: 'cash', amountCents: 300 }],
    ]);
  });

  it('uses non-cash tenders first, in order, then cash', () => {
    const out = allocatePayments(
      [
        { method: 'cash', amountCents: 400 },
        { method: 'credit', amountCents: 500, dueDate: '2026-11-01' },
      ],
      [300, 300, 300],
    );
    expect(out).toEqual([
      [{ method: 'credit', amountCents: 300, dueDate: '2026-11-01' }],
      [
        { method: 'credit', amountCents: 200, dueDate: '2026-11-01' },
        { method: 'cash', amountCents: 100 },
      ],
      [{ method: 'cash', amountCents: 300 }],
    ]);
  });

  it('handles different prices per PC and a balance tender', () => {
    const out = allocatePayments(
      [
        { method: 'wallet', amountCents: 450 },
        { method: 'cash', amountCents: 200 },
      ],
      [250, 400],
    );
    expect(out).toEqual([
      [{ method: 'wallet', amountCents: 250 }],
      [
        { method: 'wallet', amountCents: 200 },
        { method: 'cash', amountCents: 200 },
      ],
    ]);
  });

  it('a free bill gets no payment', () => {
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
});
