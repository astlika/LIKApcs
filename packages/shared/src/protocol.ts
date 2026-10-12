import { z } from 'zod';
import type { PricingTerms } from './billing.js';
import type {
  ClientAdsLayout,
  ClientAdsTransition,
  ClientLockTitle,
  ClientWidgetPosition,
  ClientWidgetSize,
  ClientWidgetStyle,
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
  ]),
  payload: z.record(z.unknown()).default({}),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  clientHelloSchema,
  clientHeartbeatSchema,
  clientAckSchema,
  clientEventSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ─── Admin → Server ────────────────────────────────────────────────────────────
export const adminHelloSchema = z.object({
  type: z.literal('admin.hello'),
  token: z.string().min(16).max(512),
  protocolVersion: z.number().int(),
});
export const adminPingSchema = z.object({ type: z.literal('admin.ping') });

export const adminMessageSchema = z.discriminatedUnion('type', [adminHelloSchema, adminPingSchema]);
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
    remainingSeconds: number | null;
    billing?: ClientSessionBilling;
  };
  /** … unless a staff unlock (maintenance) grant is in force, which survives reconnects. */
  maintenance?: null | { until: string; byName: string | null };
  /** How the customer screen looks (widget, lock title, product slideshow). Added in 0.6.0. */
  display?: ClientDisplayConfig;
}

/**
 * What the PC needs to show money in the countdown widget without ever deciding it: the amount
 * already paid (prepaid) or the terms + a billable-seconds snapshot the running cost is derived
 * from (postpaid). The server stays authoritative — the final price is always computed there.
 */
export interface ClientSessionBilling {
  billingMode: 'prepaid' | 'postpaid';
  /** Prepaid: amount paid for the booked time (grows with extensions). Postpaid: 0. */
  paidCents: number;
  /** Postpaid: pricing terms the running amount is derived from; null for prepaid. */
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
  widgetShowPayment: boolean;
  lockTitle: ClientLockTitle;
  currency: string;
  ads: {
    enabled: boolean;
    layout: ClientAdsLayout;
    transition: ClientAdsTransition;
    intervalSeconds: number;
    showPrice: boolean;
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
  /** Slide text (custom) — null for products. */
  body: string | null;
  /** Price shown (promo price while a promo is live); null for custom slides. */
  priceCents: number | null;
  /** Regular price when `priceCents` is a promo, otherwise null. */
  oldPriceCents: number | null;
  badge: string | null;
  /** Server-relative URL (`/api/v1/files/products/…`), or null for a text slide. */
  imageUrl: string | null;
  categoryName: string | null;
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

export type ServerToClientMessage =
  ServerWelcomeToClient | ServerHeartbeatAck | ServerCommand | ServerDisplay | ServerError;

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

export type ServerToAdminMessage = ServerWelcomeToAdmin | ServerEvent | ServerPong | ServerError;
