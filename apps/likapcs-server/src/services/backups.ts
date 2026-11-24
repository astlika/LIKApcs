/**
 * Backups & restore — Node-native, so it works with the embedded Windows PostgreSQL runtime that
 * ships without pg_dump.
 *
 * Archive (`*.likapcs-backup.tar.gz`, openable with 7-Zip):
 *   manifest.json            format, server + schema version, business name, per-table row counts
 *   tables/<table>.csv       `COPY … TO STDOUT (FORMAT csv, HEADER true)` of every public table,
 *                            all taken inside ONE repeatable-read snapshot (consistent point in time)
 *
 * Restore:
 *   1. the archive is unpacked and checked against its own list (0.38.0: sizes and checksums of
 *      every table and every uploaded file) before anything is changed,
 *   2. an archive made by an OLDER version is brought up to this one first (0.38.0): its schema
 *      is rebuilt in a scratch database, the data loaded, and the newer migrations run over it,
 *      exactly as an update would have. An archive made by a NEWER version is refused,
 *   3. a `pre_restore` safety backup is taken,
 *   4. in one transaction: TRUNCATE every table, COPY the archive back parent tables first
 *      (foreign-key order derived from pg_constraint), reset sequences, re-insert the acting
 *      administrator's session so the person who started the restore stays signed in,
 *   5. the uploaded files are put back, caches are dropped, Admin apps get `system.restored`,
 *      client PCs are disconnected so they re-handshake against the restored device table.
 *
 * 0.38.0 — «Backup file»: `startBackupJob` / `startRestoreJob` run the same two operations in the
 * background and report their progress in percent (`job`), for the Admin's loading bar.
 *
 * Backups live in `config.backupDir` (`<data dir>/backups` by default — never inside the install
 * directory). Retention (`backup.keep_count`) only ever deletes *scheduled* backups.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import zlib from 'node:zlib';
import * as tar from 'tar';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import {
  BACKUP_FILE_EXTENSION,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_JSON_FILE_EXTENSION,
  type BackupContents,
  type BackupEncryptionStatus,
  type BackupExternalCopy,
  type BackupFileFormat,
  type BackupFileResult,
  type BackupJobPhase,
  type BackupJobStatus,
  type BackupKind,
  type BackupManifest,
  type BackupStatus,
  type BackupSummary,
  type BackupUploadResult,
  type BackupsResponse,
  type FactoryResetResult,
  type RestoreResult,
} from '@likapcs/shared';
import { createPool, type DbClient, type DbPool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { SERVER_VERSION } from '../version.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { SettingsService } from './settings.js';
import {
  isJsonArchiveFile,
  JsonArchiveError,
  JsonTableShapeError,
  looksLikeJsonArchive,
  peekJsonManifestText,
  readJsonArchive,
  readJsonManifestText,
  verifyJsonArchive,
  writeJsonArchive,
} from './backup-json.js';
import {
  ArchiveCryptoError,
  BackupKeyRing,
  decryptFile,
  decryptedStream,
  deriveKey,
  encryptFile,
  isEncryptedFile,
  newSalt,
  readEncryptedHeader,
} from './backup-crypto.js';

/** Plain archive name inside staging folders (the encrypted file is built from it). */
const PLAIN_ARCHIVE = 'archive.tar.gz';
/** The same for a backup written as a JSON document (0.41.0). */
const PLAIN_JSON = 'archive.json';
/** Added to the archive name when the backup is encrypted (0.26.0). */
const ENCRYPTED_EXTENSION = '.enc';

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
  /** Factory reset: erases uploaded pictures and videos (the backup folder is never touched). */
  wipeUploads?: () => Promise<void>;
  /** Uploaded files folder: pictures, wallpapers and ad videos go into every backup (`uploads/`). */
  uploadDir?: string;
  /** Local key file (0.26.0): kept outside the database and outside every backup. */
  keyFile: string;
  /** 0.38.0: this installation's id, written into every archive. */
  installationId?: () => string | null;
  /**
   * 0.38.0: called after a restore with the id of the installation the archive came from, when it
   * is another one: this server becomes that installation, so its gaming PCs find it again.
   */
  adoptInstallationId?: (installationId: string) => void | Promise<void>;
  /** 0.38.0: the migration files, to bring an archive of an older version up to this one. */
  migrationsDir?: string;
  log?: { info: (o: object, msg: string) => void; error: (o: object, msg: string) => void };
}

/** Where a long operation is: percent of the whole, the step, and the position inside the step. */
export interface ProgressSnapshot {
  percent: number;
  phase: BackupJobPhase;
  current: number | null;
  total: number | null;
}
export type ProgressSink = (snapshot: ProgressSnapshot) => void;

/**
 * Turns the steps of an operation into one percentage. Each step has a weight (roughly its share
 * of the time); inside a step the caller reports a fraction, mostly bytes done out of bytes to do.
 * The percentage never goes backwards and stays below 100 until the operation has really ended.
 */
class ProgressPlan {
  private index = 0;
  private fraction = 0;
  private current: number | null = null;
  private total: number | null = null;
  private best = 0;
  private sum: number;
  private readonly steps: { phase: BackupJobPhase; weight: number }[];

  constructor(
    steps: readonly { phase: BackupJobPhase; weight: number }[],
    private readonly sink?: ProgressSink,
  ) {
    this.steps = steps.map((step) => ({ ...step }));
    this.sum = this.steps.reduce((n, step) => n + step.weight, 0) || 1;
    this.emit();
  }

  /**
   * Replaces the weights with estimated durations, once the sizes are known (a shop with 5 GB of
   * videos and a small database spends its time in other steps than one with years of sales and
   * no videos). Called before the work starts. No step gets less than 1 % of the bar, so every
   * step is seen; a step without an estimate keeps its share.
   */
  weigh(costs: Partial<Record<BackupJobPhase, number>>): void {
    const known = this.steps.filter((step) => Number.isFinite(costs[step.phase]));
    if (known.length === 0) return;
    const oldShare = known.reduce((n, step) => n + step.weight, 0);
    const total = known.reduce((n, step) => n + Math.max(0, costs[step.phase]!), 0) || 1;
    for (const step of known) {
      const share = Math.max(0.01, Math.max(0, costs[step.phase]!) / total);
      step.weight = share * oldShare;
    }
    this.sum = this.steps.reduce((n, step) => n + step.weight, 0) || 1;
    this.emit();
  }

  /** Moves to `phase`; every step before it counts as done. `total` = how many items it has. */
  enter(phase: BackupJobPhase, total: number | null = null): void {
    const at = this.steps.findIndex((step) => step.phase === phase);
    if (at > this.index) this.index = at;
    this.fraction = 0;
    this.current = total === null ? null : 0;
    this.total = total;
    this.emit();
  }

  /** Position inside the current step: `fraction` 0–1 and, when items are counted, which of how many. */
  step(fraction: number, current?: number, total?: number): void {
    this.fraction = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    if (current !== undefined) this.current = current;
    if (total !== undefined) this.total = total;
    this.emit();
  }

  private emit(): void {
    if (!this.sink) return;
    let done = 0;
    for (let i = 0; i < this.index; i += 1) done += this.steps[i]!.weight;
    const here = this.steps[this.index];
    const raw = ((done + (here?.weight ?? 0) * this.fraction) / this.sum) * 100;
    this.best = Math.max(this.best, Math.min(99, raw));
    this.sink({
      percent: Math.floor(this.best * 10) / 10,
      phase: here?.phase ?? 'starting',
      current: this.current,
      total: this.total,
    });
  }
}

/** Passes the data through and reports how many bytes went by. */
function countBytes(onBytes: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
}

/**
 * How fast each kind of work goes, in bytes per second, measured on a small PC (2 cores, SSD).
 * Only the proportions matter: they decide how much of the loading bar each step gets.
 */
const SPEED = {
  /** Table → CSV with its checksum (CSV bytes). */
  dump: 75e6,
  /** Uploaded files copied with their checksum. */
  stage: 250e6,
  /** tar + gzip of the tables and the files. */
  pack: 50e6,
  /** Reading a packed archive back: gunzip + checksums. */
  readBack: 350e6,
  /** AES-256-GCM over the archive. */
  crypt: 300e6,
  /** SHA-256 of the archive. */
  hash: 500e6,
  /** Unpacking an archive to disk and checking every file in it. */
  unpack: 180e6,
  /** CSV → tables, with their indexes. */
  load: 21e6,
  /** The check of every reference between the loaded rows, counted per CSV byte. */
  references: 28e6,
  /** 0.41.0, the JSON document — tables: CSV taken apart into rows and written (CSV bytes). */
  jsonRows: 60e6,
  /** Uploaded files written as base64 (file bytes). */
  jsonFiles: 170e6,
  /** Reading the document back: rows put together as CSV again, with their checksum. */
  jsonRowsBack: 44e6,
  /** Reading the document back: base64 to bytes, with their checksum. */
  jsonFilesBack: 600e6,
  /** A restore: the rows written to disk as CSV again, and checked. */
  jsonRowsOut: 33e6,
  /** A restore: the files written to disk, and checked. */
  jsonFilesOut: 210e6,
} as const;
/** The check of the references takes about three quarters of the time the rows took to load (measured). */
const REFERENCE_CHECK_PER_LOAD = 0.75;
/** A table's CSV is about this share of its size on disk; CSV text packs to about this share. */
const CSV_PER_HEAP_BYTE = 0.8;
const PACKED_PER_CSV_BYTE = 0.15;
/** A table as JSON rows is about this much larger than its CSV (quotes around every value). */
const JSON_PER_CSV_BYTE = 1.35;

/** Estimated seconds of each step of a backup of `csvBytes` of tables and `fileBytes` of uploads. */
function backupCosts(
  csvBytes: number,
  fileBytes: number,
  format: BackupFileFormat = 'archive',
): Record<string, number> {
  if (format === 'json') {
    // Nothing is packed: the tables grow a little as JSON rows, the files by a third as base64.
    const document = csvBytes * JSON_PER_CSV_BYTE + fileBytes * (4 / 3);
    return {
      database: csvBytes / SPEED.dump + 0.2,
      files: fileBytes / SPEED.stage + 0.05,
      packing: csvBytes / SPEED.jsonRows + fileBytes / SPEED.jsonFiles + 0.1,
      verifying: csvBytes / SPEED.jsonRowsBack + fileBytes / SPEED.jsonFilesBack + 0.05,
      encrypting: document / SPEED.crypt + 0.05,
      finishing: document / SPEED.hash + 0.1,
    };
  }
  const payload = csvBytes + fileBytes;
  const archive = csvBytes * PACKED_PER_CSV_BYTE + fileBytes;
  return {
    database: csvBytes / SPEED.dump + 0.2,
    files: fileBytes / SPEED.stage + 0.05,
    packing: payload / SPEED.pack + 0.1,
    verifying: payload / SPEED.readBack + 0.05,
    encrypting: archive / SPEED.crypt + 0.05,
    finishing: archive / SPEED.hash + 0.1,
  };
}

/**
 * Moves a share of the loading bar by the clock while one statement runs that cannot say how far
 * it is (the check of every reference after a restore, a migration over the data). `expectedMs`
 * is how long it should take: the share is 90 % full at that time and then slows down, so it
 * never claims to be done before the work really is.
 */
async function withEstimatedProgress<T>(
  expectedMs: number,
  report: (fraction: number) => void,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const expected = Math.max(300, expectedMs);
  const timer = setInterval(() => {
    const x = (Date.now() - started) / expected;
    report(x <= 1 ? 0.9 * x : 0.9 + 0.09 * (1 - 1 / x));
  }, 200);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** Finished jobs are kept this long so the Admin can still read the result. */
const JOB_KEEP_MS = 60 * 60 * 1000;
const JOB_KEEP_COUNT = 20;
/** Names that are safe to use as a file name inside the staging folder. */
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INSTALLATION_ID_PATTERN = /^[0-9A-Za-z-]{8,64}$/;
/** Free space kept on top of what a restore needs to unpack an archive. */
const RESTORE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

/** Tables never restored from an archive (migration bookkeeping belongs to the running schema). */
const SKIP_ON_RESTORE = new Set(['schema_migrations']);
/**
 * Tables whose CURRENT rows survive a restore: the backup history describes the files on disk
 * right now, not the files that existed when the archive was taken.
 */
const PRESERVE_CURRENT = new Set(['backup_history']);
/**
 * 0.37.0: tables whose rows are not brought back from an archive. The heartbeats of the PCs are
 * load samples nothing reads; an archive made before 0.37.0 can hold millions of them (every PC
 * wrote one every 10 seconds and they were never cleaned), and restoring them would put that
 * weight straight back. The table itself stays, empty.
 */
const NOT_RESTORED = new Set(['station_heartbeats']);
/**
 * Factory reset keeps the system's own configuration: migration bookkeeping, and the access roles
 * and permission catalogue that first-run setup needs. Every other table is erased.
 */
const KEEP_ON_FACTORY_RESET = new Set([
  'schema_migrations',
  'roles',
  'permissions',
  'role_permissions',
]);

export class BackupService {
  private busy: 'backup' | 'restore' | null = null;
  private lastScheduledDay: string | null = null;
  private readonly keys: BackupKeyRing;
  /** 0.38.0: long backups / restores started from the Admin, by id (memory only). */
  private readonly jobs = new Map<string, BackupJobStatus>();

  constructor(
    private readonly pool: DbPool,
    private readonly backupDir: string,
    private readonly settings: SettingsService,
    private readonly options: BackupServiceOptions,
  ) {
    this.keys = new BackupKeyRing(options.keyFile);
  }

  // ─── Encryption & external copy (0.26.0) ─────────────────────────────

  encryptionStatus(): Promise<BackupEncryptionStatus> {
    return this.keys.status();
  }

  /** Sets the backup password. The account password was already re-checked by the route. */
  async setEncryption(input: {
    archivePassword: string;
    actor: AuditActor;
  }): Promise<BackupEncryptionStatus> {
    await this.keys.setPassword(input.archivePassword);
    await recordAudit(this.pool, input.actor, {
      action: 'backup.encryption.set',
      entityType: null,
      entityId: null,
      details: {},
      severity: 'warning',
    });
    return this.keys.status();
  }

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
    const copies = await this.externalCopies(rows.map((r) => r.id));
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
      items: rows.map((r) => this.toSummary(r, copies.get(r.id) ?? null)),
    };
  }

  async get(id: string): Promise<BackupSummary> {
    const copies = await this.externalCopies([id]);
    return this.toSummary(await this.row(id), copies.get(id) ?? null);
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

  // ─── Uploaded files ──────────────────────────────────────────────────────────

  /**
   * Copies the uploads folder into the archive staging area, file by file, and notes the size and
   * checksum of each one as it is copied (0.38.0): that list goes into the manifest, so the
   * finished archive, and later a restore, can be checked against it. Null when there is no
   * uploads folder. A file that is still being uploaded (`.part`) is not part of the copy, and a
   * file deleted while the copy runs is left out.
   */
  private async stageUploads(
    target: string,
    onProgress?: (fraction: number, file: number, files: number) => void,
  ): Promise<{
    summary: { files: number; bytes: number };
    files: NonNullable<BackupManifest['files']>;
  } | null> {
    const source = this.options.uploadDir;
    if (!source || !fs.existsSync(source)) return null;
    const tree = await listTree(source);
    await fsp.mkdir(target, { recursive: true });
    for (const dir of tree.dirs) {
      await fsp.mkdir(path.join(target, ...dir.split('/')), { recursive: true });
    }
    const wanted = tree.files.filter((f) => !f.path.endsWith('.part'));
    const totalBytes = wanted.reduce((n, f) => n + f.bytes, 0) || 1;
    const files: NonNullable<BackupManifest['files']> = [];
    let copied = 0;
    let index = 0;
    for (const file of wanted) {
      index += 1;
      const from = path.join(source, ...file.path.split('/'));
      const to = path.join(target, ...file.path.split('/'));
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      try {
        await pipeline(
          fs.createReadStream(from),
          countBytes((n) => {
            bytes += n;
            copied += n;
            onProgress?.(copied / totalBytes, index, wanted.length);
          }),
          async function* (chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              hash.update(chunk);
              yield chunk;
            }
          },
          fs.createWriteStream(to),
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          await fsp.rm(to, { force: true }).catch(() => undefined);
          continue; // deleted after it was listed: it is not part of this copy
        }
        throw err;
      }
      files.push({ path: file.path, bytes, sha256: hash.digest('hex') });
    }
    return {
      summary: { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) },
      files,
    };
  }

  /**
   * Replaces the uploads folder with the archived one (entries not in the archive are removed).
   * 0.38.0: the unpacked files are moved into place when they are on the same disk, which is
   * instant and keeps the bytes that were just checked; otherwise they are copied.
   */
  private async replaceUploads(archived: string): Promise<void> {
    const target = this.options.uploadDir;
    if (!target) return;
    await fsp.mkdir(target, { recursive: true });
    for (const entry of await fsp.readdir(target)) {
      await fsp.rm(path.join(target, entry), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
    for (const entry of await fsp.readdir(archived)) {
      const from = path.join(archived, entry);
      const to = path.join(target, entry);
      try {
        await fsp.rename(from, to);
      } catch {
        await fsp.cp(from, to, { recursive: true });
      }
    }
  }

  // ─── Create ──────────────────────────────────────────────────────────────────

  async create(input: {
    kind: BackupKind;
    actor: AuditActor | null;
    /** 0.41.0: the packed archive (default) or the JSON document. */
    format?: BackupFileFormat;
  }): Promise<BackupSummary> {
    this.acquire('backup');
    try {
      return await this.runBackup(input.kind, input.actor, { format: input.format });
    } finally {
      this.busy = null;
    }
  }

  private async runBackup(
    kind: BackupKind,
    actor: AuditActor | null,
    options: { password?: string; progress?: ProgressSink; format?: BackupFileFormat } = {},
  ): Promise<BackupSummary> {
    return (await this.writeBackup(kind, actor, options)).summary;
  }

  /**
   * Writes one archive. `password` (0.38.0) gives this file a password of its own instead of the
   * backup password of this PC; `progress` reports the percentage for a loading bar; `format`
   * (0.41.0) writes the JSON document instead of the packed archive.
   */
  private async writeBackup(
    kind: BackupKind,
    actor: AuditActor | null,
    options: { password?: string; progress?: ProgressSink; format?: BackupFileFormat } = {},
  ): Promise<{ summary: BackupSummary; manifest: BackupManifest }> {
    const format = options.format ?? 'archive';
    await fsp.mkdir(this.backupDir, { recursive: true });
    const startedAt = new Date();
    const timeZone = await this.settings.get('locale.timezone');
    let key = await this.keys.currentKey();
    if (options.password) {
      const salt = newSalt();
      key = { key: deriveKey(options.password, salt), salt };
    }
    const plan = new ProgressPlan(
      [
        { phase: 'database', weight: 30 },
        { phase: 'files', weight: 22 },
        { phase: 'packing', weight: 26 },
        { phase: 'verifying', weight: 12 },
        ...(key ? [{ phase: 'encrypting' as const, weight: 6 }] : []),
        { phase: 'finishing', weight: 4 },
      ],
      options.progress,
    );
    if (options.progress) {
      const size = await this.currentSize().catch(() => null);
      if (size) plan.weigh(backupCosts(size.csvBytes, size.fileBytes, format));
    }
    const baseName = `likapcs-${kind}-${stampFor(startedAt, timeZone)}${
      format === 'json' ? BACKUP_JSON_FILE_EXTENSION : BACKUP_FILE_EXTENSION
    }`;
    const fileName = key ? `${baseName}${ENCRYPTED_EXTENSION}` : baseName;
    const finalPath = path.join(this.backupDir, fileName);
    const { rows: inserted } = await this.pool.query<{ id: string }>(
      `INSERT INTO backup_history (kind, status, file_path, schema_version, started_at, created_by)
       VALUES ($1, 'running', $2, $3, $4, $5) RETURNING id`,
      [kind, finalPath, this.options.schemaVersion(), startedAt, actor?.userId ?? null],
    );
    const id = inserted[0]!.id;
    const tmpDir = await fsp.mkdtemp(path.join(this.backupDir, '.tmp-'));
    try {
      const { plainArchive, tables, manifest } = await this.dumpPlainArchive(tmpDir, {
        kind,
        startedAt,
        timeZone,
        fileName,
        encrypted: key !== null,
        plan,
        format,
      });
      if (key) {
        plan.enter('encrypting');
        const plainBytes = (await fsp.stat(plainArchive)).size || 1;
        let done = 0;
        await encryptFile(plainArchive, finalPath, key.key, key.salt, (n) => {
          done += n;
          plan.step(done / plainBytes);
        });
      } else await fsp.rename(plainArchive, finalPath);
      plan.enter('finishing');
      const stat = await fsp.stat(finalPath);
      let hashed = 0;
      const sha256 = await sha256Of(finalPath, (n) => {
        hashed += n;
        plan.step(hashed / (stat.size || 1));
      });
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
          details: { kind, fileName, sizeBytes: stat.size, tables, format },
        });
      }
      this.options.log?.info(
        { id, kind, fileName, sizeBytes: stat.size, format },
        'backup written',
      );
      await this.copyToExternal({ id, kind, fileName, finalPath, sha256 });
      if (kind === 'scheduled') await this.applyRetention();
      return { summary: await this.get(id), manifest };
    } catch (err) {
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
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Dumps every table (a consistent snapshot) and the uploads folder into a plain, unencrypted
   * `.tar.gz` inside `tmpDir`. Shared by normal backups and USB transfers (0.27.5).
   *
   * 0.38.0: the manifest lists the checksum of every table and of every uploaded file, and the
   * finished archive is READ BACK against that list before it counts as written. An archive that
   * misses a table or a file, or holds different bytes, fails here instead of at the restore.
   *
   * 0.41.0: `format: 'json'` writes the same tables and files as one JSON document instead
   * (see `backup-json.ts`); it is read back against the same list.
   */
  private async dumpPlainArchive(
    tmpDir: string,
    input: {
      kind: BackupKind;
      startedAt: Date;
      timeZone: string;
      fileName: string;
      encrypted: boolean;
      plan?: ProgressPlan;
      format?: BackupFileFormat;
    },
  ): Promise<{ plainArchive: string; tables: number; manifest: BackupManifest }> {
    const plan = input.plan;
    const businessName = await this.settings.get('business.name');
    const client = await this.pool.connect();
    let manifestTables: BackupManifest['tables'];
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      plan?.enter('database');
      manifestTables = await this.dumpTables(client, path.join(tmpDir, 'tables'), (f, i, n) =>
        plan?.step(f, i, n),
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    // Uploaded files are part of the backup too: product pictures, wallpapers, ad videos.
    plan?.enter('files');
    const staged = await this.stageUploads(path.join(tmpDir, 'uploads'), (f, i, n) =>
      plan?.step(f, i, n),
    );
    const installationId = this.options.installationId?.() ?? null;
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: input.startedAt.toISOString(),
      serverVersion: SERVER_VERSION,
      schemaVersion: this.options.schemaVersion(),
      businessName,
      kind: input.kind,
      tables: manifestTables,
      uploads: staged?.summary ?? null,
      ...(staged ? { files: staged.files } : {}),
      ...(installationId ? { installationId } : {}),
    };
    if (input.format === 'json') {
      const plainJson = path.join(tmpDir, PLAIN_JSON);
      await this.packJson(tmpDir, manifest, plainJson, {
        timeZone: input.timeZone,
        fileName: input.fileName,
        plan,
      });
      return { plainArchive: plainJson, tables: manifestTables.length, manifest };
    }
    await fsp.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await fsp.writeFile(
      path.join(tmpDir, 'report.txt'),
      buildReport(manifest, {
        timeZone: input.timeZone,
        fileName: input.fileName,
        encrypted: input.encrypted,
      }),
    );
    const plainArchive = path.join(tmpDir, PLAIN_ARCHIVE);
    // What the tar stream will hold: every table and file, each with a 512-byte header and
    // padded to 512 bytes (only used to make the loading bar move with the work).
    const entryCount = manifestTables.length + (staged?.files.length ?? 0) + 2;
    const tarBytes =
      manifestTables.reduce((n, t) => n + t.bytes, 0) +
        (staged?.summary.bytes ?? 0) +
        entryCount * 768 || 1;
    plan?.enter('packing');
    let packed = 0;
    // The tar stream is compressed by Node's own gzip, which works off the main thread: the
    // server keeps answering the till while a large backup is packed. (tar's built-in gzip
    // compresses on the main thread.) The bytes are counted as they go INTO the compressor, so
    // the percentage follows the real work, file by file.
    const pack = tar.create({ cwd: tmpDir, portable: true, maxReadSize: 4 * 1024 * 1024 }, [
      'manifest.json',
      'report.txt',
      'tables',
      ...(staged ? ['uploads'] : []),
    ]);
    await pipeline(
      Readable.from(pack as unknown as AsyncIterable<Buffer>),
      countBytes((n) => {
        packed += n;
        plan?.step(Math.min(1, packed / tarBytes));
      }),
      zlib.createGzip(),
      fs.createWriteStream(plainArchive),
    );
    plan?.enter('verifying');
    await verifyArchive(plainArchive, manifest, (f) => plan?.step(f));
    return { plainArchive, tables: manifestTables.length, manifest };
  }

  /**
   * Writes the staged tables and files as one JSON document and reads it back (0.41.0). The
   * tables that come out of the file must be, byte for byte, the tables that were dumped: a
   * table that does not come back identical as rows is written again as the bytes of its CSV,
   * and a file that still does not match is not kept.
   */
  private async packJson(
    dir: string,
    manifest: BackupManifest,
    file: string,
    input: { timeZone: string; fileName: string; plan?: ProgressPlan },
  ): Promise<void> {
    const plan = input.plan;
    const readme = jsonReadme(manifest, { timeZone: input.timeZone, fileName: input.fileName });
    const raw = new Set<string>();
    for (;;) {
      plan?.enter('packing');
      try {
        await writeJsonArchive({
          dir,
          manifest,
          file,
          readme,
          rawTables: raw,
          onProgress: (f) => plan?.step(f),
        });
      } catch (err) {
        if (err instanceof JsonTableShapeError && !raw.has(err.table)) {
          this.options.log?.info({ table: err.table }, 'json backup: table written as raw bytes');
          raw.add(err.table);
          continue;
        }
        throw err;
      }
      plan?.enter('verifying');
      let differing: string[];
      try {
        differing = await verifyJsonArchive(file, manifest, (f) => plan?.step(f));
      } catch (err) {
        await fsp.rm(file, { force: true }).catch(() => undefined);
        throw err;
      }
      if (differing.length === 0) return;
      const again = differing.filter((t) => !raw.has(t));
      if (again.length === 0) {
        await fsp.rm(file, { force: true }).catch(() => undefined);
        throw new Error(
          `Backup verification failed: table ${differing[0]} does not match what was written. The file was not kept.`,
        );
      }
      this.options.log?.info({ tables: again }, 'json backup: tables written again as raw bytes');
      for (const t of again) raw.add(t);
    }
  }

  /**
   * Writes every public table of `client`'s database as `<dir>/<table>.csv` and returns the
   * manifest lines (rows, bytes, checksum). The caller holds the transaction, so every table is
   * read from the same snapshot.
   */
  private async dumpTables(
    client: DbClient,
    dir: string,
    onProgress?: (fraction: number, table: number, tables: number) => void,
  ): Promise<BackupManifest['tables']> {
    await fsp.mkdir(dir, { recursive: true });
    const tables = await this.publicTables(client);
    // Rough size of each table, only to make the progress bar move with the work.
    const { rows: sizes } = await client.query<{ name: string; bytes: string }>(
      `SELECT c.relname AS name, pg_relation_size(c.oid)::text AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    );
    const weightOf = new Map(sizes.map((r) => [r.name, Number(r.bytes) + 8192]));
    const totalWeight = tables.reduce((n, t) => n + (weightOf.get(t) ?? 8192), 0) || 1;
    let weightDone = 0;
    const out: BackupManifest['tables'] = [];
    let index = 0;
    for (const table of tables) {
      index += 1;
      const weight = weightOf.get(table) ?? 8192;
      onProgress?.(weightDone / totalWeight, index, tables.length);
      const target = path.join(dir, `${table}.csv`);
      const stream = client.query(
        copyTo(`COPY ${quoteIdent(table)} TO STDOUT WITH (FORMAT csv, HEADER true)`),
      );
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      const at = index;
      await pipeline(
        stream,
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            bytes += chunk.length;
            // The CSV is not the size of the table on disk; never let one table claim more than its share.
            const inside = Math.min(0.95, bytes / weight);
            onProgress?.((weightDone + weight * inside) / totalWeight, at, tables.length);
            callback(null, chunk);
          },
        }),
        fs.createWriteStream(target),
      );
      out.push({ name: table, rows: stream.rowCount, bytes, sha256: hash.digest('hex') });
      weightDone += weight;
    }
    onProgress?.(1, tables.length, tables.length);
    return out;
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
    archivePassword?: string,
  ): Promise<BackupSummary> {
    return (await this.importArchive(body, requestedName, actor, archivePassword)).backup;
  }

  /**
   * Stores an uploaded archive in the backup folder and lists it. 0.38.0: returns what the
   * archive holds as well, and a name that is already taken gets a number instead of an error
   * (the same file loaded twice, or a file that was saved from this very PC).
   */
  async importArchive(
    body: Readable,
    requestedName: string,
    actor: AuditActor,
    archivePassword?: string,
  ): Promise<BackupUploadResult> {
    await fsp.mkdir(this.backupDir, { recursive: true });
    const wanted =
      requestedName.endsWith(BACKUP_FILE_EXTENSION) ||
      requestedName.endsWith(BACKUP_JSON_FILE_EXTENSION) ||
      requestedName.endsWith(ENCRYPTED_EXTENSION)
        ? requestedName
        : /\.json$/i.test(requestedName)
          ? `${requestedName.replace(/\.json$/i, '')}${BACKUP_JSON_FILE_EXTENSION}`
          : `${requestedName.replace(/\.(tar\.gz|tgz)$/i, '')}${BACKUP_FILE_EXTENSION}`;
    let base = freeName(this.backupDir, wanted);
    let target = path.join(this.backupDir, base);
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
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
        fs.createWriteStream(target, { flags: 'wx' }),
      );
    } catch (err) {
      await fsp.rm(target, { force: true }).catch(() => undefined);
      throw err;
    }
    let manifest: BackupManifest;
    try {
      const described = await this.describeArchive(target, archivePassword);
      manifest = described.manifest;
      // 0.41.0: the name says what the file is (the list and the "save as" window go by it). A
      // file that was renamed on the way gets the ending of what it really holds.
      const named = nameForContents(base, described.format, described.encrypted);
      if (named !== base) {
        const renamed = freeName(this.backupDir, named);
        await fsp.rename(target, path.join(this.backupDir, renamed));
        base = renamed;
        target = path.join(this.backupDir, renamed);
      }
    } catch (err) {
      await fsp.rm(target, { force: true }).catch(() => undefined);
      if (err instanceof AppError) throw err;
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
    return { backup: await this.get(rows[0]!.id), contents: contentsOf(manifest) };
  }

  // ─── Archive helpers (0.26.0) ─────────────────────────────────────────

  /** The key for an encrypted archive: the typed password, else a key this PC already has. */
  private async archiveKey(file: string, password?: string): Promise<Buffer> {
    let salt: Buffer;
    try {
      ({ salt } = await readEncryptedHeader(file));
    } catch {
      throw new AppError(409, 'ARCHIVE_CORRUPT', 'Kopja është e dëmtuar ose e paplotë.');
    }
    if (password) return deriveKey(password, salt);
    const known = await this.keys.keyForSalt(salt);
    if (known) return known;
    throw new AppError(
      400,
      'ARCHIVE_PASSWORD_REQUIRED',
      'Kjo kopje është e enkriptuar. Shkruani fjalëkalimin e kopjeve për ta hapur.',
    );
  }

  /**
   * Returns the plain backup to read (a `.tar.gz` or a JSON document): the file itself, or a
   * decrypted copy inside `dir`.
   */
  private async plainArchiveOf(
    file: string,
    dir: string,
    password?: string,
    onProgress?: (fraction: number) => void,
  ): Promise<string> {
    if (!(await isEncryptedFile(file))) return file;
    const key = await this.archiveKey(file, password);
    const out = path.join(dir, PLAIN_ARCHIVE);
    const total = (await fsp.stat(file)).size || 1;
    let done = 0;
    try {
      await decryptFile(file, out, key, (n) => {
        done += n;
        onProgress?.(done / total);
      });
    } catch (err) {
      if (err instanceof ArchiveCryptoError && err.reason === 'wrong_password') {
        throw new AppError(
          403,
          'ARCHIVE_PASSWORD_WRONG',
          'Fjalëkalimi i kopjes nuk është i saktë (ose kopja është e dëmtuar).',
        );
      }
      throw err;
    }
    return out;
  }

  /**
   * The manifest of an archive. 0.38.0: only the beginning of the file is read (the manifest is
   * its first entry), also when the file is encrypted: a large archive is no longer decrypted in
   * full just to be identified. A wrong password shows here as bytes that are not an archive.
   */
  private async manifestOf(file: string, password?: string): Promise<BackupManifest> {
    return (await this.describeArchive(file, password)).manifest;
  }

  /**
   * The manifest of an archive and how the file is written (0.41.0): the packed archive or the
   * JSON document. Told from the first bytes, never from the name (a file may have been renamed).
   */
  private async describeArchive(
    file: string,
    password?: string,
  ): Promise<{ manifest: BackupManifest; format: BackupFileFormat; encrypted: boolean }> {
    if (!(await isEncryptedFile(file))) {
      if (await isJsonArchiveFile(file)) {
        try {
          return {
            manifest: parseManifest(await readJsonManifestText(file)),
            format: 'json',
            encrypted: false,
          };
        } catch (err) {
          throw jsonArchiveProblem(err);
        }
      }
      return { manifest: await readManifest(file), format: 'archive', encrypted: false };
    }
    const key = await this.archiveKey(file, password);
    try {
      return { ...(await peekAnyManifest(await decryptedStream(file, key))), encrypted: true };
    } catch {
      throw new AppError(
        403,
        'ARCHIVE_PASSWORD_WRONG',
        'Fjalëkalimi i kopjes nuk është i saktë (ose kopja është e dëmtuar).',
      );
    }
  }

  /**
   * Copies a finished, encrypted backup to the external folder (`backup.external_dir`) and checks
   * the copy by its checksum. Never fails the backup itself: the result is kept in the audit log
   * and shown on the Backups page.
   */
  private async copyToExternal(input: {
    id: string;
    kind: BackupKind;
    fileName: string;
    finalPath: string;
    sha256: string;
  }): Promise<void> {
    const dir = (await this.settings.get('backup.external_dir')).trim();
    if (!dir) return;
    const at = new Date();
    let result: BackupExternalCopy;
    try {
      const stat = await fsp.stat(dir).catch(() => null);
      if (!stat?.isDirectory()) {
        throw new Error(
          `Folderi "${dir}" nuk u gjet. Kontrolloni që disku jashtë të jetë i lidhur.`,
        );
      }
      if (!(await isEncryptedFile(input.finalPath))) {
        throw new Error('Vendosni fjalëkalimin e kopjeve para se të ruani kopje jashtë PC-së.');
      }
      const target = path.join(dir, input.fileName);
      await fsp.copyFile(input.finalPath, target);
      if ((await sha256Of(target)) !== input.sha256) {
        await fsp.rm(target, { force: true }).catch(() => undefined);
        throw new Error('Kopja jashtë nuk u verifikua (checksum-i nuk përputhet). U fshi.');
      }
      if (input.kind === 'scheduled') await this.pruneExternal(dir);
      result = { ok: true, path: target, error: null, at: at.toISOString() };
    } catch (err) {
      result = {
        ok: false,
        path: null,
        error: err instanceof Error ? err.message : String(err),
        at: at.toISOString(),
      };
    }
    await recordAudit(
      this.pool,
      { label: 'sistemi' },
      {
        action: 'backup.external_copy',
        entityType: 'backup',
        entityId: input.id,
        details: {
          ok: result.ok,
          path: result.path,
          error: result.error,
          fileName: input.fileName,
        },
        severity: result.ok ? 'info' : 'warning',
      },
    );
    if (result.ok)
      this.options.log?.info({ id: input.id, path: result.path }, 'backup copied outside');
    else
      this.options.log?.error({ id: input.id, error: result.error }, 'external backup copy failed');
  }

  /** Keeps the newest `backup.keep_count` scheduled copies on the external disk (only our files). */
  private async pruneExternal(dir: string): Promise<void> {
    const keep = await this.settings.get('backup.keep_count');
    const names = (await fsp.readdir(dir).catch(() => [] as string[])).filter((n) =>
      /^likapcs-scheduled-.*\.likapcs-backup\.tar\.gz(\.enc)?$/.test(n),
    );
    const withTime = await Promise.all(
      names.map(async (n) => ({ n, t: (await fsp.stat(path.join(dir, n))).mtimeMs })),
    );
    withTime.sort((a, b) => b.t - a.t);
    for (const old of withTime.slice(keep)) {
      await fsp.rm(path.join(dir, old.n), { force: true }).catch(() => undefined);
    }
  }

  // ─── Restore ─────────────────────────────────────────────────────────────────

  /**
   * Factory reset. A safety backup is taken first; then every table (except migration bookkeeping)
   * and every uploaded picture/video is erased, users and settings included, so the system starts
   * again at first-run setup. The backup history survives, with its links to the erased users
   * cleared, so the safety backup stays listed. The backup folder is never touched.
   */
  async factoryReset(input: {
    userId: string;
    username: string;
    ip: string;
  }): Promise<FactoryResetResult> {
    this.acquire('backup');
    try {
      const { rows: owners } = await this.pool.query(
        `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1 AND r.code = 'owner'`,
        [input.userId],
      );
      if (owners.length === 0) {
        throw new AppError(403, 'FORBIDDEN', 'Only the owner can reset the system');
      }
      const safety = await this.runBackup('pre_reset', {
        userId: input.userId,
        label: input.username,
        ip: input.ip,
      });
      const client = await this.pool.connect();
      let tablesErased = 0;
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '60s'`);
        const { rows: history } = await client.query<Record<string, unknown>>(
          'SELECT * FROM backup_history',
        );
        const erasable = (await this.publicTables(client)).filter(
          (t) => !KEEP_ON_FACTORY_RESET.has(t),
        );
        // Built-in rows (units, expense categories) carry `is_system`: they stay, user rows go.
        const { rows: flagged } = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'is_system'`,
        );
        const withFlag = new Set(flagged.map((r) => r.table_name));
        const plain = erasable.filter((t) => !withFlag.has(t));
        const builtIn = erasable.filter((t) => withFlag.has(t));
        if (plain.length > 0) {
          await client.query(`TRUNCATE ${plain.map(quoteIdent).join(', ')} RESTART IDENTITY`);
        }
        for (const t of builtIn) {
          await client.query(`DELETE FROM ${quoteIdent(t)} WHERE is_system IS NOT TRUE`);
        }
        // Rows a fresh install starts with (same as migrations 0004, 0009).
        await client.query(
          `INSERT INTO cash_registers (name)
           SELECT 'Main register' WHERE NOT EXISTS (SELECT 1 FROM cash_registers)`,
        );
        await client.query(
          `INSERT INTO document_sequences (kind, period, prefix, next_value)
           VALUES ('customer', '', 'C', 1) ON CONFLICT (kind, period) DO NOTHING`,
        );
        tablesErased = erasable.length;
        for (const h of history) {
          const row: Record<string, unknown> = { ...h, created_by: null };
          const keys = Object.keys(row);
          await client.query(
            `INSERT INTO backup_history (${keys.map(quoteIdent).join(', ')})
             VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
             ON CONFLICT (id) DO NOTHING`,
            keys.map((k) => row[k]),
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      await this.options.wipeUploads?.();
      await this.settings.ensureDefaults();
      this.options.afterRestore?.();
      this.options.log?.info(
        { preResetBackupId: safety.id, tablesErased },
        'factory reset completed',
      );
      return { preResetBackupId: safety.id, tablesErased };
    } finally {
      this.busy = null;
    }
  }

  async restore(input: {
    id: string;
    actor: AuditActor;
    /** The caller's own session — re-created after the restore so they stay signed in. */
    sessionId: string | null;
    /** Backup password, only needed for an encrypted archive this PC has no key for. */
    archivePassword?: string;
    /**
     * USB transfer (0.27.5): the archive comes from another PC. It must not be newer than this
     * server, and the devices of the old PC are revoked (each PC is approved again) and every
     * old login session is ended.
     */
    transfer?: boolean;
    /** 0.38.0: reports the percentage for a loading bar. */
    progress?: ProgressSink;
  }): Promise<RestoreResult> {
    const row = await this.row(input.id);
    if (row.status !== 'succeeded' || !row.file_path || !fs.existsSync(row.file_path)) {
      throw notFound('Backup file');
    }
    const archiveFile = row.file_path;
    const encrypted = await isEncryptedFile(archiveFile);
    // The manifest is read first (only the beginning of the file): an archive this server cannot
    // take is refused before any time is spent on it, and the steps of the restore are known.
    const { manifest: announced, format } = await this.describeArchive(
      archiveFile,
      input.archivePassword,
    );
    this.assertRestorable(announced, input.transfer === true);
    const current = this.options.schemaVersion();
    const older = announced.schemaVersion < current;
    const plan = new ProgressPlan(
      [
        { phase: 'checking', weight: 4 },
        ...(encrypted ? [{ phase: 'decrypting' as const, weight: 6 }] : []),
        { phase: 'unpacking', weight: 16 },
        ...(older ? [{ phase: 'upgrading' as const, weight: 22 }] : []),
        { phase: 'safety_copy', weight: 16 },
        { phase: 'restoring_database', weight: 16 },
        { phase: 'checking_references', weight: 14 },
        { phase: 'restoring_files', weight: 8 },
      ],
      input.progress,
    );
    const archiveSize = (await fsp.stat(archiveFile)).size;
    if (input.progress) {
      // The share of the bar each step gets follows the sizes: the tables and files in the
      // archive, and what the safety copy of the current data has to carry.
      const csv = announced.tables.reduce((n, t) => n + t.bytes, 0);
      const files = announced.uploads?.bytes ?? 0;
      const now = await this.currentSize().catch(() => null);
      plan.weigh({
        checking: archiveSize / SPEED.hash + 0.1,
        decrypting: archiveSize / SPEED.crypt + 0.1,
        unpacking:
          format === 'json'
            ? csv / SPEED.jsonRowsOut +
              files / SPEED.jsonFilesOut +
              (csv + files) / SPEED.hash +
              0.1
            : (csv + files) / SPEED.unpack + 0.1,
        upgrading: csv / SPEED.dump + csv / SPEED.load + csv / SPEED.references + 3,
        ...(now
          ? {
              safety_copy: Object.values(backupCosts(now.csvBytes, now.fileBytes)).reduce(
                (a, b) => a + b,
                0,
              ),
            }
          : {}),
        restoring_database: csv / SPEED.load + 0.2,
        checking_references: csv / SPEED.references + 0.1,
        restoring_files: files / 2e9 + 0.1,
      });
    }
    plan.enter('checking');
    if (row.sha256) {
      let read = 0;
      const actual = await sha256Of(archiveFile, (n) => {
        read += n;
        plan.step(read / (archiveSize || 1));
      });
      if (actual !== row.sha256) {
        throw conflict('The backup file is corrupt: its checksum no longer matches');
      }
    }
    this.acquire('restore');
    const t0 = Date.now();
    let scratchDir: string | null = null;
    try {
      const tmpDir = await fsp.mkdtemp(path.join(this.backupDir, '.restore-'));
      scratchDir = tmpDir;
      // Room to unpack: the plain archive (when encrypted) plus every table and file in it.
      const unpackedBytes =
        announced.tables.reduce((n, t) => n + t.bytes, 0) + (announced.uploads?.bytes ?? 0);
      const needed =
        (encrypted ? archiveSize : 0) +
        unpackedBytes * (older ? 2 : 1) +
        RESTORE_SPACE_MARGIN_BYTES;
      const free = await freeBytes(this.backupDir).catch(() => Number.POSITIVE_INFINITY);
      if (free < needed) {
        throw new AppError(
          507,
          'NOT_ENOUGH_SPACE',
          `Nuk ka vend të mjaftueshëm në disk për rikthimin: duhen ${formatBytes(needed)}, të lira janë ${formatBytes(free)}.`,
          { neededBytes: needed, freeBytes: free },
        );
      }
      if (encrypted) plan.enter('decrypting');
      const plainArchive = await this.plainArchiveOf(
        archiveFile,
        tmpDir,
        input.archivePassword,
        (f) => plan.step(f),
      );
      plan.enter('unpacking');
      // 0.41.0: a JSON document leaves the same folder behind as an unpacked archive — the
      // manifest, a CSV per table, the uploaded files — so every step after this one is shared.
      // Share of this step spent taking the file apart; the rest reads the result back.
      const apart = format === 'json' ? 0.85 : 0.6;
      if (format === 'json') {
        await unpackJsonArchive(plainArchive, tmpDir, (f) => plan.step(apart * f));
      } else {
        await unpackArchive(plainArchive, tmpDir, (f) => plan.step(apart * f));
      }
      // The decrypted copy has done its work; its room is needed for what comes next.
      if (plainArchive !== archiveFile) await fsp.rm(plainArchive, { force: true });
      const manifest = parseManifest(
        await fsp.readFile(path.join(tmpDir, 'manifest.json'), 'utf8'),
      );
      this.assertRestorable(manifest, input.transfer === true);
      // Nothing is changed before the unpacked archive has been checked against its own list.
      const checked = await verifyUnpacked(tmpDir, manifest, (f) =>
        plan.step(apart + (1 - apart) * f),
      );

      let tablesDir = path.join(tmpDir, 'tables');
      let tableList = manifest.tables;
      const upgraded = manifest.schemaVersion < current;
      if (upgraded) {
        plan.enter('upgrading');
        const result = await this.upgradeTables(tmpDir, manifest, (f) => plan.step(f));
        tablesDir = result.dir;
        tableList = result.tables;
      }

      // Safety copy first — a restore must never be the only way back.
      plan.enter('safety_copy');
      const safety = await this.runBackup('pre_restore', input.actor, {
        progress: (inner) => plan.step(inner.percent / 100),
      });

      plan.enter('restoring_database');
      const client = await this.pool.connect();
      let tablesRestored = 0;
      let rowsRestored = 0;
      let sessionKept = false;
      let loadMs = 0;
      let checkMs = 0;
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
        // 0.34.0: the tables reference each other in a circle (a session → the time credit it was
        // started from → the sale line it was sold on → the session that line bills), so no order
        // puts every parent before its children. The references are checked once, when every
        // table is back, instead of table by table.
        const deferred = await this.deferForeignKeys(client);
        await client.query(
          `TRUNCATE ${tables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`,
        );
        const archived = new Map(tableList.map((t) => [t.name, t]));
        const wanted = ordered.filter(
          (t) => !PRESERVE_CURRENT.has(t) && !NOT_RESTORED.has(t) && archived.has(t),
        );
        for (const table of ordered) {
          if (PRESERVE_CURRENT.has(table) || NOT_RESTORED.has(table)) continue;
          if (!archived.has(table)) {
            this.options.log?.info({ table }, 'table missing from backup — left empty');
          }
        }
        const csvBytes = wanted.reduce((n, t) => n + archived.get(t)!.bytes, 0) || 1;
        let loaded = 0;
        let index = 0;
        const loadStarted = Date.now();
        for (const table of wanted) {
          index += 1;
          const at = index;
          plan.step(loaded / csvBytes, at, wanted.length);
          const file = path.join(tablesDir, `${table}.csv`);
          const columns = await csvHeader(file);
          if (columns.length === 0) continue; // header-only file of a table without columns (impossible) or empty
          const stream = client.query(
            copyFrom(
              `COPY ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) FROM STDIN WITH (FORMAT csv, HEADER true)`,
            ),
          );
          await pipeline(
            fs.createReadStream(file),
            countBytes((n) => {
              loaded += n;
              plan.step(loaded / csvBytes, at, wanted.length);
            }),
            stream,
          );
          // 0.38.0: every row the archive lists for this table must have arrived.
          const expectedRows = archived.get(table)!.rows;
          if (stream.rowCount !== expectedRows) {
            throw new AppError(
              409,
              'ARCHIVE_INCOMPLETE',
              `Kopja është e paplotë: tabela "${table}" ka ${stream.rowCount} rreshta, në listën e kopjes janë ${expectedRows}. Asgjë nuk u ndryshua.`,
              { table, rows: stream.rowCount, expectedRows },
            );
          }
          tablesRestored += 1;
          rowsRestored += stream.rowCount;
        }
        // Every reference of the restored data is checked here; a broken archive stops the restore
        // and nothing is changed. The database checks them in one statement that cannot say how
        // far it is, so this share of the bar moves by the clock: the check takes about as long
        // as loading the rows did.
        loadMs = Date.now() - loadStarted;
        plan.enter('checking_references');
        const checkStarted = Date.now();
        // 0.41.1: the backup history of THIS PC goes back before the references are checked
        // (it used to go back after), and a restored row that points at a backup which is not
        // on this PC lets go of it. A shop that had imported from another program could not
        // restore any backup: the import points at its safety backup, the history was still
        // empty when the references were checked, and the whole restore failed on that one row.
        await this.putBackHistory(client, history);
        const referencesEmptied = await this.emptyLostReferences(client);
        await withEstimatedProgress(
          loadMs * REFERENCE_CHECK_PER_LOAD,
          (f) => plan.step(f),
          async () => {
            await this.enforceForeignKeys(client, deferred);
            await this.resetSequences(client);
          },
        );
        checkMs = Date.now() - checkStarted;
        if (input.transfer) {
          // Devices belong to the PC that registered them: they are revoked here and must be
          // approved again on this installation. Old login sessions end too.
          await client.query(
            `UPDATE station_devices SET status = 'revoked', token_hash = NULL, revoked_at = now()
              WHERE status <> 'revoked'`,
          );
          await client.query(
            'UPDATE user_sessions SET revoked_at = now() WHERE revoked_at IS NULL',
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
        // 0.41.1: the action log this row goes into is the RESTORED one. Whoever restores on
        // another PC is an account of that PC and is not among the restored users, and the row
        // may only name a user who is: without this the restore failed at its very last step.
        await recordAudit(client, await this.actorInRestoredData(client, input.actor), {
          action: input.transfer ? 'backup.transfer_import' : 'backup.restore',
          entityType: 'backup',
          entityId: input.id,
          severity: 'warning',
          details: {
            fileName: path.basename(archiveFile),
            backupCreatedAt: manifest.createdAt,
            backupVersion: manifest.serverVersion,
            upgradedFromSchema: upgraded ? manifest.schemaVersion : null,
            preRestoreBackupId: safety.id,
            tablesRestored,
            rowsRestored,
            referencesEmptied,
          },
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      // Files come back with the data: the archive's uploads replace the current ones, so every
      // restored product, wallpaper and ad points at a file that is really there.
      plan.enter('restoring_files', checked.files);
      const archivedUploads = path.join(tmpDir, 'uploads');
      if (fs.existsSync(archivedUploads)) {
        await this.replaceUploads(archivedUploads);
        const target = this.options.uploadDir;
        if (target) {
          // What is in the folder now must be what the archive listed.
          const now = await treeSize(target);
          if (now.files !== checked.files || now.bytes !== checked.fileBytes) {
            throw new AppError(
              500,
              'RESTORE_FILES_INCOMPLETE',
              `Të dhënat u rikthyen, por fotot dhe videot jo plotësisht (${now.files} nga ${checked.files} skedarë). Përsëriteni rikthimin.`,
              { files: now.files, expectedFiles: checked.files },
            );
          }
        }
      }
      plan.step(1, checked.files);
      // The archive may come from another installation: this server becomes it, so the gaming
      // PCs that were paired with it find this PC and connect with the device rows just restored.
      let identityAdopted = false;
      const archivedId = manifest.installationId ?? null;
      if (
        !input.transfer &&
        archivedId &&
        INSTALLATION_ID_PATTERN.test(archivedId) &&
        this.options.adoptInstallationId &&
        archivedId !== (this.options.installationId?.() ?? null)
      ) {
        await this.options.adoptInstallationId(archivedId);
        identityAdopted = true;
      }
      // Settings added after the archive's version get their defaults.
      await this.settings.ensureDefaults();
      this.settings.invalidate();
      this.options.afterRestore?.();
      const result: RestoreResult = {
        backupId: input.id,
        preRestoreBackupId: safety.id,
        tablesRestored,
        rowsRestored,
        durationMs: Date.now() - t0,
        sessionKept,
        filesRestored: checked.files,
        fileBytesRestored: checked.fileBytes,
        verified: checked.verified,
        archiveVersion: manifest.serverVersion,
        archiveSchemaVersion: manifest.schemaVersion,
        upgraded,
        identityAdopted,
      };
      this.options.log?.info({ ...result, loadMs, checkMs }, 'backup restored');
      return result;
    } finally {
      this.busy = null;
      if (scratchDir) {
        await fsp
          .rm(scratchDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
          .catch(() => undefined);
      }
    }
  }

  /** Refuses an archive this server cannot take: one made by a newer version of the program. */
  private assertRestorable(manifest: BackupManifest, transfer: boolean): void {
    if (transfer && isNewerVersion(manifest.serverVersion, SERVER_VERSION)) {
      throw new AppError(
        409,
        'TRANSFER_VERSION_NEWER',
        `Ky transferim u krijua me LIKApcs ${manifest.serverVersion}; ky PC ka ${SERVER_VERSION}. Instaloni versionin e ri për të importuar.`,
        { archiveVersion: manifest.serverVersion, serverVersion: SERVER_VERSION },
      );
    }
    const current = this.options.schemaVersion();
    if (manifest.schemaVersion > current) {
      throw new AppError(
        409,
        'ARCHIVE_NEWER',
        `Kjo kopje është bërë me LIKApcs ${manifest.serverVersion}, më i ri se ky (${SERVER_VERSION}). Përditësoni programin në këtë PC, pastaj riktheni kopjen.`,
        {
          archiveVersion: manifest.serverVersion,
          serverVersion: SERVER_VERSION,
          backupSchemaVersion: manifest.schemaVersion,
          serverSchemaVersion: current,
        },
      );
    }
  }

  /**
   * Brings the tables of an archive made by an OLDER version up to this one (0.38.0).
   *
   * A scratch database gets the schema the archive was taken with (the migrations up to its
   * version), the archive's rows are loaded into it, and the remaining migrations run over them:
   * what an update of the program would have done to that data. The result is written out again
   * as CSV, in today's shape, and restored like any other archive. The live database is not
   * touched by any of this; the scratch database is dropped at the end.
   */
  private async upgradeTables(
    tmpDir: string,
    manifest: BackupManifest,
    onProgress: (fraction: number) => void,
  ): Promise<{ dir: string; tables: BackupManifest['tables'] }> {
    const migrationsDir = this.options.migrationsDir;
    const liveUrl = (this.pool as unknown as { options?: { connectionString?: string } }).options
      ?.connectionString;
    const fail = (detail: string, cause?: unknown): AppError =>
      new AppError(
        409,
        'ARCHIVE_UPGRADE_FAILED',
        `Kjo kopje është bërë me një version më të vjetër (LIKApcs ${manifest.serverVersion}) dhe nuk u përshtat dot me këtë version. Asgjë nuk u ndryshua. (${detail})`,
        {
          backupSchemaVersion: manifest.schemaVersion,
          serverSchemaVersion: this.options.schemaVersion(),
          cause: cause instanceof Error ? cause.message : undefined,
        },
      );
    if (!migrationsDir || !liveUrl) throw fail('migrations are not available');
    const name = `likapcs_restore_${crypto.randomBytes(6).toString('hex')}`;
    const scratchUrl = new URL(liveUrl);
    scratchUrl.pathname = `/${name}`;
    try {
      await this.pool.query(
        `CREATE DATABASE ${quoteIdent(name)} ENCODING 'UTF8' TEMPLATE template0`,
      );
    } catch (err) {
      throw fail('the scratch database could not be created', err);
    }
    const scratch = createPool(scratchUrl.toString(), { max: 3 });
    try {
      onProgress(0.02);
      await withEstimatedProgress(
        1500,
        (f) => onProgress(0.02 + 0.08 * f),
        () => runMigrations(scratch, migrationsDir, undefined, { upTo: manifest.schemaVersion }),
      );
      onProgress(0.1);
      let loadMs = 0;
      const client = await scratch.connect();
      try {
        await client.query('BEGIN');
        const tables = (await this.publicTables(client)).filter((t) => !SKIP_ON_RESTORE.has(t));
        const known = new Set(tables);
        const stray = manifest.tables.find(
          (t) => !SKIP_ON_RESTORE.has(t.name) && !known.has(t.name),
        );
        if (stray) {
          throw new Error(
            `table "${stray.name}" does not exist in schema version ${manifest.schemaVersion}`,
          );
        }
        const ordered = await this.foreignKeyOrder(client, tables);
        const deferred = await this.deferForeignKeys(client);
        await client.query(
          `TRUNCATE ${tables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`,
        );
        const archived = new Map(manifest.tables.map((t) => [t.name, t]));
        // Rows that are not brought back anyway are not carried through the upgrade either.
        const wanted = ordered.filter((t) => archived.has(t) && !NOT_RESTORED.has(t));
        const csvBytes = wanted.reduce((n, t) => n + archived.get(t)!.bytes, 0) || 1;
        let loaded = 0;
        const loadStarted = Date.now();
        for (const table of wanted) {
          const file = path.join(tmpDir, 'tables', `${table}.csv`);
          const columns = await csvHeader(file);
          if (columns.length === 0) continue;
          const stream = client.query(
            copyFrom(
              `COPY ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) FROM STDIN WITH (FORMAT csv, HEADER true)`,
            ),
          );
          await pipeline(
            fs.createReadStream(file),
            countBytes((n) => {
              loaded += n;
              onProgress(0.1 + 0.25 * (loaded / csvBytes));
            }),
            stream,
          );
          if (stream.rowCount !== archived.get(table)!.rows) {
            throw new Error(
              `table "${table}" has ${stream.rowCount} rows, the archive lists ${archived.get(table)!.rows}`,
            );
          }
        }
        loadMs = Date.now() - loadStarted;
        await withEstimatedProgress(
          loadMs * REFERENCE_CHECK_PER_LOAD,
          (f) => onProgress(0.35 + 0.25 * f),
          async () => {
            await this.enforceForeignKeys(client, deferred);
            await this.resetSequences(client);
            await client.query('COMMIT');
          },
        );
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      onProgress(0.6);
      // The migrations the archive has not seen yet, over its data. How long they take depends on
      // what they do; a guess from the time the rows took to load keeps the bar moving meanwhile.
      await withEstimatedProgress(
        Math.max(2000, loadMs),
        (f) => onProgress(0.6 + 0.2 * f),
        () => runMigrations(scratch, migrationsDir),
      );
      onProgress(0.8);
      const dir = path.join(tmpDir, 'tables-upgraded');
      const reader = await scratch.connect();
      try {
        await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const tables = await this.dumpTables(reader, dir, (f) => onProgress(0.8 + 0.2 * f));
        await reader.query('COMMIT');
        return { dir, tables };
      } catch (err) {
        await reader.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        reader.release();
      }
    } catch (err) {
      this.options.log?.error(
        { err, schemaVersion: manifest.schemaVersion },
        'archive upgrade failed',
      );
      throw fail(err instanceof Error ? err.message : String(err), err);
    } finally {
      await scratch.end().catch(() => undefined);
      await this.pool
        .query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`)
        .catch((err: unknown) =>
          this.options.log?.error({ err, name }, 'scratch database could not be dropped'),
        );
    }
  }

  // ─── Backup file with progress (0.38.0) ─────────────────────────────────

  /**
   * «Backup file»: starts a complete backup in the background and returns at once. The archive
   * is an ordinary manual backup (database + every uploaded file, read back and checked); the
   * job reports the percentage and, at the end, what the archive holds.
   */
  startBackupJob(input: {
    actor: AuditActor;
    password?: string;
    /** 0.41.0: the packed archive (default) or the JSON document. */
    format?: BackupFileFormat;
  }): BackupJobStatus {
    this.acquire('backup');
    return this.runJob('backup', async (progress) => {
      try {
        const { summary, manifest } = await this.writeBackup('manual', input.actor, {
          password: input.password,
          progress,
          format: input.format,
        });
        const backup: BackupFileResult = {
          backup: summary,
          contents: contentsOf(manifest),
          verified: true,
          directory: this.backupDir,
        };
        return { backup };
      } finally {
        this.busy = null;
      }
    });
  }

  /** Starts a restore in the background and returns at once; see `restore` for what it does. */
  startRestoreJob(input: {
    id: string;
    actor: AuditActor;
    sessionId: string | null;
    archivePassword?: string;
  }): BackupJobStatus {
    if (this.busy) {
      throw new AppError(409, 'BACKUP_BUSY', `A ${this.busy} is already in progress`);
    }
    return this.runJob('restore', async (progress) => ({
      restore: await this.restore({ ...input, progress }),
    }));
  }

  /**
   * What an archive holds, read from its beginning. Refuses, before any work starts, an archive
   * whose password is missing or wrong and one made by a newer version of the program.
   */
  async inspect(id: string, archivePassword?: string): Promise<BackupContents> {
    const row = await this.row(id);
    if (row.status !== 'succeeded' || !row.file_path || !fs.existsSync(row.file_path)) {
      throw notFound('Backup file');
    }
    const manifest = await this.manifestOf(row.file_path, archivePassword);
    this.assertRestorable(manifest, false);
    return contentsOf(manifest);
  }

  /** A job by id; never touches the database, so it answers while a restore holds every table. */
  job(id: string): BackupJobStatus {
    const job = this.jobs.get(id);
    if (!job) throw notFound('Job');
    return { ...job };
  }

  private runJob(
    kind: BackupJobStatus['kind'],
    work: (
      progress: ProgressSink,
    ) => Promise<{ backup?: BackupFileResult; restore?: RestoreResult }>,
  ): BackupJobStatus {
    const now = Date.now();
    for (const [id, old] of this.jobs) {
      if (old.finishedAt && now - Date.parse(old.finishedAt) > JOB_KEEP_MS) this.jobs.delete(id);
    }
    while (this.jobs.size >= JOB_KEEP_COUNT) {
      const oldest = [...this.jobs.values()].find((j) => j.state !== 'running');
      if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
    const job: BackupJobStatus = {
      id: crypto.randomUUID(),
      kind,
      state: 'running',
      percent: 0,
      phase: 'starting',
      current: null,
      total: null,
      startedAt: new Date(now).toISOString(),
      finishedAt: null,
      error: null,
      backup: null,
      restore: null,
    };
    this.jobs.set(job.id, job);
    const progress: ProgressSink = (snapshot) => {
      if (job.state !== 'running') return;
      job.percent = Math.max(job.percent, snapshot.percent);
      job.phase = snapshot.phase;
      job.current = snapshot.current;
      job.total = snapshot.total;
    };
    void work(progress)
      .then((result) => {
        job.backup = result.backup ?? null;
        job.restore = result.restore ?? null;
        job.percent = 100;
        job.state = 'succeeded';
      })
      .catch((err: unknown) => {
        job.state = 'failed';
        job.error = describeJobError(err);
        this.options.log?.error({ err, jobId: job.id, kind }, 'backup job failed');
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
      });
    return { ...job };
  }

  // ─── USB transfer (0.27.5) ─────────────────────────────────────────────

  /**
   * Writes the whole system to `targetDir` (a USB stick or any folder) as ONE encrypted file whose
   * key comes from a 4-digit code the owner chooses. Nothing is stored in the local backup list.
   * Refused while a gaming session is still running or paused: the copy must be a clean stop.
   */
  async exportTransfer(input: {
    code: string;
    targetDir: string;
    actor: AuditActor;
  }): Promise<TransferExportResult> {
    if (!TRANSFER_CODE_PATTERN.test(input.code)) {
      throw badRequest('The transfer code must be exactly 4 digits');
    }
    const dir = path.resolve(input.targetDir.trim());
    const dirStat = await fsp.stat(dir).catch(() => null);
    if (!dirStat?.isDirectory()) {
      throw new AppError(
        400,
        'TRANSFER_TARGET_MISSING',
        'Dosja e destinacionit nuk ekziston. Lidhni USB-në dhe shkruani rrugën e saktë.',
      );
    }
    const { rows: running } = await this.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM gaming_sessions WHERE status IN ('active', 'paused')`,
    );
    if ((running[0]?.count ?? 0) > 0) {
      throw new AppError(
        409,
        'TRANSFER_SESSIONS_RUNNING',
        'Mbyllni të gjitha seancat aktive ose në pauzë para transferimit.',
      );
    }
    this.acquire('backup');
    try {
      await fsp.mkdir(this.backupDir, { recursive: true });
      const startedAt = new Date();
      const timeZone = await this.settings.get('locale.timezone');
      const fileName = `LIKApcs-transfer-${stampFor(startedAt, timeZone)}${BACKUP_FILE_EXTENSION}${ENCRYPTED_EXTENSION}`;
      const tmpDir = await fsp.mkdtemp(path.join(this.backupDir, '.transfer-'));
      try {
        const { plainArchive, tables } = await this.dumpPlainArchive(tmpDir, {
          kind: 'manual',
          startedAt,
          timeZone,
          fileName,
          encrypted: true,
        });
        const { size } = await fsp.stat(plainArchive);
        const free = await freeBytes(dir);
        if (free < size + TRANSFER_SPACE_MARGIN_BYTES) {
          throw new AppError(
            409,
            'TRANSFER_NOT_ENOUGH_SPACE',
            `Nuk ka hapësirë të mjaftueshme në USB: nevojiten rreth ${formatBytes(size)}, ka ${formatBytes(free)}.`,
            { neededBytes: size, freeBytes: free },
          );
        }
        const salt = crypto.randomBytes(16);
        const key = deriveKey(input.code, salt);
        const target = path.join(dir, fileName);
        const partial = `${target}.part`;
        try {
          await encryptFile(plainArchive, partial, key, salt);
          await fsp.rename(partial, target);
        } catch (err) {
          await fsp.rm(partial, { force: true }).catch(() => undefined);
          throw err;
        }
        const [sha256, stat] = await Promise.all([sha256Of(target), fsp.stat(target)]);
        await recordAudit(this.pool, input.actor, {
          action: 'backup.transfer_export',
          entityType: 'backup',
          entityId: null,
          details: { fileName, sizeBytes: stat.size, tables },
        });
        this.options.log?.info({ fileName, sizeBytes: stat.size }, 'transfer archive written');
        return {
          fileName,
          path: target,
          sizeBytes: stat.size,
          sha256,
          tables,
          createdAt: startedAt.toISOString(),
        };
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } finally {
      this.busy = null;
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

  /** Latest external-disk result per backup, read from the audit log (no schema change). */
  private async externalCopies(ids: string[]): Promise<Map<string, BackupExternalCopy>> {
    const map = new Map<string, BackupExternalCopy>();
    if (ids.length === 0) return map;
    const { rows } = await this.pool.query<{
      entity_id: string;
      details: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `SELECT DISTINCT ON (entity_id) entity_id::text AS entity_id, details, occurred_at
         FROM audit_logs
        WHERE action = 'backup.external_copy' AND entity_id::text = ANY($1::text[])
        ORDER BY entity_id, occurred_at DESC`,
      [ids],
    );
    for (const r of rows) {
      map.set(r.entity_id, {
        ok: r.details.ok === true,
        path: typeof r.details.path === 'string' ? r.details.path : null,
        error: typeof r.details.error === 'string' ? r.details.error : null,
        at: r.occurred_at.toISOString(),
      });
    }
    return map;
  }

  private toSummary(r: BackupRow, externalCopy: BackupExternalCopy | null = null): BackupSummary {
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
      encrypted: !!r.file_path && r.file_path.endsWith(ENCRYPTED_EXTENSION),
      format: formatOfName(r.file_path),
      externalCopy,
    };
  }

  /**
   * Rough size of what a backup would hold right now: the tables as CSV and the uploaded files.
   * Only used to share out the loading bar between the steps.
   */
  private async currentSize(): Promise<{ csvBytes: number; fileBytes: number }> {
    const { rows } = await this.pool.query<{ bytes: string }>(
      `SELECT coalesce(sum(pg_table_size(c.oid)), 0)::text AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    const source = this.options.uploadDir;
    const files = source && fs.existsSync(source) ? await treeSize(source) : { files: 0, bytes: 0 };
    return {
      csvBytes: Number(rows[0]?.bytes ?? 0) * CSV_PER_HEAP_BYTE,
      fileBytes: files.bytes,
    };
  }

  private async publicTables(client: { query: DbPool['query'] }): Promise<string[]> {
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    return rows.map((r) => r.tablename);
  }

  /**
   * Lets the foreign keys of the public schema wait until `enforceForeignKeys` (inside the
   * caller's transaction). They are normally checked at the end of each statement; for the length
   * of a restore they are made deferrable and deferred. The change is part of the transaction, so
   * a failed restore leaves the constraints exactly as they were. Returns the constraints that
   * were changed, to be put back.
   */
  private async deferForeignKeys(client: {
    query: DbPool['query'];
  }): Promise<{ table: string; name: string }[]> {
    const { rows } = await client.query<{ table: string; name: string }>(
      `SELECT c.conrelid::regclass::text AS "table", c.conname AS name
         FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'f' AND n.nspname = 'public' AND NOT c.condeferrable
          AND c.conparentid = 0
        ORDER BY 1, 2`,
    );
    await client.query('SAVEPOINT defer_foreign_keys');
    try {
      for (const fk of rows) {
        await client.query(
          `ALTER TABLE ${fk.table} ALTER CONSTRAINT ${quoteIdent(fk.name)} DEFERRABLE`,
        );
      }
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query('RELEASE SAVEPOINT defer_foreign_keys');
      return rows;
    } catch (err) {
      // A database whose tables this role may not alter: restore as before, table by table in
      // the best order there is (this works whenever the data has no circular reference).
      await client.query('ROLLBACK TO SAVEPOINT defer_foreign_keys');
      this.options.log?.error({ err }, 'foreign keys could not be deferred for the restore');
      return [];
    }
  }

  /**
   * Checks everything that was deferred, now, and makes the constraints immediate again.
   * 0.41.1: a reference that finds nothing is reported in words (it used to be the database's
   * own sentence), naming the table, and says that nothing was changed.
   */
  private async enforceForeignKeys(
    client: { query: DbPool['query'] },
    deferred: { table: string; name: string }[],
  ): Promise<void> {
    try {
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    } catch (err) {
      const pg = err as { code?: string; table?: string; constraint?: string; detail?: string };
      if (pg.code !== '23503') throw err;
      this.options.log?.error({ err }, 'restore: a reference of the backup finds nothing');
      throw new AppError(
        409,
        'ARCHIVE_REFERENCES_BROKEN',
        `Kopja nuk u kthye: te tabela "${pg.table ?? '?'}" një rresht tregon te diçka që nuk është në kopje (${pg.constraint ?? '?'}). Asgjë nuk u ndryshua.`,
        { table: pg.table ?? null, constraint: pg.constraint ?? null, detail: pg.detail ?? null },
      );
    }
    for (const fk of deferred) {
      await client.query(
        `ALTER TABLE ${fk.table} ALTER CONSTRAINT ${quoteIdent(fk.name)} NOT DEFERRABLE`,
      );
    }
  }

  /**
   * The actor of an action-log row written into data that was just restored: the user and the
   * device are named by id only when they exist there (the log references them); the label —
   * the user name the routes pass — stays either way, so the log still says who it was.
   */
  private async actorInRestoredData(
    client: { query: DbPool['query'] },
    actor: AuditActor,
  ): Promise<AuditActor> {
    const present = async (table: 'users' | 'station_devices', id: string | null | undefined) => {
      if (!id) return null;
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = $1`, [
        id,
      ]);
      return rows[0]?.id ?? null;
    };
    return {
      ...actor,
      userId: await present('users', actor.userId),
      deviceId: await present('station_devices', actor.deviceId),
    };
  }

  /**
   * Puts back the rows of the tables whose CURRENT rows survive a restore (the backup history:
   * it lists the files on this disk). Who made a backup is kept only when that user is in the
   * restored data.
   */
  private async putBackHistory(
    client: { query: DbPool['query'] },
    history: Record<string, unknown>[],
  ): Promise<void> {
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
  }

  /**
   * 0.41.1 — restored rows that point into a table whose rows are NOT brought back from the
   * archive (`PRESERVE_CURRENT`, `NOT_RESTORED`, `SKIP_ON_RESTORE`). Such a table holds what
   * this PC has, so a pointer from the archive may find nothing in it: the import of another
   * program's data points at the safety backup taken before it, and that backup is a file of
   * the PC the archive was made on.
   *
   * A pointer that finds nothing is emptied — what the database does by itself when the row it
   * points at is deleted (these references are `ON DELETE SET NULL`). A pointer that still
   * finds its row (a restore on the same PC) is kept. Only columns that may be empty are
   * touched; anything else is left to the check of the references, which then refuses the
   * archive with nothing changed. Runs inside the restore's transaction, after the kept tables
   * have their rows back. Returns what was emptied, for the action log.
   */
  private async emptyLostReferences(client: {
    query: DbPool['query'];
  }): Promise<{ table: string; columns: string[]; rows: number }[]> {
    const kept = [...PRESERVE_CURRENT, ...NOT_RESTORED, ...SKIP_ON_RESTORE];
    const { rows: references } = await client.query<{
      child: string;
      parent: string;
      child_columns: string[];
      parent_columns: string[];
      nullable: boolean;
    }>(
      `SELECT c.conrelid::regclass::text AS child,
              c.confrelid::regclass::text AS parent,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
              ) AS child_columns,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
              ) AS parent_columns,
              (SELECT bool_and(NOT a.attnotnull)
                 FROM pg_attribute a
                WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
              ) AS nullable
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
         JOIN pg_class parent ON parent.oid = c.confrelid
         JOIN pg_class child ON child.oid = c.conrelid
        WHERE c.contype = 'f' AND n.nspname = 'public' AND c.conparentid = 0
          AND parent.relname = ANY ($1::text[])
          AND NOT child.relname = ANY ($1::text[])
        ORDER BY 1, 2`,
      [kept],
    );
    const emptied: { table: string; columns: string[]; rows: number }[] = [];
    for (const ref of references) {
      if (!ref.nullable) continue;
      const columns = ref.child_columns.map(quoteIdent);
      const { rowCount } = await client.query(
        `UPDATE ${ref.child} AS c
            SET ${columns.map((column) => `${column} = NULL`).join(', ')}
          WHERE ${columns.map((column) => `c.${column} IS NOT NULL`).join(' AND ')}
            AND NOT EXISTS (
              SELECT 1 FROM ${ref.parent} AS p
               WHERE ${ref.parent_columns
                 .map((column, i) => `p.${quoteIdent(column)} = c.${columns[i]}`)
                 .join(' AND ')})`,
      );
      if ((rowCount ?? 0) > 0) {
        emptied.push({ table: ref.child, columns: ref.child_columns, rows: rowCount ?? 0 });
      }
    }
    if (emptied.length > 0) {
      this.options.log?.info({ emptied }, 'restore: references to backups of another PC emptied');
    }
    return emptied;
  }

  /** The order the tables are restored in: see `restoreOrder`. */
  private async foreignKeyOrder(
    client: { query: DbPool['query'] },
    tables: string[],
  ): Promise<string[]> {
    const { rows } = await client.query<{ child: string; parent: string }>(
      `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
         FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'f' AND n.nspname = 'public' AND c.conrelid <> c.confrelid`,
    );
    return restoreOrder(tables, rows);
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

/**
 * The order tables are restored in: parents before children (Kahn's algorithm over the foreign
 * keys); self-references are ignored.
 *
 * Where tables reference each other in a circle no such order exists, so the circle is opened at
 * one of the tables that are on it — the one with the fewest parents still missing, by name on a
 * tie — and the order goes on from there. A table that only waits for a circle (it references
 * one, but is not on it) is never moved ahead: it still comes after every one of its parents,
 * which the triggers that look a parent up rely on (`internet_access_codes` → `products`). The
 * reference that closes a circle is checked at the end of the restore (`deferForeignKeys`).
 */
export function restoreOrder(
  tables: readonly string[],
  references: readonly { child: string; parent: string }[],
): string[] {
  const set = new Set(tables);
  const parentsOf = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of references) {
    if (child !== parent && set.has(child) && set.has(parent)) parentsOf.get(child)!.add(parent);
  }
  const ordered: string[] = [];
  const done = new Set<string>();
  const missingOf = (t: string) => [...parentsOf.get(t)!].filter((p) => !done.has(p));
  /** True when `t` is its own ancestor among the tables still to come. */
  const onCircle = (t: string): boolean => {
    const seen = new Set<string>();
    const stack = missingOf(t);
    while (stack.length > 0) {
      const p = stack.pop()!;
      if (p === t) return true;
      if (seen.has(p)) continue;
      seen.add(p);
      stack.push(...missingOf(p));
    }
    return false;
  };
  while (ordered.length < tables.length) {
    const left = tables.filter((t) => !done.has(t));
    const ready = left.filter((t) => missingOf(t).length === 0);
    if (ready.length > 0) {
      for (const t of ready) {
        ordered.push(t);
        done.add(t);
      }
      continue;
    }
    // Nothing is ready, so every table left waits for another one: at least one circle exists.
    const next = left
      .filter(onCircle)
      .sort((a, b) => missingOf(a).length - missingOf(b).length || (a < b ? -1 : 1))[0]!;
    ordered.push(next);
    done.add(next);
  }
  return ordered;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function sha256Of(file: string, onBytes?: (bytes: number) => void): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk as Buffer);
    onBytes?.((chunk as Buffer).length);
  }
  return hash.digest('hex');
}

/** A name that is free in `dir`: the wanted one, or the same with -2, -3… before the extension. */
function freeName(dir: string, wanted: string): string {
  if (!fs.existsSync(path.join(dir, wanted))) return wanted;
  const ext = [
    `${BACKUP_FILE_EXTENSION}${ENCRYPTED_EXTENSION}`,
    `${BACKUP_JSON_FILE_EXTENSION}${ENCRYPTED_EXTENSION}`,
    BACKUP_FILE_EXTENSION,
    BACKUP_JSON_FILE_EXTENSION,
  ].find((e) => wanted.endsWith(e));
  const stem = ext ? wanted.slice(0, -ext.length) : wanted;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem}-${n}${ext ?? ''}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${stem}-${crypto.randomBytes(4).toString('hex')}${ext ?? ''}`;
}

/** How a stored backup is written, told from its name: the packed archive or the JSON document. */
export function formatOfName(file: string | null): BackupFileFormat {
  if (!file) return 'archive';
  const name = file.endsWith(ENCRYPTED_EXTENSION)
    ? file.slice(0, -ENCRYPTED_EXTENSION.length)
    : file;
  return name.endsWith(BACKUP_JSON_FILE_EXTENSION) ? 'json' : 'archive';
}

/**
 * `name` with the ending of what the file really holds (0.41.0). An uploaded file keeps its name
 * when the name already says the right thing; a JSON document that arrived as
 * `kopja.likapcs-backup.tar.gz`, or a file with a password whose `.enc` was dropped on the way,
 * gets the right ending. The list and the restore window go by the name.
 */
export function nameForContents(
  name: string,
  format: BackupFileFormat,
  encrypted: boolean,
): string {
  const namedEncrypted = name.endsWith(ENCRYPTED_EXTENSION);
  if (formatOfName(name) === format && namedEncrypted === encrypted) return name;
  let stem = namedEncrypted ? name.slice(0, -ENCRYPTED_EXTENSION.length) : name;
  for (const ending of [BACKUP_FILE_EXTENSION, BACKUP_JSON_FILE_EXTENSION]) {
    if (stem.endsWith(ending)) stem = stem.slice(0, -ending.length);
  }
  const ending = format === 'json' ? BACKUP_JSON_FILE_EXTENSION : BACKUP_FILE_EXTENSION;
  return `${stem || 'backup'}${ending}${encrypted ? ENCRYPTED_EXTENSION : ''}`;
}

/** What is wrong with a JSON backup, as an answer the Admin shows («damaged or changed»). */
function jsonArchiveProblem(err: unknown): unknown {
  if (!(err instanceof JsonArchiveError)) return err;
  return new AppError(
    409,
    'ARCHIVE_CORRUPT',
    `Skedari JSON i kopjes është i paplotë ose është ndryshuar. Asgjë nuk u ndryshua. (${err.message})`,
    { line: err.line },
  );
}

/**
 * Turns a JSON backup into the folder an unpacked archive leaves behind: `manifest.json`, a CSV
 * per table and the uploaded files (see `backup-json.ts`).
 */
async function unpackJsonArchive(
  file: string,
  dir: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  try {
    await readJsonArchive(file, dir, onProgress);
  } catch (err) {
    throw jsonArchiveProblem(err);
  }
}

/**
 * The manifest at the beginning of a plain backup that arrives as a stream (a decrypted file),
 * whichever way it is written. The first bytes tell a JSON document from a packed archive.
 */
async function peekAnyManifest(
  source: Readable,
): Promise<{ manifest: BackupManifest; format: BackupFileFormat }> {
  // A file opened with the wrong password fails when its last byte has gone through, which for a
  // small file is at once and at any moment. This listener stays for the whole life of the
  // stream, so that error always has somebody to go to.
  let failed: Error | null = null;
  source.on('error', (err: Error) => {
    failed ??= err;
  });
  let head: Buffer;
  try {
    head = await firstBytes(source, 256);
  } catch (err) {
    source.destroy();
    throw err;
  }
  // (Nothing can happen to the stream between this check and the reader taking it over.)
  if (failed) throw failed as Error;
  if (looksLikeJsonArchive(head)) {
    return { manifest: parseManifest(await peekJsonManifestText(source)), format: 'json' };
  }
  return { manifest: await peekManifest(source), format: 'archive' };
}

/**
 * The first `count` bytes of a stream (or more), which stay in it: whoever reads the stream next
 * starts at its first byte. A stream that ends earlier is not a backup.
 */
function firstBytes(source: Readable, count: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = (): void => {
      source.off('readable', onReadable);
      source.off('end', onEnd);
      source.off('error', onError);
    };
    const onReadable = (): void => {
      for (;;) {
        const chunk = source.read() as Buffer | null;
        if (chunk === null) return;
        chunks.push(chunk);
        size += chunk.length;
        if (size >= count) {
          stop();
          const all = Buffer.concat(chunks);
          source.unshift(all);
          resolve(all);
          return;
        }
      }
    };
    const onEnd = (): void => {
      stop();
      reject(new Error('The file ends before a backup could begin'));
    };
    const onError = (err: Error): void => {
      stop();
      reject(err);
    };
    source.on('readable', onReadable);
    source.on('end', onEnd);
    source.on('error', onError);
  });
}

/** The numbers of an archive that are shown to the owner. */
export function contentsOf(manifest: BackupManifest): BackupContents {
  // Counted the way a restore counts: the tables it brings back. (The schema's own bookkeeping,
  // the list of backups on the PC it was made on and the PCs' load samples are in the file but
  // are never loaded.) So "the file holds N rows" and "N rows were restored" are the same N.
  const loaded = manifest.tables.filter(
    (t) =>
      !SKIP_ON_RESTORE.has(t.name) && !PRESERVE_CURRENT.has(t.name) && !NOT_RESTORED.has(t.name),
  );
  return {
    createdAt: manifest.createdAt,
    serverVersion: manifest.serverVersion,
    schemaVersion: manifest.schemaVersion,
    businessName: manifest.businessName,
    tables: loaded.length,
    rows: loaded.reduce((n, t) => n + t.rows, 0),
    files: manifest.uploads?.files ?? manifest.files?.length ?? 0,
    fileBytes: manifest.uploads?.bytes ?? manifest.files?.reduce((n, f) => n + f.bytes, 0) ?? 0,
  };
}

/** What a failed job tells the Admin: the error code and a sentence for the owner. */
function describeJobError(err: unknown): { code: string; message: string } {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOSPC') {
    return { code: 'NOT_ENOUGH_SPACE', message: 'Nuk ka vend të mjaftueshëm në disk.' };
  }
  return { code: 'internal_error', message: err instanceof Error ? err.message : String(err) };
}

/** Every folder and regular file under `root`, as paths relative to it with forward slashes. */
async function listTree(
  root: string,
): Promise<{ dirs: string[]; files: { path: string; bytes: number }[] }> {
  const dirs: string[] = [];
  const files: { path: string; bytes: number }[] = [];
  const walk = async (relative: string): Promise<void> => {
    const here = relative ? path.join(root, ...relative.split('/')) : root;
    const entries = await fsp.readdir(here, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirs.push(child);
        await walk(child);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(path.join(here, entry.name)).catch(() => null);
        if (stat) files.push({ path: child, bytes: stat.size });
      }
    }
  };
  await walk('');
  return { dirs, files };
}

/** A path from a manifest that stays inside the folder it is joined to. */
function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 1024 || p.includes('\\') || p.includes('\0')) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * Reads a finished plain archive back and compares every entry with the manifest it carries
 * (0.38.0): each table and each uploaded file must be there, with the listed size and checksum.
 * A backup only counts as written after this.
 */
export async function verifyArchive(
  file: string,
  manifest: BackupManifest,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const total =
    manifest.tables.reduce((n, t) => n + t.bytes, 0) + (manifest.uploads?.bytes ?? 0) || 1;
  const seen = new Map<string, { bytes: number; sha256: string }>();
  let read = 0;
  await tar.list({
    file,
    strict: true,
    // Small pieces: each one is unpacked on the main thread, and the server answers in between.
    maxReadSize: 1024 * 1024,
    onReadEntry: (entry) => {
      if (entry.type !== 'File') return;
      const name = entry.path.replace(/^\.\//, '');
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      entry.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        bytes += chunk.length;
        read += chunk.length;
        onProgress?.(Math.min(1, read / total));
      });
      entry.on('end', () => seen.set(name, { bytes, sha256: hash.digest('hex') }));
    },
  });
  const fail = (what: string): never => {
    throw new Error(`Backup verification failed: ${what}. The archive was not kept.`);
  };
  if (!seen.has('manifest.json')) fail('manifest.json is missing');
  for (const table of manifest.tables) {
    const entry = seen.get(`tables/${table.name}.csv`);
    if (!entry) return fail(`table ${table.name} is missing`);
    if (entry.bytes !== table.bytes || (table.sha256 && entry.sha256 !== table.sha256)) {
      fail(`table ${table.name} does not match what was written`);
    }
  }
  for (const item of manifest.files ?? []) {
    const entry = seen.get(`uploads/${item.path}`);
    if (!entry) return fail(`file ${item.path} is missing`);
    if (entry.bytes !== item.bytes || entry.sha256 !== item.sha256) {
      fail(`file ${item.path} does not match what was written`);
    }
  }
}

/**
 * Checks an unpacked archive against its manifest before a restore changes anything (0.38.0):
 * every table file and every uploaded file must be there with the listed size and, when the
 * manifest has them, the listed checksum. An archive made before 0.38.0 has no file list: its
 * tables are checked by size and its files by number and total size (`verified` is then false).
 */
async function verifyUnpacked(
  dir: string,
  manifest: BackupManifest,
  onProgress?: (fraction: number) => void,
): Promise<{ verified: boolean; files: number; fileBytes: number }> {
  const incomplete = (what: string): never => {
    throw new AppError(
      409,
      'ARCHIVE_INCOMPLETE',
      `Kopja është e paplotë ose e dëmtuar: ${what}. Asgjë nuk u ndryshua.`,
    );
  };
  const total =
    manifest.tables.reduce((n, t) => n + t.bytes, 0) + (manifest.uploads?.bytes ?? 0) || 1;
  let read = 0;
  const hashOf = (file: string) =>
    sha256Of(file, (n) => {
      read += n;
      onProgress?.(Math.min(1, read / total));
    });
  let verified = true;
  for (const table of manifest.tables) {
    if (!TABLE_NAME_PATTERN.test(table.name)) incomplete(`emër tabele i pavlefshëm`);
    const file = path.join(dir, 'tables', `${table.name}.csv`);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) return incomplete(`mungon tabela "${table.name}"`);
    if (stat.size !== table.bytes) incomplete(`tabela "${table.name}" nuk ka madhësinë e duhur`);
    if (table.sha256) {
      if ((await hashOf(file)) !== table.sha256)
        incomplete(`tabela "${table.name}" është ndryshuar`);
    } else {
      verified = false;
    }
  }
  const uploads = path.join(dir, 'uploads');
  const present = fs.existsSync(uploads) ? await treeSize(uploads) : { files: 0, bytes: 0 };
  if (manifest.files) {
    for (const item of manifest.files) {
      if (!isSafeRelativePath(item.path)) incomplete('emër skedari i pavlefshëm');
      const file = path.join(uploads, ...item.path.split('/'));
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat?.isFile()) return incomplete(`mungon skedari "${item.path}"`);
      if (stat.size !== item.bytes) incomplete(`skedari "${item.path}" nuk ka madhësinë e duhur`);
      if ((await hashOf(file)) !== item.sha256)
        incomplete(`skedari "${item.path}" është ndryshuar`);
    }
    if (present.files !== manifest.files.length) {
      incomplete(`në kopje janë ${present.files} skedarë, në listë ${manifest.files.length}`);
    }
  } else {
    verified = false;
    if (
      manifest.uploads &&
      (present.files !== manifest.uploads.files || present.bytes !== manifest.uploads.bytes)
    ) {
      incomplete(`në kopje janë ${present.files} skedarë, në listë ${manifest.uploads.files}`);
    }
  }
  onProgress?.(1);
  return { verified, files: present.files, fileBytes: present.bytes };
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

/** Number of files and their total size under a folder. */
/**
 * Unpacks a plain archive into `dir`. The share reported is the share of the archive FILE that
 * has been read, so the percentage keeps moving inside one large picture or video too (counting
 * finished entries would stand still for as long as a big file takes).
 */
async function unpackArchive(
  file: string,
  dir: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const size = (await fsp.stat(file)).size || 1;
  let read = 0;
  await new Promise<void>((resolve, reject) => {
    const source = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
    const unpack = tar.extract({ cwd: dir, strict: true });
    const fail = (err: unknown) => {
      source.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    source.on('data', (chunk) => {
      read += chunk.length;
      onProgress?.(Math.min(1, read / size));
    });
    source.on('error', fail);
    unpack.on('error', fail);
    unpack.on('close', () => resolve());
    source.pipe(unpack as unknown as NodeJS.WritableStream);
  });
}

async function treeSize(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await treeSize(full);
      files += inner.files;
      bytes += inner.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += (await fsp.stat(full)).size;
    }
  }
  return { files, bytes };
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

/**
 * Reads manifest.json from a plain archive. 0.38.0: stops as soon as the manifest has been read
 * (it is the first entry of every archive this program writes), so a large archive is not read
 * through only to be identified. A manifest further in is still found.
 */
export function readManifest(file: string): Promise<BackupManifest> {
  return peekManifest(fs.createReadStream(file));
}

/** Reads manifest.json from the bytes of a plain archive and stops the source. */
export function peekManifest(source: Readable): Promise<BackupManifest> {
  return new Promise<BackupManifest>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err: Error | null, manifest?: BackupManifest): void => {
      if (settled) return;
      settled = true;
      source.unpipe();
      source.destroy();
      if (err) reject(err);
      else resolve(manifest!);
    };
    const parser = new tar.Parser({
      strict: true,
      onReadEntry: (entry) => {
        const name = entry.path.replace(/^\.\//, '');
        if (name !== 'manifest.json') {
          entry.resume();
          return;
        }
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => {
          try {
            finish(null, parseManifest(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            finish(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    });
    parser.on('error', (err: Error) => finish(err));
    parser.on('end', () => finish(new Error('manifest.json not found in archive')));
    source.on('error', (err: Error) => finish(err));
    source.pipe(parser as unknown as NodeJS.WritableStream);
  });
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

/**
 * The note at the top of a JSON backup (0.41.0), for a person who opens the file: what it is, how
 * it is brought back, and that it must not be edited. Albanian first, then English.
 */
function jsonReadme(
  manifest: BackupManifest,
  opts: { timeZone: string; fileName: string },
): string {
  const when = new Date(manifest.createdAt).toLocaleString('en-GB', {
    timeZone: opts.timeZone,
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
  const rows = manifest.tables.reduce((sum, t) => sum + t.rows, 0);
  const files = manifest.uploads?.files ?? 0;
  return [
    `LIKApcs — kopje e plotë (backup) në JSON. Biznesi: ${manifest.businessName ?? '—'}. Bërë më ${when} (${opts.timeZone}) me LIKApcs ${manifest.serverVersion}.`,
    `Përmban gjithçka: ${manifest.tables.length} tabela me ${rows} rreshta (produktet, stoku, shitjet, faturat, arka, klientët, përdoruesit me fjalëkalimet e tyre, cilësimet, PC-të) dhe ${files} skedarë (fotot, sfondet, videot, zërat).`,
    'SI KTHEHET: hapni LIKApcs (i njëjti version ose më i ri), zgjidhni «Rikthe nga kopja (backup)» dhe këtë skedar. Në një PC të ri kjo është në ekranin e parë.',
    'MOS E NDRYSHONI këtë skedar: një skedar i ndryshuar ose i prerë nuk pranohet. Ruajeni në vend të sigurt: kushdo që e ka mund t’i lexojë të dhënat.',
    'Full LIKApcs backup as JSON. To restore: open LIKApcs (same version or newer), choose «Restore from a backup» and pick this file. Do not edit it: a changed or cut-off file is refused.',
    'Layout: "tables" holds every table row by row (each value is the text PostgreSQL writes for it; null is an empty value), "files" holds every uploaded file as base64, "manifest" lists their sizes and SHA-256 checksums.',
  ].join(' ');
}

/** Human-readable report written inside every archive (report.txt). Albanian, for the owner. */
function buildReport(
  manifest: BackupManifest,
  opts: { timeZone: string; fileName: string; encrypted: boolean },
): string {
  const when = new Date(manifest.createdAt).toLocaleString('en-GB', {
    timeZone: opts.timeZone,
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
  const width = Math.max(...manifest.tables.map((t) => t.name.length), 10);
  const totalRows = manifest.tables.reduce((sum, t) => sum + t.rows, 0);
  const lines = [
    'RAPORTI I KOPJES SË RUAJTUR — LIKApcs',
    '======================================',
    `Skedari:            ${opts.fileName}`,
    `Krijuar:            ${when} (${opts.timeZone})`,
    `Lloji:              ${manifest.kind}`,
    `Biznesi:            ${manifest.businessName}`,
    `Versioni i programit: ${manifest.serverVersion}`,
    `Versioni i bazës:     ${manifest.schemaVersion}`,
    `Enkriptimi:         ${opts.encrypted ? 'PO (me fjalëkalim)' : 'JO'}`,
    '',
    `TABELAT (${manifest.tables.length}) — rreshta gjithsej: ${totalRows}`,
    ...manifest.tables.map(
      (t) => `  ${t.name.padEnd(width)}  ${String(t.rows).padStart(8)} rreshta`,
    ),
    '',
    manifest.uploads
      ? `FOTO / VIDEO: ${manifest.uploads.files} skedarë, ${(manifest.uploads.bytes / 1024 / 1024).toFixed(1)} MB`
      : 'FOTO / VIDEO: asnjë skedar',
    '',
    'SI KTHEHET',
    '  - Në një PC të ri: instaloni LIKApcs dhe në ekranin e parë zgjidhni «Rikthe nga kopja (backup)».',
    '  - Në një PC që është në punë: Kopjet rezervë › «Rikthe nga skedari», ose «Rikthe nga kopja (backup)» te ekrani i hyrjes.',
    '  - Kopja hapet në të njëjtin version të LIKApcs ose në një më të ri.',
    '',
    'NUK PËRFSHIHEN NË KOPJE',
    '  - Vetë instaluesi i programit.',
    '  - Skedari i konfigurimit të këtij PC-je, që përmban çelësat sekretë.',
    '  - Fjalëkalimi i kopjes: nuk është brenda saj. Pa të, kopja me fjalëkalim nuk hapet në PC tjetër.',
    '',
  ];
  return lines.join('\n');
}

/** A 4-digit transfer code (0000–9999). */
export const TRANSFER_CODE_PATTERN = /^\d{4}$/;
/** Free space kept on the USB stick on top of the archive itself. */
const TRANSFER_SPACE_MARGIN_BYTES = 1024 * 1024;

export interface TransferExportResult {
  fileName: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  tables: number;
  createdAt: string;
}

/** Free bytes available to non-root users on the disk that holds `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const s = await fsp.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

/** True when version `a` is strictly newer than `b` (dotted numbers, e.g. 0.27.5). */
export function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) => v.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
