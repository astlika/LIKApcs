import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the zero-configuration ("embedded") server keeps its state and finds its runtime.
 *
 * Installed layout produced by LIKApcs-Setup.exe (per-user, %LOCALAPPDATA%\LIKApcs):
 *   runtime/likapcs-server.exe          Node.js runtime (renamed node.exe)
 *   runtime/server/dist/index.js        this server, fully bundled
 *   runtime/server/database/migrations  SQL migrations
 *   runtime/pgsql/bin|lib|share         portable PostgreSQL
 *
 * Business data NEVER lives inside the installation directory (updates replace it, uninstall
 * removes it). The data directory defaults to %LOCALAPPDATA%\LIKApcs-Data on Windows.
 */

export const DEFAULT_HTTP_PORT = 4700;
export const DEFAULT_DISCOVERY_PORT = 4701;
export const DEFAULT_EMBEDDED_PG_PORT = 54700;

export function isWindows(): boolean {
  return process.platform === 'win32';
}

/** Data directory: LIKAPCS_DATA_DIR, else a per-user location outside the install dir. */
export function resolveDataDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (isWindows()) {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'LIKApcs-Data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'LIKApcs');
  }
  const xdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'likapcs');
}

export interface DataDirs {
  root: string;
  pgdata: string;
  logs: string;
  backups: string;
  configFile: string;
  stateFile: string;
}

export function dataDirs(root: string): DataDirs {
  return {
    root,
    pgdata: path.join(root, 'pgdata'),
    logs: path.join(root, 'logs'),
    backups: path.join(root, 'backups'),
    configFile: path.join(root, 'config.json'),
    stateFile: path.join(root, 'server.json'),
  };
}

export function ensureDataDirs(root: string): DataDirs {
  const dirs = dataDirs(root);
  for (const dir of [dirs.root, dirs.logs, dirs.backups]) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

const PG_EXECUTABLES = ['postgres', 'pg_ctl', 'initdb'] as const;

function hasPostgresBinaries(dir: string): boolean {
  const ext = isWindows() ? '.exe' : '';
  return PG_EXECUTABLES.every((name) => fs.existsSync(path.join(dir, name + ext)));
}

/**
 * Locates portable PostgreSQL binaries: LIKAPCS_PG_BIN, the runtime layout next to this script,
 * then common system locations (development machines, CI).
 */
export function findPostgresBinDir(explicit?: string): string | null {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const here = path.dirname(fileURLToPath(import.meta.url));
  // runtime/server/dist → runtime/pgsql/bin   (installed)   |   repo checkout → none
  candidates.push(path.resolve(here, '..', '..', 'pgsql', 'bin'));
  candidates.push(path.resolve(here, '..', 'pgsql', 'bin'));
  candidates.push(path.resolve(process.cwd(), 'pgsql', 'bin'));
  candidates.push(path.resolve(process.cwd(), '..', 'pgsql', 'bin'));
  if (!isWindows()) {
    for (const version of ['18', '17', '16', '15']) {
      candidates.push(`/usr/lib/postgresql/${version}/bin`);
      candidates.push(`/usr/local/opt/postgresql@${version}/bin`);
      candidates.push(`/opt/homebrew/opt/postgresql@${version}/bin`);
    }
  }
  for (const dir of candidates) {
    if (hasPostgresBinaries(dir)) return dir;
  }
  return null;
}
