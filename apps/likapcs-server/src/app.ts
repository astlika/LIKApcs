import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fs from 'node:fs';
import { WS_CLOSE_CODES } from '@likapcs/shared';
import type { ServerConfig } from './config.js';
import type { DbPool } from './db/pool.js';
import { getMigrationStatus } from './db/migrate.js';
import authPlugin from './plugins/auth.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import { AppError } from './errors.js';
import { RealtimeHub } from './realtime/hub.js';
import { CommandsService } from './services/commands.js';
import { PricingService } from './services/pricing.js';
import { SessionsService } from './services/sessions.js';
import { pricingRoutes } from './routes/pricing.js';
import { sessionRoutes } from './routes/sessions.js';
import { adminSocketRoutes } from './realtime/admin-socket.js';
import { clientSocketRoutes } from './realtime/client-socket.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { settingsRoutes } from './routes/settings.js';
import { stationRoutes } from './routes/stations.js';
import { systemRoutes } from './routes/system.js';
import { userRoutes } from './routes/users.js';
import { AuditQueryService } from './services/audit-query.js';
import { AuthService } from './services/auth.js';
import { DashboardService } from './services/dashboard.js';
import { DevicesService } from './services/devices.js';
import { SettingsService } from './services/settings.js';
import { StationsService } from './services/stations.js';
import { UsersService } from './services/users.js';

export interface Services {
  settings: SettingsService;
  pricing: PricingService;
  sessions: SessionsService;
  users: UsersService;
  auth: AuthService;
  stations: StationsService;
  devices: DevicesService;
  audit: AuditQueryService;
  dashboard: DashboardService;
  commands: CommandsService;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: ServerConfig;
    pool: DbPool;
    hub: RealtimeHub;
    services: Services;
    schemaVersion: number;
    startedAt: Date;
    /** Loopback-only control: token from the data directory, null when control is disabled. */
    control: { token: string | null; requestShutdown: (reason: string) => void };
  }
}

export interface BuildAppOptions {
  config: ServerConfig;
  pool: DbPool;
  logger?: boolean | object;
  /** Enables POST /system/control/stop for local tooling (installer, Admin app). */
  controlToken?: string | null;
  requestShutdown?: (reason: string) => void;
  /** Set to false in tests to drive the session clock manually. */
  sessionTicker?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, pool } = options;
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    ...(config.tls
      ? {
          https: {
            cert: fs.readFileSync(config.tls.certFile),
            key: fs.readFileSync(config.tls.keyFile),
          },
        }
      : {}),
  });

  const hub = new RealtimeHub();
  const settings = new SettingsService(pool);
  const users = new UsersService(pool);
  const auth = new AuthService(pool, users, settings, config.sessionHours);
  const stations = new StationsService(pool, hub);
  const devices = new DevicesService(pool, hub, stations);
  const audit = new AuditQueryService(pool);
  const dashboard = new DashboardService(pool, settings, stations, audit);
  const commands = new CommandsService(pool, hub);
  const pricing = new PricingService(pool, settings);
  const sessions = new SessionsService(pool, hub, settings, pricing, stations, app.log);

  await settings.ensureDefaults();
  const migrationStatus = await getMigrationStatus(pool, config.migrationsDir);

  app.decorate('config', config);
  app.decorate('pool', pool);
  app.decorate('hub', hub);
  app.decorate('services', {
    settings,
    users,
    auth,
    stations,
    devices,
    audit,
    dashboard,
    commands,
    pricing,
    sessions,
  });
  app.decorate('schemaVersion', migrationStatus.currentVersion);
  app.decorate('startedAt', new Date());
  app.decorate('control', {
    token: options.controlToken ?? null,
    requestShutdown: options.requestShutdown ?? (() => undefined),
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Non-browser clients (Tauri on Windows, Node, curl) send no Origin header.
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(
        new AppError(
          403,
          'origin_not_allowed',
          `Origin ${origin} is not allowed; add it to LIKAPCS_CORS_ORIGINS`,
        ),
        false,
      );
    },
    credentials: false,
  });
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);

  await app.register(
    async (api) => {
      await api.register(systemRoutes);
      await api.register(authRoutes);
      await api.register(userRoutes);
      await api.register(settingsRoutes);
      await api.register(stationRoutes);
      await api.register(pricingRoutes);
      await api.register(sessionRoutes);
      await api.register(auditRoutes);
    },
    { prefix: '/api/v1' },
  );
  await app.register(clientSocketRoutes);
  await app.register(adminSocketRoutes);

  // Presence → station status broadcasts
  hub.on('device.online', (presence) => void stations.broadcastStation(presence.stationId));
  hub.on('device.offline', ({ stationId, deviceId, reason }) => {
    app.log.info({ deviceId, reason }, 'device offline');
    void stations.broadcastStation(stationId);
  });

  // Background maintenance
  let sweepTimer: NodeJS.Timeout | null = null;
  let dailyTimer: NodeJS.Timeout | null = null;
  let sessionTimer: NodeJS.Timeout | null = null;
  app.addHook('onReady', async () => {
    // Session clock: prepaid expiries, expiry warnings, grace handling. Not started under tests
    // (they drive `sessions.tick()` with explicit times).
    if (options.sessionTicker !== false) {
      sessionTimer = setInterval(() => void sessions.tick(), 1_000);
    }
    sweepTimer = setInterval(() => {
      void settings
        .get('stations.offline_after_seconds')
        .then((seconds) => hub.sweep(seconds * 1000))
        .catch((err: unknown) => app.log.error({ err }, 'presence sweep failed'));
    }, 5_000);
    dailyTimer = setInterval(
      () => {
        void Promise.all([devices.pruneHeartbeats(7), auth.revokeExpiredSessions()]).catch(
          (err: unknown) => app.log.error({ err }, 'maintenance job failed'),
        );
      },
      24 * 3600 * 1000,
    );
  });
  app.addHook('onClose', async () => {
    if (sweepTimer) clearInterval(sweepTimer);
    if (dailyTimer) clearInterval(dailyTimer);
    if (sessionTimer) clearInterval(sessionTimer);
    hub.closeAll(WS_CLOSE_CODES.SERVER_SHUTDOWN, 'server shutting down');
  });

  return app;
}
