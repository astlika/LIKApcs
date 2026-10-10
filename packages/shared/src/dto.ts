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
  customerId: z.string().uuid().optional(),
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
  barcodes: z.array(productBarcodeSchema).max(20).default([]),
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
  priceIncludesTax: boolean;
  stockMilli: number;
  minStockMilli: number;
  allowNegativeStock: boolean;
  trackStock: boolean;
  lowStock: boolean;
  description: string | null;
  storageLocation: string | null;
  isActive: boolean;
  barcodes: ProductBarcodeSummary[];
  createdAt: string;
  updatedAt: string;
}

export const productListQuerySchema = z.object({
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
export const SALE_PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'other'] as const;

export const saleItemInputSchema = z.object({
  productId: z.string().uuid(),
  quantityMilli: z.number().int().min(1).max(1_000_000_000),
  discountCents: z.number().int().min(0).max(100_000_000).default(0),
});
export type SaleItemInput = z.infer<typeof saleItemInputSchema>;

export const salePaymentInputSchema = z.object({
  method: z.enum(SALE_PAYMENT_METHODS),
  amountCents: z.number().int().min(1).max(100_000_000),
  reference: z.string().trim().max(80).optional(),
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
  method: z.enum(SALE_PAYMENT_METHODS).default('cash'),
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
  balanceDueCents: number;
  notes: string | null;
  status: CustomerStatus;
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

export const customerSchema = z.object({
  code: z.string().trim().max(32).optional(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(120).nullable().optional().or(z.literal('')),
  membership: z.string().trim().max(40).nullable().optional(),
  membershipUntil: isoDate.nullable().optional(),
  discountBp: z.number().int().min(0).max(10_000).default(0),
  notes: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(CUSTOMER_STATUSES).default('active'),
});
export type CustomerRequest = z.infer<typeof customerSchema>;
export const customerPatchSchema = customerSchema.partial();
export type CustomerPatch = z.infer<typeof customerPatchSchema>;

export const customerListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(CUSTOMER_STATUSES).optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

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

export const REPORT_EXPORT_KINDS = [
  'sales',
  'sale_items',
  'expenses',
  'sessions',
  'shifts',
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

export const BACKUP_KINDS = ['manual', 'scheduled', 'pre_migration', 'pre_restore'] as const;
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
