import { z } from 'zod';
import type { WakeIssue } from './wake.js';
import { ALL_ROLE_CODES } from './permissions.js';
import type { StationLook } from './client-look.js';
import type {
  ClientAdsFeed,
  ClientDisplayConfig,
  ClientMetrics,
  HardwareInfo,
  WidgetReportPayload,
} from './protocol.js';
import {
  AD_THEMES,
  CLIENT_ADS_CAPTIONS,
  CLIENT_ADS_GRIDS,
  CLIENT_ADS_IMAGE_FITS,
  CLIENT_ADS_LAYOUTS,
  CLIENT_ADS_STYLES,
  LANGUAGES,
  type AdTheme,
  type ClientAdsCaption,
  type ClientAdsGrid,
  type ClientAdsImageFit,
  type ClientAdsLayout,
  type ClientAdsStyle,
} from './settings.js';

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
  /** Stable id of this installation (also broadcast by LAN discovery); null for external databases. */
  installationId: string | null;
  /** Business name — lets a client PC show *which* server answered a typed-in address. */
  name: string;
}

/** `GET /system/network` — what staff need to connect a gaming PC by hand. */
export interface NetworkInfoResponse {
  port: number;
  discoveryPort: number;
  discoveryEnabled: boolean;
  /** IPv4 addresses of this machine (first = most likely LAN address). */
  addresses: string[];
  installationId: string | null;
}

export interface SetupStatusResponse {
  needsSetup: boolean;
  businessName: string;
  defaultLanguage: 'en' | 'sq';
}

/**
 * Passwords / PINs: at least 4 characters (the owner asked for short cashier PINs). Brute force is
 * contained by the login rate limit (10/min per IP) and the account lock after repeated failures.
 */
export const PASSWORD_MIN_LENGTH = 4;
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(128);

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
  /**
   * "Stay signed in on this PC": the server issues a long-lived session (LIKAPCS_REMEMBER_DAYS,
   * default 30 days) instead of the default shift-length session (LIKAPCS_SESSION_HOURS).
   */
  rememberMe: z.boolean().optional().default(false),
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

export interface PermissionSummary {
  code: string;
  category: string;
  description: string;
}

/** Full replacement of a role's permission set (PUT /roles/:id/permissions). */
export const updateRolePermissionsSchema = z.object({
  permissions: z.array(z.string().trim().min(1).max(64)).max(200),
});
export type UpdateRolePermissionsRequest = z.infer<typeof updateRolePermissionsSchema>;

// ─── Stations & devices ────────────────────────────────────────────────────────
export const STATION_STATUSES = [
  'disabled',
  'offline',
  'available',
  'occupied',
  'paused',
  'locked',
  /** Unlocked by a staff member for maintenance (no customer session, no billing). */
  'maintenance',
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

/** Archive PC / delete station (0.17.0): the reason is mandatory — it goes to the audit log. */
export const stationReasonSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});
export type StationReasonRequest = z.infer<typeof stationReasonSchema>;

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
  /** CPU / GPU / RAM / OS as reported by the client at connection time; null until it connects. */
  hardware: HardwareInfo | null;
  /** Latest heartbeat load (`at` = when it was received); only meaningful while online. */
  metrics: (ClientMetrics & { at: string }) | null;
  /**
   * End Task (0.17.0): the last "close the programs" run on this PC since its session started
   * (cleared by the next session start) — the button shows as pressed while this is set.
   */
  tasksEnded: StationTasksEnded | null;
  /** 0.17.1: last self-check of the countdown widget on the PC (null = none reported yet). */
  widget: WidgetReportPayload | null;
}

export interface StationTasksEnded {
  at: string;
  /** `pending` until the PC reports back; then what happened. */
  status: 'pending' | 'done' | 'failed';
  /** Programs that were running and got closed. */
  closed: string[];
  /** Listed programs that were not running. */
  notRunning: string[];
  /** Programs the PC could not close (`exe · error`). */
  failed: string[];
  /** Whether the staff pressed the button (`manual`) or the session end triggered it (`auto`). */
  trigger: 'manual' | 'auto';
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
  /** Present while a staff unlock (maintenance) grant is in force. */
  maintenance: StationMaintenance | null;
  /** A customer's request for time waiting for staff (0.9.0); at most one per station. */
  pendingRequest: StationPendingRequest | null;
  /** Orders from the PC (0.10.0): how many wait for an answer and what is still on the bill. */
  orders: StationOrdersSummary;
  /** End pay (0.14.0): ended sessions of this PC whose bill still waits at the desk. */
  awaitingPayment: { count: number; amountCents: number };
  /** Archive PC (0.17.0): set once the station left the floor; it keeps its money history. */
  archived: StationArchive | null;
  /** 0.20.0: this PC's own look overrides (null = house setting). */
  look: StationLook;
  /** 0.20.0: this PC's lock-screen wallpaper (a server path under /api/v1), or null. */
  wallpaperUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Why and when a station was taken off the floor (kept on the row and in the audit log). */
export interface StationArchive {
  at: string;
  reason: string | null;
  byName: string | null;
}

export interface StationOrdersSummary {
  /** Orders staff have not answered yet. */
  pending: number;
  /** Accepted "on the bill" orders not yet settled (count / amount). */
  openCount: number;
  openCents: number;
}

export interface StationMaintenance {
  until: string;
  byUserId: string | null;
  byName: string | null;
}

export interface StationPendingRequest {
  id: string;
  kind: 'start' | 'extend';
  customerId: string;
  customerName: string;
  /** Package duration or the quick duration asked for. */
  durationMinutes: number;
  /** Quick duration (null when a package was asked for). */
  minutes: number | null;
  packageId: string | null;
  packageName: string | null;
  requestedAt: string;
}

/** Staff unlock at the station PC (device-token authenticated, see POST /client/staff-unlock). */
export const staffUnlockSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
  /** Defaults to the `stations.maintenance_minutes` setting. */
  minutes: z.number().int().min(1).max(480).optional(),
});
export type StaffUnlockInput = z.infer<typeof staffUnlockSchema>;

export interface StaffUnlockResponse {
  until: string;
  byName: string;
  minutes: number;
}

/**
 * How a session is billed:
 *   prepaid   fixed time, paid when it starts (extensions are paid too).
 *   postpaid  open time, billed when staff stop it.
 *   endpay    "pay at the end" (0.14.0): fixed time like prepaid, nothing paid at the start; when
 *             the time runs out the PC locks and the bill waits at the desk until staff collect it
 *             (ended early → the used time, capped at the reserved amount).
 */
export const BILLING_MODES = ['prepaid', 'postpaid', 'endpay'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

/** Populated from Phase 3 onwards; shape fixed now so clients and UI can rely on it. */
export interface ActiveSessionSummary {
  id: string;
  customerName: string | null;
  billingMode: BillingMode;
  status: 'active' | 'paused';
  startedAt: string;
  endsAt: string | null;
  pausedAt: string | null;
  pausedBy: SessionPausedBy | null;
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
  'wol.configure',
  'tasks.end',
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
  z.object({ command: z.literal('wol.configure') }),
  /** The list of programs comes from the settings on the server, never from the request. */
  z.object({ command: z.literal('tasks.end') }),
]);
export type StationCommandRequest = z.infer<typeof stationCommandSchema>;

/** `POST /stations/:id/wake` — one magic-packet burst for an offline PC (0.7.0). */
export interface StationWakeResponse {
  stationId: string;
  code: string;
  mac: string;
  /** Where the packets went (broadcasts of every server interface, the limited broadcast, last IP). */
  targets: string[];
  /** Readiness problems the server knows about (the packets were still sent). */
  warnings: WakeIssue[];
}
export interface StationWakeAllResponse {
  sent: StationWakeResponse[];
  skipped: { stationId: string; code: string; reason: 'online' | 'no_mac' | 'no_device' }[];
}

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
    billingMode: z.enum(BILLING_MODES),
    packageId: z.string().uuid().optional(),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
  })
  .refine((q) => q.billingMode === 'postpaid' || Boolean(q.packageId) !== Boolean(q.minutes), {
    message: 'prepaid / end-pay sessions need either a package or a number of minutes',
    path: ['minutes'],
  });
export type SessionQuoteRequest = z.infer<typeof sessionQuoteSchema>;

/**
 * How a session bill is paid. Either the full `payments` array (same shape as a POS sale: cash
 * with change, card, split, `credit` = pay later) or the older single `paymentMethod`, which the
 * server turns into one exact tender. When both are present `payments` wins.
 */
const sessionTenders = {
  paymentMethod: z.enum(PAYMENT_METHODS).default('cash'),
  /**
   * Tenders for the bill. An empty list is "nothing handed over": valid only when nothing is due
   * (a waived collect, a fully discounted end) — a non-zero bill with `[]` is refused (`PAYMENT`).
   */
  payments: z.lazy(() => z.array(salePaymentInputSchema).max(5)).optional(),
};

export const startSessionSchema = sessionQuoteSchema.innerType().extend({
  customerId: z.string().uuid().optional(),
  customerName: z.string().trim().max(80).optional(),
  /** Prepaid only: how the customer pays now. */
  ...sessionTenders,
  notes: z.string().trim().max(500).optional(),
  /** Idempotency key: a retried request never starts a second session. */
  clientRequestId: z.string().min(8).max(64).optional(),
  /** Approving a customer's request: it is marked approved in the same transaction (once). */
  requestId: z.string().uuid().optional(),
  /** 0.19.0: start with minutes from a time credit sold for this PC (prepaid, minutes only). */
  creditId: z.string().uuid().optional(),
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
    ...sessionTenders,
    clientRequestId: z.string().min(8).max(64).optional(),
    /** Approving a customer's extension request (see startSessionSchema.requestId). */
    requestId: z.string().uuid().optional(),
    /** 0.19.0: extend with minutes from a time credit sold for this PC (minutes only). */
    creditId: z.string().uuid().optional(),
  })
  .refine((e) => Boolean(e.packageId) !== Boolean(e.minutes), {
    message: 'either a package or a number of minutes',
    path: ['minutes'],
  });
export type ExtendSessionRequest = z.infer<typeof extendSessionSchema>;

/** 0.18.0: free minutes for a running session (`sessions.gift`) — no sale, no money, full audit. */
export const sessionGiftSchema = z.object({
  minutes: z.number().int().min(1).max(600),
  reason: z.string().trim().max(200).optional(),
});
export type SessionGiftRequest = z.infer<typeof sessionGiftSchema>;

/**
 * 0.18.0: "+ minutes" for every selected PC in one click (gift, or paid with one tender).
 * 0.18.1: `payments` is ONE tender step for the whole batch — the server splits it across the
 * prepaid bills (`allocatePayments`); end-pay sessions add their time to the bill at the end and
 * take nothing now; gift takes nothing at all.
 */
export const bulkMinutesSchema = z
  .object({
    stationIds: z.array(z.string().uuid()).min(1).max(60),
    packageId: z.string().uuid().optional(),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
    gift: z.boolean().default(false),
    reason: z.string().trim().max(200).optional(),
    /** Paid mode: how the batch is paid at the desk (cash / card / bank transfer / other). */
    paymentMethod: z.enum(PAYMENT_METHODS).default('cash'),
    /** Paid mode: the tenders for the whole batch (see above). Takes precedence over paymentMethod. */
    payments: z
      .lazy(() =>
        z.array(salePaymentInputSchema.extend({ method: z.enum(PAYMENT_METHODS) })).max(5),
      )
      .optional(),
  })
  .refine((e) => Boolean(e.packageId) !== Boolean(e.minutes), {
    message: 'either a package or a number of minutes',
    path: ['minutes'],
  });
export type BulkMinutesRequest = z.infer<typeof bulkMinutesSchema>;

export interface BulkMinutesApplied {
  stationId: string;
  code: string;
  minutes: number;
  priceCents: number;
}
export interface BulkMinutesSkipped {
  stationId: string;
  code: string;
  reason: 'no_active_session' | 'not_extendable' | 'error';
  detail?: string | null;
}
export interface BulkMinutesResult {
  applied: BulkMinutesApplied[];
  skipped: BulkMinutesSkipped[];
  totalCents: number;
}

/** 0.18.0: the debts page groups by customer — one row, click for the invoices. */
export interface DebtCustomerGroup {
  customerId: string;
  name: string;
  code: string | null;
  phone: string | null;
  totalCents: number;
  count: number;
  oldestDue: string | null;
}

/** How far back staff may "stop the clock" before the end request actually arrives. */
export const SESSION_STOP_CLOCK_GRACE_SECONDS = 10 * 60;

export const endSessionSchema = z.object({
  /** Postpaid only: discount applied by staff with the pos.discount permission. */
  discountCents: z.number().int().min(0).max(1_000_000).default(0),
  /**
   * Postpaid only: how many seconds before this request staff stopped the clock (opened the
   * checkout), so the amount quoted to the customer is the amount billed while the money is
   * counted. A duration rather than a timestamp so Admin/Server clock skew cannot shift it. The
   * server bounds it: never before the start, ignored while paused, never more than
   * `SESSION_STOP_CLOCK_GRACE_SECONDS`.
   */
  stoppedSecondsAgo: z.number().int().min(0).max(86_400).optional(),
  /** Attach the customer at checkout (a walk-in session that ends with "pay later"). */
  customerId: z.string().uuid().optional(),
  ...sessionTenders,
  notes: z.string().trim().max(500).optional(),
});
export type EndSessionRequest = z.infer<typeof endSessionSchema>;

export interface SessionQuoteResponse {
  billingMode: BillingMode;
  /** Prepaid / end pay: minutes booked. Postpaid: null. */
  minutes: number | null;
  /** Prepaid: amount due now. End pay: amount due when the time ends. Postpaid: 0. */
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

export const SESSION_PAUSED_BY = ['staff', 'customer', 'grace'] as const;
export type SessionPausedBy = (typeof SESSION_PAUSED_BY)[number];

export interface SessionSummary {
  id: string;
  stationId: string;
  stationCode: string;
  stationName: string;
  customerId: string | null;
  customerName: string | null;
  billingMode: BillingMode;
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
  /** Who paused it (`paused` only): staff in LIKApcs, the customer at the PC, or the server
   * after the PC went offline (`grace`). */
  pausedBy: SessionPausedBy | null;
  /** Customer pauses end by themselves at this instant (`sessions.pause_max_minutes`); null = no limit / not a customer pause. */
  autoResumeAt: string | null;
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
  /** Accepted "on the bill" orders still open on this session: settled together with it (0.10.0). */
  openOrdersCents: number;
  openOrdersCount: number;
  /**
   * End pay (0.14.0): the session has ended but the bill has not been collected yet — it sits in
   * the "awaiting payment" strip until `POST /sessions/:id/collect`. `finalPriceCents` is the
   * amount due for the time (open orders on the bill come on top, see `openOrdersCents`).
   */
  awaitingPayment: boolean;
  createdAt: string;
}

/** `POST /sessions/:id/collect` — staff take the money for an ended End Pay session. */
export const collectSessionSchema = z.object({
  discountCents: z.number().int().min(0).max(1_000_000).default(0),
  /** Attach / change the customer at the desk (balance or pay later need one). */
  customerId: z.string().uuid().optional(),
  ...sessionTenders,
  notes: z.string().trim().max(500).optional(),
});
export type CollectSessionRequest = z.infer<typeof collectSessionSchema>;

/** 0.21.0 — pay all: the bills waiting at one PC, paid in one tender step (cash by default). */
export const collectStationSchema = z.object({ ...sessionTenders });
export type CollectStationRequest = z.infer<typeof collectStationSchema>;

/** One bill settled by a pay-all step; each keeps its own sale and receipt. */
export interface CollectStationResponse {
  stationId: string;
  /** One entry per bill paid; `payment` carries the receipt the desk prints for it. */
  collected: {
    sessionId: string;
    receiptNo: string;
    totalCents: number;
    payment: SessionPaymentSummary | null;
  }[];
  totalCents: number;
}

/** Outcome of the command mirrored to the PC after a session transition. */
export interface ClientAckSummary {
  commandId: string;
  command: string;
  ok: boolean;
  error?: string;
}

/** Money side of a session transition that produced a bill (prepaid start/extend, postpaid end). */
export interface SessionPaymentSummary {
  saleId: string;
  receiptNo: string;
  totalCents: number;
  /** Sum of tenders (cash counted as handed over, before change). */
  paidCents: number;
  changeCents: number;
  /** Part put on the customer's tab ("pay later"), 0 otherwise. */
  creditCents: number;
  dueDate: string | null;
}

export interface SessionMutationResponse {
  session: SessionSummary;
  /** null when no client PC is connected to the station. */
  client: ClientAckSummary | null;
  /** Present when this transition billed something. */
  payment?: SessionPaymentSummary | null;
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
  customerId: z.string().uuid().optional(),
  /** `true` = only ended End Pay sessions whose bill is still to be collected (0.14.0). */
  awaitingPayment: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;

// ─── Phase 5: catalogue, inventory & POS ─────────────────────────────────────

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, '#RRGGBB');
const barcodeValue = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{3,64}$/, 'barcode');
const nullableText = (max: number) => z.string().trim().max(max).nullable().default(null);

export const taxCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  rateBp: z.number().int().min(0).max(10_000),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export type TaxCategoryInput = z.infer<typeof taxCategorySchema>;
export interface TaxCategorySummary {
  id: string;
  name: string;
  rateBp: number;
  isDefault: boolean;
  isActive: boolean;
}

export const categorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  parentId: z.string().uuid().nullable().default(null),
  color: hexColor.nullable().default(null),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
});
export type CategoryInput = z.infer<typeof categorySchema>;
export const updateCategorySchema = categorySchema.partial();
export interface CategorySummary {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
  productCount: number;
}

export const productBarcodeSchema = z.object({
  barcode: barcodeValue,
  quantityMilli: z.number().int().min(1).max(1_000_000_000).default(1000),
  isPrimary: z.boolean().default(false),
});
export type ProductBarcodeInput = z.infer<typeof productBarcodeSchema>;

export const productSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Empty → generated (`SKU-000001`). */
  sku: z.string().trim().max(40).optional(),
  categoryId: z.string().uuid().nullable().default(null),
  brand: nullableText(80),
  supplierId: z.string().uuid().nullable().default(null),
  taxCategoryId: z.string().uuid().nullable().default(null),
  unitCode: z.string().trim().min(1).max(16).default('pc'),
  purchaseCostCents: z.number().int().min(0).max(100_000_000).default(0),
  sellingPriceCents: z.number().int().min(0).max(100_000_000),
  priceIncludesTax: z.boolean().default(true),
  minStockMilli: z.number().int().min(0).max(1_000_000_000).default(0),
  allowNegativeStock: z.boolean().default(false),
  trackStock: z.boolean().default(true),
  description: nullableText(1000),
  storageLocation: nullableText(80),
  isActive: z.boolean().default(true),
  /** Offered on the PC menu (orders from the seat, 0.10.0). */
  clientMenu: z.boolean().default(false),
  barcodes: z.array(productBarcodeSchema).max(20).default([]),
  /** 0.19.0: this product is a variant of `parentId` (e.g. size M of a T-shirt). Both or neither. */
  parentId: z.string().uuid().nullable().default(null),
  variantLabel: z.string().trim().min(1).max(40).nullable().default(null),
  /** Opening stock recorded as an `initial` movement when the product is created. */
  initialStockMilli: z.number().int().min(0).max(1_000_000_000).optional(),
});
export type ProductInput = z.infer<typeof productSchema>;
export const updateProductSchema = productSchema
  .omit({ barcodes: true, initialStockMilli: true })
  .partial();
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export interface ProductBarcodeSummary {
  id: string;
  barcode: string;
  isPrimary: boolean;
  quantityMilli: number;
}

export interface ProductSummary {
  id: string;
  name: string;
  sku: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  brand: string | null;
  supplierId: string | null;
  taxCategoryId: string | null;
  /** Effective rate: the product's tax category or the business default. */
  taxRateBp: number;
  unitCode: string;
  unitIsDecimal: boolean;
  purchaseCostCents: number;
  averageCostCents: number;
  sellingPriceCents: number;
  /**
   * Price the POS charges right now when a product ad with a promo is live (always below
   * `sellingPriceCents`), otherwise null. Derived by the server — never sent by the POS.
   */
  promoPriceCents: number | null;
  priceIncludesTax: boolean;
  stockMilli: number;
  minStockMilli: number;
  allowNegativeStock: boolean;
  trackStock: boolean;
  lowStock: boolean;
  description: string | null;
  storageLocation: string | null;
  isActive: boolean;
  /** Offered on the PC menu (customers can order it from their seat, 0.10.0). */
  clientMenu: boolean;
  clientMenuOrder: number;
  /** 0.19.0: the parent product this one is a variant of, its label, and how many variants it has. */
  parentId: string | null;
  parentName: string | null;
  variantLabel: string | null;
  variantCount: number;
  /** Server-relative URL of the product picture (`/api/v1/files/products/<file>`), or null. */
  imageUrl: string | null;
  barcodes: ProductBarcodeSummary[];
  createdAt: string;
  updatedAt: string;
}

/** Product picture fetched by the server from a link (the file is then stored locally). */
export const productImageFromUrlSchema = z.object({
  url: z.string().trim().url().max(2000),
});
export type ProductImageFromUrlInput = z.infer<typeof productImageFromUrlSchema>;

export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PRODUCT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

export const productListQuerySchema = z.object({
  /** Only products offered on the PC menu (0.10.0). */
  menu: z.coerce.boolean().optional(),
  q: z.string().trim().max(80).optional(),
  categoryId: z.string().uuid().optional(),
  lowStock: z.coerce.boolean().optional(),
  active: z.enum(['all', 'active', 'inactive']).default('active'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

/** Result of scanning/typing a code at the POS. */
export interface ProductLookupResponse {
  product: ProductSummary;
  /** Quantity sold by the scanned barcode (multi-packs), 1000 for SKU matches. */
  quantityMilli: number;
  matchedBy: 'barcode' | 'sku';
}

export const STOCK_ADJUSTMENT_TYPES = [
  'adjustment',
  'initial',
  'damaged',
  'expired',
  'missing',
  'stock_count',
] as const;
export type StockAdjustmentType = (typeof STOCK_ADJUSTMENT_TYPES)[number];

export const stockAdjustmentSchema = z
  .object({
    type: z.enum(STOCK_ADJUSTMENT_TYPES).default('adjustment'),
    /** Signed change in milli units … */
    quantityMilliDelta: z.number().int().optional(),
    /** … or the counted absolute stock (stock counts). Exactly one of the two. */
    newStockMilli: z.number().int().min(0).optional(),
    reason: z.string().trim().min(2).max(200),
    unitCostCents: z.number().int().min(0).max(100_000_000).optional(),
  })
  .refine((v) => (v.quantityMilliDelta === undefined) !== (v.newStockMilli === undefined), {
    message: 'Provide quantityMilliDelta or newStockMilli',
    path: ['quantityMilliDelta'],
  });
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;

export interface InventoryMovementSummary {
  id: number;
  productId: string;
  productName: string;
  sku: string;
  movementType: string;
  quantityMilliDelta: number;
  stockAfterMilli: number;
  unitCostCents: number | null;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  createdByName: string | null;
  createdAt: string;
}

export const inventoryMovementsQuerySchema = z.object({
  productId: z.string().uuid().optional(),
  type: z.string().trim().max(30).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// ─── Sales ────────────────────────────────────────────────────────────────────

export const SALE_STATUSES = [
  'suspended',
  'completed',
  'partially_refunded',
  'refunded',
  'void',
] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];
/**
 * Tenders a sale can be settled with. `credit` = "pay later": the amount becomes a customer debt
 * (`customer_debts`) with a due date; it needs a customer on the sale and the `debts.give` permission.
 */
export const SALE_PAYMENT_METHODS = [
  'cash',
  'card',
  'bank_transfer',
  'other',
  'credit',
  'wallet',
] as const;
export type SalePaymentMethod = (typeof SALE_PAYMENT_METHODS)[number];
/**
 * Methods money can actually be handed back with — and `wallet` (0.11.0): the refund / debt
 * repayment is settled against the customer's prepaid balance instead of the drawer.
 */
export const REFUND_METHODS = ['cash', 'card', 'bank_transfer', 'other', 'wallet'] as const;

/** A catalogue product: stock, tax and price come from the product row. */
export const productSaleItemSchema = z.object({
  productId: z.string().uuid(),
  quantityMilli: z.number().int().min(1).max(1_000_000_000),
  discountCents: z.number().int().min(0).max(100_000_000).default(0),
});

/**
 * 0.19.0: an off-inventory line ("free item") — a service or any sale without a product row:
 * a name and a price typed at the till. No stock moves, no cost is booked (COGS 0), and the line
 * is priced like the default-tax products (price includes tax).
 */
export const freeSaleItemSchema = z.object({
  description: z.string().trim().min(1).max(120),
  unitPriceCents: z.number().int().min(0).max(100_000_00),
  quantityMilli: z.number().int().min(1).max(1_000_000_000),
  discountCents: z.number().int().min(0).max(100_000_000).default(0),
});

/**
 * 0.19.0: prepaid PC time sold at the till — "PC 3 · 60 min". The price is the station's own
 * quote (the server prices it); the line creates a time credit that the desk redeems at that PC.
 */
export const timeSaleItemSchema = z.object({
  stationId: z.string().uuid(),
  minutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  discountCents: z.number().int().min(0).max(100_000_000).default(0),
});

export const saleItemInputSchema = z.union([
  productSaleItemSchema,
  freeSaleItemSchema,
  timeSaleItemSchema,
]);
export type ProductSaleItemInput = z.infer<typeof productSaleItemSchema>;
export type FreeSaleItemInput = z.infer<typeof freeSaleItemSchema>;
export type TimeSaleItemInput = z.infer<typeof timeSaleItemSchema>;
export type SaleItemInput = z.infer<typeof saleItemInputSchema>;

/** 0.19.0: an open prepaid-time credit at a PC (see `GET /time-credits`). */
export interface TimeCreditSummary {
  id: string;
  stationId: string;
  stationCode: string;
  minutesTotal: number;
  minutesRemaining: number;
  saleId: string;
  createdAt: string;
}

export const salePaymentInputSchema = z.object({
  method: z.enum(SALE_PAYMENT_METHODS),
  amountCents: z.number().int().min(1).max(100_000_000),
  reference: z.string().trim().max(80).optional(),
  /** `credit` only: when the customer promised to pay (defaults to `pos.credit_default_days`). */
  dueDate: isoDate.optional(),
  /** `credit` only (0.19.0): pay the debt in this many parts — no dates are scheduled. */
  installments: z.number().int().min(2).max(24).optional(),
});
export type SalePaymentInput = z.infer<typeof salePaymentInputSchema>;

const saleBody = {
  items: z.array(saleItemInputSchema).min(1).max(200),
  discountCents: z.number().int().min(0).max(100_000_000).default(0),
  customerId: z.string().uuid().nullable().default(null),
  notes: z.string().trim().max(500).optional(),
  clientRequestId: z.string().trim().min(8).max(80).optional(),
};
export const createSaleSchema = z.object({
  ...saleBody,
  payments: z.array(salePaymentInputSchema).min(1).max(10),
});
export type CreateSaleRequest = z.infer<typeof createSaleSchema>;
export const suspendSaleSchema = z.object(saleBody);
export type SuspendSaleRequest = z.infer<typeof suspendSaleSchema>;

export const refundSchema = z.object({
  items: z
    .array(
      z.object({ saleItemId: z.number().int().min(1), quantityMilli: z.number().int().min(1) }),
    )
    .min(1)
    .max(200),
  reason: z.string().trim().min(2).max(200),
  restock: z.boolean().default(true),
  method: z.enum(REFUND_METHODS).default('cash'),
});
export type RefundRequest = z.infer<typeof refundSchema>;

export const saleListQuerySchema = z.object({
  status: z.enum(SALE_STATUSES).optional(),
  source: z.enum(['retail', 'gaming', 'mixed']).optional(),
  cashierId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  q: z.string().trim().max(40).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type SaleListQuery = z.infer<typeof saleListQuerySchema>;

export interface SaleItemSummary {
  id: number;
  lineNo: number;
  productId: string | null;
  gamingSessionId: string | null;
  description: string;
  sku: string | null;
  quantityMilli: number;
  unitPriceCents: number;
  discountCents: number;
  taxRateBp: number;
  taxCents: number;
  lineTotalCents: number;
  refundedMilli: number;
}

export interface SalePaymentSummary {
  id: string;
  kind: 'sale' | 'refund';
  method: string;
  amountCents: number;
  reference: string | null;
  receivedAt: string;
}

export interface RefundSummary {
  id: string;
  refundNo: string | null;
  totalCents: number;
  reason: string;
  restock: boolean;
  method: string;
  createdByName: string | null;
  createdAt: string;
  items: { saleItemId: number; quantityMilli: number; amountCents: number }[];
}

export interface SaleSummary {
  id: string;
  receiptNo: string | null;
  status: SaleStatus;
  source: 'retail' | 'gaming' | 'mixed';
  customerId: string | null;
  customerName: string | null;
  cashierUserId: string;
  cashierName: string | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  changeCents: number;
  refundedCents: number;
  itemCount: number;
  notes: string | null;
  /** Live (non-void) invoice issued for this sale, if any. */
  invoiceId: string | null;
  invoiceNo: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SaleDetail extends SaleSummary {
  items: SaleItemSummary[];
  payments: SalePaymentSummary[];
  refunds: RefundSummary[];
  /** Present when (part of) the sale was put on the customer's tab ("pay later"). */
  debt: {
    id: string;
    amountCents: number;
    remainingCents: number;
    dueDate: string;
    status: DebtStatus;
  } | null;
}

export interface SalesListResponse {
  items: SaleSummary[];
  total: number;
  page: number;
  pageSize: number;
  /** Totals over the whole filtered set (not just the page). */
  summary: { count: number; totalCents: number; refundedCents: number };
}

/** Everything needed to render a receipt (business header from settings + the sale). */
export interface ReceiptData {
  business: {
    name: string;
    legalName: string;
    address: string;
    city: string;
    phone: string;
    taxId: string;
    footer: string;
  };
  sale: SaleDetail;
  currency: string;
  widthMm: 58 | 80;
  /** `pos.auto_print_receipt`: the POS opens the print dialog as soon as the receipt appears. */
  autoPrint: boolean;
  /** `pos.auto_finish_seconds`: how long the "sale completed" screen waits before the next sale. */
  autoFinishSeconds: number;
  printedAt: string;
  isReprint: boolean;
}

// ─── Phase 6: cash register, expenses, customers & reports ──────────────────

export const CASH_MOVEMENT_TYPES = [
  'opening',
  'sale',
  'refund',
  'deposit',
  'withdrawal',
  'expense',
  'supplier_payment',
  'wallet_topup',
  'wallet_refund',
  'customer_payment',
  'correction',
] as const;
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export interface CashRegisterSummary {
  id: string;
  name: string;
  isActive: boolean;
  /** Id of the currently open shift on this register, if any. */
  openShiftId: string | null;
}

export interface CashMovementSummary {
  id: number;
  shiftId: string;
  type: CashMovementType;
  /** Positive = into the drawer, negative = out of the drawer. */
  amountCents: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}

export interface CashShiftTotals {
  openingCents: number;
  cashSalesCents: number;
  cashRefundsCents: number;
  depositsCents: number;
  withdrawalsCents: number;
  expensesCents: number;
  /** Cash received for customer debts ("pay later" repayments). */
  debtPaymentsCents: number;
  /** Cash taken in advance onto customer balances (0.11.0) / paid back out of them. */
  walletTopUpsCents: number;
  walletRefundsCents: number;
  otherCents: number;
  /** opening + Σ movements (what should be in the drawer right now / at close). */
  expectedCashCents: number;
  salesCount: number;
  refundsCount: number;
  /** All tenders of sales completed during the shift, by method (not only cash). */
  salesByMethod: { method: string; amountCents: number; count: number }[];
  /** Sales completed during the shift by source (retail / gaming / mixed). */
  salesBySource: { source: string; amountCents: number; count: number }[];
}

export interface CashShiftSummary {
  id: string;
  registerId: string;
  registerName: string;
  status: 'open' | 'closed';
  openedBy: { id: string; name: string };
  openedAt: string;
  openingCents: number;
  closedBy: { id: string; name: string } | null;
  closedAt: string | null;
  expectedCashCents: number | null;
  countedCashCents: number | null;
  differenceCents: number | null;
  notes: string | null;
}

export interface CashShiftDetail extends CashShiftSummary {
  totals: CashShiftTotals;
  movements: CashMovementSummary[];
}

export interface CashStatusResponse {
  registers: CashRegisterSummary[];
  /** The open shift of the default register (first active register), with live totals. */
  current: CashShiftDetail | null;
  requireOpenShift: boolean;
  /** Closing differences above this (absolute, cents) are flagged in the UI and audit log. */
  differenceWarningCents: number;
}

export const openShiftSchema = z.object({
  registerId: z.string().uuid().optional(),
  openingCents: z.number().int().min(0).max(1_000_000_000),
  notes: z.string().trim().max(500).optional(),
});
export type OpenShiftRequest = z.infer<typeof openShiftSchema>;

export const closeShiftSchema = z.object({
  countedCashCents: z.number().int().min(0).max(1_000_000_000),
  notes: z.string().trim().max(500).optional(),
});
export type CloseShiftRequest = z.infer<typeof closeShiftSchema>;

export const cashMovementSchema = z.object({
  type: z.enum(['deposit', 'withdrawal']),
  amountCents: z.number().int().min(1).max(1_000_000_000),
  reason: z.string().trim().min(1).max(200),
});
export type CashMovementRequest = z.infer<typeof cashMovementSchema>;

export const cashShiftListQuerySchema = paginationQuerySchema.extend({
  registerId: z.string().uuid().optional(),
  status: z.enum(['open', 'closed']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type CashShiftListQuery = z.infer<typeof cashShiftListQuerySchema>;

// Expenses

export interface ExpenseCategorySummary {
  code: string;
  nameEn: string;
  nameSq: string;
  isSystem: boolean;
  isActive: boolean;
}

export const expenseCategorySchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and _ only'),
  nameEn: z.string().trim().min(1).max(80),
  nameSq: z.string().trim().min(1).max(80),
});
export type ExpenseCategoryRequest = z.infer<typeof expenseCategorySchema>;

export interface ExpenseSummary {
  id: string;
  expenseDate: string;
  categoryCode: string;
  categoryName: { en: string; sq: string };
  amountCents: number;
  paymentMethod: PaymentMethod;
  description: string;
  supplierId: string | null;
  supplierName: string | null;
  /** Set when the expense was paid from the cash drawer during a shift. */
  shiftId: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export const createExpenseSchema = z.object({
  expenseDate: isoDate,
  categoryCode: z.string().trim().min(1).max(40),
  amountCents: z.number().int().min(1).max(1_000_000_000),
  paymentMethod: z.enum(PAYMENT_METHODS),
  description: z.string().trim().min(1).max(300),
  supplierId: z.string().uuid().nullable().optional(),
  /** Cash expenses: take the money from the open cash drawer (records a cash movement). */
  fromDrawer: z.boolean().default(true),
});
export type CreateExpenseRequest = z.infer<typeof createExpenseSchema>;

export const voidExpenseSchema = z.object({
  reason: z.string().trim().min(1).max(300),
});

export const expenseListQuerySchema = paginationQuerySchema.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  categoryCode: z.string().trim().max(40).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  includeVoided: z.coerce.boolean().default(false),
  q: z.string().trim().max(120).optional(),
});
export type ExpenseListQuery = z.infer<typeof expenseListQuerySchema>;

export interface ExpenseListResponse extends Paginated<ExpenseSummary> {
  totalCents: number;
}

// Customers

export const CUSTOMER_STATUSES = ['active', 'blocked', 'archived'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export interface CustomerSummary {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  membership: string | null;
  membershipUntil: string | null;
  discountBp: number;
  loyaltyPoints: number;
  walletBalanceCents: number;
  /** Open "pay later" debts (sum of remainders), kept in sync by the debts ledger. */
  balanceDueCents: number;
  /** 0 = no limit. */
  creditLimitCents: number;
  notes: string | null;
  status: CustomerStatus;
  /**
   * Customer login on the gaming PCs (0.9.0): the username they sign in with on the locked
   * screen to request time; null = no login. The PIN/password is stored hashed and never returned.
   */
  loginUsername: string | null;
  /** Staff can switch the login off without clearing the username/PIN. */
  loginEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerDetail extends CustomerSummary {
  stats: {
    salesCount: number;
    salesTotalCents: number;
    sessionsCount: number;
    sessionsMinutes: number;
    lastVisitAt: string | null;
  };
  recentSales: SaleSummary[];
  recentSessions: SessionSummary[];
}

/** Customer PINs are short by design (e.g. `1998`): the server rate-limits and locks them out. */
export const CUSTOMER_LOGIN_MIN_PASSWORD = 4;
export const customerLoginUsernameSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Only letters, digits, dot, underscore and dash are allowed');

export const customerSchema = z.object({
  code: z.string().trim().max(32).optional(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(120).nullable().optional().or(z.literal('')),
  membership: z.string().trim().max(40).nullable().optional(),
  membershipUntil: isoDate.nullable().optional(),
  discountBp: z.number().int().min(0).max(10_000).default(0),
  /** Maximum outstanding debt ("pay later"); 0 = no limit. */
  creditLimitCents: z.number().int().min(0).max(100_000_000).default(0),
  notes: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(CUSTOMER_STATUSES).default('active'),
  /** Login on the gaming PCs: username (null/'' = remove the login) … */
  loginUsername: customerLoginUsernameSchema.nullable().optional().or(z.literal('')),
  /** … and the PIN/password (≥ 4 chars). Required when a username is set for the first time;
   * omit on later edits to keep the current one. Never returned by the API. */
  loginPassword: z.string().min(CUSTOMER_LOGIN_MIN_PASSWORD).max(128).optional(),
  loginEnabled: z.boolean().optional(),
});
export type CustomerRequest = z.infer<typeof customerSchema>;
export const customerPatchSchema = customerSchema.partial();
export type CustomerPatch = z.infer<typeof customerPatchSchema>;

export const customerListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(CUSTOMER_STATUSES).optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

// Session requests (customer login on the PCs, 0.9.0)

export const SESSION_REQUEST_KINDS = ['start', 'extend'] as const;
export type SessionRequestKind = (typeof SESSION_REQUEST_KINDS)[number];
export const SESSION_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type SessionRequestStatus = (typeof SESSION_REQUEST_STATUSES)[number];

/**
 * A customer's request for time, made on the locked (or their running) PC. Staff answer it in
 * the Admin: approve = the normal start / extend dialog pre-filled (payment stays a staff
 * decision), reject = short reason shown on the PC. Pending requests never expire on their own.
 */
export interface SessionRequest {
  id: string;
  stationId: string;
  stationCode: string;
  stationName: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  /** Open debt of the customer at read time — staff see it next to "pay later". */
  customerBalanceDueCents: number;
  kind: SessionRequestKind;
  minutes: number | null;
  packageId: string | null;
  packageName: string | null;
  /** Minutes the request amounts to (package duration or `minutes`). */
  durationMinutes: number;
  /** `extend`: the session being extended. `start`: the session the approval created (if any). */
  sessionId: string | null;
  status: SessionRequestStatus;
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
}

/** `POST /client/customer-login` (device token): the customer signs in on the PC. */
export const customerLoginSchema = z.object({
  username: customerLoginUsernameSchema,
  password: z.string().min(1).max(128),
});
export type CustomerLoginInput = z.infer<typeof customerLoginSchema>;

export interface CustomerLoginResponse {
  /** Short-lived bearer token for the request endpoints (bound to this device). */
  customerToken: string;
  expiresAt: string;
  customer: ClientCustomerInfo;
  /** The customer's pending request on this PC, if one is already waiting. */
  pending: SessionRequest | null;
}

/**
 * What a customer may see about their own account on the PC (0.11.0): the prepaid balance and
 * what they owe. Returned by the login and `GET /client/customer`, pushed as `server.customer`
 * for the customer of the running session.
 */
export interface ClientCustomerInfo {
  id: string;
  name: string;
  code: string;
  /** Prepaid money on the customer's name ("balanca"). */
  walletBalanceCents: number;
  balanceDueCents: number;
}

/** `GET /client/request-options`: what the customer may ask for on this PC right now. */
export interface ClientRequestOptions {
  /** `start` while the PC is locked, `extend` while the customer's prepaid session runs,
   * `none` when nothing can be requested (someone else's session, postpaid, PC disabled). */
  kind: SessionRequestKind | 'none';
  sessionId: string | null;
  quickMinutes: number[];
  packages: { id: string; name: string; durationMinutes: number; priceCents: number }[];
  /** Price of each quick duration under the station's pricing rule (null = no rule). */
  quickPrices: Record<string, number | null>;
  currency: string;
  /** Someone is signed in to LIKApcs right now (the request will be seen promptly). */
  staffOnline: boolean;
}

export const sessionRequestCreateSchema = z
  .object({
    kind: z.enum(SESSION_REQUEST_KINDS),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
    packageId: z.string().uuid().optional(),
  })
  .refine((r) => Boolean(r.packageId) !== Boolean(r.minutes), {
    message: 'either a package or a number of minutes',
    path: ['minutes'],
  });
export type SessionRequestCreate = z.infer<typeof sessionRequestCreateSchema>;

export const sessionRequestRejectSchema = z.object({
  reason: z.string().trim().max(120).optional(),
});

export const sessionRequestListQuerySchema = z.object({
  status: z.enum(SESSION_REQUEST_STATUSES).optional(),
  stationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SessionRequestListQuery = z.infer<typeof sessionRequestListQuerySchema>;

// Orders from the PC (drinks / snacks ordered from the seat, 0.10.0)

export const ORDER_STATUSES = [
  'pending',
  'accepted',
  'paid',
  'billed',
  'rejected',
  'cancelled',
  'void',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
/** `pay_now` = a sale is recorded when staff accept; `on_bill` = settled with the session. */
export const ORDER_SETTLEMENTS = ['pay_now', 'on_bill'] as const;
export type OrderSettlement = (typeof ORDER_SETTLEMENTS)[number];
/** Staff default when accepting (`orders.settlement`); `ask` shows both choices. */
export const ORDER_SETTLEMENT_MODES = ['ask', 'pay_now', 'on_bill'] as const;
export type OrderSettlementMode = (typeof ORDER_SETTLEMENT_MODES)[number];
export const ORDER_MAX_LINES = 20;
export const ORDER_MAX_QUANTITY = 20;

export interface OrderItemSummary {
  id: number;
  productId: string;
  name: string;
  quantityMilli: number;
  unitPriceCents: number;
  lineTotalCents: number;
  imageUrl: string | null;
  /** Quantity verified when the order was prepared (0.13.0); 0 until then. */
  verifiedMilli: number;
  /** `scan` = checked with the barcode scanner, `manual` = confirmed by hand, null = not yet. */
  verification: 'scan' | 'manual' | null;
}

export interface StationOrder {
  id: string;
  number: number;
  stationId: string;
  stationCode: string;
  stationName: string;
  sessionId: string | null;
  customerId: string | null;
  customerName: string | null;
  status: OrderStatus;
  settlement: OrderSettlement | null;
  note: string | null;
  totalCents: number;
  /** Rejection / void reason (shown on the PC when rejected). */
  reason: string | null;
  saleId: string | null;
  receiptNo: string | null;
  items: OrderItemSummary[];
  requestedAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  settledAt: string | null;
  /** When the desk finished preparing it (scan / manual check, 0.13.0); null = not yet. */
  preparedAt: string | null;
}

/** `GET /client/menu` (device token): what the customer at this PC can order right now. */
export interface ClientMenu {
  /** Ordering is possible right now (a running session, or the lock screen with `orders.locked_screen`). */
  enabled: boolean;
  /**
   * Why not, otherwise. `no_session` still carries the items (0.14.0): the menu can be browsed
   * from the lock screen even when ordering must wait for a session.
   */
  reason: 'ok' | 'disabled' | 'no_session' | 'empty';
  /** Where the order would go: on the running session's bill, or from the locked PC (desk settles). */
  context: 'session' | 'locked';
  allowNote: boolean;
  currency: string;
  categories: { id: string | null; name: string; color: string | null }[];
  items: ClientMenuItem[];
  /** Someone is signed in to LIKApcs right now (the order will be seen promptly). */
  staffOnline: boolean;
}
export interface ClientMenuItem {
  productId: string;
  name: string;
  categoryId: string | null;
  priceCents: number;
  /** Regular price when `priceCents` is a live promo, otherwise null. */
  oldPriceCents: number | null;
  imageUrl: string | null;
  /** Out of stock items stay visible but cannot be ordered. */
  available: boolean;
}

export const orderCreateSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(ORDER_MAX_QUANTITY),
      }),
    )
    .min(1)
    .max(ORDER_MAX_LINES),
  note: z.string().trim().max(200).optional(),
});
export type OrderCreate = z.infer<typeof orderCreateSchema>;

/** Staff accept: `pay_now` needs tenders (a sale is recorded); `on_bill` needs a running session. */
export const orderAcceptSchema = z.object({
  settlement: z.enum(ORDER_SETTLEMENTS),
  payments: z.array(salePaymentInputSchema).max(10).optional(),
  /** Attach / confirm the customer the sale is for (`credit` tenders need one). */
  customerId: z.string().uuid().nullable().optional(),
});
export type OrderAccept = z.infer<typeof orderAcceptSchema>;

/** Settle an accepted "on the bill" order at the desk (customer pays before the session ends). */
export const orderPaySchema = z.object({
  payments: z.array(salePaymentInputSchema).min(1).max(10),
  customerId: z.string().uuid().nullable().optional(),
});
export type OrderPay = z.infer<typeof orderPaySchema>;

/**
 * `POST /orders/:id/prepare` (0.13.0): the preparation check of an accepted order — per line the
 * verified quantity and how it was verified. Lines left out are stored as unverified.
 */
export const orderPrepareSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.number().int().positive(),
        verifiedMilli: z.number().int().min(0),
        verification: z.enum(['scan', 'manual']),
      }),
    )
    .min(1)
    .max(200),
});
export type OrderPrepare = z.infer<typeof orderPrepareSchema>;

export const orderRejectSchema = z.object({ reason: z.string().trim().max(120).optional() });
export const orderVoidSchema = z.object({ reason: z.string().trim().min(2).max(200) });

export const orderListQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  /** `open` = pending + accepted (the desk's working list). */
  open: z.coerce.boolean().optional(),
  stationId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

/** Products offered on the PC menu — `PUT /catalog/menu` replaces the whole list in order. */
export const clientMenuSetSchema = z.object({
  productIds: z.array(z.string().uuid()).max(500),
});
export type ClientMenuSetRequest = z.infer<typeof clientMenuSetSchema>;

// Reports

export const reportRangeSchema = z.object({
  from: isoDate,
  to: isoDate,
});
export type ReportRange = z.infer<typeof reportRangeSchema>;

export interface ReportBucket {
  key: string;
  label: string | null;
  count: number;
  amountCents: number;
}

export interface SalesReport {
  range: ReportRange;
  sales: {
    count: number;
    grossCents: number;
    discountCents: number;
    taxCents: number;
    netCents: number;
    refundedCents: number;
    refundsCount: number;
    averageCents: number;
  };
  byMethod: ReportBucket[];
  bySource: ReportBucket[];
  byDay: {
    date: string;
    count: number;
    amountCents: number;
    gamingCents: number;
    retailCents: number;
  }[];
  byHour: { hour: number; count: number; amountCents: number }[];
  topProducts: { productId: string; name: string; quantityMilli: number; amountCents: number }[];
  byCategory: ReportBucket[];
  gaming: {
    sessionsCount: number;
    billedMinutes: number;
    amountCents: number;
    byStation: {
      stationId: string;
      code: string;
      name: string;
      sessions: number;
      minutes: number;
      amountCents: number;
    }[];
  };
  expenses: {
    count: number;
    totalCents: number;
    byCategory: ReportBucket[];
  };
  cash: {
    shiftsCount: number;
    differenceCents: number;
    shifts: CashShiftSummary[];
  };
  byEmployee: ReportBucket[];
  generatedAt: string;
}

/**
 * 0.21.0 — the cash book: one row per cash shift that overlaps the range. Money is integer cents;
 * `cashInCents` and `cashOutCents` are magnitudes (every drawer movement except the opening float),
 * so `expectedCashCents = openingCents + cashInCents − cashOutCents`. Counted and difference are
 * null while the shift is open.
 */
export interface CashBookRow {
  shift: CashShiftSummary;
  cashInCents: number;
  cashOutCents: number;
  expectedCashCents: number;
  movements: CashMovementSummary[];
}

export interface CashBookTotals {
  shiftsCount: number;
  openShiftsCount: number;
  openingCents: number;
  cashInCents: number;
  cashOutCents: number;
  expectedCashCents: number;
  /** Closed shifts only: the counted cash and the difference, summed. */
  countedCashCents: number;
  differenceCents: number;
}

export interface CashBookReport {
  from: string;
  to: string;
  rows: CashBookRow[];
  totals: CashBookTotals;
  generatedAt: string;
}

export const REPORT_EXPORT_KINDS = [
  'sales',
  'sale_items',
  'expenses',
  'sessions',
  'shifts',
  'cash_book',
] as const;
export type ReportExportKind = (typeof REPORT_EXPORT_KINDS)[number];
export const reportExportQuerySchema = reportRangeSchema.extend({
  kind: z.enum(REPORT_EXPORT_KINDS),
});

// ─── Phase 7: suppliers & purchases ──────────────────────────────────────────

export const PURCHASE_STATUSES = [
  'draft',
  'ordered',
  'partially_received',
  'received',
  'cancelled',
] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];
export const PURCHASE_PAYMENT_STATUSES = ['unpaid', 'partial', 'paid'] as const;
export type PurchasePaymentStatus = (typeof PURCHASE_PAYMENT_STATUSES)[number];

export interface SupplierSummary {
  id: string;
  name: string;
  businessName: string | null;
  taxId: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  contactPerson: string | null;
  notes: string | null;
  isActive: boolean;
  /** Non-cancelled purchases. */
  purchasesCount: number;
  purchasedCents: number;
  /** Σ (total − paid) over non-cancelled purchases. */
  balanceDueCents: number;
  lastPurchaseAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const supplierSchema = z.object({
  name: z.string().trim().min(1).max(120),
  businessName: z.string().trim().max(160).nullable().optional(),
  taxId: z.string().trim().max(40).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(120).nullable().optional().or(z.literal('')),
  address: z.string().trim().max(240).nullable().optional(),
  contactPerson: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type SupplierRequest = z.infer<typeof supplierSchema>;
export const supplierPatchSchema = supplierSchema.partial();
export type SupplierPatch = z.infer<typeof supplierPatchSchema>;
export const supplierListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  includeInactive: z.coerce.boolean().default(false),
});
export type SupplierListQuery = z.infer<typeof supplierListQuerySchema>;

export const purchaseItemInputSchema = z.object({
  productId: uuidSchema,
  quantityMilli: z.number().int().positive(),
  unitCostCents: z.number().int().min(0),
  /** Supplier VAT on top of the unit cost; informational for the cost price. */
  taxRateBp: z.number().int().min(0).max(10_000).default(0),
});
export type PurchaseItemInput = z.infer<typeof purchaseItemInputSchema>;

export const purchasePaymentInputSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountCents: z.number().int().positive(),
  reference: z.string().trim().max(80).nullable().optional(),
});
export type PurchasePaymentInput = z.infer<typeof purchasePaymentInputSchema>;

export const createPurchaseSchema = z.object({
  supplierId: uuidSchema,
  supplierInvoiceNo: z.string().trim().max(60).nullable().optional(),
  orderDate: isoDate.optional(),
  expectedDate: isoDate.nullable().optional(),
  items: z.array(purchaseItemInputSchema).min(1).max(500),
  additionalCostsCents: z.number().int().min(0).default(0),
  notes: z.string().trim().max(1000).nullable().optional(),
  /** true → goods are booked into stock immediately (the common "invoice arrives with the goods" case). */
  receiveNow: z.boolean().default(true),
  /** Optional payment recorded together with the purchase. */
  payment: purchasePaymentInputSchema.nullable().optional(),
});
export type CreatePurchaseRequest = z.infer<typeof createPurchaseSchema>;

export const receivePurchaseSchema = z.object({
  /** Omitted → everything still outstanding is received. */
  items: z
    .array(
      z.object({
        purchaseItemId: z.number().int().positive(),
        quantityMilli: z.number().int().positive(),
      }),
    )
    .min(1)
    .optional(),
  deliveryNoteNo: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type ReceivePurchaseRequest = z.infer<typeof receivePurchaseSchema>;

export const purchaseListQuerySchema = paginationQuerySchema.extend({
  supplierId: uuidSchema.optional(),
  status: z.enum(PURCHASE_STATUSES).optional(),
  paymentStatus: z.enum(PURCHASE_PAYMENT_STATUSES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(120).optional(),
});
export type PurchaseListQuery = z.infer<typeof purchaseListQuerySchema>;

export interface PurchaseSummary {
  id: string;
  referenceNo: string;
  supplierId: string;
  supplierName: string;
  supplierInvoiceNo: string | null;
  status: PurchaseStatus;
  paymentStatus: PurchasePaymentStatus;
  orderDate: string;
  expectedDate: string | null;
  subtotalCents: number;
  additionalCostsCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  itemsCount: number;
  notes: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseItemSummary {
  id: number;
  lineNo: number;
  productId: string;
  productName: string;
  sku: string | null;
  description: string;
  quantityOrderedMilli: number;
  quantityReceivedMilli: number;
  quantityReturnedMilli: number;
  unitCostCents: number;
  taxRateBp: number;
  lineTotalCents: number;
}

export interface PurchaseReceiptSummary {
  id: string;
  receivedAt: string;
  receivedByName: string | null;
  deliveryNoteNo: string | null;
  notes: string | null;
  items: { purchaseItemId: number; quantityMilli: number; unitCostCents: number }[];
}

export interface PurchasePaymentSummary {
  id: string;
  method: PaymentMethod;
  amountCents: number;
  paidAt: string;
  reference: string | null;
  shiftId: string | null;
  createdByName: string | null;
}

export interface PurchaseDetail extends PurchaseSummary {
  items: PurchaseItemSummary[];
  receipts: PurchaseReceiptSummary[];
  payments: PurchasePaymentSummary[];
}

export interface PurchaseListResponse extends Paginated<PurchaseSummary> {
  summary: { count: number; totalCents: number; paidCents: number; dueCents: number };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 7: backups & restore
// ═══════════════════════════════════════════════════════════════════════════════

export const BACKUP_KINDS = [
  'manual',
  'scheduled',
  'pre_migration',
  'pre_restore',
  'pre_import',
] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];
export const BACKUP_STATUSES = ['running', 'succeeded', 'failed', 'deleted'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

/** Archive format identifier written into every backup's manifest.json. */
export const BACKUP_FORMAT = 'likapcs-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_FILE_EXTENSION = '.likapcs-backup.tar.gz';

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  serverVersion: string;
  schemaVersion: number;
  businessName: string | null;
  kind: BackupKind;
  tables: { name: string; rows: number; bytes: number }[];
}

export interface BackupSummary {
  id: string;
  kind: BackupKind;
  status: BackupStatus;
  fileName: string | null;
  /** False when the history row exists but the file was removed from the backup directory. */
  fileExists: boolean;
  sizeBytes: number | null;
  sha256: string | null;
  schemaVersion: number | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdByName: string | null;
}

export interface BackupsResponse {
  directory: string;
  schemaVersion: number;
  schedule: { enabled: boolean; time: string; keepCount: number; nextRunAt: string | null };
  items: BackupSummary[];
}

export const backupListQuerySchema = z.object({
  includeDeleted: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type BackupListQuery = z.infer<typeof backupListQuerySchema>;

export const restoreBackupSchema = z.object({
  /** The acting administrator's own password — re-confirmed before anything is overwritten. */
  password: z.string().min(1).max(200),
  /** Must be literally true: the UI asks for an explicit acknowledgement. */
  confirm: z.literal(true),
});
export type RestoreBackupRequest = z.infer<typeof restoreBackupSchema>;

export interface RestoreResult {
  backupId: string;
  /** Safety copy taken immediately before the restore. */
  preRestoreBackupId: string | null;
  tablesRestored: number;
  rowsRestored: number;
  durationMs: number;
  /** True when the caller's session survived (its user exists in the restored data). */
  sessionKept: boolean;
}

export const backupUploadQuerySchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(
      /^[A-Za-z0-9._-]+$/,
      'file name may only contain letters, digits, dot, dash, underscore',
    ),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 7: updates dashboard
// ═══════════════════════════════════════════════════════════════════════════════

export const UPDATE_COMPONENTS = ['admin', 'client', 'server'] as const;
export type UpdateComponent = (typeof UPDATE_COMPONENTS)[number];
export const UPDATE_STATUSES = [
  'pending',
  'downloading',
  'downloaded',
  'installing',
  'succeeded',
  'failed',
  'rolled_back',
] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

/** A release known to the server (from the GitHub update manifests). */
export interface ApplicationVersionSummary {
  component: UpdateComponent;
  version: string;
  channel: 'stable' | 'beta';
  releasedAt: string | null;
  releaseNotes: string | null;
  downloadUrl: string | null;
  /** Detached minisign signature of the installer, as published in the manifest. */
  signed: boolean;
  isLatest: boolean;
}

export type ClientVersionState = 'current' | 'outdated' | 'newer' | 'unknown';

export interface ClientUpdateRow {
  deviceId: string;
  stationId: string | null;
  stationCode: string | null;
  stationName: string | null;
  hostname: string | null;
  appVersion: string | null;
  online: boolean;
  lastSeenAt: string | null;
  state: ClientVersionState;
  lastUpdate: {
    status: UpdateStatus;
    toVersion: string;
    startedAt: string;
    finishedAt: string | null;
    errorMessage: string | null;
  } | null;
}

export interface UpdateHistoryEntry {
  id: string;
  component: UpdateComponent;
  deviceId: string | null;
  stationCode: string | null;
  fromVersion: string | null;
  toVersion: string;
  status: UpdateStatus;
  initiatedByName: string | null;
  /** Client runs: what started them (`command` = pushed from Admin, `incompatible` = forced). */
  trigger: string | null;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

export interface UpdateCheckState {
  checkedAt: string | null;
  ok: boolean | null;
  error: string | null;
  /** Where the manifests are fetched from (for the dashboard's "source" line). */
  feedUrl: string;
}

export interface UpdatesOverview {
  server: { version: string; schemaVersion: number; startedAt: string };
  /**
   * Version every client should run: always the server's. The main PC (server + Admin) is updated
   * first; clients are then pushed to the same version (a client may not be newer than its server).
   */
  targetVersion: string;
  latest: {
    admin: ApplicationVersionSummary | null;
    client: ApplicationVersionSummary | null;
    /** The release feed carries a newer main-PC installer than the running server. */
    serverUpdateAvailable: boolean;
  };
  check: UpdateCheckState;
  policy: {
    channel: 'stable' | 'beta';
    checkOnStartup: boolean;
    autoDownload: boolean;
    clientPolicy: 'manual' | 'idle_only' | 'maintenance_window';
    maintenanceWindow: string;
  };
  clients: ClientUpdateRow[];
  counts: { clients: number; online: number; outdated: number; updating: number };
  history: UpdateHistoryEntry[];
}

export const updateEventSchema = z.object({
  component: z.enum(['admin', 'server']),
  fromVersion: z.string().trim().max(40).nullable().optional(),
  toVersion: z.string().trim().min(1).max(40),
  status: z.enum(UPDATE_STATUSES),
  error: z.string().trim().max(500).nullable().optional(),
});
export type UpdateEventRequest = z.infer<typeof updateEventSchema>;

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 7: invoices & printing
// ═══════════════════════════════════════════════════════════════════════════════

export const INVOICE_STATUSES = ['issued', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const createInvoiceSchema = z.object({
  saleId: uuidSchema,
  customerId: uuidSchema.nullable().optional(),
  billingName: z.string().trim().min(1).max(200),
  billingTaxId: z.string().trim().max(60).nullable().optional(),
  billingAddress: z.string().trim().max(500).nullable().optional(),
  billingEmail: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  notes: z.string().trim().max(1000).nullable().optional(),
  /** Overrides `printing.invoice_due_days` for this invoice. */
  dueDays: z.number().int().min(0).max(365).optional(),
});
export type CreateInvoiceRequest = z.infer<typeof createInvoiceSchema>;

export const voidInvoiceSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type VoidInvoiceRequest = z.infer<typeof voidInvoiceSchema>;

export const invoiceListQuerySchema = z.object({
  status: z.enum(INVOICE_STATUSES).optional(),
  customerId: uuidSchema.optional(),
  q: z.string().trim().max(60).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;

export interface InvoiceSummary {
  id: string;
  invoiceNo: string;
  status: InvoiceStatus;
  saleId: string;
  receiptNo: string | null;
  customerId: string | null;
  billingName: string;
  billingTaxId: string | null;
  billingAddress: string | null;
  billingEmail: string | null;
  notes: string | null;
  issuedAt: string;
  /** ISO date (YYYY-MM-DD) or null = due on issue. */
  dueAt: string | null;
  issuedByName: string | null;
  totalCents: number;
  taxCents: number;
  printCount: number;
  lastPrintedAt: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface InvoiceDetail extends InvoiceSummary {
  sale: SaleDetail;
}

export interface InvoicesListResponse {
  items: InvoiceSummary[];
  total: number;
  page: number;
  pageSize: number;
  summary: { count: number; totalCents: number };
}

/** Everything needed to render / print an A4 invoice. */
export interface InvoiceData {
  business: {
    name: string;
    legalName: string;
    address: string;
    city: string;
    phone: string;
    email: string;
    website: string;
    taxId: string;
    registrationNo: string;
    bankDetails: string;
    footer: string;
  };
  invoice: InvoiceSummary;
  sale: SaleDetail;
  currency: string;
  printedAt: string;
  isReprint: boolean;
}

// ─── Customer debts ("pay later") ───────────────────────────────────────────────
export const DEBT_STATUSES = ['open', 'partial', 'paid', 'written_off'] as const;
export type DebtStatus = (typeof DEBT_STATUSES)[number];

export interface DebtSummary {
  id: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  customerPhone: string | null;
  /** Sale or session bill that opened the debt (null for debts opened by hand). */
  saleId: string | null;
  receiptNo: string | null;
  amountCents: number;
  paidCents: number;
  remainingCents: number;
  status: DebtStatus;
  /** YYYY-MM-DD */
  dueDate: string;
  /** Days past the due date for open debts (0 when not yet due). */
  overdueDays: number;
  /** 0.19.0: planned installments (null = a plain debt), repayments made so far, and the next part. */
  installmentCount: number | null;
  installmentsPaid: number;
  installmentCents: number | null;
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface DebtPaymentSummary {
  id: string;
  amountCents: number;
  method: PaymentMethod;
  reference: string | null;
  receivedAt: string;
  receivedByName: string | null;
}

export interface DebtDetail extends DebtSummary {
  payments: DebtPaymentSummary[];
  writtenOffReason: string | null;
  /** Lines of the originating sale, for the "what was it" question at the counter. */
  items: { description: string; quantityMilli: number; lineTotalCents: number }[];
}

export interface DebtsOverview {
  openCents: number;
  overdueCents: number;
  dueTodayCents: number;
  openCount: number;
  overdueCount: number;
  /** Distinct customers with an open debt. */
  debtors: number;
}

export const DEBT_LIST_FILTERS = [
  'open',
  'overdue',
  'due_today',
  'paid',
  'written_off',
  'all',
] as const;
export const debtListQuerySchema = paginationQuerySchema.extend({
  filter: z.enum(DEBT_LIST_FILTERS).default('open'),
  customerId: uuidSchema.optional(),
  q: z.string().trim().max(120).optional(),
});
export type DebtListQuery = z.infer<typeof debtListQuerySchema>;

export const debtPaymentSchema = z.object({
  amountCents: z.number().int().min(1).max(100_000_000),
  method: z.enum(REFUND_METHODS).default('cash'),
  /** Cash handed over (≥ amount); the response reports the change to give back. */
  tenderedCents: z.number().int().min(0).max(100_000_000).optional(),
  reference: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(300).optional(),
});
export type DebtPaymentRequest = z.infer<typeof debtPaymentSchema>;

export const debtRescheduleSchema = z.object({
  dueDate: isoDate,
  notes: z.string().trim().max(300).optional(),
});
export type DebtRescheduleRequest = z.infer<typeof debtRescheduleSchema>;

/** `POST /customers/:id/debts/reschedule` — every open debt of the customer gets the new date. */
export interface DebtRescheduleAllResult {
  debts: DebtDetail[];
  count: number;
}

export const debtWriteOffSchema = z.object({ reason: z.string().trim().min(2).max(200) });
export type DebtWriteOffRequest = z.infer<typeof debtWriteOffSchema>;

export interface DebtPaymentResult {
  /** Debts touched by this payment (one, or several for a customer-level payment). */
  debts: DebtDetail[];
  paidCents: number;
  changeCents: number;
  customer: { id: string; name: string; balanceDueCents: number };
}

// ─── Customer wallet & account statement (0.11.0) ──────────────────────────────

/** Error codes the balance tender can fail with (HTTP 409 / 400). */
export const WALLET_ERROR_CODES = {
  /** The balance is lower than the amount — `details.balanceCents` says how much there is. */
  INSUFFICIENT: 'wallet_insufficient',
  /** A balance payment needs a customer on the sale. */
  NEEDS_CUSTOMER: 'wallet_needs_customer',
  /** `wallet.enabled` is off. */
  DISABLED: 'wallet_disabled',
} as const;

export const walletTopUpSchema = z.object({
  amountCents: z.number().int().min(1).max(100_000_000),
  /** Cash handed over (≥ amount); the response reports the change to give back. */
  tenderedCents: z.number().int().min(0).max(100_000_000).optional(),
  note: z.string().trim().max(200).optional(),
});
export type WalletTopUpRequest = z.infer<typeof walletTopUpSchema>;

export const walletWithdrawSchema = z.object({
  amountCents: z.number().int().min(1).max(100_000_000),
  reason: z.string().trim().min(2).max(200),
});
export type WalletWithdrawRequest = z.infer<typeof walletWithdrawSchema>;

export const WALLET_ENTRY_TYPES = [
  'wallet_topup',
  'wallet_payment',
  'wallet_refund',
  'wallet_withdrawal',
] as const;
export type WalletEntryType = (typeof WALLET_ENTRY_TYPES)[number];

/** One line of the customer's balance ledger (newest first). */
export interface WalletEntry {
  id: string;
  type: WalletEntryType;
  /** Signed: top-ups / refunds positive, payments / withdrawals negative. */
  amountCents: number;
  balanceAfterCents: number;
  /** What the money went to / came from: a receipt, a debt payment, a refund. */
  referenceType: 'sale' | 'debt_payment' | 'refund' | 'payment' | null;
  referenceId: string | null;
  receiptNo: string | null;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface WalletMutationResult {
  customer: CustomerSummary;
  entry: WalletEntry;
  /** Top-ups: cash to hand back when more was tendered than the amount. */
  changeCents: number;
}

/**
 * `GET /customers/:id/statement` — everything that ever happened on a customer's account,
 * newest first: receipts (POS, session bills, orders) with how each was paid, debt
 * repayments, wallet top-ups / pay-outs and refunds.
 */
export const STATEMENT_FILTERS = ['all', 'receipts', 'unpaid', 'payments', 'wallet'] as const;
export type StatementFilter = (typeof STATEMENT_FILTERS)[number];

export const statementQuerySchema = paginationQuerySchema.extend({
  filter: z.enum(STATEMENT_FILTERS).default('all'),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type StatementQuery = z.infer<typeof statementQuerySchema>;

export const STATEMENT_ENTRY_KINDS = [
  'sale',
  'refund',
  'debt_payment',
  'wallet_topup',
  'wallet_withdrawal',
] as const;
export type StatementEntryKind = (typeof STATEMENT_ENTRY_KINDS)[number];

export interface StatementEntry {
  /** `${kind}:${id}` — stable across pages. */
  key: string;
  kind: StatementEntryKind;
  at: string;
  /** Receipt / refund number, when the entry has one. */
  receiptNo: string | null;
  /** Receipts: what was bought (first lines, "PC 01 · 1h 30m" for a session bill). */
  description: string;
  stationCode: string | null;
  /** Session bills: billed play time. */
  durationSeconds: number | null;
  /** The amount of the entry (receipt total, repayment, top-up…), always ≥ 0. */
  amountCents: number;
  /** Receipts: split of the tenders. Repayments: the method used. */
  paid: { cashCents: number; walletCents: number; creditCents: number; otherCents: number };
  /** Receipts settled on credit: the debt's state today. */
  debt: {
    id: string;
    status: 'open' | 'partial' | 'paid' | 'written_off';
    remainingCents: number;
    dueDate: string;
    /** When the debt was fully settled (or written off). */
    settledAt: string | null;
  } | null;
  /** Repayments: the receipts (debts) the money went to. */
  settles: { debtId: string; receiptNo: string | null; amountCents: number }[];
  saleId: string | null;
  sessionId: string | null;
  createdByName: string | null;
  note: string | null;
}

export interface CustomerStatement {
  customer: CustomerSummary;
  /** Over the whole history (not only the filtered page). */
  totals: {
    receiptsCount: number;
    /** Sum of receipt totals net of refunds. */
    spentCents: number;
    paidCashCents: number;
    paidWalletCents: number;
    onCreditCents: number;
    debtPaidCents: number;
    debtOpenCents: number;
    walletTopUpsCents: number;
    playSeconds: number;
    firstVisitAt: string | null;
    lastVisitAt: string | null;
  };
  items: StatementEntry[];
  total: number;
  page: number;
  pageSize: number;
}

// Ads — the customer-screen slideshow (`ads` table, migration 0016)

export const AD_KINDS = ['product', 'custom'] as const;
export type AdKind = (typeof AD_KINDS)[number];

/** Per-slide time on screen; null = the owner's global interval (`client.ads_interval_seconds`). */
export const AD_DURATION_MIN_SECONDS = 3;
export const AD_DURATION_MAX_SECONDS = 120;

const adBadge = z.string().trim().min(1).max(16).nullable().optional();
const adInstant = z.string().datetime({ offset: true }).nullable().optional();
const adClock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

/**
 * Slide styles (0.10.0) for the single-slide layouts (`card` / `full`): `poster` = picture with
 * the caption along the bottom (the 0.7 look), `hero` = the picture floats sharp over a blurred,
 * zoomed copy of itself with big staggered type, `split` = picture left / text right,
 * `banner` = text first with a huge price (promos).
 */
export const AD_STYLES = CLIENT_ADS_STYLES;
export type AdStyle = ClientAdsStyle;
export const AD_VIDEO_MAX_BYTES = 80 * 1024 * 1024;
export const AD_DAYS_ALL = 127;
/** Bit of a weekday in `daysMask` (Monday = 0 … Sunday = 6). */
export function adDayBit(mondayBasedIndex: number): number {
  return 1 << mondayBasedIndex;
}

/**
 * Create / update body. `product` ads: `productId` (one ad per product) and an optional
 * `promoPriceCents` that must stay below the product's selling price — while the ad is active the
 * POS charges it. `custom` ads: `title` (+ `body`), picture uploaded separately.
 */
export const adInputSchema = z
  .object({
    kind: z.enum(AD_KINDS),
    productId: uuidSchema.nullable().optional(),
    title: z.string().trim().min(1).max(80).nullable().optional(),
    body: z.string().trim().max(300).nullable().optional(),
    promoPriceCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
    badge: adBadge,
    theme: z.enum(AD_THEMES).nullable().optional(),
    /** Slide style (0.10.0); null = the owner's default (`client.ads_style`). */
    style: z.enum(AD_STYLES).nullable().optional(),
    /** Accent colour for the price tag / badge (#RRGGBB); null = theme colour. */
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, '#RRGGBB')
      .nullable()
      .optional(),
    /** Call-to-action line ("Order from your seat", "Ask at the desk"). */
    cta: z.string().trim().min(1).max(60).nullable().optional(),
    /** Weekday bitmask, bit 0 = Monday … bit 6 = Sunday; 127 = every day. */
    daysMask: z.number().int().min(1).max(127).optional(),
    /** Daily window `HH:MM` (local time), both or neither; may wrap midnight (22:00 → 02:00). */
    timeFrom: adClock.nullable().optional(),
    timeTo: adClock.nullable().optional(),
    /** How often the slide comes round: 1 = normal, 2 = twice, 3 = three times per rotation. */
    weight: z.number().int().min(1).max(3).optional(),
    /** Only these PCs show the slide; null = every PC. */
    stationIds: z.array(uuidSchema).max(500).nullable().optional(),
    /** Video slide: an https:// URL (uploads go through `PUT /ads/:id/video`). */
    videoUrl: z
      .string()
      .trim()
      .url()
      .regex(/^https?:\/\//i, 'http(s) link')
      .max(2000)
      .nullable()
      .optional(),
    durationSeconds: z
      .number()
      .int()
      .min(AD_DURATION_MIN_SECONDS)
      .max(AD_DURATION_MAX_SECONDS)
      .nullable()
      .optional(),
    startsAt: adInstant,
    endsAt: adInstant,
    /** 0.12.0: the album the slide plays in; null = no album (plays first, with the defaults). */
    albumId: uuidSchema.nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'product' && !v.productId)
      ctx.addIssue({ code: 'custom', path: ['productId'], message: 'Choose a product' });
    if (v.kind === 'custom' && !v.title)
      ctx.addIssue({ code: 'custom', path: ['title'], message: 'A title is required' });
    if (v.kind === 'custom' && v.promoPriceCents != null)
      ctx.addIssue({
        code: 'custom',
        path: ['promoPriceCents'],
        message: 'Only product ads carry a promo price',
      });
    if (v.startsAt && v.endsAt && new Date(v.endsAt) <= new Date(v.startsAt))
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Must end after it starts' });
    if ((v.timeFrom == null) !== (v.timeTo == null))
      ctx.addIssue({ code: 'custom', path: ['timeTo'], message: 'Set both times or neither' });
    if (v.timeFrom && v.timeTo && v.timeFrom === v.timeTo)
      ctx.addIssue({ code: 'custom', path: ['timeTo'], message: 'The window is empty' });
  });
export type AdInput = z.infer<typeof adInputSchema>;
export const adPatchSchema = adInputSchema
  .innerType()
  .omit({ kind: true, productId: true })
  .partial()
  .superRefine((v, ctx) => {
    // A patch may carry one of the two times only when it clears both or sets both.
    if ('timeFrom' in v !== 'timeTo' in v)
      ctx.addIssue({ code: 'custom', path: ['timeTo'], message: 'Set both times or neither' });
    if ((v.timeFrom == null) !== (v.timeTo == null))
      ctx.addIssue({ code: 'custom', path: ['timeTo'], message: 'Set both times or neither' });
    if (v.timeFrom && v.timeTo && v.timeFrom === v.timeTo)
      ctx.addIssue({ code: 'custom', path: ['timeTo'], message: 'The window is empty' });
  });
export type AdPatch = z.infer<typeof adPatchSchema>;

export const adReorderSchema = z.object({ ids: z.array(uuidSchema).min(1).max(500) });
export type AdReorderRequest = z.infer<typeof adReorderSchema>;

/** `POST /ads/products/bulk` — one plain product ad (no promo) per chosen product, in that order. */
export const adBulkProductsSchema = z.object({
  productIds: z.array(uuidSchema).min(1).max(500),
  /** 0.12.0: put the new slides straight into this album. */
  albumId: uuidSchema.nullable().optional(),
});
export type AdBulkProductsRequest = z.infer<typeof adBulkProductsSchema>;
/** `POST /ads/products/all` — every active product (optionally only those with a photo). */
export const adAddAllSchema = z.object({
  onlyWithPhoto: z.boolean().default(false),
  albumId: uuidSchema.nullable().optional(),
});
export type AdAddAllRequest = z.infer<typeof adAddAllSchema>;

/**
 * Why an ad is (not) on the screens right now — shown as a status chip in Admin. `unavailable`
 * = the product was archived; being out of stock does not hide an ad (0.7.1), the Admin only
 * flags it.
 */
export const AD_STATES = [
  'live',
  'disabled',
  'scheduled',
  'expired',
  'unavailable',
  'off_hours',
  /** 0.12.0: the slide's album is switched off. */
  'album_off',
] as const;
export type AdState = (typeof AD_STATES)[number];

export interface AdSummary {
  id: string;
  kind: AdKind;
  /** Product ads */
  productId: string | null;
  productName: string | null;
  productSku: string | null;
  productPriceCents: number | null;
  productInStock: boolean | null;
  productActive: boolean | null;
  promoPriceCents: number | null;
  /** Custom ads: title. `body` is the slide text — also allowed under a product's name. */
  title: string | null;
  body: string | null;
  /** Picture: the custom ad's own upload, or the product's photo. Server-relative URL. */
  imageUrl: string | null;
  badge: string | null;
  /** Background preset; null = `midnight`. */
  theme: AdTheme | null;
  /** Seconds on screen; null = the global interval. */
  durationSeconds: number | null;
  startsAt: string | null;
  endsAt: string | null;
  /** 0.10.0 */
  style: AdStyle | null;
  accent: string | null;
  cta: string | null;
  daysMask: number;
  timeFrom: string | null;
  timeTo: string | null;
  weight: number;
  stationIds: string[];
  /** Server-relative URL of the uploaded video, or the external URL; null = picture / text slide. */
  videoUrl: string | null;
  /** 0.12.0: album the slide plays in (`AdAlbumSummary.id`), null = no album. */
  albumId: string | null;
  enabled: boolean;
  sortOrder: number;
  /** `live` = currently part of the client feed (`off_hours` = outside its weekly schedule). */
  state: AdState;
  createdAt: string;
  updatedAt: string;
}

/** `POST /ads/products/all|bulk` — the products that had no ad yet were added. */
export interface AdBulkResult {
  created: number;
  items: AdSummary[];
}

// ─── Albums (0.12.0, `ad_albums`) ───────────────────────────────────────────
// A named group of slides with its own look. The PCs play the albums one after another in
// `sortOrder` (slides without an album first), each completely, then start over. Every look
// field is nullable: null = "as in Settings › Client screen" (the owner's default).

export const AD_ALBUM_NAME_MAX = 60;
const adAlbumLook = {
  layout: z.enum(CLIENT_ADS_LAYOUTS).nullable().optional(),
  /** Grid layout: columns × rows per page. */
  grid: z.enum(CLIENT_ADS_GRIDS).nullable().optional(),
  imageFit: z.enum(CLIENT_ADS_IMAGE_FITS).nullable().optional(),
  caption: z.enum(CLIENT_ADS_CAPTIONS).nullable().optional(),
  /** Default slide style of the album (single-slide layouts). */
  style: z.enum(CLIENT_ADS_STYLES).nullable().optional(),
  /** Seconds per page in this album; null = the owner's interval. */
  intervalSeconds: z
    .number()
    .int()
    .min(AD_DURATION_MIN_SECONDS)
    .max(AD_DURATION_MAX_SECONDS)
    .nullable()
    .optional(),
  /** Shuffle the slides inside the album; null = the owner's setting. */
  shuffle: z.boolean().nullable().optional(),
};
export const adAlbumInputSchema = z.object({
  name: z.string().trim().min(1).max(AD_ALBUM_NAME_MAX),
  ...adAlbumLook,
  /** Off = the whole album leaves the screens (its slides show `album_off`). */
  enabled: z.boolean().default(true),
});
export type AdAlbumInput = z.infer<typeof adAlbumInputSchema>;
export const adAlbumPatchSchema = adAlbumInputSchema.partial();
export type AdAlbumPatch = z.infer<typeof adAlbumPatchSchema>;
/** `PUT /ads/albums/order` — the given albums first, in that order; others keep following. */
export const adAlbumReorderSchema = z.object({ ids: z.array(uuidSchema).min(1).max(100) });
export type AdAlbumReorderRequest = z.infer<typeof adAlbumReorderSchema>;
/** `PUT /ads/album` — move slides into an album (`albumId: null` = out of any album). */
export const adMoveToAlbumSchema = z.object({
  ids: z.array(uuidSchema).min(1).max(500),
  albumId: uuidSchema.nullable(),
});
export type AdMoveToAlbumRequest = z.infer<typeof adMoveToAlbumSchema>;

export interface AdAlbumSummary {
  id: string;
  name: string;
  layout: ClientAdsLayout | null;
  grid: ClientAdsGrid | null;
  imageFit: ClientAdsImageFit | null;
  caption: ClientAdsCaption | null;
  style: ClientAdsStyle | null;
  intervalSeconds: number | null;
  shuffle: boolean | null;
  enabled: boolean;
  sortOrder: number;
  /** Slides in the album / of those, the ones on the screens right now. */
  adCount: number;
  liveCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Global search (0.15.0) ──────────────────────────────────────────────────────
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(80),
  /** Per-group cap (the palette shows a handful per kind). */
  limit: z.coerce.number().int().min(1).max(20).default(6),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export type SearchHit =
  | {
      kind: 'sale';
      id: string;
      receiptNo: string;
      status: SaleStatus;
      totalCents: number;
      customerName: string | null;
      completedAt: string | null;
    }
  | {
      kind: 'refund';
      id: string;
      refundNo: string;
      saleId: string;
      receiptNo: string | null;
      totalCents: number;
      createdAt: string;
    }
  | {
      kind: 'invoice';
      id: string;
      invoiceNo: string;
      status: string;
      billingName: string | null;
      issuedAt: string;
      saleId: string | null;
    }
  | {
      kind: 'purchase';
      id: string;
      referenceNo: string;
      status: string;
      supplierName: string | null;
      totalCents: number;
      orderDate: string | null;
    }
  | {
      kind: 'customer';
      id: string;
      code: string;
      name: string;
      phone: string | null;
      loginUsername: string | null;
      balanceDueCents: number;
      walletBalanceCents: number;
    }
  | {
      kind: 'product';
      id: string;
      name: string;
      /** The barcode that matched the query (or the first one). */
      barcode: string | null;
      sellingPriceCents: number;
      stockMilli: number;
      trackStock: boolean;
      isActive: boolean;
    }
  | { kind: 'station'; id: string; code: string; name: string; enabled: boolean };

export type SearchKind = SearchHit['kind'];

export interface SearchResponse {
  q: string;
  /** A document number typed in full (receipt, refund, invoice, purchase) — opened directly on Enter. */
  exact: SearchHit | null;
  /** Grouped, each group capped at `limit`, only the kinds the user may see. */
  hits: SearchHit[];
}

// ─── Import from another program (0.15.0) ───────────────────────────────────────
export const IMPORT_SOURCES = ['likapos_pro'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export const IMPORT_ENTITIES = ['products', 'customers', 'debts', 'sales', 'expenses'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

/** What the file contains, per entity — shown on the wizard's preview step. */
export interface ImportEntityPreview {
  /** Rows in the file that can be imported. */
  total: number;
  /** Rows already linked to a LIKApcs record by an earlier run (will be skipped). */
  alreadyImported: number;
  /** Money involved, where it means something (debts open amount, sales total, expenses total). */
  amountCents: number | null;
  /** A few names / numbers so the operator recognises the data. */
  sample: string[];
  /** Earliest / latest date in the rows, when dated. */
  from: string | null;
  to: string | null;
}

export interface ImportAnalysis {
  source: ImportSource;
  /** Store name / export date as recorded in the file, when present. */
  storeName: string | null;
  exportedAt: string | null;
  entities: Record<ImportEntity, ImportEntityPreview>;
  /** Things the operator should know before importing (variants flattened, invalid barcodes, …). */
  warnings: string[];
  /** Parts of the file that are never imported, with their row counts. */
  notImported: { key: string; count: number }[];
}

export const importRunOptionsSchema = z.object({
  entities: z.array(z.enum(IMPORT_ENTITIES)).min(1),
  dryRun: z.boolean().default(false),
  fileName: z.string().trim().max(200).optional(),
});
export type ImportRunOptions = z.infer<typeof importRunOptionsSchema>;

export interface ImportEntityResult {
  created: number;
  skipped: number;
  failed: number;
}

export interface ImportReport {
  dryRun: boolean;
  runId: string | null;
  backupId: string | null;
  results: Record<ImportEntity, ImportEntityResult>;
  /** Pictures queued for download after the import (links in the file). */
  imagesQueued: number;
  warnings: string[];
  durationMs: number;
}

export interface ImportStatus {
  /** Background picture downloads started by the last import on this server process. */
  images: { pending: number; done: number; failed: number };
  lastRun: {
    id: string;
    source: ImportSource;
    fileName: string | null;
    startedAt: string;
    finishedAt: string | null;
    status: 'running' | 'succeeded' | 'failed';
    report: ImportReport | null;
  } | null;
}

// ─── Customer display (0.16.0) ──────────────────────────────────────────────────
/**
 * `GET /ads/feed` — what the counter's customer-facing screen plays while no sale is open: the
 * same live slides / albums a PC gets (no station filter), plus the owner's default look the
 * albums resolve against and the few business facts the screen shows. Any signed-in user may
 * read it (it is what every customer sees anyway).
 */
export interface CustomerDisplayFeed {
  feed: ClientAdsFeed;
  ads: ClientDisplayConfig['ads'];
  businessName: string;
  language: 'en' | 'sq';
  currency: string;
}
