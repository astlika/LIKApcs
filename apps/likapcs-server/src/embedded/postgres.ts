import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { isWindows } from './paths.js';
import { explainExitCode } from './startup-state.js';

/**
 * Manages a private PostgreSQL instance from portable binaries: initdb on first run, start/stop
 * through pg_ctl, readiness checks and database creation. It listens on 127.0.0.1 only and uses a
 * generated password, so nothing but this server can reach it. Crash recovery is PostgreSQL's own.
 */
export interface EmbeddedPostgresOptions {
  binDir: string;
  dataDir: string;
  /** Preferred port; when another program holds it a free one is used for this run instead. */
  port: number;
  user: string;
  password: string;
  database: string;
  logFile: string;
  /** Called with human-readable progress (startup log). */
  log?: (message: string) => void;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Phases reported to the start-up progress file (see startup-state.ts). */
export type EmbeddedPhase = 'database-init' | 'database-start' | 'database-repair';

/** Codes PostgreSQL returns while it is up but refuses our credentials — retrying is pointless. */
const AUTH_ERROR_CODES = new Set(['28P01', '28000']);

export class EmbeddedPostgres {
  /** The port the cluster actually listens on (may differ from `opts.port`, see `start`). */
  private port: number;
  private repaired = false;

  constructor(
    private readonly opts: EmbeddedPostgresOptions,
    private readonly onPhase: (phase: EmbeddedPhase, detail?: string) => void = () => undefined,
  ) {
    this.port = opts.port;
  }

  get listenPort(): number {
    return this.port;
  }

  private bin(name: string): string {
    return path.join(this.opts.binDir, isWindows() ? `${name}.exe` : name);
  }

  private info(message: string): void {
    this.opts.log?.(message);
  }

  /** Runs a PostgreSQL utility and captures its output (never inherits stdio: no console windows). */
  run(name: string, args: string[], timeoutMs = 120_000): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin(name), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PGPASSWORD: '', LC_ALL: 'C' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${name} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const hint = code != null && code !== 0 ? explainExitCode(code) : null;
        resolve({ code: code ?? -1, stdout, stderr: hint ? `${stderr}\n${hint}`.trim() : stderr });
      });
    });
  }

  isInitialized(): boolean {
    return fs.existsSync(path.join(this.opts.dataDir, 'PG_VERSION'));
  }

  /** Creates the cluster on first run (scram-sha-256 auth, UTF-8, C locale for deterministic sorting). */
  async ensureInitialized(): Promise<boolean> {
    if (this.isInitialized()) return false;
    this.onPhase('database-init');
    this.info('initialising database cluster');
    fs.mkdirSync(path.dirname(this.opts.dataDir), { recursive: true });
    const pwFile = path.join(os.tmpdir(), `likapcs-pw-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(pwFile, this.opts.password + '\n', { mode: 0o600 });
    try {
      const result = await this.run('initdb', [
        '-D',
        this.opts.dataDir,
        '-U',
        this.opts.user,
        `--pwfile=${pwFile}`,
        '--auth=scram-sha-256',
        '--encoding=UTF8',
        '--locale=C',
        '--no-instructions',
      ]);
      if (result.code !== 0) {
        throw new Error(`initdb failed (${result.code}): ${result.stderr || result.stdout}`);
      }
    } finally {
      fs.rmSync(pwFile, { force: true });
    }
    return true;
  }

  private serverOptions(): string {
    const settings = [
      `-p ${this.port}`,
      '-c listen_addresses=127.0.0.1',
      '-c max_connections=40',
      '-c shared_buffers=128MB',
      // Frequent, cheap checkpoints keep crash recovery short when Windows shuts the PC down
      // without stopping the server (the whole database is a few MB).
      '-c checkpoint_timeout=2min',
      '-c log_min_messages=warning',
      '-c log_timezone=UTC',
      '-c timezone=UTC',
    ];
    if (!isWindows()) settings.push(`-c unix_socket_directories=${this.opts.dataDir}`);
    return settings.join(' ');
  }

  async status(): Promise<'running' | 'stopped'> {
    const result = await this.run('pg_ctl', ['status', '-D', this.opts.dataDir], 30_000);
    // pg_ctl status exit codes: 0 running, 3 not running, 4 no accessible data directory
    return result.code === 0 ? 'running' : 'stopped';
  }

  /**
   * postmaster.pid of a live cluster: line 1 pid, line 4 port. Returns the port when the process
   * exists, otherwise null (no file, dead process, unreadable).
   */
  private livePostmaster(): { pid: number; port: number } | null {
    try {
      const lines = fs
        .readFileSync(path.join(this.opts.dataDir, 'postmaster.pid'), 'utf8')
        .split(/\r?\n/);
      const pid = Number.parseInt(lines[0] ?? '', 10);
      const port = Number.parseInt(lines[3] ?? '', 10);
      if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(port) || port <= 0) return null;
      process.kill(pid, 0); // throws when the process does not exist
      return { pid, port };
    } catch {
      return null;
    }
  }

  /** True when something accepts TCP connections on 127.0.0.1:port. */
  private static portOpen(port: number, timeoutMs = 400): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = (open: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  }

  private static freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
      });
    });
  }

  /**
   * Starts the cluster (idempotent) and waits until it accepts connections.
   *
   * Fast path first: a live postmaster.pid whose port answers means the database survived (for
   * example only the Node process was restarted) — no pg_ctl round trip at all. Otherwise the
   * preferred port is checked; when another program occupies it a free port is used for this run,
   * so a port clash can never keep the POS from starting.
   */
  async start(): Promise<void> {
    this.onPhase('database-start');
    const t0 = Date.now();
    const live = this.livePostmaster();
    if (live && (await EmbeddedPostgres.portOpen(live.port))) {
      this.port = live.port;
      this.info(`database already running (pid ${live.pid}, port ${live.port})`);
    } else {
      this.cleanStalePidFile();
      fs.mkdirSync(path.dirname(this.opts.logFile), { recursive: true });
      if (await EmbeddedPostgres.portOpen(this.port)) {
        const alternative = await EmbeddedPostgres.freePort();
        this.info(`port ${this.port} is used by another program — using ${alternative}`);
        this.port = alternative;
      }
      const result = await this.run('pg_ctl', [
        'start',
        '-D',
        this.opts.dataDir,
        '-w',
        '-t',
        '90',
        '-l',
        this.opts.logFile,
        '-o',
        this.serverOptions(),
      ]);
      if (result.code !== 0) {
        throw new Error(
          `PostgreSQL did not start (${result.code}): ${(result.stderr || result.stdout).trim()} — see ${this.opts.logFile}`,
        );
      }
    }
    await this.waitUntilReady(60_000);
    this.info(`database ready in ${Date.now() - t0} ms`);
  }

  /**
   * The embedded role's password lives in config.json next to the cluster. Should the two ever
   * disagree (config.json restored from elsewhere, recreated by hand, …) the server would be locked
   * out of its own database forever. Since we own the cluster we repair it: stop, set the password
   * in single-user mode (no authentication), start again. Done at most once per process.
   */
  private async repairPassword(): Promise<void> {
    if (this.repaired) throw new Error('database password repair did not help');
    this.repaired = true;
    this.onPhase('database-repair');
    this.info('database refuses our credentials — repairing the role password');
    await this.stop();
    const escaped = this.opts.password.replace(/'/g, "''");
    const role = this.opts.user.replace(/"/g, '""');
    const sql = `ALTER ROLE "${role}" WITH PASSWORD '${escaped}';\n`;
    const result = await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(this.bin('postgres'), ['--single', '-D', this.opts.dataDir, 'postgres'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('single-user postgres timed out'));
      }, 60_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.stdin.end(sql);
    });
    if (result.code !== 0) {
      throw new Error(
        `password repair failed (${result.code}): ${(result.stderr || result.stdout).trim()}`,
      );
    }
    await this.start();
  }

  /** Stops the cluster gracefully ("fast": active transactions are rolled back, data is flushed). */
  async stop(): Promise<void> {
    if (!this.livePostmaster() && (await this.status()) !== 'running') return;
    const result = await this.run('pg_ctl', [
      'stop',
      '-D',
      this.opts.dataDir,
      '-m',
      'fast',
      '-w',
      '-t',
      '60',
    ]);
    if (result.code !== 0) {
      throw new Error(
        `PostgreSQL did not stop (${result.code}): ${(result.stderr || result.stdout).trim()}`,
      );
    }
  }

  /** After a crash a postmaster.pid can be left behind; PostgreSQL usually recovers but we help it. */
  private cleanStalePidFile(): void {
    const pidFile = path.join(this.opts.dataDir, 'postmaster.pid');
    if (!fs.existsSync(pidFile)) return;
    try {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').split(/\r?\n/)[0] ?? '', 10);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // throws when the process does not exist
          return; // alive → leave it to pg_ctl
        } catch {
          /* dead */
        }
      }
      fs.rmSync(pidFile, { force: true });
      this.info('removed stale postmaster.pid');
    } catch {
      /* ignore */
    }
  }

  adminConnectionString(database = 'postgres'): string {
    const { user, password } = this.opts;
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${this.port}/${database}`;
  }

  connectionString(): string {
    return this.adminConnectionString(this.opts.database);
  }

  private async waitUntilReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      const client = new Client({
        connectionString: this.adminConnectionString(),
        connectionTimeoutMillis: 3000,
      });
      try {
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await client.end().catch(() => undefined);
        const code = (err as { code?: string } | null)?.code;
        if (code && AUTH_ERROR_CODES.has(code)) {
          // The server is up and talking to us; waiting longer cannot change its answer.
          await this.repairPassword();
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw new Error(`PostgreSQL did not become ready within ${timeoutMs} ms: ${lastError}`);
  }

  /** Creates the application database on first run. */
  async ensureDatabase(): Promise<boolean> {
    const client = new Client({ connectionString: this.adminConnectionString() });
    await client.connect();
    try {
      const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        this.opts.database,
      ]);
      if (exists.rowCount && exists.rowCount > 0) return false;
      this.info(`creating database ${this.opts.database}`);
      await client.query(
        `CREATE DATABASE "${this.opts.database.replace(/"/g, '""')}" ENCODING 'UTF8' TEMPLATE template0`,
      );
      return true;
    } finally {
      await client.end();
    }
  }
}
