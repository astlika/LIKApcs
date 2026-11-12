import { describe, expect, it } from 'vitest';
import type { StationSummary } from '@likapcs/shared';
import { bulkEligibility } from './bulk-eligibility';

const pc = (code: string, billingMode: 'prepaid' | 'postpaid' | 'endpay' | null) =>
  ({
    code,
    activeSession: billingMode ? { id: code, billingMode } : null,
  }) as unknown as StationSummary;

describe('bulkEligibility', () => {
  it('splits a selection into PCs that get minutes and PCs skipped with a reason', () => {
    const { will, wont } = bulkEligibility([
      pc('PC1', 'prepaid'),
      pc('PC2', null),
      pc('PC3', 'endpay'),
      pc('PC4', 'postpaid'),
      pc('PC5', 'prepaid'),
    ]);
    expect(will.map((s) => s.code)).toEqual(['PC1', 'PC3', 'PC5']);
    expect(wont.map((w) => [w.station.code, w.reason])).toEqual([
      ['PC2', 'no_session'],
      ['PC4', 'postpaid'],
    ]);
  });

  it('gives nothing to a selection with no live session', () => {
    const { will, wont } = bulkEligibility([pc('PC1', null), pc('PC2', null)]);
    expect(will).toEqual([]);
    expect(wont).toHaveLength(2);
  });
});
