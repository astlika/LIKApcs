import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROLES, passwordSchema, usernameSchema } from '@likapcs/shared';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { getMigrationStatus, runMigrations } from './db/migrate.js';
import { openDatabase } from './embedded/bootstrap.js';
import { dataDirs, resolveDataDir } from './embedded/paths.js';
import { readControlToken } from './embedded/runtime-config.js';
import { discoverServers } from './discovery.js';
import { UsersService } from './services/users.js';
import { SERVER_VERSION } from './version.js';

/**
 * likapcs-server CLI
 *   migrate          apply pending migrations
 *   migrate:status   show applied / pending migrations
 *   create-admin     interactively create an owner account (bootstrap or recovery)
 *   status           show whether the local server is running (reads server.json + health)
 *   start            start the local server as a detached background process and wait for it
 *   stop             gracefully stop the local server (used by the installer and the Admin app)
 *   discover         find LIKApcs servers on the LAN (UDP broadcast)
 *   data-dir         print the data directory
 *   version          print the server version
 */

interface ServerState {
  state: 'running' | 'stopping';
  pid: number;
  version: string;
  port: number;
}

function readState(file: string): ServerState | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ServerState;
  } catch {
    return null;
  }
}

async function health(port: number): Promise<{ version: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/system/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as { version: string };
  } catch {
    return null;
  }
}

/** Starts index.js next to this file as a detached background process (no console window on Windows). */
async function startLocalServer(): Promise<void> {
  const port = Number(process.env.LIKAPCS_PORT ?? 4700);
  const live = await health(port);
  if (live) {
    console.info(`server already running (version ${live.version})`);
    return;
  }
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
  const child = spawn(process.execPath, [entry, '--background'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(path.dirname(entry)),
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const ok = await health(port);
    if (ok) {
      console.info(`server started (version ${ok.version}) on port ${port}`);
      return;
    }
  }
  const dirs = dataDirs(resolveDataDir(process.env.LIKAPCS_DATA_DIR));
  throw new Error(
    `server did not start within 90 seconds — see ${path.join(dirs.logs, 'server.log')}`,
  );
}

/** Asks the running server to stop and waits until its port is closed. Exit 0 if it was not running. */
async function stopLocalServer(): Promise<void> {
  const dirs = dataDirs(resolveDataDir(process.env.LIKAPCS_DATA_DIR));
  const port = Number(process.env.LIKAPCS_PORT ?? readState(dirs.stateFile)?.port ?? 4700);
  if (!(await health(port))) {
    console.info('server is not running');
    fs.rmSync(dirs.stateFile, { force: true });
    return;
  }
  const token = readControlToken(dirs.configFile);
  if (!token) throw new Error(`control token not found in ${dirs.configFile}`);
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/system/control/stop`, {
    method: 'POST',
    headers: { 'x-likapcs-control': token },
  });
  if (res.status !== 202) throw new Error(`stop request rejected (${res.status})`);
  // The server removes server.json as its very last step (after the embedded database stopped).
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!fs.existsSync(dirs.stateFile) && !(await health(port))) {
      console.info('server stopped');
      return;
    }
  }
  throw new Error('server did not stop within 90 seconds');
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    console.info(
      `likapcs-server ${SERVER_VERSION}\n\nCommands:\n  migrate          Apply pending database migrations\n  migrate:status   Show migration status\n  create-admin     Create an owner account (first run or recovery)\n  version          Print version`,
    );
    return;
  }
  if (command === 'version') {
    console.info(SERVER_VERSION);
    return;
  }
  if (command === 'data-dir') {
    console.info(resolveDataDir(process.env.LIKAPCS_DATA_DIR));
    return;
  }
  if (command === 'status') {
    const dirs = dataDirs(resolveDataDir(process.env.LIKAPCS_DATA_DIR));
    const state = readState(dirs.stateFile);
    const port = Number(process.env.LIKAPCS_PORT ?? state?.port ?? 4700);
    const live = await health(port);
    console.info(
      JSON.stringify({
        running: Boolean(live),
        port,
        version: live?.version ?? null,
        pid: live ? (state?.pid ?? null) : null,
        dataDir: dirs.root,
      }),
    );
    process.exitCode = live ? 0 : 3;
    return;
  }
  if (command === 'start') {
    await startLocalServer();
    return;
  }
  if (command === 'stop') {
    await stopLocalServer();
    return;
  }
  if (command === 'discover') {
    const found = await discoverServers(Number(process.argv[3] ?? 2000));
    console.info(JSON.stringify(found, null, 2));
    return;
  }

  const config = loadConfig({ LIKAPCS_LOG_FILE: 'stdout' });
  const database = await openDatabase(config, (m) => console.info(`[startup] ${m}`));
  const pool = createPool(database.databaseUrl, { max: 2 });
  try {
    switch (command) {
      case 'migrate': {
        const result = await runMigrations(pool, config.migrationsDir, {
          info: (m) => console.info(`[migrate] ${m}`),
          error: (m) => console.error(`[migrate] ${m}`),
        });
        console.info(
          `Database is at schema version ${result.currentVersion} (${result.applied.length} applied now).`,
        );
        break;
      }
      case 'migrate:status': {
        const status = await getMigrationStatus(pool, config.migrationsDir);
        console.info(`Current schema version: ${status.currentVersion}`);
        for (const a of status.applied)
          console.info(
            `  applied  ${String(a.version).padStart(4, '0')}_${a.name}  (${a.appliedAt.toISOString()})`,
          );
        for (const p of status.pending) console.info(`  pending  ${p.fileName}`);
        if (status.pending.length === 0) console.info('  no pending migrations');
        break;
      }
      case 'create-admin': {
        const status = await getMigrationStatus(pool, config.migrationsDir);
        if (status.pending.length)
          throw new Error('Run "migrate" before creating an administrator.');
        const rl = createInterface({ input: stdin, output: stdout });
        try {
          const fullName = (await rl.question('Full name: ')).trim();
          const username = usernameSchema.parse(await rl.question('Username: '));
          const password = passwordSchema.parse(
            await rl.question('Password (min 8 chars, letters + digits): '),
          );
          const users = new UsersService(pool);
          const user = await users.create(
            {
              username,
              fullName,
              password,
              roles: [ROLES.OWNER],
              mustChangePassword: false,
              email: null,
              phone: null,
            },
            { userId: null, roles: null, label: 'cli' },
          );
          console.info(`Owner account "${user.username}" created (id ${user.id}).`);
        } finally {
          rl.close();
        }
        break;
      }
      default:
        throw new Error(`Unknown command "${command}". Run with --help.`);
    }
  } finally {
    await pool.end();
    await database.release();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
