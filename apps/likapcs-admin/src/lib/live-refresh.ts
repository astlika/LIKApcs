/**
 * 0.37.0 — one refresh per burst of server events.
 *
 * One action at the desk (a session started, a sale) arrives as several events within a few
 * milliseconds, and most of them refresh the same lists; ten PCs switched on together arrive as
 * ten. Each event used to restart the same requests: the server answered every one of them and
 * the Admin threw all but the last away. Here the lists to refresh are gathered for a moment and
 * each is refreshed once.
 */

/** How long the refreshes asked for by server events are gathered before they are sent. */
export const LIVE_REFRESH_DELAY_MS = 200;

export type RefreshKey = readonly unknown[];

export interface RefreshQueue {
  /** Asks for these lists to be refreshed with the next batch. */
  add: (...keys: RefreshKey[]) => void;
  /** Forgets what was asked for (the caller refreshes everything itself). */
  clear: () => void;
  /** Stops the queue: nothing asked for so far is refreshed. */
  stop: () => void;
}

/**
 * `refresh` is called once per distinct key, `delayMs` after the first `add` of a batch — not
 * after the last, so a steady stream of events cannot hold the refreshes back.
 */
export function createRefreshQueue(
  refresh: (key: RefreshKey) => void,
  delayMs: number = LIVE_REFRESH_DELAY_MS,
): RefreshQueue {
  const waiting = new Map<string, RefreshKey>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const keys = [...waiting.values()];
    waiting.clear();
    for (const key of keys) refresh(key);
  };
  return {
    add: (...keys) => {
      for (const key of keys) waiting.set(JSON.stringify(key), key);
      timer ??= setTimeout(flush, delayMs);
    },
    clear: () => waiting.clear(),
    stop: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      waiting.clear();
    },
  };
}
