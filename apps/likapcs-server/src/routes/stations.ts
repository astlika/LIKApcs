import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  approveDeviceSchema,
  createStationSchema,
  registerDeviceSchema,
  staffUnlockSchema,
  stationCommandSchema,
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
  app.get('/stations', { preHandler: app.requirePermission(PERMISSIONS.STATIONS_VIEW) }, async () =>
    services.stations.list(),
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
      await services.stations.getById(id);
      return services.devices.connectionLogs(id, 100);
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
      return services.stations.update(id, body, actorOf(request));
    },
  );

  app.delete(
    '/stations/:id',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_MANAGE) },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await services.stations.remove(id, actorOf(request));
      return reply.status(204).send();
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
