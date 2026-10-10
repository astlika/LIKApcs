/**
 * Backups & restore — Node-native, so it works with the embedded Windows PostgreSQL runtime that
 * ships without pg_dump.
 *
 * Archive (`*.likapcs-backup.tar.gz`, openable with 7-Zip):
 *   manifest.json            format, server + schema version, business name, per-table row counts
 *   tables/<table>.csv       `COPY … TO STDOUT (FORMAT csv, HEADER true)` of every public table,
 *                            all taken inside ONE repeatable-read snapshot (consistent point in time)
 *
 * Restore (same schema version only):
 *   1. a `pre_restore` safety backup is taken first,
 *   2. in one transaction: TRUNCATE every table, COPY the archive back parent tables first
 *      (foreign-key order derived from pg_constraint), reset sequences, re-insert the acting
 *      administrator's session so the person who started the restore stays signed in,
 *   3. caches are dropped, Admin apps get `system.restored`, client PCs are disconnected so they
 *      re-handshake against the restored device table.
 *
 * Backups live in `config.backupDir` (`<data dir>/backups` by default — never inside the install
 * directory). Retention (`backup.keep_count`) only ever deletes *scheduled* backups.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import * as tar from 'tar';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import {
  BACKUP_FILE_EXTENSION,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  type BackupKind,
  type BackupManifest,
  type BackupStatus,
  type BackupSummary,
  type BackupsResponse,
  type RestoreResult,
} from '@likapcs/shared';
import type { DbPool } from '../db/pool.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { SERVER_VERSION } from '../version.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { SettingsService } from './settings.js';

interface BackupRow {
  id: string;
  kind: BackupKind;
  status: BackupStatus;
  file_path: string | null;
  size_bytes: string | null;
  sha256: string | null;
  schema_version: number | null;
  started_at: Date;
  finished_at: Date | null;
  error_message: string | null;
  created_by_name: string | null;
}

export interface BackupServiceOptions {
  /** Current schema version (restores must match it exactly). */
  schemaVersion: () => number;
  /** Called after a successful restore (drop caches, notify Admins, disconnect clients). */
  afterRestore?: () => void;
  log?: { info: (o: object, msg: string) => void; error: (o: object, msg: string) => void };
}

/** Tables never restored from an archive (migration bookkeeping belongs to the running schema). */
const SKIP_ON_RESTORE = new Set(['schema_migrations']);
/**
 * Tables whose CURRENT rows survive a restore: the backup history describes the files on disk
 * right now, not the files that existed when the archive was taken.
 */
const PRESERVE_CURRENT = new Set(['backup_history']);

export class BackupService {
  private busy: 'backup' | 'restore' | null = null;
  private lastScheduledDay: string | null = null;

  constructor(
    private readonly pool: DbPool,
    private readonly backupDir: string,
    private readonly settings: SettingsService,
    private readonly options: BackupServiceOptions,
  ) {}

  get directory(): string {
    return this.backupDir;
  }

  // ─── Listing ─────────────────────────────────────────────────────────────────

  async list(query: { includeDeleted: boolean; limit: number }): Promise<BackupsResponse> {
    const { rows } = await this.pool.query<BackupRow>(
      `SELECT b.id, b.kind, b.status, b.file_path, b.size_bytes::text, b.sha256, b.schema_version,
              b.started_at, b.finished_at, b.error_message, u.full_name AS created_by_name
         FROM backup_history b
         LEFT JOIN users u ON u.id = b.created_by
        WHERE ($1::boolean OR b.status <> 'deleted')
        ORDER BY b.started_at DESC
        LIMIT $2`,
      [query.includeDeleted, query.limit],
    );
    const [enabled, time, keepCount, timeZone] = await Promise.all([
      this.settings.get('backup.enabled'),
      this.settings.get('backup.time'),
      this.settings.get('backup.keep_count'),
      this.settings.get('locale.timezone'),
    ]);
    return {
      directory: this.backupDir,
      schemaVersion: this.options.schemaVersion(),
      schedule: {
        enabled,
        time,
        keepCount,
        nextRunAt: enabled ? nextOccurrence(time, timeZone, new Date()).toISOString() : null,
      },
      items: rows.map((r) => this.toSummary(r)),
    };
  }

  async get(id: string): Promise<BackupSummary> {
    return this.toSummary(await this.row(id));
  }

  /** Absolute path + download name of a stored archive. */
  async file(id: string): Promise<{ path: string; fileName: string; sizeBytes: number }> {
    const row = await this.row(id);
    if (row.status !== 'succeeded' || !row.file_path || !fs.existsSync(row.file_path)) {
      throw notFound('Backup file');
    }
    const stat = await fsp.stat(row.file_path);
    return { path: row.file_path, fileName: path.basename(row.file_path), sizeBytes: stat.size };
  }

  // ─── Create ──────────────────────────────────────────────────────────────────

  async create(input: { kind: BackupKind; actor: AuditActor | null }): Promise<BackupSummary> {
    this.acquire('backup');
    try {
      return await this.runBackup(input.kind, input.actor);
    } finally {
      this.busy = null;
    }
  }

  private async runBackup(kind: BackupKind, actor: AuditActor | null): Promise<BackupSummary> {
    await fsp.mkdir(this.backupDir, { recursive: true });
    const startedAt = new Date();
    const timeZone = await this.settings.get('locale.timezone');
    const businessName = await this.settings.get('business.name');
    const fileName = `likapcs-${kind}-${stampFor(startedAt, timeZone)}${BACKUP_FILE_EXTENSION}`;
    const finalPath = path.join(this.backupDir, fileName);
    const { rows: inserted } = await this.pool.query<{ id: string }>(
      `INSERT INTO backup_history (kind, status, file_path, schema_version, started_at, created_by)
       VALUES ($1, 'running', $2, $3, $4, $5) RETURNING id`,
      [kind, finalPath, this.options.schemaVersion(), startedAt, actor?.userId ?? null],
    );
    const id = inserted[0]!.id;
    const tmpDir = await fsp.mkdtemp(path.join(this.backupDir, '.tmp-'));
    const client = await this.pool.connect();
    try {
      await fsp.mkdir(path.join(tmpDir, 'tables'));
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const tables = await this.publicTables(client);
      const manifestTables: BackupManifest['tables'] = [];
      for (const table of tables) {
        const target = path.join(tmpDir, 'tables', `${table}.csv`);
        const stream = client.query(
          copyTo(`COPY ${quoteIdent(table)} TO STDOUT WITH (FORMAT csv, HEADER true)`),
        );
        await pipeline(stream, fs.createWriteStream(target));
        const stat = await fsp.stat(target);
        manifestTables.push({ name: table, rows: stream.rowCount, bytes: stat.size });
      }
      await client.query('COMMIT');
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: startedAt.toISOString(),
        serverVersion: SERVER_VERSION,
        schemaVersion: this.options.schemaVersion(),
        businessName,
        kind,
        tables: manifestTables,
      };
      await fsp.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await tar.create({ gzip: true, file: finalPath, cwd: tmpDir, portable: true }, [
        'manifest.json',
        'tables',
      ]);
      const [sha256, stat] = await Promise.all([sha256Of(finalPath), fsp.stat(finalPath)]);
      await this.pool.query(
        `UPDATE backup_history
            SET status = 'succeeded', size_bytes = $2, sha256 = $3, finished_at = now()
          WHERE id = $1`,
        [id, stat.size, sha256],
      );
      if (actor) {
        await recordAudit(this.pool, actor, {
          action: 'backup.create',
          entityType: 'backup',
          entityId: id,
          details: { kind, fileName, sizeBytes: stat.size, tables: manifestTables.length },
        });
      }
      this.options.log?.info({ id, kind, fileName, sizeBytes: stat.size }, 'backup written');
      if (kind === 'scheduled') await this.applyRetention();
      return this.get(id);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      await fsp.rm(finalPath, { force: true }).catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      await this.pool
        .query(
          `UPDATE backup_history SET status = 'failed', error_message = $2, finished_at = now()
            WHERE id = $1`,
          [id, message.slice(0, 1000)],
        )
        .catch(() => undefined);
      this.options.log?.error({ err, id, kind }, 'backup failed');
      throw err;
    } finally {
      client.release();
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Keeps the newest `backup.keep_count` scheduled backups; manual and safety copies are never touched. */
  async applyRetention(): Promise<number> {
    const keep = await this.settings.get('backup.keep_count');
    const { rows } = await this.pool.query<{ id: string; file_path: string | null }>(
      `SELECT id, file_path FROM backup_history
        WHERE kind = 'scheduled' AND status = 'succeeded'
        ORDER BY started_at DESC OFFSET $1`,
      [keep],
    );
    for (const row of rows) {
      if (row.file_path) await fsp.rm(row.file_path, { force: true }).catch(() => undefined);
      await this.pool.query(`UPDATE backup_history SET status = 'deleted' WHERE id = $1`, [row.id]);
    }
    return rows.length;
  }

  async delete(id: string, actor: AuditActor): Promise<BackupSummary> {
    const row = await this.row(id);
    if (row.status === 'running') throw conflict('This backup is still running');
    if (row.file_path) await fsp.rm(row.file_path, { force: true }).catch(() => undefined);
    await this.pool.query(`UPDATE backup_history SET status = 'deleted' WHERE id = $1`, [id]);
    await recordAudit(this.pool, actor, {
      action: 'backup.delete',
      entityType: 'backup',
      entityId: id,
      details: { fileName: row.file_path ? path.basename(row.file_path) : null },
    });
    return this.get(id);
  }

  // ─── Upload (import an archive copied from elsewhere) ────────────────────────

  async importUpload(
    body: Readable,
    requestedName: string,
    actor: AuditActor,
  ): Promise<BackupSummary> {
    await fsp.mkdir(this.backupDir, { recursive: true });
    const base = requestedName.endsWith(BACKUP_FILE_EXTENSION)
      ? requestedName
      : `${requestedName.replace(/\.(tar\.gz|tgz)$/i, '')}${BACKUP_FILE_EXTENSION}`;
    const target = path.join(this.backupDir, base);
    if (fs.existsSync(target)) throw conflict(`A backup named ${base} already exists`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    await pipeline(
      body,
      async function* (source) {
        for await (const chunk of source) {
          const buf = chunk as Buffer;
          hash.update(buf);
          size += buf.length;
          yield buf;
        }
      },
      fs.createWriteStream(target),
    );
    let manifest: BackupManifest;
    try {
      manifest = await readManifest(target);
    } catch (err) {
      await fsp.rm(target, { force: true }).catch(() => undefined);
      throw badRequest(
        `Not a LIKApcs backup archive: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO backup_history
         (kind, status, file_path, size_bytes, sha256, schema_version, started_at, finished_at, created_by)
       VALUES ('manual', 'succeeded', $1, $2, $3, $4, $5, now(), $6) RETURNING id`,
      [target, size, hash.digest('hex'), manifest.schemaVersion, manifest.createdAt, actor.userId],
    );
    await recordAudit(this.pool, actor, {
      action: 'backup.upload',
      entityType: 'backup',
      entityId: rows[0]!.id,
      details: { fileName: base, sizeBytes: size, schemaVersion: manifest.schemaVersion },
    });
    return this.get(rows[0]!.id);
  }

  // ─── Restore ─────────────────────────────────────────────────────────────────

  async restore(input: {
    id: string;
    actor: AuditActor;
    /** The caller's own session — re-created after the restore so they stay signed in. */
    sessionId: string;
  }): Promise<RestoreResult> {
    const row = await this.row(input.id);
    if (row.status !== 'succeeded' || !row.file_path || !fs.existsSync(row.file_path)) {
      throw notFound('Backup file');
    }
    if (row.sha256 && (await sha256Of(row.file_path)) !== row.sha256) {
      throw conflict('The backup file is corrupt: its checksum no longer matches');
    }
    this.acquire('restore');
    const t0 = Date.now();
    const tmpDir = await fsp.mkdtemp(path.join(this.backupDir, '.restore-'));
    try {
      await tar.extract({ file: row.file_path, cwd: tmpDir, strict: true });
      const manifest = parseManifest(
        await fsp.readFile(path.join(tmpDir, 'manifest.json'), 'utf8'),
      );
      const current = this.options.schemaVersion();
      if (manifest.schemaVersion !== current) {
        throw new AppError(
          409,
          'SCHEMA_MISMATCH',
          `This backup was taken with database schema v${manifest.schemaVersion}; the server runs v${current}. ` +
            'Install the matching LIKApcs version to restore it.',
          { backupSchemaVersion: manifest.schemaVersion, serverSchemaVersion: current },
        );
      }
      // Safety copy first — a restore must never be the only way back.
      const safety = await this.runBackup('pre_restore', input.actor);

      const client = await this.pool.connect();
      let tablesRestored = 0;
      let rowsRestored = 0;
      let sessionKept = false;
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '60s'`);
        const { rows: sessionRows } = await client.query<Record<string, unknown>>(
          'SELECT * FROM user_sessions WHERE id = $1',
          [input.sessionId],
        );
        const session = sessionRows[0] ?? null;
        const { rows: history } = await client.query<Record<string, unknown>>(
          'SELECT * FROM backup_history',
        );
        const tables = (await this.publicTables(client)).filter((t) => !SKIP_ON_RESTORE.has(t));
        const ordered = await this.foreignKeyOrder(client, tables);
        await client.query(
          `TRUNCATE ${tables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`,
        );
        const archived = new Set(manifest.tables.map((t) => t.name));
        for (const table of ordered) {
          if (PRESERVE_CURRENT.has(table)) continue;
          if (!archived.has(table)) {
            this.options.log?.info({ table }, 'table missing from backup — left empty');
            continue;
          }
          const file = path.join(tmpDir, 'tables', `${table}.csv`);
          const columns = await csvHeader(file);
          if (columns.length === 0) continue; // header-only file of a table without columns (impossible) or empty
          const stream = client.query(
            copyFrom(
              `COPY ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) FROM STDIN WITH (FORMAT csv, HEADER true)`,
            ),
          );
          await pipeline(fs.createReadStream(file), stream);
          tablesRestored += 1;
          rowsRestored += stream.rowCount;
        }
        await this.resetSequences(client);
        for (const h of history) {
          const keys = Object.keys(h);
          await client.query(
            `INSERT INTO backup_history (${keys.map(quoteIdent).join(', ')})
             VALUES (${keys
               .map((k, i) =>
                 k === 'created_by' ? `(SELECT id FROM users WHERE id = $${i + 1})` : `$${i + 1}`,
               )
               .join(', ')})
             ON CONFLICT (id) DO NOTHING`,
            keys.map((k) => h[k]),
          );
        }
        if (session) {
          const keys = Object.keys(session);
          // The archive may already contain this session (signed in before the backup was taken);
          // otherwise re-create it when its user still exists in the restored data.
          await client.query(
            `INSERT INTO user_sessions (${keys.map(quoteIdent).join(', ')})
             SELECT ${keys.map((_, i) => `$${i + 1}`).join(', ')}
              WHERE EXISTS (SELECT 1 FROM users WHERE id = $${keys.indexOf('user_id') + 1})
             ON CONFLICT (id) DO NOTHING`,
            keys.map((k) => session[k]),
          );
          const { rowCount } = await client.query(
            'SELECT 1 FROM user_sessions WHERE id = $1 AND revoked_at IS NULL',
            [input.sessionId],
          );
          sessionKept = (rowCount ?? 0) > 0;
        }
        await recordAudit(client, input.actor, {
          action: 'backup.restore',
          entityType: 'backup',
          entityId: input.id,
          severity: 'warning',
          details: {
            fileName: path.basename(row.file_path),
            backupCreatedAt: manifest.createdAt,
            preRestoreBackupId: safety.id,
            tablesRestored,
            rowsRestored,
          },
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      this.settings.invalidate();
      this.options.afterRestore?.();
      const result: RestoreResult = {
        backupId: input.id,
        preRestoreBackupId: safety.id,
        tablesRestored,
        rowsRestored,
        durationMs: Date.now() - t0,
        sessionKept,
      };
      this.options.log?.info(result, 'backup restored');
      return result;
    } finally {
      this.busy = null;
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ─── Scheduler ───────────────────────────────────────────────────────────────

  /**
   * Called every ~30 s. Runs the daily backup once the business-local clock reaches `backup.time`
   * (at most once per local day, also across restarts — the history table is consulted).
   */
  async tick(now = new Date()): Promise<BackupSummary | null> {
    if (this.busy) return null;
    const [enabled, time, timeZone] = await Promise.all([
      this.settings.get('backup.enabled'),
      this.settings.get('backup.time'),
      this.settings.get('locale.timezone'),
    ]);
    if (!enabled) return null;
    const local = localParts(now, timeZone);
    const today = `${local.year}-${local.month}-${local.day}`;
    if (this.lastScheduledDay === today) return null;
    if (`${local.hour}:${local.minute}` < time) return null;
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM backup_history
        WHERE kind = 'scheduled' AND status IN ('running', 'succeeded')
          AND (started_at AT TIME ZONE $1)::date = $2::date`,
      [timeZone, today],
    );
    this.lastScheduledDay = today;
    if (Number(rows[0]!.n) > 0) return null;
    try {
      return await this.create({ kind: 'scheduled', actor: null });
    } catch {
      return null; // already logged; the next day gets a fresh attempt
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private acquire(what: 'backup' | 'restore'): void {
    if (this.busy) {
      throw new AppError(409, 'BACKUP_BUSY', `A ${this.busy} is already in progress`);
    }
    this.busy = what;
  }

  private async row(id: string): Promise<BackupRow> {
    const { rows } = await this.pool.query<BackupRow>(
      `SELECT b.id, b.kind, b.status, b.file_path, b.size_bytes::text, b.sha256, b.schema_version,
              b.started_at, b.finished_at, b.error_message, u.full_name AS created_by_name
         FROM backup_history b LEFT JOIN users u ON u.id = b.created_by
        WHERE b.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('Backup');
    return rows[0];
  }

  private toSummary(r: BackupRow): BackupSummary {
    const exists = r.status === 'succeeded' && !!r.file_path && fs.existsSync(r.file_path);
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      fileName: r.file_path ? path.basename(r.file_path) : null,
      fileExists: exists,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      sha256: r.sha256,
      schemaVersion: r.schema_version,
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
      durationMs: r.finished_at ? r.finished_at.getTime() - r.started_at.getTime() : null,
      errorMessage: r.error_message,
      createdByName: r.created_by_name,
    };
  }

  private async publicTables(client: { query: DbPool['query'] }): Promise<string[]> {
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    return rows.map((r) => r.tablename);
  }

  /** Parents before children (Kahn's algorithm over pg_constraint); self-references are ignored. */
  private async foreignKeyOrder(
    client: { query: DbPool['query'] },
    tables: string[],
  ): Promise<string[]> {
    const { rows } = await client.query<{ child: string; parent: string }>(
      `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
         FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'f' AND n.nspname = 'public' AND c.conrelid <> c.confrelid`,
    );
    const set = new Set(tables);
    const parentsOf = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
    for (const { child, parent } of rows) {
      if (set.has(child) && set.has(parent)) parentsOf.get(child)!.add(parent);
    }
    const ordered: string[] = [];
    const done = new Set<string>();
    while (ordered.length < tables.length) {
      const ready = tables
        .filter((t) => !done.has(t))
        .filter((t) => [...parentsOf.get(t)!].every((p) => done.has(p)));
      if (ready.length === 0) {
        // Cycle (mutual FKs): fall back to alphabetical for the rest; COPY checks FKs per statement
        // so this only matters when both sides reference rows of each other.
        for (const t of tables) {
          if (!done.has(t)) {
            ordered.push(t);
            done.add(t);
          }
        }
        break;
      }
      for (const t of ready) {
        ordered.push(t);
        done.add(t);
      }
    }
    return ordered;
  }

  private async resetSequences(client: { query: DbPool['query'] }): Promise<void> {
    const { rows } = await client.query<{ table_name: string; column_name: string; seq: string }>(
      `SELECT c.table_name, c.column_name,
              pg_get_serial_sequence(quote_ident(c.table_schema) || '.' || quote_ident(c.table_name), c.column_name) AS seq
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND (c.column_default LIKE 'nextval(%' OR c.is_identity = 'YES')`,
    );
    for (const r of rows) {
      if (!r.seq) continue;
      await client.query(
        `SELECT setval($1, COALESCE((SELECT max(${quoteIdent(r.column_name)}) FROM ${quoteIdent(r.table_name)}), 0) + 1, false)`,
        [r.seq],
      );
    }
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────────

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function sha256Of(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Reads the first line of a CSV written by COPY … HEADER and returns the column names. */
async function csvHeader(file: string): Promise<string[]> {
  const handle = await fsp.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(65536), 0, 65536, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    if (nl < 0 && bytesRead === 0) return [];
    const line = (nl < 0 ? text : text.slice(0, nl)).replace(/\r$/, '');
    if (!line) return [];
    return line.split(',').map((c) =>
      c
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/""/g, '"'),
    );
  } finally {
    await handle.close();
  }
}

export function parseManifest(text: string): BackupManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }
  const m = data as Partial<BackupManifest>;
  if (
    m.format !== BACKUP_FORMAT ||
    typeof m.schemaVersion !== 'number' ||
    !Array.isArray(m.tables)
  ) {
    throw new Error('manifest.json is missing the LIKApcs backup fields');
  }
  if ((m.formatVersion ?? 0) > BACKUP_FORMAT_VERSION) {
    throw new Error(`backup format v${m.formatVersion} is newer than this server understands`);
  }
  return m as BackupManifest;
}

/** Extracts only manifest.json from an archive (validates the archive without unpacking tables). */
export async function readManifest(file: string): Promise<BackupManifest> {
  const chunks: Buffer[] = [];
  await tar.list({
    file,
    strict: true,
    filter: (p) => p === 'manifest.json' || p === './manifest.json',
    onReadEntry: (entry) => {
      entry.on('data', (c: Buffer) => chunks.push(c));
    },
  });
  if (chunks.length === 0) throw new Error('manifest.json not found in archive');
  return parseManifest(Buffer.concat(chunks).toString('utf8'));
}

interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === '24' ? '00' : get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function stampFor(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

/** Offset of `timeZone` from UTC at the given instant, in milliseconds. */
function offsetMs(utcMs: number, timeZone: string): number {
  const p = localParts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - utcMs;
}

/** Next instant at which the business-local wall clock reads `HH:MM`. */
export function nextOccurrence(time: string, timeZone: string, now: Date): Date {
  const [hh, mm] = time.split(':').map(Number);
  const p = localParts(now, timeZone);
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const guess = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + dayOffset, hh, mm);
    const instant = guess - offsetMs(guess, timeZone);
    if (instant > now.getTime()) return new Date(instant);
  }
  return new Date(now.getTime() + 24 * 3600 * 1000);
}
