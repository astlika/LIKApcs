import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { getMigrationStatus, runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';
import { openDatabase } from './embedded/bootstrap.js';
import { DiscoveryResponder } from './discovery.js';
import { SERVER_VERSION } from './version.js';

function isInstalled(moduleName: string): boolean {
  try {
    createRequire(import.meta.url).resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

/** Keeps the log file bounded without a rotation daemon: roll once at start-up when it grew large. */
function rotateIfLarge(file: string, maxBytes = 20 * 1024 * 1024): void {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
      fs.rmSync(`${file}.1`, { force: true });
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* best effort */
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const startupLog = (message: string) => console.info(`[startup] ${message}`);

  if (config.logFile) rotateIfLarge(config.logFile);
  // Pretty console output only for an interactive developer terminal; a background process
  // (stdout not a TTY) always logs plain JSON so no worker thread / optional module is involved.
  const logger = config.logFile
    ? { level: config.logLevel, file: config.logFile }
    : process.env.NODE_ENV !== 'production' && process.stdout.isTTY && isInstalled('pino-pretty')
      ? {
          level: config.logLevel,
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : { level: config.logLevel };

  const database = await openDatabase(config, startupLog);
  const pool = createPool(database.databaseUrl);

  const status = await getMigrationStatus(pool, config.migrationsDir);
  if (status.pending.length > 0) {
    if (!config.autoMigrate) {
      console.error(
        `Database schema is behind: ${status.pending.length} pending migration(s). ` +
          'Run "likapcs-server migrate" or set LIKAPCS_AUTO_MIGRATE=true.',
      );
      await database.release();
      process.exit(1);
    }
    await runMigrations(pool, config.migrationsDir, {
      info: (m) => console.info(`[migrate] ${m}`),
      error: (m) => console.error(`[migrate] ${m}`),
    });
  }

  let shuttingDown = false;
  const app = await buildApp({
    config,
    pool,
    logger,
    controlToken: database.runtime?.controlToken ?? null,
    requestShutdown: (reason) => void shutdown(reason),
  });
  await app.listen({ host: config.host, port: config.port });

  const discovery =
    config.discovery.enabled && database.runtime
      ? new DiscoveryResponder(
          {
            installationId: database.runtime.installationId,
            httpPort: config.port,
            getName: () => app.services.settings.get('business.name'),
          },
          config.discovery.port,
          app.log,
        )
      : null;
  if (discovery) {
    await discovery
      .start()
      .catch((err) => app.log.warn({ err }, 'LAN discovery disabled (port busy?)'));
  }

  // Runtime state for the Admin app / installer (pid lets them detect a crashed server).
  const stateFile = database.dirs.stateFile;
  const writeState = (state: 'running' | 'stopping') =>
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        {
          state,
          pid: process.pid,
          version: SERVER_VERSION,
          port: config.port,
          databaseMode: database.mode,
          logFile: config.logFile,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  writeState('running');

  app.log.info(
    {
      version: SERVER_VERSION,
      schemaVersion: app.schemaVersion,
      host: config.host,
      port: config.port,
      tls: Boolean(config.tls),
      database: database.mode,
      dataDir: database.dirs.root,
    },
    'LIKApcs Server started',
  );
  startupLog(`listening on http://${config.host}:${config.port} (${database.mode} database)`);

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ reason }, 'shutting down');
    try {
      writeState('stopping');
    } catch {
      /* ignore */
    }
    try {
      await discovery?.close();
      await app.close();
      await pool.end();
      await database.release();
      fs.rmSync(stateFile, { force: true });
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
}

main().catch((err: unknown) => {
  console.error('LIKApcs Server failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
