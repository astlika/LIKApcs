import { z } from 'zod';

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
export const clientHelloSchema = z.object({
  type: z.literal('client.hello'),
  token: z.string().min(16).max(512),
  appVersion: z.string().min(1).max(32),
  protocolVersion: z.number().int(),
  machineId: z.string().min(8).max(128),
});

export const clientHeartbeatSchema = z.object({
  type: z.literal('client.heartbeat'),
  ts: z.string().datetime({ offset: true }),
  sessionId: z.string().uuid().nullable().optional(),
  locked: z.boolean().optional(),
  metrics: z
    .object({
      cpuPercent: z.number().min(0).max(100).optional(),
      memoryUsedMb: z.number().int().min(0).optional(),
      uptimeSeconds: z.number().int().min(0).optional(),
    })
    .optional(),
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
  };
  /** … unless a staff unlock (maintenance) grant is in force, which survives reconnects. */
  maintenance?: null | { until: string; byName: string | null };
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
  ServerWelcomeToClient | ServerHeartbeatAck | ServerCommand | ServerError;

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
