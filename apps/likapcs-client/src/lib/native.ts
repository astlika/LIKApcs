/**
 * Bridge to the Tauri shell. In the browser/dev build every function degrades to a harmless
 * fallback (localStorage secrets, no window control, no power actions) so the agent logic can be
 * exercised against a real server without the native app.
 */
import type {
  ClientMetrics,
  HardwareInfo,
  HealthResponse,
  RemoteInputEvent,
} from '@likapcs/shared';
import { widgetDesign, widgetFootprint } from '@likapcs/shared';

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

/** Live control (phase 2): sends one input event to this PC. Desktop app only. */
export async function sendRemoteInput(event: RemoteInputEvent): Promise<void> {
  if (!isDesktopApp()) return;
  await invoke<void>('send_remote_input', { event });
}

/** Live screen (remote view): one JPEG of the primary screen. Desktop app only. */
export async function captureScreenFrame(
  maxWidth: number,
  maxHeight: number,
  quality: number,
): Promise<{ width: number; height: number; jpeg: string }> {
  if (!isDesktopApp()) throw new Error('live screen is only available in the desktop app');
  return invoke<{ width: number; height: number; jpeg: string }>('capture_screen_frame', {
    maxWidth,
    maxHeight,
    quality,
  });
}

/** 0.23.0: sets this PC's Windows desktop wallpaper (base64 picture bytes; ext `png` or `jpg`). */
export async function setDesktopWallpaper(bytesBase64: string, ext: 'png' | 'jpg'): Promise<void> {
  if (isDesktopApp()) return invoke<void>('set_desktop_wallpaper', { bytes: bytesBase64, ext });
}

/** 0.23.0: puts back the wallpaper the PC had before the first Admin change. */
export async function restoreDesktopWallpaper(): Promise<void> {
  if (isDesktopApp()) return invoke<void>('restore_desktop_wallpaper');
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

/** Static hardware facts (CPU, GPU, RAM, OS, disk). Fields the OS does not expose stay absent. */
export async function hardwareInfo(): Promise<HardwareInfo | null> {
  if (!isDesktopApp()) return null;
  try {
    return await invoke<HardwareInfo>('hardware_info');
  } catch {
    return null;
  }
}

/** Live load (CPU %, RAM, free disk, temperatures) — null outside the desktop app or on failure. */
export async function hardwareMetrics(): Promise<Omit<ClientMetrics, 'uptimeSeconds'> | null> {
  if (!isDesktopApp()) return null;
  try {
    return await invoke<Omit<ClientMetrics, 'uptimeSeconds'>>('hardware_metrics');
  } catch {
    return null;
  }
}

export async function discoverServers(timeoutMs = 2500): Promise<DiscoveredServer[]> {
  if (!isDesktopApp()) return [];
  return invoke<DiscoveredServer[]>('discover_servers', { timeoutMs });
}

/**
 * Countdown widget design + footprint + corner (owner settings, 0.13.0 designs). The window size
 * comes from the shared design table so the native shell needs no knowledge of the designs; the
 * see-through designs make the window background transparent. Browser dev mode mirrors it via CSS.
 */
/** The window size we last asked the native shell for, and how to ask again (0.16.2 fix). */
let expectedWidth = 0;
let expectedHeight = 0;
let replayWindow: (() => Promise<void>) | null = null;

/** True when the webview really is the size we asked for (the widget window, on the desktop). */
export function widgetWindowSizeOk(): boolean {
  if (!isDesktopApp() || expectedWidth === 0) return true;
  return (
    Math.abs(window.innerWidth - expectedWidth) <= 6 &&
    Math.abs(window.innerHeight - expectedHeight) <= 6
  );
}

/** Asks the native shell for the widget window again (same design / same fit as last time). */
export async function reapplyWidgetWindow(): Promise<void> {
  await replayWindow?.();
}

export async function setWidgetLayout(
  size: string,
  position: string,
  style: string,
): Promise<void> {
  const design = widgetDesign(style);
  const { width, height } = widgetFootprint(design.id, size);
  expectedWidth = width;
  expectedHeight = height;
  replayWindow = () => setWidgetLayout(size, position, style);
  const root = document.documentElement;
  root.dataset.widgetSize = size;
  root.dataset.widgetPos = position;
  root.dataset.widgetDesign = design.id;
  root.dataset.widgetTransparent = design.transparent ? '1' : '0';
  root.style.setProperty('--ov-w', `${width}px`);
  root.style.setProperty('--ov-h', `${height}px`);
  if (!isDesktopApp()) return;
  try {
    await invoke<void>('set_widget_layout', { size, position, width, height });
  } catch {
    /* an older native shell without the command keeps the default corner */
  }
}

/**
 * Tells the Rust side the React app has mounted (0.17.1 handshake). If this never arrives the
 * Rust guard replaces a silently blank window with a native message + crash.log line.
 */
export async function reportWebviewReady(): Promise<void> {
  if (!isDesktopApp()) return;
  try {
    await invoke('webview_ready');
  } catch {
    /* a missing command only means an older native side — never worth breaking the UI for */
  }
}

/** 0.17.1: the PC's own widget-visibility check (heals a hidden / off-screen widget window). */
export async function widgetCheck(): Promise<{ ok: boolean; detail: string }> {
  if (!isDesktopApp()) return { ok: true, detail: 'browser' };
  return invoke<{ ok: boolean; detail: string }>('widget_check');
}

/**
 * The card widget grows to fit its words (staff notice, maintenance, an order flash): the overlay
 * measures what it rendered and asks the native shell for a window that shows all of it, so no
 * text is ever cut and a narrow footprint never clips the staff's message (0.17.0).
 */
export async function setWidgetFit(width: number, height: number): Promise<void> {
  expectedWidth = Math.round(width);
  expectedHeight = Math.round(height);
  replayWindow = () => setWidgetFit(width, height);
  const root = document.documentElement;
  root.style.setProperty('--ov-w', `${Math.round(width)}px`);
  root.style.setProperty('--ov-h', `${Math.round(height)}px`);
  if (!isDesktopApp()) return;
  try {
    await invoke<void>('widget_fit', { width, height });
  } catch {
    /* an older native shell keeps the design footprint */
  }
}

/** The owner's "block the Windows key in Steam games" setting, applied by the keyboard hook. */
export async function setBlockWinInGames(enabled: boolean): Promise<void> {
  if (!isDesktopApp()) return;
  try {
    await invoke<void>('set_block_win_in_games', { enabled });
  } catch {
    /* an older native shell without the command keeps the Windows key working */
  }
}

/** 0.19.7: the owner's "hide the widget in games" setting, applied by the native watcher. */
export async function setWidgetHideInGames(enabled: boolean): Promise<void> {
  if (!isDesktopApp()) return;
  try {
    await invoke<void>('set_widget_hide_in_games', { enabled });
  } catch {
    /* an older native shell without the command keeps showing the widget */
  }
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

export interface WolConfigureResult {
  ok: boolean;
  message: string;
  /** True when Windows had to ask for administrator confirmation (UAC) on this PC. */
  elevated: boolean;
  /** Fresh hardware facts (adapters re-read) — null outside the desktop app. */
  hardware: HardwareInfo | null;
}

/**
 * Switches "wake on magic packet" on for every physical adapter and Fast startup off. Needs
 * admin rights on the PC: the native side tries directly and falls back to a UAC prompt.
 */
export async function wolConfigure(): Promise<WolConfigureResult> {
  if (!isDesktopApp()) {
    return {
      ok: false,
      message: 'not available in the browser build',
      elevated: false,
      hardware: null,
    };
  }
  return invoke<WolConfigureResult>('wol_configure');
}

/** What the PC did with an End Task request (`tasks.end`) — one entry per listed program. */
export interface EndTasksResult {
  /** Programs that were running and are closed now. */
  closed: string[];
  /** Listed programs that were not running at all. */
  notRunning: string[];
  /** Programs that could not be closed (`error` is what Windows said). */
  failed: { exe: string; error: string }[];
  /** Entries the native side refused by itself (protected or malformed). */
  skipped: string[];
}

/**
 * End Task (0.17.0): closes the listed programs with `taskkill /IM <name> /F /T`. The native
 * side keeps its own protected list (LIKApcs-Client, WebView2, the Windows shell) and refuses
 * anything that is not a plain `name.exe`, so a bad request can never take the PC down.
 */
export async function endTasks(exes: string[]): Promise<EndTasksResult> {
  if (!isDesktopApp()) {
    console.info(`[dev] end tasks ignored: ${exes.join(', ')}`);
    return { closed: [], notRunning: exes, failed: [], skipped: [] };
  }
  return invoke<EndTasksResult>('end_tasks', { exes });
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

/**
 * 0.17.1: the LAN path first — cafe PCs usually have no internet, so the server on the local
 * network serves the signed installer (Admin → Updates → "Publish to LAN"). Same minisign
 * signature as GitHub; the updater verifies it before installing.
 */
export async function checkUpdateFromServer(serverUrl: string): Promise<UpdateCheck> {
  if (!isDesktopApp()) return { status: 'unavailable' };
  try {
    const version = await invoke<string | null>('update_check_server', { base: serverUrl });
    return version ? { status: 'available', version } : { status: 'none' };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Downloads the LAN-published installer and applies it (the client relaunches itself). */
export async function applySelfUpdateFromServer(
  serverUrl: string,
  onProgress?: (percent: number | null) => void,
): Promise<UpdateOutcome> {
  if (!isDesktopApp()) return { status: 'unavailable' };
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<number | null>('update-progress', (event) =>
    onProgress?.(event.payload),
  );
  try {
    const version = await invoke<string | null>('update_from_server', { base: serverUrl });
    if (!version) return { status: 'none' };
    return { status: 'installed', version };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  } finally {
    unlisten();
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

/** Outcome of a CS2 command on this PC (`cs2.install`, `cs2.start`, `cs2.stop`, `cs2.connect`). */
export interface Cs2Result {
  ok: boolean;
  message: string;
  /** Start only: whether the firewall rules for the server port are in place (one Windows admin prompt, then remembered). */
  firewall?: boolean;
}

const cs2Unavailable = (): Cs2Result => ({
  ok: false,
  message: 'not available in the browser build',
});

/** 0.24.0: downloads the CS2 dedicated server with SteamCMD (the firewall is handled at start). */
export async function cs2Install(): Promise<Cs2Result> {
  if (!isDesktopApp()) return cs2Unavailable();
  return invoke<Cs2Result>('cs2_install');
}

/** 0.24.0: starts the CS2 server with the arguments the server built (`-dedicated …`). */
export async function cs2Start(args: string[]): Promise<Cs2Result> {
  if (!isDesktopApp()) return cs2Unavailable();
  return invoke<Cs2Result>('cs2_start', { args });
}

/** 0.24.0: stops the CS2 server on this PC. */
export async function cs2Stop(): Promise<Cs2Result> {
  if (!isDesktopApp()) return cs2Unavailable();
  return invoke<Cs2Result>('cs2_stop');
}

/** 0.24.0: starts CS2 through Steam and joins the server from the link the server built. */
export async function cs2Connect(url: string): Promise<Cs2Result> {
  if (!isDesktopApp()) return cs2Unavailable();
  return invoke<Cs2Result>('cs2_connect', { url });
}
