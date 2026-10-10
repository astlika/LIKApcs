import fs from 'node:fs';
import path from 'node:path';

/**
 * Start-up progress of the server process, written to `<data dir>/startup.json`.
 *
 * The Admin app on the main PC launches the server as a detached process and cannot see its
 * stdout. It polls this file while it waits for the health endpoint, so the "Starting LIKApcs
 * server…" screen can show *what* is happening (first-run database initialisation, crash recovery,
 * migrations) and — when something goes wrong — the real error immediately instead of a generic
 * timeout a minute and a half later.
 */
export type StartupPhase =
  | 'starting' // process booted, reading configuration
  | 'database-init' // first run: initdb
  | 'database-start' // pg_ctl start / waiting for connections (includes crash recovery)
  | 'database-repair' // automatic password repair of the embedded role
  | 'migrations' // schema check / pending migrations
  | 'listening' // HTTP server up — the health endpoint answers from here on
  | 'failed';

export interface StartupState {
  phase: StartupPhase;
  detail: string | null;
  error: string | null;
  pid: number;
  version: string;
  startedAt: string;
  updatedAt: string;
  /** Milliseconds since the process started, for the log and for the Admin's progress screen. */
  elapsedMs: number;
}

export const STARTUP_FILE_NAME = 'startup.json';

export class StartupReporter {
  private readonly file: string;
  private readonly t0 = Date.now();
  private readonly startedAt = new Date().toISOString();
  private phaseSince = Date.now();
  private phase: StartupPhase = 'starting';
  private detail: string | null = null;

  constructor(
    dataDir: string,
    private readonly version: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.file = path.join(dataDir, STARTUP_FILE_NAME);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch {
      /* reported by the first write */
    }
    this.write(null);
  }

  get filePath(): string {
    return this.file;
  }

  /** Moves to the next phase; logs how long the previous one took. */
  set(phase: StartupPhase, detail: string | null = null): void {
    const took = Date.now() - this.phaseSince;
    if (phase !== this.phase) this.log(`${this.phase} done in ${took} ms → ${phase}`);
    this.phase = phase;
    this.detail = detail;
    this.phaseSince = Date.now();
    this.write(null);
  }

  /** Terminal failure: the Admin shows `error` verbatim (plus the log tail). */
  fail(error: string): void {
    this.phase = 'failed';
    this.write(error);
  }

  snapshot(error: string | null): StartupState {
    return {
      phase: this.phase,
      detail: this.detail,
      error,
      pid: process.pid,
      version: this.version,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - this.t0,
    };
  }

  private write(error: string | null): void {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.snapshot(error), null, 2));
      fs.renameSync(tmp, this.file); // atomic replace: readers never see a half-written file
    } catch (err) {
      this.log(`cannot write ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Human-readable hints for Windows exit codes that otherwise look like random negative numbers. */
export function explainExitCode(code: number): string | null {
  switch (code) {
    case -1073741515: // 0xC0000135 STATUS_DLL_NOT_FOUND
      return 'a required DLL is missing (install the Microsoft Visual C++ 2015-2022 x64 Redistributable)';
    case -1073741819: // 0xC0000005 access violation
      return 'the program crashed (access violation) — an antivirus product may be interfering';
    case -1073741502: // 0xC0000142 DLL init failed
      return 'a DLL failed to initialise — try rebooting the PC';
    default:
      return null;
  }
}
