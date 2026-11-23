/**
 * «Skedar për AI» (0.39.0): every figure of the business in one JSON file and/or one text file,
 * made in the background with a percentage to follow.
 *
 * The whole file is read inside ONE read-only transaction that sees one moment of the database
 * (repeatable read): the shop keeps selling while the file is made, and still the totals at the
 * top are exactly the sum of the rows below them. The reports the totals come from read through
 * the same transaction. Every table is counted first and read through a cursor afterwards; the
 * two numbers must match, or the job fails rather than hand over a file that misses rows.
 *
 * The files are written into a folder of their own under the data folder, kept for an hour (at
 * most three exports) and deleted when the server starts: they hold the business in plain text.
 * They are not part of a backup.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  DATA_EXPORT_DEFAULT_PARTS,
  DATA_EXPORT_PARTS,
  type DataExportFile,
  type DataExportFormat,
  type DataExportJobStatus,
  type DataExportPart,
  type DataExportPhase,
  type DataExportRequest,
  type DataExportResult,
  type DataExportSection,
} from '@likapcs/shared';
import type { DbClient, DbPool } from '../../db/pool.js';
import { AppError, notFound } from '../../errors.js';
import { recordAudit, type AuditActor } from '../audit.js';
import { CashService } from '../cash.js';
import { ReportsService } from '../reports.js';
import type { SettingsService } from '../settings.js';
import { ExportDocument, FileSink, l, type Fact } from './document.js';
import { guide } from './labels.js';
import { SECTIONS, countRows, readRows, type ExportContext, type SerialDb } from './sections.js';
import { writeSummary } from './summary.js';

/**
 * The folder under the data folder where finished files wait to be saved. A name of its own:
 * what is in it is deleted without asking.
 */
export const DATA_EXPORT_FOLDER = 'ai-file-tmp';
/** A job's folder is named by its id; nothing else in the folder is ever touched. */
const JOB_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How long the server keeps the files of an export, and how many exports at most. */
export const DATA_EXPORT_KEEP_MS = 60 * 60 * 1000;
/** How often the removal of a folder is tried again later (every half minute). */
const REMOVE_ATTEMPTS = 10;
const KEEP_COUNT = 3;
/**
 * Version of the layout of the file itself (stated inside it).
 *   2 (0.39.1): «Sipas produktit» lists every product, with margin and stock; the new table
 *     «Stoku tani sipas produktit»; the stock state in words; «Gjendja tani» counts by it.
 *   3 (0.40.0): the line of a product that stood on a PC's bill says when it was put there
 *     («Shtuar në faturën e PC-së»); a sentence of the guide explains it.
 */
const FILE_FORMAT_VERSION = 3;
/**
 * Share of the loading bar: counting the rows, the summary, the tables, closing the files. The
 * summary's share inside the middle part follows the size of the data (see `summaryUnits`).
 */
const COUNTING_PERCENT = 3;
const FINISHING_PERCENT = 2;
/** Queries the summary runs (the reports' and its own); only paces the bar inside that step. */
const SUMMARY_QUERIES = 44;

export interface DataExportOptions {
  /** Folder the files are written to (`<data>/ai-file-tmp`, see `DATA_EXPORT_FOLDER`). */
  dir: string;
  version: string;
  log?: FastifyBaseLogger;
  /** How long the files are kept (an hour; the tests use a moment). */
  keepMs?: number;
  /** How long until a folder that could not be removed is tried again (30 s). */
  retryRemoveMs?: number;
  /**
   * Called once the rows are counted — the snapshot of the database is fixed by then. The tests
   * make a sale here to prove that the file does not see what happens while it is written.
   */
  onSnapshot?: () => Promise<void>;
}

export interface DataExportActor extends AuditActor {
  /** Name written into the file as the one who made it. */
  name: string;
}

interface Job {
  status: DataExportJobStatus;
  dir: string;
  files: Map<DataExportFormat, { path: string; fileName: string; sizeBytes: number }>;
  /** The owner gave it up while it ran (closed the window, or pressed «Anulo»). */
  cancelled: boolean;
  /** Stops the reading at the next query; set while the job reads. */
  stop?: () => void;
}

const cancelledError = (): AppError =>
  new AppError(409, 'EXPORT_CANCELLED', 'The data file was cancelled');

/** The connection of the snapshot, asked one query at a time. */
export interface StoppableDb extends SerialDb {
  /** From now on every query is refused with `reason`, without reaching the database. */
  stop(reason: Error): void;
  /** Resolves once the query that is running (if any) has ended and the queue is empty. */
  idle(): Promise<void>;
}

/**
 * One query at a time on one connection: `Promise.all` in the reports then simply queues.
 *
 * It can be stopped: a cancelled or failed job must not leave queries behind that would still
 * run on the connection after it went back to the pool — queued ones are refused where they
 * stand, and `idle()` waits for the one already under way.
 */
export function serialDb(
  client: Pick<DbClient, 'query'>,
  onQuery: () => void = () => undefined,
): StoppableDb {
  let tail: Promise<unknown> = Promise.resolve();
  let stopped: Error | null = null;
  return {
    query: (text: string, values?: unknown[]) => {
      const run = tail.then(() => {
        if (stopped) throw stopped;
        return client.query(text, values);
      });
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run.then((result) => {
        onQuery();
        return result;
      }) as ReturnType<SerialDb['query']>;
    },
    stop: (reason: Error) => {
      stopped ??= reason;
    },
    idle: () => tail.then(() => undefined),
  } as StoppableDb;
}

const describeError = (err: unknown): { code: string; message: string } => {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOSPC') {
    return { code: 'NOT_ENOUGH_SPACE', message: 'There is not enough free space on the disk' };
  }
  return { code: 'EXPORT_FAILED', message: err instanceof Error ? err.message : String(err) };
};

export class DataExportService {
  private readonly jobs = new Map<string, Job>();
  private running = false;

  constructor(
    private readonly pool: DbPool,
    private readonly settings: SettingsService,
    private readonly options: DataExportOptions,
  ) {}

  /**
   * Removes what an earlier run of the server left behind (its jobs are gone with it): the
   * folders of jobs, known by their names. Anything else that somebody put there stays.
   */
  async clearLeftovers(): Promise<void> {
    const entries = await fsp.readdir(this.options.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !JOB_FOLDER.test(entry.name)) continue;
      await this.removeDir(path.join(this.options.dir, entry.name));
    }
  }

  /** Starts an export in the background and returns at once with the job to follow. */
  start(input: DataExportRequest, actor: DataExportActor): DataExportJobStatus {
    if (this.running) {
      throw new AppError(409, 'EXPORT_BUSY', 'A data file is already being made');
    }
    void this.prune();
    const id = crypto.randomUUID();
    const job: Job = {
      status: {
        id,
        state: 'running',
        percent: 0,
        phase: 'starting',
        current: null,
        total: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        result: null,
      },
      dir: path.join(this.options.dir, id),
      files: new Map(),
      cancelled: false,
    };
    this.jobs.set(id, job);
    this.running = true;
    void this.run(job, input, actor)
      .then((result) => {
        // Given up while the very last step ran: it ends as cancelled, like any other moment.
        if (job.cancelled) throw cancelledError();
        job.status.result = result;
        job.status.percent = 100;
        job.status.state = 'succeeded';
      })
      .catch(async (err: unknown) => {
        const error = describeError(err);
        if (error.code === 'EXPORT_CANCELLED') {
          this.options.log?.info({ jobId: id }, 'data export cancelled');
        } else {
          this.options.log?.error({ err, jobId: id }, 'data export failed');
        }
        // The files go first: the job counts as ended only when nothing of it is left.
        await this.removeDir(job.dir);
        job.status.error = error;
        job.status.state = 'failed';
      })
      .finally(() => {
        job.status.finishedAt = new Date().toISOString();
        this.running = false;
        // The files hold the business in plain text: gone after an hour, saved or not.
        const timer = setTimeout(() => {
          if (this.jobs.get(id) !== job) return;
          this.jobs.delete(id);
          void this.removeDir(job.dir);
        }, this.options.keepMs ?? DATA_EXPORT_KEEP_MS);
        timer.unref();
      });
    return { ...job.status };
  }

  job(id: string): DataExportJobStatus {
    const job = this.jobs.get(id);
    if (!job) throw notFound('Job');
    return { ...job.status };
  }

  /** One finished file, to send. 404 once the export was deleted or has expired. */
  file(
    id: string,
    format: DataExportFormat,
  ): { path: string; fileName: string; sizeBytes: number } {
    const job = this.jobs.get(id);
    const file = job?.status.state === 'succeeded' ? job.files.get(format) : undefined;
    if (!file || !fs.existsSync(file.path)) throw notFound('Data file');
    return file;
  }

  /**
   * Deletes the files of one export now (the owner has saved them). An export that is still
   * being made is cancelled instead: it stops at its next query — within a moment — and ends as
   * failed with `EXPORT_CANCELLED`, with nothing left on the disk.
   */
  async delete(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw notFound('Job');
    if (job.status.state === 'running') {
      job.cancelled = true;
      job.stop?.();
      return;
    }
    this.jobs.delete(id);
    await this.removeDir(job.dir);
  }

  /**
   * Removes the folder of a job with what is in it. Never throws. Windows refuses to remove a
   * file that something still holds open (a download under way, a virus scanner): the files
   * hold the business in plain text, so it is tried again until it is gone — a few times at
   * once, then every half minute for five minutes. What is left after that goes at the next
   * start of the server.
   */
  private async removeDir(dir: string, attempt = 0): Promise<void> {
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    } catch (err) {
      if (attempt >= REMOVE_ATTEMPTS) {
        this.options.log?.warn({ err, dir }, 'data export: the folder could not be removed');
        return;
      }
      const timer = setTimeout(
        () => void this.removeDir(dir, attempt + 1),
        this.options.retryRemoveMs ?? 30_000,
      );
      timer.unref();
    }
  }

  /** Forgets exports older than an hour and keeps at most three, with their files. */
  private async prune(): Promise<void> {
    const now = Date.now();
    const finished = [...this.jobs.entries()]
      .filter(([, job]) => job.status.state !== 'running')
      .sort(
        ([, a], [, b]) =>
          Date.parse(b.status.finishedAt ?? b.status.startedAt) -
          Date.parse(a.status.finishedAt ?? a.status.startedAt),
      );
    for (const [index, [id, job]] of finished.entries()) {
      const age = now - Date.parse(job.status.finishedAt ?? job.status.startedAt);
      // `KEEP_COUNT - 1`: the export about to start is the newest one.
      if (age <= (this.options.keepMs ?? DATA_EXPORT_KEEP_MS) && index < KEEP_COUNT - 1) continue;
      this.jobs.delete(id);
      await this.removeDir(job.dir);
    }
  }

  private async run(
    job: Job,
    input: DataExportRequest,
    actor: DataExportActor,
  ): Promise<DataExportResult> {
    const status = job.status;
    const formats = [...new Set(input.formats)];
    const chosen = new Set<DataExportPart>(input.parts ?? DATA_EXPORT_DEFAULT_PARTS);
    const parts = DATA_EXPORT_PARTS.filter((part) => chosen.has(part));
    const missingParts = DATA_EXPORT_PARTS.filter((part) => !chosen.has(part) && part !== 'audit');
    const sections = SECTIONS.filter((section) => chosen.has(section.part));
    const lang = input.language;

    await fsp.mkdir(job.dir, { recursive: true });
    const client = await this.pool.connect();
    const sinks: FileSink[] = [];
    let summaryQueries = 0;
    let inSummary = false;
    // The bar: units done out of all units, between the counting and the finishing shares.
    let doneUnits = 0;
    let totalUnits = 1;
    let summaryUnits = 0;
    const setPercent = () => {
      const span = 100 - COUNTING_PERCENT - FINISHING_PERCENT;
      const percent = COUNTING_PERCENT + (span * Math.min(doneUnits, totalUnits)) / totalUnits;
      status.percent = Math.max(status.percent, Math.min(99, Math.floor(percent * 10) / 10));
    };
    const db = serialDb(client, () => {
      if (!inSummary) return;
      summaryQueries += 1;
      doneUnits = summaryUnits * Math.min(1, summaryQueries / SUMMARY_QUERIES);
      setPercent();
    });
    job.stop = () => db.stop(cancelledError());
    const stopIfCancelled = () => {
      if (job.cancelled) throw cancelledError();
    };

    try {
      stopIfCancelled();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const [timeZone, currency, business] = await Promise.all([
        this.settings.get('locale.timezone'),
        this.settings.get('locale.currency'),
        this.settings.get('business.name'),
      ]);
      const clock = await db.query<{ today: string; now: string }>(
        `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS today,
                to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS now`,
        [timeZone],
      );
      const { today, now } = clock.rows[0]!;
      const wholeHistory = input.from === undefined || input.to === undefined;
      const from = wholeHistory ? ((await this.firstDay(db, timeZone)) ?? today) : input.from!;
      const to = wholeHistory ? today : input.to!;
      const ctx: ExportContext = {
        db,
        from,
        to,
        timeZone,
        lang,
        hideCustomers: input.hideCustomers,
      };

      // 1. Count every table: the bar's scale, and the check at the end.
      status.phase = 'counting';
      const expected = new Map<DataExportSection, number>();
      for (const [index, section] of sections.entries()) {
        expected.set(section.id, await countRows(ctx, section));
        status.percent = Math.max(
          status.percent,
          Math.floor(((index + 1) / sections.length) * COUNTING_PERCENT * 10) / 10,
        );
      }
      await this.options.onSnapshot?.();
      stopIfCancelled();
      const totalRows = [...expected.values()].reduce((a, b) => a + b, 0);
      const tableUnits = sections.reduce(
        (sum, section) => sum + (expected.get(section.id) ?? 0) * section.weight,
        0,
      );
      // The summary reads the sales and their lines about ten times over (measured: about a
      // sixth of the whole on a year of sales), and takes a moment even on an empty shop.
      summaryUnits = Math.max(200, Math.round(tableUnits * 0.2));
      totalUnits = summaryUnits + tableUnits;
      status.current = 0;
      status.total = totalRows;

      // 2. Open the files.
      const stem = `LIKApcs-AI-${from}_${to}`;
      const open = (format: DataExportFormat): FileSink | null => {
        if (!formats.includes(format)) return null;
        const sink = new FileSink(path.join(job.dir, `${stem}.${format}.part`));
        sinks.push(sink);
        return sink;
      };
      const jsonSink = open('json');
      const txtSink = open('txt');
      const doc = new ExportDocument(lang, jsonSink, txtSink);

      const title =
        lang === 'sq'
          ? [
              `LIKApcs — të dhënat e biznesit «${business}»`,
              `Periudha: ${from} deri ${to}   Bërë më: ${now}`,
            ]
          : [
              `LIKApcs — business data of "${business}"`,
              `Period: ${from} to ${to}   Made at: ${now}`,
            ];
      await doc.begin(title);
      const fileFacts: Fact[] = [
        { label: l('Programi', 'Program'), value: `LIKApcs ${this.options.version}` },
        { label: l('Biznesi', 'Business'), value: business },
        { label: l('Nga data', 'From'), value: from },
        { label: l('Deri më datën', 'To'), value: to },
        { label: l('Gjithë historia', 'Whole history'), kind: 'bool', value: wholeHistory },
        { label: l('Bërë më', 'Made at'), value: now },
        { label: l('Bërë nga', 'Made by'), value: actor.name },
        { label: l('Zona kohore', 'Time zone'), value: timeZone },
        { label: l('Monedha', 'Currency'), value: currency },
        {
          label: l('Klientët e fshehur', 'Customers hidden'),
          kind: 'bool',
          value: input.hideCustomers,
        },
        {
          label: l('Versioni i formatit', 'Format version'),
          kind: 'int',
          value: FILE_FORMAT_VERSION,
        },
      ];
      await doc.facts(l('Skedari', 'File'), fileFacts);
      await doc.note(
        l('Si lexohet', 'How to read it'),
        guide({
          lang,
          business,
          from,
          to,
          wholeHistory,
          timeZone,
          currency,
          hideCustomers: input.hideCustomers,
          missingParts,
        }),
      );
      const specs = new Map(sections.map((section) => [section.id, section.spec(ctx)] as const));
      if (sections.length > 0) {
        await doc.facts(
          l('Çfarë ka skedari (rreshta për tabelë)', 'What the file holds (rows per table)'),
          sections.map((section) => ({
            label: specs.get(section.id)!.title,
            kind: 'int' as const,
            value: expected.get(section.id) ?? 0,
          })),
        );
      }

      // 3. The summary, read through the same snapshot as everything else.
      status.phase = 'summary';
      inSummary = true;
      const snapshotPool = { query: db.query } as unknown as DbPool;
      const reports = new ReportsService(
        snapshotPool,
        new CashService(snapshotPool, this.settings),
        this.settings,
      );
      await writeSummary(ctx, doc, reports);
      inSummary = false;
      doneUnits = summaryUnits;
      setPercent();

      // 4. The tables.
      const counts: Partial<Record<DataExportSection, number>> = {};
      let rowsDone = 0;
      for (const section of sections) {
        status.phase = section.id as DataExportPhase;
        const written = await doc.table(specs.get(section.id)!, readRows(ctx, section), (rows) => {
          rowsDone += rows;
          doneUnits += rows * section.weight;
          status.current = rowsDone;
          setPercent();
        });
        if (written !== expected.get(section.id)) {
          throw new AppError(
            500,
            'EXPORT_INCOMPLETE',
            `Table ${section.id}: ${written} rows written, ${expected.get(section.id)} counted`,
          );
        }
        counts[section.id] = written;
      }

      // 5. Close the files; they get their real names only when they are complete.
      status.phase = 'finishing';
      await doc.end();
      await client.query('COMMIT');
      const files: DataExportFile[] = [];
      for (const format of formats) {
        const sink = format === 'json' ? jsonSink! : txtSink!;
        const { bytes, sha256 } = await sink.close();
        const fileName = `${stem}.${format}`;
        const target = path.join(job.dir, fileName);
        await fsp.rename(sink.path, target);
        job.files.set(format, { path: target, fileName, sizeBytes: bytes });
        files.push({ format, fileName, sizeBytes: bytes, sha256 });
      }
      status.percent = Math.max(status.percent, 99);
      // Given up in the last moment: the caller no longer waits for these files.
      stopIfCancelled();

      const createdAt = new Date();
      const result: DataExportResult = {
        id: status.id,
        from,
        to,
        wholeHistory,
        parts,
        hideCustomers: input.hideCustomers,
        language: lang,
        counts,
        totalRows,
        files,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(
          createdAt.getTime() + (this.options.keepMs ?? DATA_EXPORT_KEEP_MS),
        ).toISOString(),
      };
      // Who took the whole business out of the program, and when.
      await recordAudit(this.pool, actor, {
        action: 'report.data_file',
        entityType: 'report',
        severity: 'warning',
        details: {
          from,
          to,
          wholeHistory,
          formats,
          parts,
          hideCustomers: input.hideCustomers,
          rows: totalRows,
          sizeBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
        },
      }).catch((err: unknown) =>
        this.options.log?.error({ err }, 'data export: audit entry failed'),
      );
      return result;
    } catch (err) {
      // The files are closed before the caller removes them.
      await Promise.all(sinks.map((sink) => sink.abort()));
      // Nothing of this job may still run on the connection once it is back in the pool.
      db.stop(err instanceof Error ? err : new Error(String(err)));
      await db.idle();
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      job.stop = undefined;
      client.release();
    }
  }

  /** The first day anything happened, for «the whole history». */
  private async firstDay(db: SerialDb, timeZone: string): Promise<string | null> {
    const result = await db.query<{ d: string | null }>(
      `SELECT to_char(MIN(t) AT TIME ZONE $1, 'YYYY-MM-DD') AS d FROM (
         SELECT MIN(created_at) AS t FROM sales
         UNION ALL SELECT MIN(started_at) FROM gaming_sessions
         UNION ALL SELECT MIN(opened_at) FROM cash_shifts
         UNION ALL SELECT MIN(created_at) FROM inventory_movements
         UNION ALL SELECT MIN(expense_date)::timestamp AT TIME ZONE $1 FROM expenses
         UNION ALL SELECT MIN(order_date)::timestamp AT TIME ZONE $1 FROM purchases
       ) x`,
      [timeZone],
    );
    return result.rows[0]?.d ?? null;
  }
}
