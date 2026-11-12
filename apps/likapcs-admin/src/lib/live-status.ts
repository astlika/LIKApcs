/**
 * The live connection to the server (`/ws/admin`), readable from any screen. The green PC icon
 * in the top bar is this state: when it is not `connected`, a POS sale goes to the offline queue
 * (Punkti 4, 0.28.0). AppShell publishes it; the POS reads it.
 */
import { useSyncExternalStore } from 'react';
import type { LiveStatus } from './ws';

let current: LiveStatus = 'disconnected';
const listeners = new Set<() => void>();

export function publishLiveStatus(status: LiveStatus): void {
  if (status === current) return;
  current = status;
  for (const listener of listeners) listener();
}

export function getLiveStatus(): LiveStatus {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(subscribe, getLiveStatus, getLiveStatus);
}
