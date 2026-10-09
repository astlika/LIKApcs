import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DbPool } from './pool.js';

/**
 * Forward-only SQL migration runner.
 *
 *  - Files are named NNNN_description.sql and applied in ascending order.
 *  - Each file runs in its own transaction and is recorded in schema_migrations with a checksum.
 *  - A changed checksum of an already-applied file is an error (history must not be rewritten).
 *  - A PostgreSQL advisory lock prevents two server processes migrating concurrently.
 *  - There are deliberately NO automatic "down" migrations: rollbacks are done by restoring a
 *    pre-migration backup (see docs/backup-and-recovery.md).
 */

export interface MigrationFile {
  version: number;
  name: string;
  fileName: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  currentVersion: number;
  applied: AppliedMigration[];
  pending: MigrationFile[];
}

const LOCK_KEY = 727001; // arbitrary, unique to LIKApcs
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = await fs.readdir(dir);
  const files: MigrationFile[] = [];
  for (const fileName of entries) {
    const match = FILE_PATTERN.exec(fileName);
    if (!match) {
      if (fileName.endsWith('.sql')) {
        throw new Error(`Migration file "${fileName}" does not match NNNN_description.sql`);
      }
      continue;
    }
    const sql = await fs.readFile(path.join(dir, fileName), 'utf8');
    files.push({
      version: Number(match[1]),
      name: match[2] ?? '',
      fileName,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  files.sort((a, b) => a.version - b.version);
  for (let i = 1; i < files.length; i += 1) {
    if (files[i]!.version === files[i - 1]!.version) {
      throw new Error(`Duplicate migration version ${files[i]!.version}`);
    }
  }
  return files;
}

async function ensureMigrationsTable(pool: DbPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

export async function getAppliedMigrations(pool: DbPool): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(pool);
  const result = await pool.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: Date;
  }>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');
  return result.rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
  }));
}

export async function getMigrationStatus(pool: DbPool, dir: string): Promise<MigrationStatus> {
  const files = await loadMigrationFiles(dir);
  const applied = await getAppliedMigrations(pool);
  const appliedVersions = new Map(applied.map((a) => [a.version, a]));
  for (const file of files) {
    const existing = appliedVersions.get(file.version);
    if (existing && existing.checksum !== file.checksum) {
      throw new Error(
        `Migration ${file.fileName} was modified after being applied (checksum mismatch). ` +
          'Applied migrations are immutable — add a new migration instead.',
      );
    }
  }
  const pending = files.filter((f) => !appliedVersions.has(f.version));
  const currentVersion = applied.length ? Math.max(...applied.map((a) => a.version)) : 0;
  return { currentVersion, applied, pending };
}

export interface MigrateLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

export async function runMigrations(
  pool: DbPool,
  dir: string,
  logger: MigrateLogger = { info: () => {}, error: () => {} },
): Promise<{ applied: MigrationFile[]; currentVersion: number }> {
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const status = await getMigrationStatus(pool, dir);
    const appliedNow: MigrationFile[] = [];
    for (const migration of status.pending) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        appliedNow.push(migration);
        logger.info(`applied migration ${migration.fileName}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`migration ${migration.fileName} failed: ${message}`);
        throw new Error(`Migration ${migration.fileName} failed: ${message}`, { cause: err });
      } finally {
        client.release();
      }
    }
    const final = await getMigrationStatus(pool, dir);
    return { applied: appliedNow, currentVersion: final.currentVersion };
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    lockClient.release();
  }
}
