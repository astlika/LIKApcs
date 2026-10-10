/**
 * Bridge to the native shell (Tauri) for main-PC features: the bundled LIKApcs Server, LAN
 * discovery, Windows Firewall and start-at-login. Every function degrades gracefully in the
 * browser/dev build, where `isDesktopApp()` is false.
 */
import { isDesktopApp } from './updater';

export interface EmbeddedServerInfo {
  /** True only on the main (counter) PC, where the installer placed the server runtime. */
  available: boolean;
  running: boolean;
  version: string | null;
  port: number;
  pid: number | null;
  runtimeDir: string | null;
  dataDir: string;
  logFile: string | null;
}

export interface DiscoveredServer {
  service: 'likapcs';
  protocolVersion: number;
  version: string;
  installationId: string;
  name: string;
  port: number;
  urls: string[];
  ts: string;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** Null in the browser build; `available: false` on secondary Admin PCs. */
export async function embeddedServerInfo(): Promise<EmbeddedServerInfo | null> {
  if (!isDesktopApp()) return null;
  return invoke<EmbeddedServerInfo>('embedded_server_info');
}

/** Starts the bundled server when it is not running and waits until it answers (≤ 90 s). */
export function embeddedServerStart(): Promise<EmbeddedServerInfo> {
  return invoke<EmbeddedServerInfo>('embedded_server_start');
}
export interface EmbeddedStartupState {
  phase:
    | 'starting'
    | 'database-init'
    | 'database-start'
    | 'database-repair'
    | 'migrations'
    | 'listening'
    | 'failed';
  detail: string | null;
  error: string | null;
  pid: number;
  version: string;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
}

export interface EmbeddedStartupStatus {
  running: boolean;
  startup: EmbeddedStartupState | null;
  logFile: string;
}

/** Non-blocking start; resolves true when a new server process was spawned. */
export function embeddedServerLaunch(): Promise<boolean> {
  return invoke<boolean>('embedded_server_launch');
}
/** Health + the server's own start-up progress (`startup.json`). */
export function embeddedServerStartup(): Promise<EmbeddedStartupStatus> {
  return invoke<EmbeddedStartupStatus>('embedded_server_startup');
}
export function embeddedServerStop(): Promise<EmbeddedServerInfo> {
  return invoke<EmbeddedServerInfo>('embedded_server_stop');
}
export function embeddedServerRestart(): Promise<EmbeddedServerInfo> {
  return invoke<EmbeddedServerInfo>('embedded_server_restart');
}

/** Last part of the bundled server's log file (main PC only; empty when there is no log yet). */
export function embeddedServerLog(maxBytes = 64 * 1024): Promise<string> {
  return invoke<string>('embedded_server_log', { maxBytes });
}

/** Finds LIKApcs servers on the local network (UDP broadcast, answered by every running server). */
export async function discoverServers(timeoutMs = 2500): Promise<DiscoveredServer[]> {
  if (!isDesktopApp()) return [];
  return invoke<DiscoveredServer[]>('discover_servers', { timeoutMs });
}

/** Adds Windows Firewall rules for the server (one UAC prompt). Rejects when cancelled. */
export function allowFirewall(): Promise<void> {
  return invoke<void>('allow_firewall');
}

export async function autostartEnabled(): Promise<boolean> {
  if (!isDesktopApp()) return false;
  const { isEnabled } = await import('@tauri-apps/plugin-autostart');
  return isEnabled();
}
export async function setAutostart(enabled: boolean): Promise<void> {
  const mod = await import('@tauri-apps/plugin-autostart');
  if (enabled) await mod.enable();
  else await mod.disable();
}
