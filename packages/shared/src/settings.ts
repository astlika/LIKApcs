import { z } from 'zod';
import type { ClientDisplayConfig } from './protocol.js';

/**
 * Application settings stored in the `settings` table (one row per key, JSON value).
 * Every key has a validation schema and a default. Business identity is NEVER hardcoded.
 */

export const CLIENT_WIDGET_SIZES = ['small', 'normal', 'large'] as const;
export const CLIENT_WIDGET_POSITIONS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;
export const CLIENT_WIDGET_STYLES = ['minimal', 'detailed'] as const;
export const CLIENT_LOCK_TITLES = ['brand', 'station'] as const;
export const CLIENT_ADS_LAYOUTS = ['card', 'full', 'grid'] as const;
export const CLIENT_ADS_TRANSITIONS = ['slide-left', 'slide-right', 'fade', 'zoom'] as const;
/** Grid pages: columns × rows → 4, 6, 8, 9, 12 or 16 products per page. */
export const CLIENT_ADS_GRIDS = ['2x2', '3x2', '4x2', '3x3', '4x3', '4x4'] as const;
export const CLIENT_ADS_IMAGE_FITS = ['contain', 'cover'] as const;
export const CLIENT_ADS_CAPTIONS = ['bottom', 'top', 'hidden'] as const;
/** Slide / backdrop colour presets (ads 0017, screen backdrop 0018). `midnight` is the default. */
export const AD_THEMES = ['midnight', 'ocean', 'sunset', 'forest', 'ruby', 'gold', 'mono'] as const;
export type ClientWidgetSize = (typeof CLIENT_WIDGET_SIZES)[number];
export type ClientWidgetPosition = (typeof CLIENT_WIDGET_POSITIONS)[number];
export type ClientWidgetStyle = (typeof CLIENT_WIDGET_STYLES)[number];
export type ClientLockTitle = (typeof CLIENT_LOCK_TITLES)[number];
export type ClientAdsLayout = (typeof CLIENT_ADS_LAYOUTS)[number];
export type ClientAdsTransition = (typeof CLIENT_ADS_TRANSITIONS)[number];
export type ClientAdsGrid = (typeof CLIENT_ADS_GRIDS)[number];
export type ClientAdsImageFit = (typeof CLIENT_ADS_IMAGE_FITS)[number];
export type ClientAdsCaption = (typeof CLIENT_ADS_CAPTIONS)[number];
export type AdTheme = (typeof AD_THEMES)[number];

/** `'3x2'` → `{cols: 3, rows: 2}` (products per grid page = cols × rows). */
export function adsGridSize(grid: ClientAdsGrid): { cols: number; rows: number } {
  const [cols, rows] = grid.split('x').map(Number) as [number, number];
  return { cols, rows };
}

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
  'security.min_password_length': z.number().int().min(4).max(64),
  'security.max_failed_logins': z.number().int().min(3).max(20),
  'security.lockout_minutes': z.number().int().min(1).max(1440),

  'stations.heartbeat_interval_seconds': z.number().int().min(3).max(120),
  'stations.offline_after_seconds': z.number().int().min(5).max(600),
  'stations.session_grace_seconds': z.number().int().min(0).max(3600),
  'stations.expiry_warning_minutes': z.array(z.number().int().min(1).max(120)).max(5),
  'stations.client_welcome_message': z.string().max(300),
  /** How long a staff unlock (maintenance) keeps a station PC open before it locks again. */
  'stations.maintenance_minutes': z.number().int().min(1).max(480),
  /** Customer login on the PCs ("Client" button on the locked screen) + session requests. */
  'requests.enabled': z.boolean(),
  /** Quick durations (minutes) a signed-in customer can ask for, besides the gaming packages. */
  'requests.quick_minutes': z
    .array(z.number().int().min(5).max(1440))
    .min(1)
    .max(8)
    .refine((xs) => new Set(xs).size === xs.length, 'durations must be distinct'),

  // ── Client screen (LIKApcs-Client on the customer PC) ──────────────────────
  /** Countdown widget during a session: footprint. */
  'client.widget_size': z.enum(CLIENT_WIDGET_SIZES),
  /** Countdown widget: which corner of the screen. */
  'client.widget_position': z.enum(CLIENT_WIDGET_POSITIONS),
  /** `minimal` = one line like "PC1 · 23 min"; `detailed` = timer, ends-at, paid / owed. */
  'client.widget_style': z.enum(CLIENT_WIDGET_STYLES),
  /** Show the paid amount (prepaid) / the running amount owed (postpaid) in the widget. */
  'client.widget_show_payment': z.boolean(),
  /** Lock screen title: the brand ("LIKApcs") or the station code ("PC 01"). */
  'client.lock_title': z.enum(CLIENT_LOCK_TITLES),
  /** Lock-screen slideshow of in-stock products with photos. */
  'client.ads_enabled': z.boolean(),
  /** `card` one product at a time; `full` edge-to-edge photo; `grid` a classic box of several. */
  'client.ads_layout': z.enum(CLIENT_ADS_LAYOUTS),
  'client.ads_transition': z.enum(CLIENT_ADS_TRANSITIONS),
  'client.ads_interval_seconds': z.number().int().min(3).max(120),
  'client.ads_show_price': z.boolean(),
  /** Username pre-filled in the staff login that a left click on the locked screen opens. */
  'client.staff_login_username': z.string().trim().max(64),
  // ── Screen (0018): what the locked PC shows around and inside the slideshow ──
  /** Grid layout page size (columns × rows). */
  'client.ads_grid': z.enum(CLIENT_ADS_GRIDS),
  /** Slideshow edge to edge; brand, clock, PC code and status become overlays (toggles below). */
  'client.ads_fullscreen': z.boolean(),
  'client.ads_show_clock': z.boolean(),
  'client.ads_show_brand': z.boolean(),
  'client.ads_show_station': z.boolean(),
  /** The "This PC is locked — ask the staff" strip. */
  'client.ads_show_status': z.boolean(),
  /** Category chip ("DRINKS") above the product name. */
  'client.ads_show_category': z.boolean(),
  /** Page dots + progress bar of the current slide. */
  'client.ads_show_progress': z.boolean(),
  'client.ads_image_fit': z.enum(CLIENT_ADS_IMAGE_FITS),
  /** Full layout: caption at the bottom, at the top, or no caption at all. */
  'client.ads_caption': z.enum(CLIENT_ADS_CAPTIONS),
  /** Slow zoom / pan on full-screen pictures (Ken Burns). */
  'client.ads_motion': z.boolean(),
  /** Backdrop behind the slides (same presets as the slide themes). */
  'client.ads_background': z.enum(AD_THEMES),
  /** Scrolling line at the bottom of the locked screen; empty = none. */
  'client.ads_ticker_text': z.string().trim().max(200),

  'pos.receipt_width_mm': z.union([z.literal(58), z.literal(80)]),
  /** Open the print dialog as soon as a sale is completed (off: the cashier presses Print). */
  'pos.auto_print_receipt': z.boolean(),
  /** Seconds the "sale completed" screen stays before the next sale starts by itself (0 = wait). */
  'pos.auto_finish_seconds': z.number().int().min(0).max(60),
  /** Offer card as a payment method. Off: every payment choice in the app is cash only. */
  'pos.card_payments': z.boolean(),
  /** Offer "pay later" (customer debt with a due date) in POS and session bills. */
  /** Pre-filled due date for a new debt: today + this many days. */
  'pos.credit_default_days': z.number().int().min(0).max(365),

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
  'security.min_password_length': 4,
  'security.max_failed_logins': 5,
  'security.lockout_minutes': 15,

  'stations.heartbeat_interval_seconds': 10,
  'stations.offline_after_seconds': 35,
  'stations.session_grace_seconds': 120,
  'stations.expiry_warning_minutes': [5, 1],
  'stations.client_welcome_message': 'Welcome! Please ask the staff to start your session.',
  'stations.maintenance_minutes': 15,
  'requests.enabled': true,
  'requests.quick_minutes': [30, 60, 120, 180],

  'client.widget_size': 'normal',
  'client.widget_position': 'top-right',
  'client.widget_style': 'detailed',
  'client.widget_show_payment': true,
  'client.lock_title': 'brand',
  'client.ads_enabled': false,
  'client.ads_layout': 'card',
  'client.ads_transition': 'slide-left',
  'client.ads_interval_seconds': 8,
  'client.ads_show_price': true,
  'client.staff_login_username': '',
  'client.ads_grid': '2x2',
  'client.ads_fullscreen': false,
  'client.ads_show_clock': true,
  'client.ads_show_brand': true,
  'client.ads_show_station': true,
  'client.ads_show_status': true,
  'client.ads_show_category': true,
  'client.ads_show_progress': true,
  'client.ads_image_fit': 'contain',
  'client.ads_caption': 'bottom',
  'client.ads_motion': true,
  'client.ads_background': 'midnight',
  'client.ads_ticker_text': '',

  'pos.receipt_width_mm': 80,
  'pos.auto_print_receipt': false,
  'pos.auto_finish_seconds': 5,
  'pos.card_payments': false,
  'pos.credit_default_days': 7,

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
  // Which payment methods the app offers; every cashier needs it before any sale exists.
  'pos.card_payments',
  'pos.credit_default_days',
  // Client screen: the Admin previews them; the client receives them through its own channel.
  'client.widget_size',
  'client.widget_position',
  'client.widget_style',
  'client.widget_show_payment',
  'client.lock_title',
  'client.ads_enabled',
  'client.ads_layout',
  'client.ads_transition',
  'client.ads_interval_seconds',
  'client.ads_show_price',
  'client.staff_login_username',
  'client.ads_grid',
  'client.ads_fullscreen',
  'client.ads_show_clock',
  'client.ads_show_brand',
  'client.ads_show_station',
  'client.ads_show_status',
  'client.ads_show_category',
  'client.ads_show_progress',
  'client.ads_image_fit',
  'client.ads_caption',
  'client.ads_motion',
  'client.ads_background',
  'client.ads_ticker_text',
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

/** Keys whose change must be pushed to every connected customer PC (`server.display`). */
export const CLIENT_DISPLAY_SETTING_KEYS: readonly SettingKey[] = [
  'requests.enabled',
  'client.widget_size',
  'client.widget_position',
  'client.widget_style',
  'client.widget_show_payment',
  'client.lock_title',
  'client.ads_enabled',
  'client.ads_layout',
  'client.ads_transition',
  'client.ads_interval_seconds',
  'client.ads_show_price',
  'client.staff_login_username',
  'client.ads_grid',
  'client.ads_fullscreen',
  'client.ads_show_clock',
  'client.ads_show_brand',
  'client.ads_show_station',
  'client.ads_show_status',
  'client.ads_show_category',
  'client.ads_show_progress',
  'client.ads_image_fit',
  'client.ads_caption',
  'client.ads_motion',
  'client.ads_background',
  'client.ads_ticker_text',
  'locale.currency',
  'locale.default_language',
  'business.name',
  'stations.client_welcome_message',
];

/** The customer-screen configuration the client receives, derived from the settings map. */
export function clientDisplayFromSettings(settings: SettingsMap): ClientDisplayConfig {
  return {
    widgetSize: settings['client.widget_size'],
    widgetPosition: settings['client.widget_position'],
    widgetStyle: settings['client.widget_style'],
    widgetShowPayment: settings['client.widget_show_payment'],
    lockTitle: settings['client.lock_title'],
    currency: settings['locale.currency'],
    staffLoginUsername: settings['client.staff_login_username'],
    customerLogin: settings['requests.enabled'],
    ads: {
      enabled: settings['client.ads_enabled'],
      layout: settings['client.ads_layout'],
      transition: settings['client.ads_transition'],
      intervalSeconds: settings['client.ads_interval_seconds'],
      showPrice: settings['client.ads_show_price'],
      grid: settings['client.ads_grid'],
      fullscreen: settings['client.ads_fullscreen'],
      showClock: settings['client.ads_show_clock'],
      showBrand: settings['client.ads_show_brand'],
      showStation: settings['client.ads_show_station'],
      showStatus: settings['client.ads_show_status'],
      showCategory: settings['client.ads_show_category'],
      showProgress: settings['client.ads_show_progress'],
      imageFit: settings['client.ads_image_fit'],
      caption: settings['client.ads_caption'],
      motion: settings['client.ads_motion'],
      background: settings['client.ads_background'],
      tickerText: settings['client.ads_ticker_text'],
    },
  };
}
