/**
 * Bridge to the Tauri shell. In the browser/dev build every function degrades to a harmless
 * fallback (localStorage secrets, no window control, no power actions) so the agent logic can be
 * exercised against a real server without the native app.
 */
import type { HealthResponse } from '@likapcs/shared';

export interface DeviceIdentity {
  /** Stable per-machine identifier (Windows MachineGuid); null when it cannot be read. */
  machineId: string | null;
  hostname: string;
  osInfo: string;
}

export interface DiscoveredServer {
  installationId: string;
  name: string;
  port: number;
  urls: string[];
  version: string;
  /** IP the discovery reply came from (added by the native layer) — the proven-reachable one. */
  from?: string;
}

/** 'panel': centred settings window used from the tray while the PC is unlocked. */
export type WindowMode = 'locked' | 'overlay' | 'panel';

export const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0-dev';

export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

const LS_PREFIX = 'likapcs-client.secret.';

export async function deviceIdentity(): Promise<DeviceIdentity> {
  if (isDesktopApp()) return invoke<DeviceIdentity>('device_identity');
  return { machineId: null, hostname: 'browser-dev', osInfo: navigator.userAgent.slice(0, 120) };
}

export async function secretGet(name: string): Promise<string | null> {
  if (isDesktopApp()) return invoke<string | null>('secret_get', { name });
  return window.localStorage.getItem(LS_PREFIX + name);
}
export async function secretSet(name: string, value: string): Promise<void> {
  if (isDesktopApp()) return invoke<void>('secret_set', { name, value });
  window.localStorage.setItem(LS_PREFIX + name, value);
}
export async function secretDelete(name: string): Promise<void> {
  if (isDesktopApp()) return invoke<void>('secret_delete', { name });
  window.localStorage.removeItem(LS_PREFIX + name);
}

export async function discoverServers(timeoutMs = 2500): Promise<DiscoveredServer[]> {
  if (!isDesktopApp()) return [];
  return invoke<DiscoveredServer[]>('discover_servers', { timeoutMs });
}

export async function setWindowMode(mode: WindowMode): Promise<void> {
  if (!isDesktopApp()) {
    document.documentElement.dataset.mode = mode;
    return;
  }
  document.documentElement.dataset.mode = mode;
  await invoke<void>('set_window_mode', { mode });
}

export interface ServerProbe {
  ok: boolean;
  url: string;
  version?: string;
  installationId?: string | null;
  name?: string;
  schemaVersion?: number;
  /** Why the address did not answer like a LIKApcs server. */
  error?: 'timeout' | 'unreachable' | 'http' | 'not_likapcs';
}

/**
 * `GET /api/v1/system/health` with a short timeout — the single call used to test an address
 * before it is saved. Works in the browser build too (same-origin or CORS-allowed servers).
 */
export async function probeServer(url: string, timeoutMs = 2500): Promise<ServerProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/v1/system/health`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, url, error: 'http' };
    const body = (await res.json()) as Partial<HealthResponse> | null;
    if (!body || typeof body.version !== 'string' || typeof body.schemaVersion !== 'number') {
      return { ok: false, url, error: 'not_likapcs' };
    }
    return {
      ok: true,
      url,
      version: body.version,
      installationId: body.installationId ?? null,
      name: body.name ?? 'LIKApcs',
      schemaVersion: body.schemaVersion,
    };
  } catch {
    return { ok: false, url, error: controller.signal.aborted ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Probes several addresses at once and resolves with the first *in list order* that answers. */
export async function firstReachable(
  urls: string[],
  timeoutMs = 2500,
): Promise<ServerProbe | null> {
  if (urls.length === 0) return null;
  const probes = await Promise.all(urls.map((u) => probeServer(u, timeoutMs)));
  return probes.find((p) => p.ok) ?? null;
}

export interface TrayLabels {
  status: string;
  settings: string;
  update: string;
  quit: string;
}

/** Tray menu texts + status line (the Rust side rebuilds the menu). No-op in the browser. */
export async function trayUpdate(labels: TrayLabels): Promise<void> {
  if (!isDesktopApp()) return;
  await invoke<void>('tray_update', { labels });
}

export type TrayAction = 'settings' | 'update' | 'quit' | 'status';

/** Tray menu clicks forwarded by the native layer. Resolves with an unlisten function. */
export async function onTrayAction(handler: (action: TrayAction) => void): Promise<() => void> {
  if (!isDesktopApp()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string>('tray', (event) => handler(event.payload as TrayAction));
}

/**
 * Exits the client. The native side refuses while the PC is locked unless `force` is set, which
 * the agent only does for a PC that is not paired yet (technician setting it up).
 */
export async function quitApp(force = false): Promise<void> {
  if (!isDesktopApp()) {
    console.info('[dev] quit ignored');
    return;
  }
  await invoke<void>('quit_app', { force });
}

export async function powerAction(action: 'restart' | 'shutdown'): Promise<void> {
  if (!isDesktopApp()) {
    console.info(`[dev] power action ignored: ${action}`);
    return;
  }
  await invoke<void>('power_action', { action });
}

export async function ensureAutostart(): Promise<void> {
  if (!isDesktopApp()) return;
  try {
    const { enable, isEnabled } = await import('@tauri-apps/plugin-autostart');
    if (!(await isEnabled())) await enable();
  } catch (err) {
    console.warn('autostart could not be enabled', err);
  }
}

export interface UpdateOutcome {
  status: 'none' | 'installed' | 'failed' | 'unavailable';
  version?: string;
  error?: string;
}

export interface UpdateCheck {
  status: 'none' | 'available' | 'failed' | 'unavailable';
  version?: string;
  error?: string;
}

/** Asks the release feed whether a newer signed client exists — without installing anything. */
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!isDesktopApp()) return { status: 'unavailable' };
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check({ timeout: 20_000 });
    if (!update) return { status: 'none' };
    const version = update.version;
    await update.close().catch(() => undefined);
    return { status: 'available', version };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Checks GitHub Releases for a newer signed client, installs it and relaunches. */
export async function applySelfUpdate(
  onProgress?: (percent: number | null) => void,
): Promise<UpdateOutcome> {
  if (!isDesktopApp()) return { status: 'unavailable' };
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check({ timeout: 20_000 });
    if (!update) return { status: 'none' };
    let downloaded = 0;
    let total: number | null = null;
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') total = event.data.contentLength ?? null;
      else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        onProgress?.(total ? Math.round((downloaded / total) * 100) : null);
      } else if (event.event === 'Finished') onProgress?.(100);
    });
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
    return { status: 'installed', version: update.version };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Hex SHA-256 — used to derive the machineId sent to the server from the raw OS identifier. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
