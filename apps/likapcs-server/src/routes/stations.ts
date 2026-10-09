import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  approveDeviceSchema,
  createStationSchema,
  registerDeviceSchema,
  updateStationSchema,
  uuidSchema,
} from '@likapcs/shared';

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
