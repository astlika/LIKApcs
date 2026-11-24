import fs from 'node:fs';
import crypto from 'node:crypto';
import { DEFAULT_EMBEDDED_PG_PORT } from './paths.js';

/**
 * `config.json` in the data directory — generated once on first start, never typed by a human.
 * It holds the embedded database password and the local control token; file permissions are
 * restricted to the current user (the same user the Admin app runs as).
 */
export interface RuntimeConfig {
  installationId: string;
  createdAt: string;
  embeddedPostgres: { port: number; user: string; database: string; password: string };
  /** Shared secret for the loopback-only control endpoint (graceful stop from installer/Admin). */
  controlToken: string;
}

export function loadOrCreateRuntimeConfig(file: string): RuntimeConfig {
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RuntimeConfig>;
    if (parsed.embeddedPostgres?.password && parsed.controlToken && parsed.installationId) {
      return parsed as RuntimeConfig;
    }
  }
  const config: RuntimeConfig = {
    installationId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    embeddedPostgres: {
      port: DEFAULT_EMBEDDED_PG_PORT,
      user: 'likapcs',
      database: 'likapcs',
      password: crypto.randomBytes(24).toString('base64url'),
    },
    controlToken: crypto.randomBytes(32).toString('base64url'),
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return config;
}

export function readControlToken(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RuntimeConfig>;
    return parsed.controlToken ?? null;
  } catch {
    return null;
  }
}

/**
 * 0.38.0: makes this installation the one a restored backup came from. Only the id changes; the
 * database password and the control token stay this PC's own. The gaming PCs remember the id of
 * the server they were paired with, so with it they find the new main PC by themselves.
 */
export function writeInstallationId(file: string, installationId: string): void {
  const current = JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimeConfig;
  const next: RuntimeConfig = { ...current, installationId };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
