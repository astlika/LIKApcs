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
  factoryResetSchema,
  type FactoryResetResult,
  backupUploadQuerySchema,
  transferRestoreSchema,
  buildServerEndpoints,
  normalizeRemoteAddress,
  REMOTE_ADDRESS_MAX_COUNT,
  type ServerInfoResponse,
} from '@likapcs/shared';
import crypto from 'node:crypto';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { lanAddresses } from '../discovery.js';
import { SERVER_VERSION } from '../version.js';
import { withTransaction } from '../db/pool.js';
import type { Readable } from 'node:stream';

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
   * Backups › Server and network: every address and port this server answers on (LAN addresses found
   * on this machine plus the addresses staff typed, e.g. Tailscale). Read-only apart from the list below.
   */
  const serverInfo = (remoteAddresses: string[]): ServerInfoResponse => {
    const lan = lanAddresses();
    const scheme = app.config.tls ? 'https' : 'http';
    return {
      version: SERVER_VERSION,
      startedAt: startedAt.toISOString(),
      scheme,
      bind: { host: app.config.host, port: app.config.port },
      discovery: { enabled: app.config.discovery.enabled, port: app.config.discovery.port },
      corsOrigins: app.config.corsOrigins,
      lanAddresses: lan,
      remoteAddresses,
      endpoints: buildServerEndpoints({
        lanAddresses: lan,
        remoteAddresses,
        port: app.config.port,
        scheme,
      }),
    };
  };

  app.get(
    '/system/server-info',
    { preHandler: app.requirePermission(PERMISSIONS.BACKUPS_MANAGE) },
    async (): Promise<ServerInfoResponse> => {
      const settings = await services.settings.getAll();
      return serverInfo(settings['network.remote_addresses']);
    },
  );

  /** Replaces the list of addresses typed by staff. Each entry must be an IP or host name, never a URL. */
  app.put(
    '/system/server-info/remote-addresses',
    { preHandler: app.requirePermission(PERMISSIONS.BACKUPS_MANAGE) },
    async (request): Promise<ServerInfoResponse> => {
      const ctx = request.auth!;
      const body = z
        .object({ addresses: z.array(z.string().max(253)).max(REMOTE_ADDRESS_MAX_COUNT) })
        .parse(request.body);
      const invalid = body.addresses.filter((a) => normalizeRemoteAddress(a) === null);
      if (invalid.length > 0) {
        throw badRequest(`Invalid server address: ${invalid[0]}`, { invalid });
      }
      const normalized = [
        ...new Set(body.addresses.map((a) => normalizeRemoteAddress(a) as string)),
      ];
      await services.settings.update(
        { 'network.remote_addresses': normalized },
        { userId: ctx.user.id, label: ctx.user.username, ip: request.ip },
      );
      return serverInfo(normalized);
    },
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

  /**
   * Factory reset (Settings → Security). Owner only. The caller's own username and password are
   * re-checked and `confirm: true` is required; the service takes a safety backup first.
   */
  app.post(
    '/system/factory-reset',
    { preHandler: app.requireAuth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request): Promise<FactoryResetResult> => {
      const body = factoryResetSchema.parse(request.body);
      const auth = request.auth!;
      if (body.username !== auth.user.username) {
        throw new AppError(403, 'USERNAME_MISMATCH', 'The username is not the signed-in account');
      }
      const ok = await services.auth.confirmPassword(auth.user.id, body.password);
      if (!ok) throw new AppError(403, 'PASSWORD_MISMATCH', 'The password is not correct');
      return services.backups.factoryReset({
        userId: auth.user.id,
        username: auth.user.username,
        ip: request.ip,
      });
    },
  );

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

  /**
   * USB transfer on a FRESH installation (0.27.5): the archive made by another PC is uploaded and
   * restored here before any user exists. Refused as soon as the system has a user, so it can never
   * be used to overwrite a configured installation.
   */
  const UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
  app.addContentTypeParser(
    ['application/octet-stream', 'application/gzip', 'application/x-gzip'],
    (_request, payload, done) => done(null, payload),
  );
  const assertFreshInstall = async () => {
    if ((await services.users.count()) > 0) {
      throw conflict('This installation already has users. Use Backups → USB transfer instead.');
    }
  };

  app.post(
    '/system/transfer/upload',
    {
      bodyLimit: UPLOAD_LIMIT_BYTES,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      await assertFreshInstall();
      const { fileName } = backupUploadQuerySchema.parse(request.query);
      const body = request.body as NodeJS.ReadableStream | undefined;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') {
        throw new AppError(
          415,
          'unsupported_media_type',
          'Send the transfer file as application/octet-stream',
        );
      }
      const code =
        typeof request.headers['x-archive-password'] === 'string'
          ? request.headers['x-archive-password'].slice(0, 4)
          : undefined;
      const backup = await services.backups.importUpload(
        body as unknown as Readable,
        fileName,
        { label: 'transfer', ip: request.ip },
        code,
      );
      return reply.code(201).send(backup);
    },
  );

  app.post(
    '/system/transfer/restore',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      await assertFreshInstall();
      const body = transferRestoreSchema.parse(request.body);
      return services.backups.restore({
        id: body.backupId,
        actor: { label: 'transfer', ip: request.ip },
        sessionId: null,
        archivePassword: body.code,
        transfer: true,
      });
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
