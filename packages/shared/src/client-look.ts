/**
 * 0.20.0: how one PC's customer screen differs from the house look (`stations.look`), and how the
 * server turns the global `client.*` settings plus that PC's overrides into what the PC receives.
 * Pure functions: the server, the Admin preview and the tests share them.
 */
import { z } from 'zod';
import type { ClientDisplayConfig } from './protocol.js';
import {
  CLIENT_DISPLAY_SETTING_KEYS,
  CLIENT_WIDGET_POSITIONS,
  CLIENT_WIDGET_SIZES,
  CLIENT_WIDGET_STYLES,
  CLIENT_WIDGET_THEMES,
  SETTING_SCHEMAS,
  type SettingKey,
} from './settings.js';

/**
 * A PC's own overrides. `null` or absent = use the house setting. Stored as JSON on the station.
 */
export const stationLookSchema = z
  .object({
    widgetSize: z.enum(CLIENT_WIDGET_SIZES).nullable().optional(),
    widgetPosition: z.enum(CLIENT_WIDGET_POSITIONS).nullable().optional(),
    widgetStyle: z.enum(CLIENT_WIDGET_STYLES).nullable().optional(),
    widgetTheme: z.enum(CLIENT_WIDGET_THEMES).nullable().optional(),
    adsEnabled: z.boolean().nullable().optional(),
  })
  .strict();
export type StationLook = z.infer<typeof stationLookSchema>;

/** Keeps only the overrides that are set (drops nulls), so the stored JSON stays small. */
export function compactLook(look: StationLook): StationLook {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(look)) if (v !== null && v !== undefined) out[k] = v;
  return out as StationLook;
}

/** The PC's display: the house config with its overrides and its wallpaper applied. */
export function applyStationLook(
  house: ClientDisplayConfig,
  look: StationLook,
  wallpaperUrl: string | null,
  desktopWallpaperUrl: string | null = null,
): ClientDisplayConfig {
  const pick = <T>(value: T | null | undefined, fallback: T): T =>
    value === null || value === undefined ? fallback : value;
  return {
    ...house,
    widgetSize: pick(look.widgetSize, house.widgetSize),
    widgetPosition: pick(look.widgetPosition, house.widgetPosition),
    widgetStyle: pick(look.widgetStyle, house.widgetStyle),
    widgetTheme: pick(look.widgetTheme, house.widgetTheme),
    ads: { ...house.ads, enabled: pick(look.adsEnabled, house.ads.enabled) },
    wallpaperUrl,
    desktopWallpaperUrl,
  };
}

/** The Admin's URL for a station wallpaper file (public, random names — see the server route). */
export const wallpaperPath = (fileName: string): string => `/api/v1/files/wallpapers/${fileName}`;

/**
 * The house settings a layout preset may carry: every customer-screen look key (widget, ads
 * layout, lock title). Nothing else — a preset cannot change prices or the business name.
 */
export const CLIENT_LAYOUT_SETTING_KEYS: readonly SettingKey[] = CLIENT_DISPLAY_SETTING_KEYS.filter(
  (key) => key.startsWith('client.'),
);

export const LAYOUT_PRESET_NAME_MAX = 60;

export type LayoutSettingsCheck =
  { ok: true; settings: Record<string, unknown> } | { ok: false; key: string; message: string };

/**
 * Checks a preset's settings: only layout keys, each value valid for its own setting. Returns the
 * clean map (only the keys given) or the first problem.
 */
export function checkLayoutSettings(input: unknown): LayoutSettingsCheck {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, key: 'settings', message: 'settings must be an object' };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(CLIENT_LAYOUT_SETTING_KEYS as readonly string[]).includes(key)) {
      return { ok: false, key, message: `${key} is not a layout setting` };
    }
    const schema = SETTING_SCHEMAS[key as SettingKey] as z.ZodTypeAny;
    const parsed = schema.safeParse(value);
    if (!parsed.success) return { ok: false, key, message: `${key} has an invalid value` };
    out[key] = parsed.data;
  }
  if (Object.keys(out).length === 0) {
    return {
      ok: false,
      key: 'settings',
      message: 'A preset must hold at least one layout setting',
    };
  }
  return { ok: true, settings: out };
}

/** A layout preset as sent by the Admin (the settings are checked by `checkLayoutSettings`). */
export const layoutPresetBodySchema = z.object({
  name: z.string().trim().min(1).max(LAYOUT_PRESET_NAME_MAX),
  settings: z.unknown(),
});

/** A saved layout preset, as the server lists it. */
export interface LayoutPresetSummary {
  id: string;
  name: string;
  settings: Record<string, unknown>;
  updatedAt: string;
}
