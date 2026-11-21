import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_REFRESH_DELAY_MS, createRefreshQueue, type RefreshKey } from './live-refresh';

describe('refreshes asked for by server events', () => {
  let refreshed: RefreshKey[];
  const queue = () => createRefreshQueue((key) => refreshed.push(key));

  beforeEach(() => {
    vi.useFakeTimers();
    refreshed = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('nothing is refreshed before the delay has passed', () => {
    const q = queue();
    q.add(['stations'], ['dashboard']);
    vi.advanceTimersByTime(LIVE_REFRESH_DELAY_MS - 1);
    expect(refreshed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(refreshed).toEqual([['stations'], ['dashboard']]);
  });

  it('a burst of events refreshes each list once', () => {
    const q = queue();
    // A session started: session.changed, station.changed and reports.changed, 20 PCs at once.
    for (let pc = 0; pc < 20; pc += 1) {
      q.add(['stations'], ['dashboard'], ['cash'], ['sessions', 'awaiting-payment']);
      q.add(['stations'], ['dashboard'], ['cash'], ['sessions', 'awaiting-payment']);
      q.add(['reports'], ['cash'], ['dashboard'], ['live']);
    }
    vi.advanceTimersByTime(LIVE_REFRESH_DELAY_MS);
    expect(refreshed).toEqual([
      ['stations'],
      ['dashboard'],
      ['cash'],
      ['sessions', 'awaiting-payment'],
      ['reports'],
      ['live'],
    ]);
  });

  it('the delay runs from the first event of a batch, so a steady stream is not held back', () => {
    const q = queue();
    q.add(['stations']);
    vi.advanceTimersByTime(LIVE_REFRESH_DELAY_MS - 50);
    q.add(['orders']);
    vi.advanceTimersByTime(50);
    expect(refreshed).toEqual([['stations'], ['orders']]);
    // What arrives afterwards starts the next batch.
    q.add(['stations']);
    vi.advanceTimersByTime(LIVE_REFRESH_DELAY_MS - 1);
    expect(refreshed).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(refreshed).toEqual([['stations'], ['orders'], ['stations']]);
  });

  it('keys that differ in any part are different lists', () => {
    const q = queue();
    q.add(['sessions'], ['sessions', 'awaiting-payment'], ['display', 'feed'], ['display']);
    vi.advanceTimersByTime(LIVE_REFRESH_DELAY_MS);
    expect(refreshed).toHaveLength(4);
  });

  it('clear forgets the batch; stop also cancels the timer', () => {
    const q = queue();
    q.add(['stations']);
    q.clear();
    vi.advanceTimersByTime(LIVE_REFRESH_DELAY_MS);
    expect(refreshed).toEqual([]);
    // The queue still works after a clear.
    q.add(['cash']);
    vi.advanceTimersByTime(LIVE_REFRESH_DELAY_MS);
    expect(refreshed).toEqual([['cash']]);

    q.add(['stations']);
    q.stop();
    vi.advanceTimersByTime(LIVE_REFRESH_DELAY_MS * 2);
    expect(refreshed).toEqual([['cash']]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
