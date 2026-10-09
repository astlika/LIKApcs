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
import { RealtimeHub } from './realtime/hub.js';
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
  users: UsersService;
  auth: AuthService;
  stations: StationsService;
  devices: DevicesService;
  audit: AuditQueryService;
  dashboard: DashboardService;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: ServerConfig;
    pool: DbPool;
    hub: RealtimeHub;
    services: Services;
    schemaVersion: number;
    startedAt: Date;
  }
}

export interface BuildAppOptions {
  config: ServerConfig;
  pool: DbPool;
  logger?: boolean | object;
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

  await settings.ensureDefaults();
  const migrationStatus = await getMigrationStatus(pool, config.migrationsDir);

  app.decorate('config', config);
  app.decorate('pool', pool);
  app.decorate('hub', hub);
  app.decorate('services', { settings, users, auth, stations, devices, audit, dashboard });
  app.decorate('schemaVersion', migrationStatus.currentVersion);
  app.decorate('startedAt', new Date());

  await app.register(cors, {
    origin: (origin, callback) => {
      // Non-browser clients (Tauri on Windows, Node, curl) send no Origin header.
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed'), false);
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
  app.addHook('onReady', async () => {
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
    hub.closeAll(WS_CLOSE_CODES.SERVER_SHUTDOWN, 'server shutting down');
  });

  return app;
}
