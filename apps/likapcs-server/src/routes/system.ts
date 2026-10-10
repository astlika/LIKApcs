import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ISO_DATE_REGEX,
  PERMISSIONS,
  PROTOCOL_VERSION,
  ROLES,
  setupRequestSchema,
  toIsoDate,
  type HealthResponse,
  type NetworkInfoResponse,
  type SetupStatusResponse,
  type SystemInfoResponse,
} from '@likapcs/shared';
import crypto from 'node:crypto';
import { conflict, forbidden, notFound } from '../errors.js';
import { lanAddresses } from '../discovery.js';
import { SERVER_VERSION } from '../version.js';
import { withTransaction } from '../db/pool.js';

export const systemRoutes: FastifyPluginAsync = async (app) => {
  const { pool, services, startedAt } = app;

  app.get('/system/health', async (): Promise<HealthResponse> => {
    let database: 'ok' | 'error' = 'ok';
    try {
      await pool.query('SELECT 1');
    } catch {
      database = 'error';
    }
    const name =
      database === 'ok'
        ? await services.settings.get('business.name').catch(() => 'LIKApcs')
        : 'LIKApcs';
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      version: SERVER_VERSION,
      schemaVersion: app.schemaVersion,
      database,
      time: new Date().toISOString(),
      installationId: app.installationId,
      name,
    };
  });

  /** Addresses staff type into a gaming PC when automatic discovery cannot reach this server. */
  app.get(
    '/system/network',
    { preHandler: app.requirePermission(PERMISSIONS.DEVICES_MANAGE) },
    async (): Promise<NetworkInfoResponse> => ({
      port: app.config.port,
      discoveryPort: app.config.discovery.port,
      discoveryEnabled: app.config.discovery.enabled,
      addresses: lanAddresses(),
      installationId: app.installationId,
    }),
  );

  /**
   * Graceful stop for local tooling (installer hooks, the Admin app's "Restart server" button).
   * Only accepted from the loopback interface with the token stored in the data directory —
   * i.e. from a process running as the same OS user. Never reachable from the LAN.
   */
  app.post('/system/control/stop', async (request, reply) => {
    const expected = app.control.token;
    if (!expected) throw notFound('control endpoint disabled');
    const isLoopback =
      request.ip === '127.0.0.1' || request.ip === '::1' || request.ip === '::ffff:127.0.0.1';
    const provided = request.headers['x-likapcs-control'];
    const token = Array.isArray(provided) ? provided[0] : provided;
    const valid =
      typeof token === 'string' &&
      token.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!isLoopback || !valid) throw forbidden('control token invalid');
    app.log.info({ ip: request.ip }, 'stop requested through control endpoint');
    setTimeout(() => app.control.requestShutdown('control.stop'), 50);
    return reply.code(202).send({ stopping: true });
  });

  app.get('/system/setup-status', async (): Promise<SetupStatusResponse> => {
    const [count, publicSettings] = await Promise.all([
      services.users.count(),
      services.settings.getPublic(),
    ]);
    return {
      needsSetup: count === 0,
      businessName: publicSettings['business.name'] ?? 'LIKApcs',
      defaultLanguage: publicSettings['locale.default_language'] ?? 'en',
    };
  });

  /**
   * First-run setup: creates the owner account. Only works while NO user exists, so it can never
   * be used to add an administrator to a configured system. Rate-limited.
   */
  app.post(
    '/system/setup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = setupRequestSchema.parse(request.body);
      const result = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
        const existing = await client.query<{ count: number }>(
          'SELECT COUNT(*)::int AS count FROM users',
        );
        if ((existing.rows[0]?.count ?? 0) > 0) throw conflict('Setup has already been completed');
        const owner = await services.users.create(
          {
            username: body.owner.username,
            fullName: body.owner.fullName,
            password: body.owner.password,
            roles: [ROLES.OWNER],
            mustChangePassword: false,
            email: null,
            phone: null,
          },
          { userId: null, roles: null, label: 'setup', ip: request.ip },
          client,
        );
        await client.query(
          `INSERT INTO settings (key, value, updated_by) VALUES ('business.name', $1::jsonb, $3), ('locale.default_language', $2::jsonb, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [JSON.stringify(body.businessName), JSON.stringify(body.language), owner.id],
        );
        return owner;
      });
      services.settings.invalidate();
      const login = await services.auth.login({
        username: body.owner.username,
        password: body.owner.password,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      request.log.info({ userId: result.id }, 'first-run setup completed');
      return reply.status(201).send(login);
    },
  );

  app.get(
    '/system/info',
    { preHandler: app.requireAuth },
    async (): Promise<SystemInfoResponse> => {
      const started = Date.now();
      let ok = true;
      try {
        await pool.query('SELECT 1');
      } catch {
        ok = false;
      }
      const latencyMs = Date.now() - started;
      const [users, stations] = await Promise.all([
        services.users.count(),
        pool.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM stations'),
      ]);
      return {
        serverVersion: SERVER_VERSION,
        schemaVersion: app.schemaVersion,
        protocolVersion: PROTOCOL_VERSION,
        startedAt: startedAt.toISOString(),
        time: new Date().toISOString(),
        database: { ok, latencyMs },
        counts: {
          users,
          stations: stations.rows[0]?.count ?? 0,
          devicesOnline: app.hub.onlineDeviceIds().size,
          adminConnections: app.hub.adminCount(),
        },
      };
    },
  );

  app.get(
    '/dashboard/summary',
    { preHandler: app.requirePermission(PERMISSIONS.DASHBOARD_VIEW) },
    async (request) => {
      const query = z
        .object({ date: z.string().regex(ISO_DATE_REGEX).optional() })
        .parse(request.query);
      const timezone = await services.settings.get('locale.timezone');
      const date = query.date ?? toIsoDate(new Date(), { timeZone: timezone });
      return services.dashboard.summary(date);
    },
  );
};
