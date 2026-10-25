import type { StationSummary } from '@likapcs/shared';

/**
 * Which selected PCs will get the minutes and which will be skipped (the server skips the same
 * ones): no live session (`no_session`) or a postpaid session (`postpaid`).
 */
export function bulkEligibility(stations: StationSummary[]) {
  const will: StationSummary[] = [];
  const wont: { station: StationSummary; reason: 'no_session' | 'postpaid' }[] = [];
  for (const s of stations) {
    if (!s.activeSession) wont.push({ station: s, reason: 'no_session' });
    else if (s.activeSession.billingMode === 'postpaid')
      wont.push({ station: s, reason: 'postpaid' });
    else will.push(s);
  }
  return { will, wont };
}
