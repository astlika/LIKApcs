import { describe, expect, it } from 'vitest';
import { formatHms, projectSession } from './session-time';

describe('session timers', () => {
  it('formats HH:MM:SS and never goes negative', () => {
    expect(formatHms(0)).toBe('00:00:00');
    expect(formatHms(59.9)).toBe('00:00:59');
    expect(formatHms(3661)).toBe('01:01:01');
    expect(formatHms(-5)).toBe('00:00:00');
    expect(formatHms(36_000)).toBe('10:00:00');
  });

  it('projects an active session forward from the fetch time', () => {
    const fetchedAt = Date.parse('2026-10-09T10:00:00Z');
    const now = fetchedAt + 90_000;
    const r = projectSession(
      { status: 'active', billableSeconds: 600, endsAt: '2026-10-09T10:30:00Z', pausedAt: null },
      fetchedAt,
      now,
    );
    expect(r.elapsed).toBe(690);
    expect(r.remaining).toBe(28 * 60 + 30);
  });

  it('freezes elapsed and remaining while paused', () => {
    const fetchedAt = Date.parse('2026-10-09T10:00:00Z');
    const r = projectSession(
      {
        status: 'paused',
        billableSeconds: 600,
        endsAt: '2026-10-09T10:30:00Z',
        pausedAt: '2026-10-09T10:05:00Z',
      },
      fetchedAt,
      fetchedAt + 600_000,
    );
    expect(r.elapsed).toBe(600);
    expect(r.remaining).toBe(25 * 60);
  });

  it('reports no remaining time for open-ended (postpaid) sessions and clamps at zero', () => {
    const fetchedAt = Date.parse('2026-10-09T10:00:00Z');
    expect(
      projectSession(
        { status: 'active', billableSeconds: 10, endsAt: null, pausedAt: null },
        fetchedAt,
        fetchedAt,
      ).remaining,
    ).toBeNull();
    expect(
      projectSession(
        { status: 'active', billableSeconds: 10, endsAt: '2026-10-09T09:00:00Z', pausedAt: null },
        fetchedAt,
        fetchedAt,
      ).remaining,
    ).toBe(0);
  });
});
