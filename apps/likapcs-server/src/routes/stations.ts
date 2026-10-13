import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  approveDeviceSchema,
  createStationSchema,
  registerDeviceSchema,
  staffUnlockSchema,
  stationCommandSchema,
  stationReasonSchema,
  updateStationSchema,
  uuidSchema,
} from '@likapcs/shared';
import { forbidden, unauthorized } from '../errors.js';

export const stationRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });

  // ─── Stations ────────────────────────────────────────────────────────────────
  app.get(
    '/stations',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_VIEW) },
    async (request) => {
      // Archived PCs (0.17.0) leave the floor; the Admin asks for them only with the toggle on.
      // NOTE: z.coerce.boolean() turns the string 'false' into true — parse the flag by hand.
      const { includeArchived } = z
        .object({
          includeArchived: z
            .union([z.boolean(), z.string()])
            .optional()
            .transform((v) => v === true || v === 'true' || v === '1'),
        })
        .parse(request.query ?? {});
      return services.stations.list(undefined, includeArchived);
    },
  );

  app.get(
    '/stations/:id',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_VIEW) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return services.stations.getById(id);
    },
  );

  app.get(
    '/stations/:id/connection-logs',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_VIEW) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      // `limit` (default 100, max 500): the Admin shows the last few and asks for more on demand.
      const { limit } = z
        .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
        .parse(request.query ?? {});
      await services.stations.getById(id);
      return services.devices.connectionLogs(id, limit);
    },
  );

  app.post(
    '/stations',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_MANAGE) },
    async (request, reply) => {
      const body = createStationSchema.parse(request.body);
      const station = await services.stations.create(body, actorOf(request));
      return reply.status(201).send(station);
    },
  );

  app.patch(
    '/stations/:id',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = updateStationSchema.parse(request.body);
      const station = await services.stations.update(id, body, actorOf(request));
      // A PC taken out of service cannot be unlocked: whatever a customer asked for is cancelled.
      if (body.isEnabled === false)
        await services.requests.cancelAndAnnounce(id, 'station_disabled', actorOf(request));
      return station;
    },
  );

  app.delete(
    '/stations/:id',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_MANAGE) },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { reason } = stationReasonSchema.parse(request.body ?? {});
      await services.stations.remove(id, reason, actorOf(request));
      return reply.status(204).send();
    },
  );

  // Archive PC (0.17.0): off the floor, device revoked, reason kept; unarchive puts it back.
  app.post(
    '/stations/:id/archive',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { reason } = stationReasonSchema.parse(request.body ?? {});
      return services.stations.archive(id, reason, actorOf(request));
    },
  );
  app.post(
    '/stations/:id/unarchive',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return services.stations.unarchive(id, actorOf(request));
    },
  );

  // ─── Commands to the client PC ───────────────────────────────────────────────
  app.post(
    '/stations/:id/command',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_CONTROL) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = stationCommandSchema.parse(request.body);
      const perms = request.auth!.permissions;
      if (body.command.startsWith('power.') && !perms.has(PERMISSIONS.STATIONS_POWER))
        throw forbidden('Power actions require the stations.power permission');
      if (body.command === 'update.apply' && !perms.has(PERMISSIONS.DEVICES_MANAGE))
        throw forbidden('Client updates require the devices.manage permission');
      await services.stations.getById(id);
      return services.commands.sendToStation(id, body, actorOf(request));
    },
  );

  // ─── Wake-on-LAN (0.7.0) ─────────────────────────────────────────────────────
  app.post(
    '/stations/wake-all',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_POWER) },
    async (request) => services.wake.wakeAll(actorOf(request)),
  );

  app.post(
    '/stations/:id/wake',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_POWER) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return services.wake.wake(id, actorOf(request));
    },
  );

  app.post(
    '/devices/update-outdated',
    { preHandler: app.requirePermission(PERMISSIONS.DEVICES_MANAGE) },
    async (request) => services.commands.pushUpdateToOutdated(actorOf(request)),
  );

  // ─── Devices (admin) ─────────────────────────────────────────────────────────
  app.get(
    '/devices',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_VIEW) },
    async (request) => {
      const query = z
        .object({ status: z.enum(['pending', 'approved', 'revoked', 'rejected']).optional() })
        .parse(request.query);
      return services.devices.list(query.status);
    },
  );

  app.post(
    '/devices/:id/approve',
    { preHandler: app.requirePermission(PERMISSIONS.DEVICES_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = approveDeviceSchema.parse(request.body);
      return services.devices.approve(id, body.stationId, actorOf(request));
    },
  );

  app.post(
    '/devices/:id/reject',
    { preHandler: app.requirePermission(PERMISSIONS.DEVICES_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return services.devices.reject(id, actorOf(request));
    },
  );

  app.post(
    '/devices/:id/revoke',
    { preHandler: app.requirePermission(PERMISSIONS.DEVICES_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return services.devices.revoke(id, actorOf(request));
    },
  );

  app.post(
    '/devices/:id/reissue-token',
    { preHandler: app.requirePermission(PERMISSIONS.DEVICES_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return services.devices.reissueToken(id, actorOf(request));
    },
  );

  // ─── Devices (client, unauthenticated but rate-limited) ──────────────────────
  app.post(
    '/client/register',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = registerDeviceSchema.parse(request.body);
      const result = await services.devices.register(body, request.ip);
      return reply.status(result.status === 'pending' ? 202 : 200).send(result);
    },
  );

  // ─── Devices (client, device-token authenticated) ────────────────────────────
  const deviceOf = async (request: FastifyRequest) => {
    const header = request.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    const device =
      scheme?.toLowerCase() === 'bearer' && token
        ? await services.devices.authenticate(token.trim())
        : null;
    if (!device) throw unauthorized('Device token required');
    return device;
  };

  /** Staff unlock at the PC: own username/password → time-limited maintenance unlock. */
  app.post(
    '/client/staff-unlock',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const device = await deviceOf(request);
      const body = staffUnlockSchema.parse(request.body);
      return services.maintenance.unlockFromDevice(device, body, request.ip);
    },
  );

  /** Staff ended the maintenance unlock at the PC (the client has locked itself already). */
  app.post(
    '/client/staff-lock',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const device = await deviceOf(request);
      return services.maintenance.lockFromDevice(device, request.ip);
    },
  );

  /** Lock-screen slideshow for the PC: the owner's ads (Admin › Ads), live ones only, in order. */
  app.get(
    '/client/ads',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const device = await deviceOf(request);
      return services.ads.clientFeed(device.station.id);
    },
  );

  app.get(
    '/client/registration/:id',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { secret } = z.object({ secret: z.string().min(32).max(256) }).parse(request.query);
      return services.devices.poll(id, secret);
    },
  );
};
