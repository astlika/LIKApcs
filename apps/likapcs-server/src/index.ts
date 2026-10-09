import { createRequire } from 'node:module';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { getMigrationStatus, runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';
import { SERVER_VERSION } from './version.js';

function isInstalled(moduleName: string): boolean {
  try {
    createRequire(import.meta.url).resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  // Human-friendly log output only when pino-pretty is installed (dev dependency) and we are not
  // explicitly in production; the release bundle ships without it and logs JSON lines.
  const logger =
    process.env.NODE_ENV !== 'production' && isInstalled('pino-pretty')
      ? {
          level: config.logLevel,
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : { level: config.logLevel };

  const status = await getMigrationStatus(pool, config.migrationsDir);
  if (status.pending.length > 0) {
    if (!config.autoMigrate) {
      console.error(
        `Database schema is behind: ${status.pending.length} pending migration(s). ` +
          'Run "likapcs-server migrate" or set LIKAPCS_AUTO_MIGRATE=true.',
      );
      process.exit(1);
    }
    await runMigrations(pool, config.migrationsDir, {
      info: (m) => console.info(`[migrate] ${m}`),
      error: (m) => console.error(`[migrate] ${m}`),
    });
  }

  const app = await buildApp({ config, pool, logger });
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      version: SERVER_VERSION,
      schemaVersion: app.schemaVersion,
      host: config.host,
      port: config.port,
      tls: Boolean(config.tls),
    },
    'LIKApcs Server started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('LIKApcs Server failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
