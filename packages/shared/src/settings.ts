import { z } from 'zod';

/**
 * Application settings stored in the `settings` table (one row per key, JSON value).
 * Every key has a validation schema and a default. Business identity is NEVER hardcoded.
 */

export const LANGUAGES = ['en', 'sq'] as const;
export type Language = (typeof LANGUAGES)[number];

export const SETTING_SCHEMAS = {
  'business.name': z.string().min(1).max(120),
  'business.legal_name': z.string().max(160),
  'business.address': z.string().max(300),
  'business.city': z.string().max(80),
  'business.phone': z.string().max(40),
  'business.email': z.string().max(120),
  'business.website': z.string().max(120),
  'business.tax_id': z.string().max(40),
  'business.registration_no': z.string().max(40),
  'business.logo_path': z.string().max(500),
  'business.receipt_footer': z.string().max(500),

  'locale.default_language': z.enum(LANGUAGES),
  'locale.currency': z.string().length(3),
  'locale.timezone': z.string().min(1).max(64),
  'locale.date_format': z.literal('DD.MM.YYYY'),
  'locale.time_format': z.literal('HH:mm'),

  'tax.default_rate_bp': z.number().int().min(0).max(10_000),
  'tax.prices_include_tax': z.boolean(),

  'security.session_hours': z.number().int().min(1).max(168),
  'security.min_password_length': z.number().int().min(6).max(64),
  'security.max_failed_logins': z.number().int().min(3).max(20),
  'security.lockout_minutes': z.number().int().min(1).max(1440),

  'stations.heartbeat_interval_seconds': z.number().int().min(3).max(120),
  'stations.offline_after_seconds': z.number().int().min(5).max(600),
  'stations.session_grace_seconds': z.number().int().min(0).max(3600),
  'stations.expiry_warning_minutes': z.array(z.number().int().min(1).max(120)).max(5),
  'stations.client_welcome_message': z.string().max(300),

  'pos.scan_increments_quantity': z.boolean(),
  'pos.receipt_width_mm': z.union([z.literal(58), z.literal(80)]),
  'pos.auto_print_receipt': z.boolean(),

  /** Default payment term for invoices (0 = due on issue). */
  'printing.invoice_due_days': z.number().int().min(0).max(365),
  /** Bank account / IBAN block printed on invoices. */
  'printing.invoice_bank_details': z.string().max(500),
  /** Terms / legal text printed at the bottom of invoices. */
  'printing.invoice_footer': z.string().max(1000),

  /** Cash tenders (sales, session bills, drawer expenses) require an open cash shift. */
  'cash.require_open_shift': z.boolean(),
  /** Warn when the closing count differs from the expected cash by more than this (cents). */
  'cash.difference_warning_cents': z.number().int().min(0).max(1_000_000),

  'backup.enabled': z.boolean(),
  'backup.time': z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  'backup.keep_count': z.number().int().min(1).max(365),

  'updates.channel': z.enum(['stable', 'beta']),
  'updates.check_on_startup': z.boolean(),
  'updates.auto_download': z.boolean(),
  'updates.client_policy': z.enum(['manual', 'idle_only', 'maintenance_window']),
  'updates.maintenance_window': z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingsMap = { [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]> };

export const SETTING_DEFAULTS: SettingsMap = {
  'business.name': 'LIKApcs Gaming Station',
  'business.legal_name': '',
  'business.address': '',
  'business.city': '',
  'business.phone': '',
  'business.email': '',
  'business.website': '',
  'business.tax_id': '',
  'business.registration_no': '',
  'business.logo_path': '',
  'business.receipt_footer': '',

  'locale.default_language': 'en',
  'locale.currency': 'EUR',
  'locale.timezone': 'Europe/Belgrade',
  'locale.date_format': 'DD.MM.YYYY',
  'locale.time_format': 'HH:mm',

  'tax.default_rate_bp': 1800,
  'tax.prices_include_tax': true,

  'security.session_hours': 12,
  'security.min_password_length': 8,
  'security.max_failed_logins': 5,
  'security.lockout_minutes': 15,

  'stations.heartbeat_interval_seconds': 10,
  'stations.offline_after_seconds': 35,
  'stations.session_grace_seconds': 120,
  'stations.expiry_warning_minutes': [5, 1],
  'stations.client_welcome_message': 'Welcome! Please ask the staff to start your session.',

  'pos.scan_increments_quantity': true,
  'pos.receipt_width_mm': 80,
  'pos.auto_print_receipt': true,

  'printing.invoice_due_days': 0,
  'printing.invoice_bank_details': '',
  'printing.invoice_footer': '',

  'cash.require_open_shift': true,
  'cash.difference_warning_cents': 500,

  'backup.enabled': true,
  'backup.time': '04:00',
  'backup.keep_count': 30,

  'updates.channel': 'stable',
  'updates.check_on_startup': true,
  'updates.auto_download': false,
  'updates.client_policy': 'idle_only',
  'updates.maintenance_window': '03:00-06:00',
};

export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];

/** Keys readable without authentication (login screen branding, client welcome screen). */
export const PUBLIC_SETTING_KEYS: readonly SettingKey[] = [
  'business.name',
  'locale.default_language',
  'locale.currency',
  'locale.timezone',
  'stations.client_welcome_message',
];

/** Validates a partial settings patch; unknown keys are rejected. */
export function validateSettingsPatch(input: unknown): Partial<SettingsMap> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new z.ZodError([
      { code: 'custom', path: [], message: 'Settings patch must be an object' },
    ]);
  }
  const result: Partial<SettingsMap> = {};
  const issues: z.ZodIssue[] = [];
  for (const [key, value] of Object.entries(input)) {
    const schema = (SETTING_SCHEMAS as Record<string, z.ZodTypeAny>)[key];
    if (!schema) {
      issues.push({ code: 'custom', path: [key], message: `Unknown setting "${key}"` });
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      issues.push(...parsed.error.issues.map((i) => ({ ...i, path: [key, ...i.path] })));
    } else {
      (result as Record<string, unknown>)[key] = parsed.data;
    }
  }
  if (issues.length) throw new z.ZodError(issues);
  return result;
}
