import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataExportJobStatus } from '@likapcs/shared';
import type * as ApiModule from './api';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('./api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: apiMock,
}));

import { ApiError } from './api';
import { JobLostError } from './backup-file';
import {
  ALL_DETAIL_PARTS,
  deleteDataFile,
  followDataFile,
  LARGE_FOR_AI_BYTES,
  periodRange,
  rangeIsValid,
  SAVE_CHECK_FROM_PERCENT,
  savePercent,
  startDataFile,
} from './data-file';
import { presetRange } from './report-range';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);
const own = { from: '2026-02-03', to: '2026-02-09' };

describe('periodRange', () => {
  it('the whole history has no dates', () => {
    expect(periodRange('all', own, at(2026, 11, 22))).toBeNull();
  });

  it('own dates are given back as they are', () => {
    expect(periodRange('custom', own, at(2026, 11, 22))).toEqual(own);
  });

  it('the last 7 days are seven days with today, across a month and a year', () => {
    expect(periodRange('last7', own, at(2026, 11, 22))).toEqual({
      from: '2026-11-16',
      to: '2026-11-22',
    });
    expect(periodRange('last7', own, at(2026, 12, 3))).toEqual({
      from: '2026-11-27',
      to: '2026-12-03',
    });
    expect(periodRange('last7', own, at(2027, 1, 2))).toEqual({
      from: '2026-12-27',
      to: '2027-01-02',
    });
  });

  it('the other periods are those of the Reports page', () => {
    const now = at(2026, 11, 22);
    for (const period of ['today', 'yesterday', 'month', 'lastMonth'] as const) {
      expect(periodRange(period, own, now)).toEqual(presetRange(period, now));
    }
  });
});

describe('rangeIsValid', () => {
  it('accepts the whole history, one day and dates in order', () => {
    expect(rangeIsValid(null)).toBe(true);
    expect(rangeIsValid({ from: '2026-11-22', to: '2026-11-22' })).toBe(true);
    expect(rangeIsValid({ from: '2026-01-01', to: '2026-11-22' })).toBe(true);
  });

  it('refuses dates the wrong way round, missing or half typed', () => {
    expect(rangeIsValid({ from: '2026-11-22', to: '2026-11-21' })).toBe(false);
    expect(rangeIsValid({ from: '', to: '2026-11-21' })).toBe(false);
    expect(rangeIsValid({ from: '2026-11-21', to: '' })).toBe(false);
    expect(rangeIsValid({ from: '2026-11-2', to: '2026-11-21' })).toBe(false);
    expect(rangeIsValid({ from: '22/11/2026', to: '23/11/2026' })).toBe(false);
  });
});

describe('savePercent', () => {
  it('writing fills the first part of the bar, reading back the rest', () => {
    expect(savePercent('saving', 0)).toBe(0);
    expect(savePercent('saving', 0.5)).toBe(35);
    expect(savePercent('saving', 1)).toBe(SAVE_CHECK_FROM_PERCENT);
    expect(savePercent('checking_copy', 0)).toBe(SAVE_CHECK_FROM_PERCENT);
    expect(savePercent('checking_copy', 0.5)).toBe(85);
  });

  it('never shows 100 before the copy is confirmed, and never leaves 0–99', () => {
    expect(savePercent('checking_copy', 1)).toBe(99);
    expect(savePercent('checking_copy', 7)).toBe(99);
    expect(savePercent('saving', -1)).toBe(0);
    expect(savePercent('saving', 3)).toBe(SAVE_CHECK_FROM_PERCENT);
  });

  it('only goes up over a whole save', () => {
    const seen: number[] = [];
    for (let i = 0; i <= 50; i += 1) seen.push(savePercent('saving', i / 50));
    for (let i = 0; i <= 50; i += 1) seen.push(savePercent('checking_copy', i / 50));
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(99);
  });
});

describe('what the dialog offers', () => {
  it('ticks every part but the action log', () => {
    expect(ALL_DETAIL_PARTS).not.toContain('audit');
    expect(ALL_DETAIL_PARTS).toContain('sales');
    expect(ALL_DETAIL_PARTS).toContain('cash');
    expect(ALL_DETAIL_PARTS.length).toBe(7);
  });

  it('calls a file large from one megabyte on', () => {
    expect(LARGE_FOR_AI_BYTES).toBe(1_048_576);
  });
});

function status(over: Partial<DataExportJobStatus>): DataExportJobStatus {
  return {
    id: 'job-1',
    state: 'running',
    percent: 10,
    phase: 'sales',
    current: 0,
    total: 100,
    startedAt: '2026-11-22T10:00:00.000Z',
    finishedAt: null,
    error: null,
    result: null,
    ...over,
  };
}

describe('the job on the server', () => {
  beforeEach(() => {
    apiMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with the choices and gives back the id of the job', async () => {
    apiMock.mockResolvedValueOnce({ jobId: 'job-9' });
    const body = {
      from: '2026-11-01',
      to: '2026-11-22',
      formats: ['json' as const, 'txt' as const],
      parts: ['sales' as const],
      hideCustomers: true,
      language: 'sq' as const,
    };
    await expect(startDataFile(body)).resolves.toBe('job-9');
    expect(apiMock).toHaveBeenCalledWith('/reports/data-file', { method: 'POST', body });
  });

  it('reports every answer and ends with the last one', async () => {
    apiMock
      .mockResolvedValueOnce(status({ percent: 10 }))
      .mockResolvedValueOnce(status({ percent: 60, phase: 'cashMovements' }))
      .mockResolvedValueOnce(status({ percent: 100, state: 'succeeded', phase: 'finishing' }));
    const seen: number[] = [];
    const done = followDataFile('job-1', (s) => seen.push(s.percent), { intervalMs: 300 });
    await vi.advanceTimersByTimeAsync(1000);
    const last = await done;
    expect(seen).toEqual([10, 60, 100]);
    expect(last.state).toBe('succeeded');
    expect(apiMock).toHaveBeenCalledTimes(3);
    expect(apiMock).toHaveBeenCalledWith('/reports/data-file/jobs/job-1');
  });

  it('ends with the failure the server reports', async () => {
    apiMock.mockResolvedValueOnce(
      status({ state: 'failed', error: { code: 'EXPORT_INCOMPLETE', message: 'rows changed' } }),
    );
    const last = await followDataFile('job-1', () => undefined);
    expect(last.state).toBe('failed');
    expect(last.error?.code).toBe('EXPORT_INCOMPLETE');
  });

  it('gives up at once when the server no longer knows the job', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'gone'));
    await expect(followDataFile('job-1', () => undefined)).rejects.toBeInstanceOf(JobLostError);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('keeps asking through a short silence', async () => {
    apiMock
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK', 'no answer'))
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK', 'no answer'))
      .mockResolvedValueOnce(status({ percent: 100, state: 'succeeded' }));
    const seen: number[] = [];
    const done = followDataFile('job-1', (s) => seen.push(s.percent), {
      intervalMs: 300,
      patienceMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toMatchObject({ state: 'succeeded' });
    expect(seen).toEqual([100]);
  });

  it('gives up after the server stays silent longer than the patience', async () => {
    apiMock.mockRejectedValue(new ApiError(0, 'NETWORK', 'no answer'));
    const done = followDataFile('job-1', () => undefined, { intervalMs: 300, patienceMs: 5000 });
    const caught = done.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await caught).toBeInstanceOf(JobLostError);
    expect(apiMock.mock.calls.length).toBeGreaterThan(3);
  });

  it('the patience can shrink while the job is followed (after a cancel)', async () => {
    apiMock.mockRejectedValue(new ApiError(0, 'NETWORK', 'no answer'));
    let patienceMs = 60_000;
    const done = followDataFile('job-1', () => undefined, {
      intervalMs: 300,
      patienceMs: () => patienceMs,
    });
    let ended: unknown = null;
    void done.catch((err: unknown) => {
      ended = err;
    });
    // Ten silent seconds: still waiting, the minute is not over.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ended).toBeNull();
    // «Anulo»: four seconds of silence are enough now, and ten have passed already.
    patienceMs = 4000;
    await vi.advanceTimersByTimeAsync(1500);
    expect(ended).toBeInstanceOf(JobLostError);
  });

  it('deleting the copy never throws, even when the server is gone', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(0, 'NETWORK', 'no answer'));
    await expect(deleteDataFile('job-1')).resolves.toBeUndefined();
    expect(apiMock).toHaveBeenCalledWith('/reports/data-file/job-1', { method: 'DELETE' });
  });
});
