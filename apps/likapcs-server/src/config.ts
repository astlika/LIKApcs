import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { DEFAULT_DISCOVERY_PORT, findPostgresBinDir, resolveDataDir } from './embedded/paths.js';

/**
 * Server configuration — read from environment variables (optionally a local .env file).
 * Secrets never live in source code. See .env.example at the repository root.
 */

const envSchema = z.object({
  /** External PostgreSQL. When absent the server runs its embedded PostgreSQL (zero configuration). */
  LIKAPCS_DATABASE_URL: z.string().min(1).optional(),
  LIKAPCS_DATA_DIR: z.string().optional(),
  LIKAPCS_PG_BIN: z.string().optional(),
  LIKAPCS_LOG_FILE: z.string().optional(),
  LIKAPCS_DISCOVERY: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  LIKAPCS_DISCOVERY_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_DISCOVERY_PORT),
  LIKAPCS_HOST: z.string().default('0.0.0.0'),
  LIKAPCS_PORT: z.coerce.number().int().min(1).max(65535).default(4700),
  LIKAPCS_AUTO_MIGRATE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  LIKAPCS_LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
  LIKAPCS_CORS_ORIGINS: z
    .string()
    .default(
      'http://localhost:1420,http://127.0.0.1:1420,tauri://localhost,http://tauri.localhost',
    ),
  LIKAPCS_TLS_CERT_FILE: z.string().optional(),
  LIKAPCS_TLS_KEY_FILE: z.string().optional(),
  LIKAPCS_SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  LIKAPCS_MIGRATIONS_DIR: z.string().optional(),
  LIKAPCS_TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
});

export interface ServerConfig {
  /** null → embedded PostgreSQL managed by this process (see embedded/postgres.ts). */
  databaseUrl: string | null;
  /** Data directory (embedded database, logs, runtime config, backups). */
  dataDir: string;
  /** Portable PostgreSQL binaries, when found (required for embedded mode). */
  pgBinDir: string | null;
  /** Log destination: a file path, or null for stdout. */
  logFile: string | null;
  discovery: { enabled: boolean; port: number };
  host: string;
  port: number;
  autoMigrate: boolean;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  corsOrigins: string[];
  tls: { certFile: string; keyFile: string } | null;
  sessionHours: number;
  migrationsDir: string;
  trustProxy: boolean;
}

/** Walks upwards from several starting points to find `database/migrations`. */
export function findMigrationsDir(explicit?: string): string {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`Migrations directory not found: ${explicit}`);
    return path.resolve(explicit);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const starts = [process.cwd(), here];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(dir, 'database', 'migrations');
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    'Could not locate database/migrations. Set LIKAPCS_MIGRATIONS_DIR to the migrations folder.',
  );
}

export function loadConfig(overrides: Partial<Record<string, string>> = {}): ServerConfig {
  loadDotenv({ path: path.resolve(process.cwd(), '.env') });
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid server configuration: ${issues}`);
  }
  const env = parsed.data;
  const dataDir = resolveDataDir(env.LIKAPCS_DATA_DIR);
  const databaseUrl = env.LIKAPCS_DATABASE_URL ?? null;
  const pgBinDir = findPostgresBinDir(env.LIKAPCS_PG_BIN);
  if (!databaseUrl && !pgBinDir) {
    throw new Error(
      'No database configured: set LIKAPCS_DATABASE_URL to a PostgreSQL connection string, or ' +
        'install the portable PostgreSQL runtime (pgsql/bin next to the server, or LIKAPCS_PG_BIN).',
    );
  }
  // Embedded/background installs log to a file by default; LIKAPCS_LOG_FILE=stdout forces the console.
  const logFile =
    env.LIKAPCS_LOG_FILE === 'stdout'
      ? null
      : (env.LIKAPCS_LOG_FILE ?? (databaseUrl ? null : path.join(dataDir, 'logs', 'server.log')));
  const tls =
    env.LIKAPCS_TLS_CERT_FILE && env.LIKAPCS_TLS_KEY_FILE
      ? { certFile: env.LIKAPCS_TLS_CERT_FILE, keyFile: env.LIKAPCS_TLS_KEY_FILE }
      : null;
  return {
    databaseUrl,
    dataDir,
    pgBinDir,
    logFile,
    discovery: { enabled: env.LIKAPCS_DISCOVERY, port: env.LIKAPCS_DISCOVERY_PORT },
    host: env.LIKAPCS_HOST,
    port: env.LIKAPCS_PORT,
    autoMigrate: env.LIKAPCS_AUTO_MIGRATE,
    logLevel: env.LIKAPCS_LOG_LEVEL,
    corsOrigins: env.LIKAPCS_CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    tls,
    sessionHours: env.LIKAPCS_SESSION_HOURS,
    migrationsDir: findMigrationsDir(env.LIKAPCS_MIGRATIONS_DIR),
    trustProxy: env.LIKAPCS_TRUST_PROXY,
  };
}
