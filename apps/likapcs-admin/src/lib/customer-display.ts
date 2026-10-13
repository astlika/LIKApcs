/**
 * Customer display (0.16.0) — the link between the POS window and the customer-facing screen.
 *
 * The display is a second window of the Admin app (`display.html`, see `src/display/`) that the
 * cashier puts on the monitor turned towards the customers. It is a *dumb* screen: it never
 * talks to the server and holds no token. The main window owns every fact and pushes it over a
 * one-way channel:
 *
 *  - `DisplayState` — what the customer should see right now (ads while idle, the open sale
 *    line by line, the payment being counted, the thank-you screen);
 *  - `CustomerDisplayFeed` — the ads program (`GET /ads/feed`), refreshed by the main window.
 *
 * Transport: `BroadcastChannel` (same origin — the browser build and both Tauri webviews share
 * one profile) *and* Tauri events when running on the desktop; the display de-duplicates by
 * `(source, seq)` so a message delivered twice is harmless. The display announces itself with a
 * `hello` and the main window answers with the full state + feed, so it can be opened (or
 * reloaded) at any time.
 *
 * Which monitor / whether this PC uses a display at all is a per-PC choice (localStorage), not a
 * business setting: a second Admin PC may have no second monitor.
 */
import type { CustomerDisplayFeed } from '@likapcs/shared';
import { isDesktopApp } from './updater';

export const DISPLAY_CHANNEL = 'likapcs-customer-display';
/** How long the thank-you screen stays after a completed sale. */
export const DISPLAY_THANKS_SECONDS = 8;

export interface DisplayLine {
  id: string;
  name: string;
  quantityMilli: number;
  unitPriceCents: number;
  /** After the line discount. */
  totalCents: number;
  /** Regular price when the unit price is a promo, otherwise null. */
  regularPriceCents: number | null;
  /** Absolute URL of the product picture (square, small), or null. */
  imageUrl: string | null;
}

export interface DisplayCustomer {
  name: string;
  /** Open debt (null when none). */
  balanceDueCents: number | null;
  /** Prepaid balance (null when the wallet feature is off). */
  walletBalanceCents: number | null;
}

export type DisplayTenderMode = 'cash' | 'credit' | 'wallet' | 'split' | 'card' | 'endpay';

export interface DisplaySale {
  lines: DisplayLine[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  itemCount: number;
  customer: DisplayCustomer | null;
  /** Id of the line changed last (highlighted on the screen). */
  lastLineId: string | null;
}

export interface DisplayTender {
  mode: DisplayTenderMode;
  /** Money handed over now (cash + balance), 0 while nothing was typed. */
  paidCents: number;
  cashCents: number;
  walletCents: number;
  /** Put on the customer's tab. */
  creditCents: number;
  changeCents: number;
  covered: boolean;
}

export interface DisplayDone {
  receiptNo: string | null;
  totalCents: number;
  paidCents: number;
  changeCents: number;
  creditCents: number;
  /** Customer's balances after the sale, when a customer was attached. */
  customer: DisplayCustomer | null;
  /** Epoch ms of the completion (the display times its 8 s from it). */
  at: number;
}

export type DisplayState =
  | { kind: 'idle' }
  | { kind: 'sale'; sale: DisplaySale }
  | { kind: 'paying'; sale: DisplaySale; tender: DisplayTender }
  | { kind: 'done'; done: DisplayDone };

export interface DisplayBrand {
  businessName: string;
  language: 'en' | 'sq';
  currency: string;
}

/** What travels over the channel (before the envelope adds `source` + `seq`). */
export type DisplayPayload =
  | { type: 'state'; state: DisplayState; brand: DisplayBrand }
  | { type: 'feed'; feed: CustomerDisplayFeed | null }
  | { type: 'hello' };
export type DisplayMessage = DisplayPayload & { source: string; seq: number };

// ─── Channel ────────────────────────────────────────────────────────────────────

type Listener = (message: DisplayMessage) => void;

function makeSource(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
}

/**
 * One end of the link. `post()` sends over every available transport; `subscribe()` receives
 * from all of them, dropping duplicates and the sender's own messages.
 */
export class DisplayChannel {
  readonly source = makeSource();
  private seq = 0;
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<Listener>();
  private seen = new Map<string, number>();
  private unlistenTauri: (() => void) | null = null;
  private started = false;

  private start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.channel = new BroadcastChannel(DISPLAY_CHANNEL);
      this.channel.onmessage = (e: MessageEvent<DisplayMessage>) => this.receive(e.data);
    } catch {
      this.channel = null;
    }
    if (isDesktopApp()) {
      void import('@tauri-apps/api/event')
        .then(({ listen }) =>
          listen<DisplayMessage>(DISPLAY_CHANNEL, (e) => this.receive(e.payload)),
        )
        .then((off) => {
          this.unlistenTauri = off;
        })
        .catch(() => {
          /* events unavailable — the BroadcastChannel still works */
        });
    }
  }

  private receive(message: DisplayMessage | null | undefined): void {
    if (!message || typeof message !== 'object' || message.source === this.source) return;
    const key = `${message.source}/${message.type}`;
    const last = this.seen.get(key);
    if (last !== undefined && message.seq <= last) return;
    this.seen.set(key, message.seq);
    for (const l of this.listeners) l(message);
  }

  subscribe(listener: Listener): () => void {
    this.start();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  post(message: DisplayPayload): void {
    this.start();
    const full: DisplayMessage = { ...message, source: this.source, seq: ++this.seq };
    try {
      this.channel?.postMessage(full);
    } catch {
      /* a non-cloneable payload would throw; every payload here is plain JSON */
    }
    if (isDesktopApp()) {
      void import('@tauri-apps/api/event')
        .then(({ emit }) => emit(DISPLAY_CHANNEL, full))
        .catch(() => {
          /* ignore: BroadcastChannel delivered it */
        });
    }
  }

  close(): void {
    this.channel?.close();
    this.channel = null;
    this.unlistenTauri?.();
    this.unlistenTauri = null;
    this.listeners.clear();
    this.started = false;
  }
}

// ─── Per-PC preferences ───────────────────────────────────────────────────────────

const PREF_KEY = 'likapcs.customerDisplay';

export interface DisplayPrefs {
  /** The display opens with the app on this PC. */
  enabled: boolean;
  /** Monitor name (`MonitorInfo.name`); '' = the first monitor that is not the Admin's. */
  monitor: string;
}

export function loadDisplayPrefs(): DisplayPrefs {
  try {
    const raw = window.localStorage.getItem(PREF_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DisplayPrefs>;
      return { enabled: parsed.enabled === true, monitor: String(parsed.monitor ?? '') };
    }
  } catch {
    /* fall through */
  }
  return { enabled: false, monitor: '' };
}

export function saveDisplayPrefs(prefs: DisplayPrefs): void {
  try {
    window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
}

// ─── Native window ──────────────────────────────────────────────────────────────

export interface MonitorInfo {
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scaleFactor: number;
  /** The monitor the Admin window is on. */
  current: boolean;
  primary: boolean;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

let browserWindow: Window | null = null;

/** Monitors of this PC (desktop only; `[]` in the browser build). */
export async function displayMonitors(): Promise<MonitorInfo[]> {
  if (!isDesktopApp()) return [];
  return invoke<MonitorInfo[]>('display_monitors');
}

/**
 * Opens (or re-shows) the display. Desktop: full screen on the chosen monitor — resolves true —
 * or a windowed preview when this PC has a single monitor (false). Browser: a popup window with
 * the same page, so the feature can be tried without the desktop app.
 */
export async function openCustomerDisplay(monitor: string): Promise<boolean> {
  if (isDesktopApp()) return invoke<boolean>('display_open', { monitor: monitor || null });
  if (browserWindow && !browserWindow.closed) {
    browserWindow.focus();
    return false;
  }
  browserWindow = window.open(
    'display.html',
    'likapcs-customer-display',
    'popup=yes,width=1024,height=640',
  );
  return false;
}

export async function closeCustomerDisplay(): Promise<void> {
  if (isDesktopApp()) return invoke<void>('display_close');
  browserWindow?.close();
  browserWindow = null;
}

export async function isCustomerDisplayOpen(): Promise<boolean> {
  if (isDesktopApp()) return invoke<boolean>('display_is_open');
  return !!browserWindow && !browserWindow.closed;
}
