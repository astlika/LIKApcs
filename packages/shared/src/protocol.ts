import { z } from 'zod';
import type { PricingTerms } from './billing.js';
import type { ClientCustomerInfo } from './dto.js';
import type {
  AdTheme,
  ClientAdsCaption,
  ClientAdsGrid,
  ClientAdsImageFit,
  ClientAdsLayout,
  ClientAdsStyle,
  ClientAdsTransition,
  ClientLockTitle,
  ClientWidgetPosition,
  ClientWidgetSize,
  ClientWidgetStyle,
  ClientWidgetTheme,
} from './settings.js';

/**
 * Real-time protocol (WebSocket, JSON text frames). See docs/network-protocol.md.
 *
 * Two endpoints on the server:
 *   /ws/client — LIKApcs-Client devices (authenticated with a device token)
 *   /ws/admin  — LIKApcs Admin instances (authenticated with a user session token)
 *
 * Design rules:
 *  - The first frame on every connection MUST be a hello message; anything else closes the socket.
 *  - Every server→client command carries a unique `commandId` and a per-connection `seq`.
 *    Clients must ack each command exactly once and ignore duplicates (replay protection).
 *  - Server time is authoritative; clients only *display* time derived from server timestamps.
 */

export const PROTOCOL_VERSION = 1;

export const WS_CLOSE_CODES = {
  UNAUTHORIZED: 4001,
  PROTOCOL_ERROR: 4002,
  INCOMPATIBLE_VERSION: 4003,
  REPLACED_BY_NEW_CONNECTION: 4004,
  DEVICE_REVOKED: 4005,
  SERVER_SHUTDOWN: 4010,
} as const;

// ─── Client → Server ───────────────────────────────────────────────────────────
const label = z.string().trim().max(120);
const mb = z.number().int().min(0).max(1_000_000_000);
const temp = z.number().min(-50).max(200);

/** Colon-separated upper-case MAC (`AA:BB:CC:DD:EE:FF`) — the client normalises before sending. */
export const macAddressSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase().replace(/-/g, ':'))
  .pipe(z.string().regex(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/, 'MAC address'));

/**
 * One physical network adapter of the PC (0.7.0, for Wake-on-LAN). `wakeOnMagicPacket` is what
 * Windows reports for the adapter's power management (`null` = could not be read); the BIOS side
 * cannot be read at all — see docs/wake-on-lan.md.
 */
export const networkAdapterSchema = z.object({
  name: label,
  description: label.nullable().optional(),
  mac: macAddressSchema,
  ipv4: z.string().trim().max(45).nullable().optional(),
  up: z.boolean().nullable().optional(),
  wakeOnMagicPacket: z.boolean().nullable().optional(),
});
export type NetworkAdapterInfo = z.infer<typeof networkAdapterSchema>;

/** Static facts about the PC, sent once per connection. Missing = the OS did not expose it. */
export const hardwareInfoSchema = z.object({
  cpu: label.nullable().optional(),
  cpuCores: z.number().int().min(1).max(1024).nullable().optional(),
  cpuThreads: z.number().int().min(1).max(4096).nullable().optional(),
  gpus: z.array(label).max(4).default([]),
  ramTotalMb: mb.nullable().optional(),
  os: label.nullable().optional(),
  diskTotalMb: mb.nullable().optional(),
  /** Physical adapters with their MAC — what Wake-on-LAN needs (0.7.0). */
  network: z.array(networkAdapterSchema).max(8).default([]),
  /** Windows "Fast startup" (hiberboot). While on, most PCs ignore magic packets after a shutdown. */
  fastStartup: z.boolean().nullable().optional(),
});
export type HardwareInfo = z.infer<typeof hardwareInfoSchema>;

/** Live load, sent with every heartbeat. Temperatures only where the platform has sensors. */
export const clientMetricsSchema = z.object({
  cpuPercent: z.number().min(0).max(100).nullable().optional(),
  memoryUsedMb: mb.nullable().optional(),
  memoryTotalMb: mb.nullable().optional(),
  diskFreeMb: mb.nullable().optional(),
  cpuTempC: temp.nullable().optional(),
  gpuTempC: temp.nullable().optional(),
  uptimeSeconds: z.number().int().min(0).optional(),
});
export type ClientMetrics = z.infer<typeof clientMetricsSchema>;

export const clientHelloSchema = z.object({
  type: z.literal('client.hello'),
  token: z.string().min(16).max(512),
  appVersion: z.string().min(1).max(32),
  protocolVersion: z.number().int(),
  machineId: z.string().min(8).max(128),
  hardware: hardwareInfoSchema.optional(),
});

export const clientHeartbeatSchema = z.object({
  type: z.literal('client.heartbeat'),
  ts: z.string().datetime({ offset: true }),
  sessionId: z.string().uuid().nullable().optional(),
  locked: z.boolean().optional(),
  metrics: clientMetricsSchema.optional(),
});

export const clientAckSchema = z.object({
  type: z.literal('client.ack'),
  commandId: z.string().uuid(),
  ok: z.boolean(),
  error: z.string().max(500).optional(),
});

export const clientEventSchema = z.object({
  type: z.literal('client.event'),
  event: z.enum([
    'locked',
    'unlocked',
    'session_expired_locally',
    'maintenance_ended',
    'update_status',
    'error',
    /** Static hardware facts that were not ready at `client.hello` (payload: `HardwareInfo`). */
    'hardware',
    /** Outcome of a `wol.configure` command (payload: `{ok, message, elevated}`), hardware follows. */
    'wol_configured',
    /** Outcome of a `tasks.end` command (payload: `TasksEndedPayload`). */
    'tasks_ended',
    /** 0.17.1: is the countdown widget actually visible on the PC (payload: `WidgetReportPayload`). */
    'widget_report',
  ]),
  payload: z.record(z.unknown()).default({}),
});

/** What the PC reports after closing the listed programs (`client.event` `tasks_ended`). */
export const tasksEndedPayloadSchema = z.object({
  closed: z.array(z.string().max(80)).max(100),
  notRunning: z.array(z.string().max(80)).max(100),
  failed: z.array(z.object({ exe: z.string().max(80), error: z.string().max(300) })).max(100),
  /** Entries the PC refused (protected or malformed) — should be empty, the server filters first. */
  skipped: z.array(z.string().max(80)).max(100),
});
export type TasksEndedPayload = z.infer<typeof tasksEndedPayloadSchema>;

/**
 * The PC's own answer to "can the customer see the countdown?" (0.17.1). `ok` = the widget window
 * is visible, on-screen and not covered by an exclusive-fullscreen app; `detail` says what is
 * wrong otherwise, so the desk sees the cause without walking to the PC.
 */
export const widgetReportPayloadSchema = z.object({
  ok: z.boolean(),
  detail: z.string().max(300),
  at: z.string(),
});
export type WidgetReportPayload = z.infer<typeof widgetReportPayloadSchema>;

// ─── Live screen (remote view, phase 1) ───────────────────────────────────────
/** Largest JPEG frame accepted from a PC, as base64 characters (about 450 KB of JPEG). */
export const REMOTE_FRAME_MAX_BASE64 = 600_000;

export const clientFrameSchema = z.object({
  type: z.literal('client.frame'),
  width: z.number().int().min(1).max(4096),
  height: z.number().int().min(1).max(4096),
  jpeg: z.string().min(16).max(REMOTE_FRAME_MAX_BASE64),
  ts: z.string().datetime({ offset: true }),
});
export type ClientFrame = z.infer<typeof clientFrameSchema>;

export const clientMessageSchema = z.discriminatedUnion('type', [
  clientHelloSchema,
  clientHeartbeatSchema,
  clientAckSchema,
  clientEventSchema,
  clientFrameSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ─── Admin → Server ────────────────────────────────────────────────────────────
export const adminHelloSchema = z.object({
  type: z.literal('admin.hello'),
  token: z.string().min(16).max(512),
  protocolVersion: z.number().int(),
});
export const adminPingSchema = z.object({ type: z.literal('admin.ping') });

export const adminStreamSchema = z.object({
  type: z.enum(['admin.stream_start', 'admin.stream_stop']),
  stationId: z.string().uuid(),
  /** `thumb` for the grid (about one frame every 2–3 s), `focus` for one PC in full (up to 3 fps). */
  mode: z.enum(['thumb', 'focus']).default('focus'),
});

export const adminMessageSchema = z.discriminatedUnion('type', [
  adminHelloSchema,
  adminPingSchema,
  adminStreamSchema,
]);
export type AdminMessage = z.infer<typeof adminMessageSchema>;

// ─── Server → Client ───────────────────────────────────────────────────────────
export const STATION_COMMANDS = [
  'session.start',
  'session.pause',
  'session.resume',
  'session.extend',
  'session.end',
  'lock',
  'unlock',
  'message.show',
  'power.restart',
  'power.shutdown',
  'update.apply',
  /** Turn on "wake on magic packet" + turn off Fast startup on the PC (may need admin consent there). */
  'wol.configure',
  /** End Task (0.17.0): close the owner-listed programs (`payload.exes`), never the client itself. */
  'tasks.end',
  /** 0.18.0: gifted minutes — the widget throws a party-popper celebration (`payload.minutes`). */
  'celebrate',
] as const;
export type StationCommand = (typeof STATION_COMMANDS)[number];

export interface ServerWelcomeToClient {
  type: 'server.welcome';
  protocolVersion: number;
  serverVersion: string;
  serverTime: string;
  station: { id: string; number: number; code: string; name: string };
  heartbeatIntervalSeconds: number;
  offlineAfterSeconds: number;
  language: 'en' | 'sq';
  welcomeMessage: string;
  businessName: string;
  /** null when no session is active; the client must be locked in that case … */
  session: null | {
    id: string;
    status: 'active' | 'paused';
    startedAt: string;
    endsAt: string | null;
    pausedAt: string | null;
    /** 0.10.0: who paused and when a customer pause ends by itself. */
    pausedBy?: 'staff' | 'customer' | 'grace' | null;
    autoResumeAt?: string | null;
    remainingSeconds: number | null;
    billing?: ClientSessionBilling;
  };
  /** … unless a staff unlock (maintenance) grant is in force, which survives reconnects. */
  maintenance?: null | { until: string; byName: string | null };
  /** How the customer screen looks (widget, lock title, product slideshow). Added in 0.6.0. */
  display?: ClientDisplayConfig;
  /** A customer's request for time still waiting on this PC (0.9.0), so a restart keeps showing it. */
  request?: ServerRequestUpdate['request'] | null;
  /** Orders of the running session still open on this PC (0.10.0), newest first. */
  orders?: ServerOrderUpdate['order'][];
}

/**
 * An order from this PC changed (accepted / paid / rejected / …) — pushed so the customer sees
 * the answer instantly. Display facts only; nothing the PC must act on.
 */
export interface ServerOrderUpdate {
  type: 'server.order';
  order: {
    id: string;
    number: number;
    status: 'pending' | 'accepted' | 'paid' | 'billed' | 'rejected' | 'cancelled' | 'void';
    settlement: 'pay_now' | 'on_bill' | null;
    totalCents: number;
    reason: string | null;
    items: { name: string; quantity: number; lineTotalCents: number }[];
    requestedAt: string;
    decidedAt: string | null;
    /** Set when the desk finished preparing it — "on its way" (0.13.0). */
    preparedAt: string | null;
  };
}

/**
 * What the PC needs to show money in the countdown widget without ever deciding it: the amount
 * already paid (prepaid) or the terms + a billable-seconds snapshot the running cost is derived
 * from (postpaid). The server stays authoritative — the final price is always computed there.
 */
export interface ClientSessionBilling {
  billingMode: 'prepaid' | 'postpaid' | 'endpay';
  /** Prepaid: amount paid for the booked time (grows with extensions). Postpaid / end pay: 0. */
  paidCents: number;
  /** End pay (0.14.0): amount due at the desk when the time ends (grows with extensions). Else 0. */
  dueCents?: number;
  /** Postpaid: pricing terms the running amount is derived from; null for prepaid / end pay. */
  terms: PricingTerms | null;
  /** Billable seconds at `asOf` (pauses excluded) — the client counts on from there. */
  billableSeconds: number;
  asOf: string;
}

/** Customer-screen look & feel, derived from the `client.*` settings (see settings.ts). */
export interface ClientDisplayConfig {
  widgetSize: ClientWidgetSize;
  widgetPosition: ClientWidgetPosition;
  widgetStyle: ClientWidgetStyle;
  /** 0.20.0: the widget's colour theme (a per-PC override applies). */
  widgetTheme: ClientWidgetTheme;
  /** 0.20.0: this PC's lock-screen wallpaper (absolute once the PC resolves it), or null. */
  wallpaperUrl: string | null;
  widgetShowPayment: boolean;
  /** 0.19.7: hide the countdown widget while a fullscreen game runs. */
  widgetHideInGames: boolean;
  /** The Windows keys are blocked while a Steam game runs in front. */
  blockWinInGames: boolean;
  lockTitle: ClientLockTitle;
  currency: string;
  /** Pre-filled username of the staff login that a left click on the locked screen opens. */
  staffLoginUsername: string;
  /** Show the small "Client" button (customer login → session requests, 0.9.0). */
  customerLogin: boolean;
  /** 0.10.0: the customer may pause / resume from the PC; a customer pause ends after this many minutes (0 = never). */
  customerPause: boolean;
  customerResume: boolean;
  pauseMaxMinutes: number;
  /** 0.10.0: orders from the seat (the "Order" button in the widget) and whether a note may be added. */
  orders: boolean;
  ordersNote: boolean;
  /** 0.14.0: the menu button on the lock screen — orders may be sent before a session starts. */
  ordersLocked: boolean;
  /** 0.11.0: the prepaid balance is in use — the PC shows the customer's balance (even 0.00). */
  wallet: boolean;
  ads: {
    enabled: boolean;
    layout: ClientAdsLayout;
    transition: ClientAdsTransition;
    intervalSeconds: number;
    showPrice: boolean;
    /** Grid layout: columns × rows per page (`client.ads_grid`, e.g. `3x3` → 9 products). */
    grid: ClientAdsGrid;
    /** The slideshow fills the whole screen; brand / clock / PC code / status become overlays. */
    fullscreen: boolean;
    showClock: boolean;
    showBrand: boolean;
    showStation: boolean;
    showStatus: boolean;
    showCategory: boolean;
    /** Page dots + the thin progress bar of the current slide. */
    showProgress: boolean;
    /** Pictures: `contain` (whole picture, padded) or `cover` (fills the frame, may crop). */
    imageFit: ClientAdsImageFit;
    /** Full layout: where the name / price caption sits. */
    caption: ClientAdsCaption;
    /** Slow zoom / pan on full-screen pictures. */
    motion: boolean;
    /** Lock-screen backdrop behind the slides (`AD_THEMES`). */
    background: AdTheme;
    /** Scrolling line at the bottom; empty = none. */
    tickerText: string;
    /** 0.10.0: default slide style, shuffled rotation, "offer ends in" countdown on promos. */
    style: ClientAdsStyle;
    shuffle: boolean;
    promoCountdown: boolean;
  };
}

/** Pushed to every connected PC when a `client.*` (or related) setting changes. */
export interface ServerDisplay {
  type: 'server.display';
  display: ClientDisplayConfig;
  /** Business name / welcome text travel along so a rename shows up without a reconnect. */
  businessName: string;
  welcomeMessage: string;
  language: 'en' | 'sq';
}

/**
 * Lock-screen slideshow item (`GET /client/ads`, device-token authenticated) — the owner's
 * curated list (Admin › Ads). `product` items carry the current price and, during a promo, the
 * crossed-out regular price in `oldPriceCents`; `custom` items are free slides. `imageUrl` is null
 * for text-only slides.
 */
export interface ClientAdItem {
  id: string;
  kind: 'product' | 'custom';
  /** Product name or slide title. */
  name: string;
  /** Slide text — a custom slide's text or the short line under a product's name. */
  body: string | null;
  /** Price shown (promo price while a promo is live); null for custom slides. */
  priceCents: number | null;
  /** Regular price when `priceCents` is a promo, otherwise null. */
  oldPriceCents: number | null;
  badge: string | null;
  /** Server-relative URL (`/api/v1/files/products/…`), or null for a text slide. */
  imageUrl: string | null;
  categoryName: string | null;
  /** Background preset (`AD_THEMES`); null = `midnight`. */
  theme: AdTheme | null;
  /** Seconds this slide stays; null = `display.ads.intervalSeconds`. */
  durationSeconds: number | null;
  /** 0.10.0 */
  style: ClientAdsStyle | null;
  accent: string | null;
  cta: string | null;
  /** Promo / slide end instant (for the "ends in …" countdown), when scheduled. */
  endsAt: string | null;
  /** 1–3: the slide is repeated that many times in the rotation. */
  weight: number;
  /** Video slide (server-relative or https URL); shown instead of the picture. */
  videoUrl: string | null;
}

/**
 * An album of the slideshow (0.12.0, `ad_albums`): a named group of slides with its own look.
 * The PCs play the albums one after another, in this order — album 1 completely, then album 2,
 * … — and start over. Every look field is `null` when the album keeps the owner's default
 * (`ClientDisplayConfig.ads.*`), so the PC resolves them against the display settings it already
 * has. `id` is null for the slides that are in no album (they play first, with the defaults).
 */
export interface ClientAdAlbum {
  id: string | null;
  name: string;
  layout: ClientAdsLayout | null;
  grid: ClientAdsGrid | null;
  imageFit: ClientAdsImageFit | null;
  caption: ClientAdsCaption | null;
  style: ClientAdsStyle | null;
  intervalSeconds: number | null;
  shuffle: boolean | null;
  items: ClientAdItem[];
}

/**
 * `GET /client/ads`. `items` is the flat list (every live slide, album by album) that pre-0.12
 * clients play with the single layout; `albums` is what a 0.12+ client plays. `nextChangeAt`
 * tells the PC when the weekly schedule next flips a slide on/off.
 */
export interface ClientAdsFeed {
  items: ClientAdItem[];
  albums: ClientAdAlbum[];
  nextChangeAt: string | null;
}

export interface ServerHeartbeatAck {
  type: 'server.heartbeat_ack';
  serverTime: string;
}

export interface ServerCommand {
  type: 'server.command';
  commandId: string;
  seq: number;
  command: StationCommand;
  payload: Record<string, unknown>;
  issuedAt: string;
  /** Commands are rejected by the client after this instant (replay/late-delivery protection). */
  expiresAt: string;
}

export interface ServerError {
  type: 'server.error';
  code: string;
  message: string;
}

/**
 * A session request made on this PC changed (approved / rejected / cancelled) — pushed so the
 * customer sees the answer instantly. Carries the facts the PC shows, nothing it must act on:
 * an approval is followed by the real `session.start` / `session.extend` command.
 */
export interface ServerRequestUpdate {
  type: 'server.request';
  request: {
    id: string;
    kind: 'start' | 'extend';
    status: 'pending' | 'approved' | 'rejected' | 'cancelled';
    reason: string | null;
    decidedAt: string | null;
  };
}

/**
 * The account of the customer this PC is playing on changed (0.11.0): a top-up at the desk, a
 * balance payment, a debt settled. Carries the facts the widget shows; `null` when the running
 * session has no customer. The PC may also ask with `GET /client/customer`.
 */
export interface ServerCustomerUpdate {
  type: 'server.customer';
  customer: ClientCustomerInfo | null;
}

/** Server → client: stream frames while `active` (the grid or a focused PC is open in Admin). */
export interface ServerStream {
  type: 'server.stream';
  active: boolean;
  /** Frames per second to send (0.25–5 in phase 1; the grid uses a fraction of a frame per second). */
  fps: number;
  /** Widest frame the PC should send, in pixels; the PC keeps the aspect ratio. */
  maxWidth: number;
}

export type ServerToClientMessage =
  | ServerWelcomeToClient
  | ServerHeartbeatAck
  | ServerCommand
  | ServerDisplay
  | ServerRequestUpdate
  | ServerOrderUpdate
  | ServerCustomerUpdate
  | ServerStream
  | ServerError;

// ─── Server → Admin ────────────────────────────────────────────────────────────
export const ADMIN_EVENTS = [
  'station.changed',
  'device.registered',
  'device.changed',
  'session.changed',
  'notification',
  /** A backup was restored: every cached view must be reloaded. */
  'system.restored',
  /** A role's permission set changed: signed-in users must refresh their permissions. */
  'permissions.changed',
  /** A customer's session request was created / answered / cancelled (payload: SessionRequest). */
  'request.changed',
  /** An order from a PC was created / answered / settled (payload: StationOrder). */
  'order.changed',
  /** 0.16.0: a slide / album / promo changed — the customer display's feed is stale (no payload). */
  'ads.changed',
] as const;
export type AdminEventName = (typeof ADMIN_EVENTS)[number];

export interface ServerWelcomeToAdmin {
  type: 'server.welcome';
  protocolVersion: number;
  serverVersion: string;
  serverTime: string;
}

export interface ServerEvent<T = unknown> {
  type: 'server.event';
  event: AdminEventName;
  payload: T;
  ts: string;
}

export interface ServerPong {
  type: 'server.pong';
  serverTime: string;
}

/** Server → Admin: one live frame of a station PC. */
export interface ServerFrame {
  type: 'server.frame';
  stationId: string;
  width: number;
  height: number;
  jpeg: string;
  ts: string;
}

/** Server → Admin: whether the PC can send frames right now. */
export interface ServerStreamStatus {
  type: 'server.stream_status';
  stationId: string;
  state: 'live' | 'offline' | 'denied';
}

export type ServerToAdminMessage =
  ServerWelcomeToAdmin | ServerEvent | ServerPong | ServerError | ServerFrame | ServerStreamStatus;
