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

// ─── Phase 3: pricing & gaming sessions ─────────────────────────────────────

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const weekdays = z.array(z.number().int().min(1).max(7)).min(1).max(7);

export const pricingRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    stationId: z.string().uuid().nullable().default(null),
    daysOfWeek: weekdays.default([1, 2, 3, 4, 5, 6, 7]),
    startTime: clockTime.nullable().default(null),
    endTime: clockTime.nullable().default(null),
    rateCentsPerHour: z.number().int().min(0).max(1_000_000),
    billingIncrementMinutes: z.number().int().min(1).max(120).default(1),
    minimumChargeCents: z.number().int().min(0).max(1_000_000).default(0),
    minimumMinutes: z.number().int().min(0).max(600).default(0),
    roundingMode: z.enum(['up', 'down', 'nearest']).default('up'),
    roundingIncrementCents: z.number().int().min(1).max(1000).default(1),
    isHappyHour: z.boolean().default(false),
    priority: z.number().int().min(-100).max(100).default(0),
    isActive: z.boolean().default(true),
    validFrom: isoDate.nullable().default(null),
    validTo: isoDate.nullable().default(null),
  })
  .refine((r) => (r.startTime === null) === (r.endTime === null), {
    message: 'startTime and endTime must be given together',
    path: ['endTime'],
  });
export type PricingRuleInput = z.infer<typeof pricingRuleSchema>;
export const updatePricingRuleSchema = pricingRuleSchema.innerType().partial();
export type UpdatePricingRuleInput = z.infer<typeof updatePricingRuleSchema>;

export interface PricingRuleSummary {
  id: string;
  name: string;
  stationId: string | null;
  stationCode: string | null;
  daysOfWeek: number[];
  startTime: string | null;
  endTime: string | null;
  rateCentsPerHour: number;
  billingIncrementMinutes: number;
  minimumChargeCents: number;
  minimumMinutes: number;
  roundingMode: 'up' | 'down' | 'nearest';
  roundingIncrementCents: number;
  isHappyHour: boolean;
  priority: number;
  isActive: boolean;
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export const gamingPackageSchema = z.object({
  name: z.string().trim().min(1).max(80),
  durationMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  priceCents: z.number().int().min(0).max(1_000_000),
  stationIds: z.array(z.string().uuid()).nullable().default(null),
  daysOfWeek: weekdays.default([1, 2, 3, 4, 5, 6, 7]),
  startTime: clockTime.nullable().default(null),
  endTime: clockTime.nullable().default(null),
  isPromotional: z.boolean().default(false),
  validFrom: isoDate.nullable().default(null),
  validTo: isoDate.nullable().default(null),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export type GamingPackageInput = z.infer<typeof gamingPackageSchema>;
export const updateGamingPackageSchema = gamingPackageSchema.partial();
export type UpdateGamingPackageInput = z.infer<typeof updateGamingPackageSchema>;

export interface GamingPackageSummary {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  stationIds: string[] | null;
  daysOfWeek: number[];
  startTime: string | null;
  endTime: string | null;
  isPromotional: boolean;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SESSION_STATUSES = ['active', 'paused', 'completed', 'cancelled', 'expired'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const SESSION_END_REASONS = [
  'expired',
  'stopped_by_staff',
  'cancelled',
  'transferred',
  'server_recovery',
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/** Prepaid: either a package or a number of minutes priced by the current rule. */
export const sessionQuoteSchema = z
  .object({
    stationId: z.string().uuid(),
    billingMode: z.enum(['prepaid', 'postpaid']),
    packageId: z.string().uuid().optional(),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
  })
  .refine((q) => q.billingMode === 'postpaid' || Boolean(q.packageId) !== Boolean(q.minutes), {
    message: 'prepaid sessions need either a package or a number of minutes',
    path: ['minutes'],
  });
export type SessionQuoteRequest = z.infer<typeof sessionQuoteSchema>;

export const startSessionSchema = sessionQuoteSchema.innerType().extend({
  customerId: z.string().uuid().optional(),
  customerName: z.string().trim().max(80).optional(),
  /** Prepaid only: how the customer pays now. */
  paymentMethod: z.enum(PAYMENT_METHODS).default('cash'),
  notes: z.string().trim().max(500).optional(),
  /** Idempotency key: a retried request never starts a second session. */
  clientRequestId: z.string().min(8).max(64).optional(),
});
export type StartSessionRequest = z.infer<typeof startSessionSchema>;

export const extendSessionSchema = z
  .object({
    packageId: z.string().uuid().optional(),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
    paymentMethod: z.enum(PAYMENT_METHODS).default('cash'),
    clientRequestId: z.string().min(8).max(64).optional(),
  })
  .refine((e) => Boolean(e.packageId) !== Boolean(e.minutes), {
    message: 'either a package or a number of minutes',
    path: ['minutes'],
  });
export type ExtendSessionRequest = z.infer<typeof extendSessionSchema>;

export const endSessionSchema = z.object({
  /** Postpaid only: discount applied by staff with the pos.discount permission. */
  discountCents: z.number().int().min(0).max(1_000_000).default(0),
  paymentMethod: z.enum(PAYMENT_METHODS).default('cash'),
  notes: z.string().trim().max(500).optional(),
});
export type EndSessionRequest = z.infer<typeof endSessionSchema>;

export interface SessionQuoteResponse {
  billingMode: 'prepaid' | 'postpaid';
  /** Prepaid: minutes bought. Postpaid: null. */
  minutes: number | null;
  /** Prepaid: amount due now. Postpaid: 0. */
  priceCents: number;
  rule: { id: string; name: string; rateCentsPerHour: number } | null;
  package: { id: string; name: string } | null;
  terms: {
    rateCentsPerHour: number;
    billingIncrementMinutes: number;
    minimumMinutes: number;
    minimumChargeCents: number;
    roundingMode: 'up' | 'down' | 'nearest';
    roundingIncrementCents: number;
  };
}

export interface SessionSummary {
  id: string;
  stationId: string;
  stationCode: string;
  stationName: string;
  customerId: string | null;
  customerName: string | null;
  billingMode: 'prepaid' | 'postpaid';
  status: SessionStatus;
  ruleName: string | null;
  packageName: string | null;
  rateCentsPerHour: number;
  /** Pricing terms frozen at start — lets the Admin tick the live price with the shared formula. */
  terms: SessionQuoteResponse['terms'];
  plannedSeconds: number | null;
  startedAt: string;
  endsAt: string | null;
  pausedAt: string | null;
  totalPausedSeconds: number;
  endedAt: string | null;
  endReason: SessionEndReason | null;
  /** Live sessions: seconds billed so far (server clock). Ended: final billable seconds. */
  billableSeconds: number;
  /** Live sessions: price so far (postpaid) or paid amount (prepaid). Ended: final price. */
  currentPriceCents: number;
  quotedPriceCents: number | null;
  discountCents: number;
  finalPriceCents: number | null;
  saleId: string | null;
  receiptNo: string | null;
  billedAt: string | null;
  createdByName: string | null;
  notes: string | null;
  createdAt: string;
}

/** Outcome of the command mirrored to the PC after a session transition. */
export interface ClientAckSummary {
  commandId: string;
  command: string;
  ok: boolean;
  error?: string;
}

export interface SessionMutationResponse {
  session: SessionSummary;
  /** null when no client PC is connected to the station. */
  client: ClientAckSummary | null;
}

export interface SessionEventSummary {
  id: number;
  eventType: string;
  occurredAt: string;
  actorName: string | null;
  payload: Record<string, unknown>;
}

export const sessionListQuerySchema = z.object({
  status: z.enum(SESSION_STATUSES).optional(),
  stationId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;
