/**
 * «Backup file» and «Restore from a backup» (0.38.0): the parts that talk to the server and to
 * the disk. The dialogs are in `components/backups/BackupFile.tsx`.
 *
 *  - a long backup or restore runs on the server as a job; its percentage is read WITHOUT the
 *    sign-in, because a signed-in request waits behind the restore (the server checks the
 *    session in the very tables the restore holds);
 *  - an upload reports its own percentage, so one bar covers "send the file" + "restore it";
 *  - the finished file is written where the owner chose (a USB stick, another disk) and then read
 *    back from there and compared with the checksum of the server's copy.
 */
import {
  BACKUP_FILE_EXTENSION,
  BACKUP_JSON_FILE_EXTENSION,
  type BackupDownloadTicket,
  type BackupFileFormat,
  type BackupJobPhase,
  type BackupJobStatus,
  type BackupSummary,
} from '@likapcs/shared';
import { api, apiDownload, ApiError, getServerUrl, getToken } from './api';
import { Sha256 } from './sha256';
import { storage } from './storage';

/** First bytes of an encrypted LIKApcs archive (see the server's `backup-crypto.ts`). */
const ENCRYPTED_MAGIC = 'LKPBENC1';
/**
 * The beginning of a backup written as a JSON document (0.41.0; the server's `backup-json.ts`).
 * Spaces are allowed for: a file another program has saved again is told "damaged" by the
 * server, which is more use to the owner than "not a backup".
 */
const JSON_BACKUP_HEAD = /^\uFEFF?\s*\{\s*"format"\s*:\s*"likapcs-backup-json"/;

export type ArchiveKind = 'encrypted' | 'plain' | 'unknown';

/** What a chosen file is, from its first bytes — before anything is sent to the server. */
export async function archiveKindOf(file: Blob): Promise<ArchiveKind> {
  const head = new Uint8Array(await file.slice(0, 96).arrayBuffer());
  if (head.length >= 8 && String.fromCharCode(...head.subarray(0, 8)) === ENCRYPTED_MAGIC) {
    return 'encrypted';
  }
  // A .tar.gz starts with the gzip signature.
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'plain';
  // A JSON backup is text that says what it is.
  if (JSON_BACKUP_HEAD.test(new TextDecoder().decode(head))) return 'plain';
  return 'unknown';
}

/**
 * How «Backup file» writes the file when the owner has not chosen yet on this PC: the JSON
 * document. The choice made in the window is remembered for the next time.
 */
export const DEFAULT_BACKUP_FILE_FORMAT: BackupFileFormat = 'json';

export function rememberedBackupFormat(): BackupFileFormat {
  const stored = storage.get('backupFileFormat');
  return stored === 'json' || stored === 'archive' ? stored : DEFAULT_BACKUP_FILE_FORMAT;
}

export function rememberBackupFormat(format: BackupFileFormat): void {
  storage.set('backupFileFormat', format);
}

/** A file name the upload accepts: letters, digits, dot, dash, underscore; at most 160. */
export function safeUploadName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '');
  if (!cleaned) return 'backup';
  // Keep the end of the name: the extension is what tells the kinds of archive apart.
  return cleaned.length > 160 ? cleaned.slice(cleaned.length - 160).replace(/^[-.]+/, '') : cleaned;
}

/**
 * Name offered in the "save as" window, e.g. `LIKApcs-backup-20261121-2114.likapcs-backup.json`
 * (`.likapcs-backup.tar.gz` for the packed archive; `.enc` is added to a file with a password).
 */
export function suggestedBackupName(
  at: Date,
  encrypted: boolean,
  format: BackupFileFormat = 'archive',
): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`;
  const ending = format === 'json' ? BACKUP_JSON_FILE_EXTENSION : BACKUP_FILE_EXTENSION;
  return `LIKApcs-backup-${stamp}${ending}${encrypted ? '.enc' : ''}`;
}

// ─── One bar for several steps ─────────────────────────────────────────────────

/** A step shown under the bar: the server's own phases plus the ones done on this PC. */
export type ProgressPhase = BackupJobPhase | 'uploading' | 'saving' | 'checking_copy';

export interface ProgressView {
  /** 0–100 for the whole operation. */
  percent: number;
  phase: ProgressPhase;
  current: number | null;
  total: number | null;
}

/**
 * Share of the whole bar each step takes. Making a backup: the server's job, then the copy to the
 * chosen place, then reading that copy back. Restoring: sending the file, then the server's job.
 */
export const BACKUP_SHARES = { job: 70, saving: 20, checking: 10 } as const;
export const RESTORE_SHARES = { upload: 15, job: 85 } as const;

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Position of the bar while the server makes the backup. `saves` = a copy is written afterwards. */
export function backupJobPercent(jobPercent: number, saves: boolean): number {
  return saves ? Math.floor((clamp(jobPercent) * BACKUP_SHARES.job) / 100) : clamp(jobPercent);
}
export function backupSavingPercent(fraction: number): number {
  return Math.floor(BACKUP_SHARES.job + clamp(fraction * 100) * (BACKUP_SHARES.saving / 100));
}
export function backupCheckingPercent(fraction: number): number {
  // 100 is shown only once the checksum was compared.
  return Math.min(
    99,
    Math.floor(
      BACKUP_SHARES.job +
        BACKUP_SHARES.saving +
        clamp(fraction * 100) * (BACKUP_SHARES.checking / 100),
    ),
  );
}
export function restoreUploadPercent(loaded: number, total: number): number {
  if (total <= 0) return 0;
  return Math.floor((clamp((loaded / total) * 100) * RESTORE_SHARES.upload) / 100);
}
/** `uploaded` = the file was sent first (else the job is the whole bar). */
export function restoreJobPercent(jobPercent: number, uploaded: boolean): number {
  if (!uploaded) return clamp(jobPercent);
  if (jobPercent >= 100) return 100;
  return Math.floor(RESTORE_SHARES.upload + (clamp(jobPercent) * RESTORE_SHARES.job) / 100);
}

// ─── Server jobs ───────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The job stopped answering: the server was closed or restarted while it ran. */
export class JobLostError extends Error {
  constructor() {
    super('The server stopped answering');
    this.name = 'JobLostError';
  }
}

/**
 * Follows a backup or restore job to its end and reports every answer. Resolves with the final
 * status (succeeded or failed); throws `JobLostError` when the server no longer knows the job or
 * gives no answer for about a minute.
 */
export async function followJob(
  jobId: string,
  onStatus: (status: BackupJobStatus) => void,
  options: { intervalMs?: number; patienceMs?: number } = {},
): Promise<BackupJobStatus> {
  const interval = options.intervalMs ?? 350;
  const patience = options.patienceMs ?? 60_000;
  let silentSince: number | null = null;
  for (;;) {
    let status: BackupJobStatus | null = null;
    try {
      // No sign-in on purpose: see the note at the top of this file.
      status = await api<BackupJobStatus>(`/backups/jobs/${jobId}`, { auth: false });
      silentSince = null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw new JobLostError();
      silentSince ??= Date.now();
      if (Date.now() - silentSince > patience) throw new JobLostError();
    }
    if (status) {
      onStatus(status);
      if (status.state !== 'running') return status;
    }
    await sleep(status ? interval : Math.max(interval, 1000));
  }
}

// ─── Upload with a percentage ──────────────────────────────────────────────────

export interface UploadOptions {
  /** Sign-in to use instead of the stored one (not stored). */
  token?: string;
  /** False on a fresh installation: nobody is signed in. */
  auth?: boolean;
  /** Password of an encrypted archive. */
  archivePassword?: string;
  onProgress?: (loaded: number, total: number) => void;
}

/** Sends a file as the raw body and reports how much of it has gone (fetch cannot). */
export function uploadWithProgress<T>(
  path: string,
  file: Blob,
  query: Record<string, string>,
  options: UploadOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const url = new URL(`${getServerUrl()}/api/v1${path}`, window.location.origin);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url.toString());
    const token = options.auth === false ? null : (options.token ?? getToken());
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    // Percent-encoded: a header holds single bytes only, a password may hold any letter.
    if (options.archivePassword) {
      xhr.setRequestHeader('x-archive-password-utf8', encodeURIComponent(options.archivePassword));
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded, e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', 'network error'));
    xhr.onabort = () => reject(new ApiError(0, 'network_error', 'aborted'));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not json */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.(file.size, file.size);
        resolve(body as T);
        return;
      }
      const error = (body as { error?: { code?: string; message?: string; details?: unknown } })
        ?.error;
      reject(
        new ApiError(
          xhr.status,
          error?.code ?? 'upload_failed',
          error?.message ?? `HTTP ${xhr.status}`,
          error?.details,
        ),
      );
    };
    xhr.send(file);
  });
}

// ─── Saving the file where the owner chose ─────────────────────────────────────

interface SavePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}
type SavePicker = (options?: SavePickerOptions) => Promise<FileSystemFileHandle>;

function savePicker(): SavePicker | null {
  if (typeof window === 'undefined') return null;
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  return typeof picker === 'function' ? picker.bind(window) : null;
}

/** True when this window can open a "save as" window (the desktop app, Chrome, Edge). */
export function canChooseSaveLocation(): boolean {
  return savePicker() !== null;
}

/**
 * Opens the "save as" window. Must be called straight from a click. `'cancelled'` when the owner
 * closed the window; `null` when this PC cannot show one (the file is then offered as a download).
 */
export async function chooseSaveLocation(
  suggestedName: string,
): Promise<FileSystemFileHandle | 'cancelled' | null> {
  const picker = savePicker();
  if (!picker) return null;
  const isCancel = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';
  try {
    return await picker({ suggestedName });
  } catch (err) {
    if (isCancel(err)) return 'cancelled';
    return null;
  }
}

/** A link that downloads one archive without the sign-in header (valid for a few minutes). */
export async function backupDownloadUrl(backupId: string): Promise<string> {
  const { ticket } = await api<BackupDownloadTicket>(`/backups/${backupId}/download-ticket`, {
    method: 'POST',
    body: {},
  });
  return `${getServerUrl()}/api/v1/backups/${backupId}/download?ticket=${encodeURIComponent(ticket)}`;
}

/** Above this size an archive is not held in memory for a download: the link is used instead. */
const HELD_DOWNLOAD_LIMIT_BYTES = 1024 ** 3;

/**
 * Saves the archive as a normal download (the Downloads folder). In the desktop app the file is
 * fetched and handed to the web view the way every other download of the Admin is, which is
 * known to work there. A browser — and an archive too large to hold — follows a link with a
 * ticket instead, and the browser's own download takes over.
 */
export async function downloadBackupByLink(backup: BackupSummary): Promise<void> {
  const name = backup.fileName ?? 'backup.likapcs-backup.tar.gz';
  const inDesktopApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (inDesktopApp && (backup.sizeBytes ?? 0) <= HELD_DOWNLOAD_LIMIT_BYTES) {
    await apiDownload(`/backups/${backup.id}/download`, name);
    return;
  }
  const url = await backupDownloadUrl(backup.id);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** The copy on the chosen disk is not the file the server made. */
export class CopyMismatchError extends Error {
  constructor(readonly reason: 'size' | 'checksum') {
    super(`The saved copy does not match (${reason})`);
    this.name = 'CopyMismatchError';
  }
}

/**
 * Lets the window draw and answer between two pieces of long work. A message, not a timer: timers
 * are slowed to one per second while the window is minimised, which would make the work crawl.
 */
function breathe(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Calls `report` at most every 120 ms (a progress callback fires thousands of times). */
function throttled(report: (fraction: number) => void): (fraction: number) => void {
  let last = 0;
  return (fraction) => {
    const now = Date.now();
    if (fraction >= 1 || now - last >= 120) {
      last = now;
      report(fraction);
    }
  };
}

/**
 * Writes the archive into the chosen file and then reads that file back from the disk: its size
 * and checksum must be those of the archive on the server. Throws `CopyMismatchError` when they
 * are not, after trying to delete the bad copy. A write that fails half-way leaves no file (the
 * data goes to a temporary file that replaces the chosen one only when it is complete).
 */
export async function saveBackupTo(
  handle: FileSystemFileHandle,
  backup: BackupSummary,
  onProgress: (step: 'saving' | 'checking_copy', fraction: number) => void,
): Promise<{ name: string; bytes: number; checksumChecked: boolean }> {
  return saveUrlTo(
    handle,
    {
      url: await backupDownloadUrl(backup.id),
      sizeBytes: backup.sizeBytes ?? 0,
      sha256: backup.sha256 ?? null,
    },
    onProgress,
  );
}

/** A file on the server to copy: where it is read from, and what the copy must come out as. */
export interface SaveSource {
  url: string;
  sizeBytes: number;
  sha256: string | null;
}

/**
 * Copies a file of the server into the chosen file and reads the copy back (see `saveBackupTo`).
 * Used for the backup archive and for the data files made for an AI.
 */
export async function saveUrlTo(
  handle: FileSystemFileHandle,
  source: SaveSource,
  onProgress: (step: 'saving' | 'checking_copy', fraction: number) => void,
): Promise<{ name: string; bytes: number; checksumChecked: boolean }> {
  const total = source.sizeBytes;
  const url = source.url;
  const writable = await handle.createWritable();
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new ApiError(response.status, 'download_failed', `HTTP ${response.status}`);
    }
    const report = throttled((f) => onProgress('saving', f));
    const reader = response.body.getReader();
    let written = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      written += value.length;
      report(total > 0 ? Math.min(written / total, 0.999) : 0);
    }
    await writable.close();
    onProgress('saving', 1);
  } catch (err) {
    await writable.abort().catch(() => undefined);
    throw err;
  }
  // Read it back from where it was saved.
  const discard = async (reason: 'size' | 'checksum'): Promise<never> => {
    const remove = (handle as unknown as { remove?: () => Promise<void> }).remove;
    if (typeof remove === 'function') await remove.call(handle).catch(() => undefined);
    throw new CopyMismatchError(reason);
  };
  const saved = await handle.getFile();
  if (total > 0 && saved.size !== total) await discard('size');
  let checksumChecked = false;
  if (source.sha256) {
    const sha = new Sha256();
    const report = throttled((f) => onProgress('checking_copy', f));
    const reader = saved.stream().getReader();
    let read = 0;
    let lastBreath = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sha.update(value);
      read += value.length;
      report(saved.size > 0 ? Math.min(read / saved.size, 0.999) : 0);
      // Hashing keeps the window busy; without a pause the bar would stand still until the end.
      if (Date.now() - lastBreath > 30) {
        await breathe();
        lastBreath = Date.now();
      }
    }
    if (sha.digestHex() !== source.sha256) await discard('checksum');
    checksumChecked = true;
  }
  onProgress('checking_copy', 1);
  return { name: saved.name, bytes: saved.size, checksumChecked };
}

/**
 * Saves a file of the server as an ordinary download (the Downloads folder), with a percentage:
 * the file is read piece by piece and handed to the window when it is complete. This is the way
 * every download of the Admin works in the desktop app. A file too large to hold in memory
 * follows the link instead, and the browser's own download takes over (no percentage here then).
 */
export async function downloadUrlWithProgress(
  source: { url: string; sizeBytes: number; fileName: string; type: string },
  onProgress: (fraction: number) => void,
): Promise<void> {
  const click = (href: string) => {
    const a = document.createElement('a');
    a.href = href;
    a.download = source.fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  if (source.sizeBytes > HELD_DOWNLOAD_LIMIT_BYTES) {
    click(source.url);
    onProgress(1);
    return;
  }
  const response = await fetch(source.url);
  if (!response.ok || !response.body) {
    throw new ApiError(response.status, 'download_failed', `HTTP ${response.status}`);
  }
  const report = throttled(onProgress);
  const reader = response.body.getReader();
  const pieces: BlobPart[] = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pieces.push(value);
    read += value.length;
    report(source.sizeBytes > 0 ? Math.min(read / source.sizeBytes, 0.999) : 0);
  }
  if (source.sizeBytes > 0 && read !== source.sizeBytes) {
    throw new CopyMismatchError('size');
  }
  const href = URL.createObjectURL(new Blob(pieces, { type: source.type }));
  click(href);
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  onProgress(1);
}

/**
 * The largest file a FAT32 disk can hold (4 GB less one byte). Most USB sticks are sold as FAT32,
 * and Windows only says "the file is too large" when the copy is tried.
 */
export const FAT32_FILE_LIMIT_BYTES = 4 * 1024 ** 3 - 1;

/** True when a backup of this size cannot be copied to a FAT32 USB stick. */
export function tooLargeForFat32(sizeBytes: number | null | undefined): boolean {
  return typeof sizeBytes === 'number' && sizeBytes > FAT32_FILE_LIMIT_BYTES;
}
