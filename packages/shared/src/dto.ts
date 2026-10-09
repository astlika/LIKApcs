import { z } from 'zod';
import { ALL_ROLE_CODES } from './permissions.js';
import { LANGUAGES } from './settings.js';

/**
 * HTTP API request/response contracts (v1). The server validates every request body with these
 * schemas; the Admin uses the inferred types. See docs/network-protocol.md.
 */

// ─── Common ────────────────────────────────────────────────────────────────────
export const uuidSchema = z.string().uuid();

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

// ─── System / setup ────────────────────────────────────────────────────────────
export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  schemaVersion: number;
  database: 'ok' | 'error';
  time: string;
}

export interface SetupStatusResponse {
  needsSetup: boolean;
  businessName: string;
  defaultLanguage: 'en' | 'sq';
}

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), 'Password must contain letters and numbers');

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Only letters, digits, dot, underscore and dash are allowed');

export const setupRequestSchema = z.object({
  businessName: z.string().trim().min(1).max(120),
  language: z.enum(LANGUAGES).default('en'),
  owner: z.object({
    fullName: z.string().trim().min(1).max(120),
    username: usernameSchema,
    password: passwordSchema,
  }),
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

// ─── Auth ──────────────────────────────────────────────────────────────────────
export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface UserSummary {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  roles: string[];
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedUser extends UserSummary {
  permissions: string[];
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: AuthenticatedUser;
}

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

// ─── Users & roles ─────────────────────────────────────────────────────────────
export const createUserSchema = z.object({
  username: usernameSchema,
  fullName: z.string().trim().min(1).max(120),
  password: passwordSchema,
  email: z.string().trim().email().max(120).nullish(),
  phone: z.string().trim().max(40).nullish(),
  roles: z.array(z.enum(ALL_ROLE_CODES as [string, ...string[]])).min(1),
  mustChangePassword: z.boolean().default(true),
});
export type CreateUserRequest = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().max(120).nullish(),
  phone: z.string().trim().max(40).nullish(),
  roles: z
    .array(z.enum(ALL_ROLE_CODES as [string, ...string[]]))
    .min(1)
    .optional(),
  isActive: z.boolean().optional(),
});
export type UpdateUserRequest = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({
  newPassword: passwordSchema,
  mustChangePassword: z.boolean().default(true),
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordSchema>;

export interface RoleSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  rank: number;
  permissions: string[];
}

// ─── Stations & devices ────────────────────────────────────────────────────────
export const STATION_STATUSES = [
  'disabled',
  'offline',
  'available',
  'occupied',
  'paused',
  'locked',
  'updating',
  'error',
] as const;
export type StationStatus = (typeof STATION_STATUSES)[number];

export const createStationSchema = z.object({
  number: z.number().int().min(1).max(999),
  name: z.string().trim().min(1).max(60),
  zone: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(500).nullish(),
  isEnabled: z.boolean().default(true),
});
export type CreateStationRequest = z.infer<typeof createStationSchema>;

export const updateStationSchema = createStationSchema.partial();
export type UpdateStationRequest = z.infer<typeof updateStationSchema>;

export interface StationDeviceSummary {
  id: string;
  stationId: string | null;
  machineId: string;
  hostname: string | null;
  osInfo: string | null;
  appVersion: string | null;
  status: 'pending' | 'approved' | 'revoked' | 'rejected';
  registeredAt: string;
  approvedAt: string | null;
  lastSeenAt: string | null;
  lastIp: string | null;
  online: boolean;
}

export interface StationSummary {
  id: string;
  number: number;
  code: string;
  name: string;
  zone: string | null;
  notes: string | null;
  isEnabled: boolean;
  status: StationStatus;
  device: StationDeviceSummary | null;
  activeSession: ActiveSessionSummary | null;
  createdAt: string;
  updatedAt: string;
}

/** Populated from Phase 3 onwards; shape fixed now so clients and UI can rely on it. */
export interface ActiveSessionSummary {
  id: string;
  customerName: string | null;
  billingMode: 'prepaid' | 'postpaid';
  status: 'active' | 'paused';
  startedAt: string;
  endsAt: string | null;
  pausedAt: string | null;
  elapsedSeconds: number;
  remainingSeconds: number | null;
  currentPriceCents: number;
}

export const registerDeviceSchema = z.object({
  machineId: z.string().trim().min(8).max(128),
  hostname: z.string().trim().min(1).max(120),
  osInfo: z.string().trim().max(200).optional(),
  appVersion: z.string().trim().min(1).max(32),
  /** Random secret generated by the client; required to collect the token once approved. */
  registrationSecret: z.string().min(32).max(256),
});
export type RegisterDeviceRequest = z.infer<typeof registerDeviceSchema>;

export interface RegisterDeviceResponse {
  registrationId: string;
  status: 'pending' | 'approved' | 'revoked' | 'rejected';
}

export interface RegistrationPollResponse {
  status: 'pending' | 'approved' | 'revoked' | 'rejected';
  /** Only present once, immediately after approval. */
  deviceToken?: string;
  station?: { id: string; number: number; code: string; name: string };
}

export const approveDeviceSchema = z.object({
  stationId: uuidSchema,
});
export type ApproveDeviceRequest = z.infer<typeof approveDeviceSchema>;

// ─── Audit log ─────────────────────────────────────────────────────────────────
export const auditQuerySchema = paginationQuerySchema.extend({
  action: z.string().trim().max(80).optional(),
  actorUserId: uuidSchema.optional(),
  entityType: z.string().trim().max(60).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  search: z.string().trim().max(120).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditLogEntry {
  id: number;
  occurredAt: string;
  actorUserId: string | null;
  actorDeviceId: string | null;
  actorLabel: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  ipAddress: string | null;
  severity: 'info' | 'warning' | 'critical';
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────
export interface DashboardSummary {
  date: string; // YYYY-MM-DD (business time zone)
  revenue: {
    totalCents: number;
    productSalesCents: number;
    gamingCents: number;
    refundsCents: number;
  };
  purchasesCents: number;
  expensesCents: number;
  costOfGoodsSoldCents: number;
  grossProfitCents: number;
  operatingProfitCents: number;
  cashRegisterBalanceCents: number | null;
  stations: {
    total: number;
    enabled: number;
    online: number;
    available: number;
    occupied: number;
    paused: number;
    offline: number;
    activeSessions: number;
  };
  pendingDevices: number;
  lowStockProducts: number;
  recentAudit: AuditLogEntry[];
}

export interface SystemInfoResponse {
  serverVersion: string;
  schemaVersion: number;
  protocolVersion: number;
  startedAt: string;
  time: string;
  database: { ok: boolean; latencyMs: number };
  counts: { users: number; stations: number; devicesOnline: number; adminConnections: number };
}

// ─── Station commands (Admin → Server → Client) ────────────────────────────────
/** Commands staff can send directly; session.* commands are issued by the session service. */
export const DIRECT_STATION_COMMANDS = [
  'lock',
  'unlock',
  'message.show',
  'power.restart',
  'power.shutdown',
  'update.apply',
] as const;
export type DirectStationCommand = (typeof DIRECT_STATION_COMMANDS)[number];

export const stationCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('lock') }),
  z.object({ command: z.literal('unlock') }),
  z.object({
    command: z.literal('message.show'),
    text: z.string().trim().min(1).max(300),
    durationSeconds: z.number().int().min(3).max(600).default(20),
  }),
  z.object({ command: z.literal('power.restart') }),
  z.object({ command: z.literal('power.shutdown') }),
  z.object({ command: z.literal('update.apply') }),
]);
export type StationCommandRequest = z.infer<typeof stationCommandSchema>;

export interface StationCommandResponse {
  commandId: string;
  command: DirectStationCommand;
  ok: boolean;
  error?: string;
}

export interface ClientUpdatePushResponse {
  /** Online devices running a version older than the server's. */
  outdated: number;
  sent: number;
  results: { deviceId: string; stationId: string; ok: boolean; error?: string }[];
}
