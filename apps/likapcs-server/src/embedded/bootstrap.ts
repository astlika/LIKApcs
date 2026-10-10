import path from 'node:path';
import type { ServerConfig } from '../config.js';
import { EmbeddedPostgres } from './postgres.js';
import { ensureDataDirs, type DataDirs } from './paths.js';
import { loadOrCreateRuntimeConfig, type RuntimeConfig } from './runtime-config.js';

/**
 * Resolves the database for this process: an external PostgreSQL (LIKAPCS_DATABASE_URL) or the
 * embedded one, which is initialised and started here on demand.
 */
export interface DatabaseHandle {
  databaseUrl: string;
  mode: 'external' | 'embedded';
  dirs: DataDirs;
  runtime: RuntimeConfig | null;
  embedded: EmbeddedPostgres | null;
  /** Stops the embedded database (no-op for external). */
  release: () => Promise<void>;
}

export async function openDatabase(
  config: ServerConfig,
  log: (message: string) => void = () => undefined,
  onPhase: (
    phase: 'database-init' | 'database-start' | 'database-repair',
    detail?: string,
  ) => void = () => undefined,
): Promise<DatabaseHandle> {
  const dirs = ensureDataDirs(config.dataDir);
  const runtime = loadOrCreateRuntimeConfig(dirs.configFile);
  if (config.databaseUrl) {
    return {
      databaseUrl: config.databaseUrl,
      mode: 'external',
      dirs,
      runtime,
      embedded: null,
      release: async () => undefined,
    };
  }
  if (!config.pgBinDir) throw new Error('Embedded PostgreSQL binaries not found');
  const pg = new EmbeddedPostgres(
    {
      binDir: config.pgBinDir,
      dataDir: dirs.pgdata,
      port: runtime.embeddedPostgres.port,
      user: runtime.embeddedPostgres.user,
      password: runtime.embeddedPostgres.password,
      database: runtime.embeddedPostgres.database,
      logFile: path.join(dirs.logs, 'postgres.log'),
      log,
    },
    onPhase,
  );
  const created = await pg.ensureInitialized();
  if (created) log(`database cluster created in ${dirs.pgdata}`);
  await pg.start();
  await pg.ensureDatabase();
  return {
    databaseUrl: pg.connectionString(),
    mode: 'embedded',
    dirs,
    runtime,
    embedded: pg,
    release: () => pg.stop(),
  };
}
