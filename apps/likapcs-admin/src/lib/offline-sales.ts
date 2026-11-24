/**
 * Punkti 4, shtresa 1 (0.28.0): POS sales made while this PC cannot reach the server.
 *
 * A sale made offline gets this PC's own number (`PC2-000001`) and waits in a local queue. When
 * the connection comes back, the queue is sent to `POST /sales/sync`. The server gives each sale
 * its official receipt number and answers per sale: created, duplicate (already synced, e.g.
 * after a lost answer), or failed (with the reason). Failed sales stay in the list until someone
 * removes them. The queue lives in local storage, so it survives a restart of the app.
 */
import type {
  CreateSaleRequest,
  SyncSaleResult,
  SyncSalesRequest,
  SyncSalesResponse,
} from '@likapcs/shared';

export type OfflineStatus = 'pending' | 'failed';

/** One product line as the cashier saw it (for the offline slip). */
export interface OfflineLine {
  name: string;
  quantityMilli: number;
  unitPriceCents: number;
  lineCents: number;
}

export interface QueuedSale {
  clientRequestId: string;
  localNumber: string;
  totalCents: number;
  lines: OfflineLine[];
  queuedAt: string;
  status: OfflineStatus;
  error: string | null;
  body: QueuedSaleBody;
}

/**
 * The request as it is stored and sent. `accessCodes` (0.34.0) has a default on the server and
 * sales queued by an older version do not carry it; an offline sale never holds internet access.
 */
export type QueuedSaleBody = Omit<CreateSaleRequest, 'accessCodes'> & { accessCodes?: boolean };

export interface SyncedSale {
  localNumber: string;
  receiptNo: string | null;
  syncedAt: string;
}

export interface OfflineSnapshot {
  queue: QueuedSale[];
  synced: SyncedSale[];
  deviceCode: string | null;
}

/** Minimal key/value store; the browser's localStorage, or memory in tests. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const QUEUE_KEY = 'likapcs.offline-sales.v1';
const COUNTER_KEY = 'likapcs.offline-counter.v1';
const SYNCED_KEY = 'likapcs.offline-synced.v1';
const DEVICE_KEY = 'likapcs.device-code.v1';
const SYNC_BATCH = 50;
const SYNCED_KEEP = 20;
const DEVICE_RE = /^PC[1-9]\d{0,2}$/;

function memoryStore(): KeyValue {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

let store: KeyValue = typeof localStorage !== 'undefined' ? localStorage : memoryStore();

/** Tests (and the app, if it ever needs another store) can replace the storage. */
export function setOfflineStore(next: KeyValue): void {
  store = next;
  cache = load();
  notify();
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function load(): OfflineSnapshot {
  return {
    queue: readJson<QueuedSale[]>(QUEUE_KEY, []),
    synced: readJson<SyncedSale[]>(SYNCED_KEY, []),
    deviceCode: readJson<string | null>(DEVICE_KEY, null),
  };
}

let cache: OfflineSnapshot = load();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function commit(next: OfflineSnapshot): void {
  cache = next;
  store.setItem(QUEUE_KEY, JSON.stringify(next.queue));
  store.setItem(SYNCED_KEY, JSON.stringify(next.synced));
  store.setItem(DEVICE_KEY, JSON.stringify(next.deviceCode));
  notify();
}

export function getOfflineSnapshot(): OfflineSnapshot {
  return cache;
}

export function subscribeOffline(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The number this PC gives its sales offline. Set once per PC (e.g. `PC2`). */
export function setDeviceCode(code: string): boolean {
  const clean = code.trim().toUpperCase();
  if (!DEVICE_RE.test(clean)) return false;
  commit({ ...cache, deviceCode: clean });
  return true;
}

/**
 * Next local number for this device. Never goes back: it is above every number already queued
 * or synced here, even if the counter was lost.
 */
export function nextLocalNumber(deviceCode: string): string {
  const stored = Number(store.getItem(COUNTER_KEY) ?? 0) || 0;
  const prefix = `${deviceCode}-`;
  const seen = [...cache.queue, ...cache.synced.map((s) => ({ localNumber: s.localNumber }))]
    .map((s) => s.localNumber)
    .filter((n) => n.startsWith(prefix))
    .map((n) => Number(n.slice(prefix.length)) || 0);
  const next = Math.max(stored, ...seen) + 1;
  store.setItem(COUNTER_KEY, String(next));
  return `${prefix}${String(next).padStart(6, '0')}`;
}

export interface OfflineSaleDraft {
  /** The normal sale request (items, payments, notes); its clientRequestId is kept. */
  request: Omit<QueuedSaleBody, 'offline'> & { clientRequestId: string };
  lines: OfflineLine[];
  /** The price each product line showed at the till (without extras). */
  unitPrices: { productId: string; unitPriceCents: number }[];
  totalCents: number;
}

/** Puts a sale in the queue with its local number. Returns the queued sale. */
export function queueOfflineSale(draft: OfflineSaleDraft): QueuedSale {
  const deviceCode = cache.deviceCode;
  if (!deviceCode) throw new Error('OFFLINE_NO_DEVICE');
  const localNumber = nextLocalNumber(deviceCode);
  const queued: QueuedSale = {
    clientRequestId: draft.request.clientRequestId,
    localNumber,
    totalCents: draft.totalCents,
    lines: draft.lines,
    queuedAt: new Date().toISOString(),
    status: 'pending',
    error: null,
    body: {
      ...draft.request,
      offline: {
        deviceCode,
        localNumber,
        createdAt: new Date().toISOString(),
        unitPrices: draft.unitPrices,
      },
    } as CreateSaleRequest,
  };
  commit({ ...cache, queue: [...cache.queue, queued] });
  return queued;
}

export function removeFailedSale(clientRequestId: string): void {
  commit({
    ...cache,
    queue: cache.queue.filter(
      (q) => !(q.clientRequestId === clientRequestId && q.status === 'failed'),
    ),
  });
}

export type SyncSender = (body: SyncSalesRequest) => Promise<SyncSalesResponse>;

export interface FlushOutcome {
  created: number;
  duplicates: number;
  failed: number;
  /** The server could not be reached: the queue stays as it is. */
  unreachable: boolean;
}

/**
 * Sends the pending sales (in the order they were made) and applies the answer. A sale the
 * server answers as created or duplicate leaves the queue; a failed one is kept for review.
 * A network error keeps everything pending for the next try.
 */
export async function flushWith(send: SyncSender): Promise<FlushOutcome> {
  const pending = cache.queue.filter((q) => q.status === 'pending').slice(0, SYNC_BATCH);
  const outcome: FlushOutcome = { created: 0, duplicates: 0, failed: 0, unreachable: false };
  if (pending.length === 0) return outcome;
  let response: SyncSalesResponse;
  try {
    response = await send({ sales: pending.map((p) => p.body) });
  } catch {
    // No answer (network down, or the server errored): nothing is changed, the next try resends.
    return { ...outcome, unreachable: true };
  }
  const byId = new Map<string, SyncSaleResult>(response.results.map((r) => [r.clientRequestId, r]));
  const now = new Date().toISOString();
  let queue = cache.queue;
  const synced: SyncedSale[] = [];
  for (const p of pending) {
    const r = byId.get(p.clientRequestId);
    if (!r) continue; // no answer for it: stays pending
    if (r.status === 'failed') {
      outcome.failed += 1;
      queue = queue.map((q) =>
        q.clientRequestId === p.clientRequestId
          ? {
              ...q,
              status: 'failed' as const,
              error: `${r.error?.code ?? 'failed'}: ${r.error?.message ?? ''}`,
            }
          : q,
      );
      continue;
    }
    if (r.status === 'duplicate') outcome.duplicates += 1;
    else outcome.created += 1;
    queue = queue.filter((q) => q.clientRequestId !== p.clientRequestId);
    synced.push({ localNumber: p.localNumber, receiptNo: r.receiptNo, syncedAt: now });
  }
  commit({
    ...cache,
    queue,
    synced: [...synced, ...cache.synced].slice(0, SYNCED_KEEP),
  });
  return outcome;
}

/** Sends through the real API (dynamic import keeps this module testable without the browser). */
let flushing: Promise<FlushOutcome> | null = null;

/** One send at a time: the interval and the connection event never overlap. */
export function flushOfflineQueue(): Promise<FlushOutcome> {
  if (flushing) return flushing;
  flushing = (async () => {
    const { api } = await import('./api');
    return flushWith((body) => api<SyncSalesResponse>('/sales/sync', { method: 'POST', body }));
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** A sale the PC refuses to queue, with the message to show the cashier. */
export class OfflineRefusedError extends Error {}
