import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { isWindows } from './paths.js';

/**
 * Manages a private PostgreSQL instance from portable binaries: initdb on first run, start/stop
 * through pg_ctl, readiness checks and database creation. It listens on 127.0.0.1 only and uses a
 * generated password, so nothing but this server can reach it. Crash recovery is PostgreSQL's own.
 */
export interface EmbeddedPostgresOptions {
  binDir: string;
  dataDir: string;
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

export class EmbeddedPostgres {
  constructor(private readonly opts: EmbeddedPostgresOptions) {}

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
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  isInitialized(): boolean {
    return fs.existsSync(path.join(this.opts.dataDir, 'PG_VERSION'));
  }

  /** Creates the cluster on first run (scram-sha-256 auth, UTF-8, C locale for deterministic sorting). */
  async ensureInitialized(): Promise<boolean> {
    if (this.isInitialized()) return false;
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
      `-p ${this.opts.port}`,
      '-c listen_addresses=127.0.0.1',
      '-c max_connections=40',
      '-c shared_buffers=128MB',
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

  /** Starts the cluster (idempotent) and waits until it accepts connections. */
  async start(): Promise<void> {
    if ((await this.status()) === 'running') {
      this.info('database already running');
    } else {
      this.cleanStalePidFile();
      fs.mkdirSync(path.dirname(this.opts.logFile), { recursive: true });
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
  }

  /** Stops the cluster gracefully ("fast": active transactions are rolled back, data is flushed). */
  async stop(): Promise<void> {
    if ((await this.status()) !== 'running') return;
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
    const { user, password, port } = this.opts;
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
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
        await new Promise((r) => setTimeout(r, 500));
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
