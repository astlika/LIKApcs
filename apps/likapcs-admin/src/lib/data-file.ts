/**
 * «Skedar për AI» (0.39.0): every figure of the business in one JSON and/or text file, made by
 * the server with a percentage and then saved where the owner chooses.
 *
 * The work has two waits, each with its own bar:
 *  1. the server makes the file(s): `startDataFile` → `followDataFile` (percentage from the job);
 *  2. each file is saved: into a place chosen in the "save as" window, where the window has one
 *     — written, then read back and compared with the server's checksum — or as an ordinary
 *     download, read piece by piece so that it too has a percentage.
 */
import {
  DATA_EXPORT_DEFAULT_PARTS,
  type DataExportFile,
  type DataExportJobStarted,
  type DataExportJobStatus,
  type DataExportPart,
  type DataExportRequest,
  type DataExportTicket,
} from '@likapcs/shared';
import { api, ApiError, getServerUrl } from './api';
import { JobLostError, downloadUrlWithProgress, saveUrlTo } from './backup-file';
import { isoDate, presetRange, type DateRange, type RangePreset } from './report-range';

/** The periods the dialog offers; `all` = the whole history, `custom` = two dates. */
export type DataFilePeriod = Exclude<RangePreset, 'custom' | 'week'> | 'last7' | 'all' | 'custom';

/** The dates a period stands for today; null for the whole history. */
export function periodRange(
  period: DataFilePeriod,
  custom: DateRange,
  now: Date = new Date(),
): DateRange | null {
  if (period === 'all') return null;
  if (period === 'custom') return custom;
  if (period === 'last7') {
    const from = new Date(now);
    from.setDate(from.getDate() - 6);
    return { from: isoDate(from), to: isoDate(now) };
  }
  return presetRange(period, now);
}

/** True when the dates can be sent: both there, in order. The whole history always can. */
export function rangeIsValid(range: DateRange | null): boolean {
  if (range === null) return true;
  const date = /^\d{4}-\d{2}-\d{2}$/;
  return date.test(range.from) && date.test(range.to) && range.from <= range.to;
}

export const ALL_DETAIL_PARTS: readonly DataExportPart[] = DATA_EXPORT_DEFAULT_PARTS;

/**
 * A file larger than this is flagged in the dialog: an AI reads a limited amount of text at
 * once, and what does not fit is skipped or summarised. The figure is a cautious round number,
 * not a limit of any one AI.
 */
export const LARGE_FOR_AI_BYTES = 1024 * 1024;

export async function startDataFile(body: DataExportRequest): Promise<string> {
  const started = await api<DataExportJobStarted>('/reports/data-file', { method: 'POST', body });
  return started.jobId;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Follows the job to its end and reports every answer. Resolves with the final status (succeeded
 * or failed); throws `JobLostError` when the server no longer knows the job or gives no answer
 * for about a minute.
 *
 * `patienceMs` may be a function: it is asked at every missing answer, so the wait can be cut
 * short while the job runs (after «Anulo» nobody wants to wait a minute for a silent server).
 */
export async function followDataFile(
  jobId: string,
  onStatus: (status: DataExportJobStatus) => void,
  options: { intervalMs?: number; patienceMs?: number | (() => number) } = {},
): Promise<DataExportJobStatus> {
  const interval = options.intervalMs ?? 300;
  const patience = (): number =>
    typeof options.patienceMs === 'function'
      ? options.patienceMs()
      : (options.patienceMs ?? 60_000);
  let silentSince: number | null = null;
  for (;;) {
    let status: DataExportJobStatus | null = null;
    try {
      status = await api<DataExportJobStatus>(`/reports/data-file/jobs/${jobId}`);
      silentSince = null;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        throw new JobLostError();
      }
      silentSince ??= Date.now();
      if (Date.now() - silentSince > patience()) throw new JobLostError();
    }
    if (status) {
      onStatus(status);
      if (status.state !== 'running') return status;
    }
    await sleep(status ? interval : Math.max(interval, 1000));
  }
}

/** A link that opens one file without the sign-in header (valid for a few minutes). */
async function dataFileUrl(exportId: string, file: DataExportFile): Promise<string> {
  const base = `/reports/data-file/${exportId}/${file.format}/download`;
  const { ticket } = await api<DataExportTicket>(`${base}-ticket`, { method: 'POST', body: {} });
  return `${getServerUrl()}/api/v1${base}?ticket=${encodeURIComponent(ticket)}`;
}

/** Share of a file's own bar: writing it, then reading the copy back. */
const SAVE_SHARES = { saving: 70, checking: 30 } as const;
/** From this percentage on the saved copy is being read back. */
export const SAVE_CHECK_FROM_PERCENT = SAVE_SHARES.saving;

export function savePercent(step: 'saving' | 'checking_copy', fraction: number): number {
  const f = Math.max(0, Math.min(1, fraction));
  return step === 'saving'
    ? Math.floor(f * SAVE_SHARES.saving)
    : Math.min(99, Math.floor(SAVE_SHARES.saving + f * SAVE_SHARES.checking));
}

/**
 * Writes one file where the owner chose and reads it back: its size and checksum must be the
 * server's. `onPercent` runs 0–99; the caller shows 100 when this resolves.
 */
export async function saveDataFileTo(
  handle: FileSystemFileHandle,
  exportId: string,
  file: DataExportFile,
  onPercent: (percent: number) => void,
): Promise<{ name: string; checked: boolean }> {
  const url = await dataFileUrl(exportId, file);
  const saved = await saveUrlTo(
    handle,
    { url, sizeBytes: file.sizeBytes, sha256: file.sha256 },
    (step, fraction) => onPercent(savePercent(step, fraction)),
  );
  return { name: saved.name, checked: saved.checksumChecked };
}

const MIME = { json: 'application/json', txt: 'text/plain' } as const;

/** Saves one file as an ordinary download, with a percentage while it is read. */
export async function downloadDataFile(
  exportId: string,
  file: DataExportFile,
  onPercent: (percent: number) => void,
): Promise<void> {
  const url = await dataFileUrl(exportId, file);
  await downloadUrlWithProgress(
    { url, sizeBytes: file.sizeBytes, fileName: file.fileName, type: MIME[file.format] },
    (fraction) => onPercent(Math.min(99, Math.floor(fraction * 100))),
  );
}

/** Tells the server to delete its copy of the files now (it would after an hour anyway). */
export async function deleteDataFile(exportId: string): Promise<void> {
  await api(`/reports/data-file/${exportId}`, { method: 'DELETE' }).catch(() => undefined);
}
