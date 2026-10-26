import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { cs2ConnectBodySchema, cs2RconBodySchema, PERMISSIONS } from '@likapcs/shared';
import { z } from 'zod';
import { badRequest } from '../errors.js';

/**
 * CS2 match server (0.24.0): configure it, install/start/stop it on the server PC, send the
 * one-click connect to chosen PCs, and run match commands over RCON.
 */
export const cs2Routes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const regenerateParams = z.object({ kind: z.enum(['rcon', 'player']) });

  app.get('/cs2', { preHandler: app.requirePermission(PERMISSIONS.STATIONS_VIEW) }, async () =>
    services.cs2.status(),
  );

  app.patch(
    '/cs2',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_MANAGE) },
    async (request) => services.cs2.update(request.body, actorOf(request)),
  );

  app.post(
    '/cs2/passwords/:kind',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_MANAGE) },
    async (request) => {
      const { kind } = regenerateParams.parse(request.params);
      return services.cs2.regeneratePassword(kind, actorOf(request));
    },
  );

  app.post(
    '/cs2/server/install',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_CONTROL) },
    async (request) => services.cs2.install(actorOf(request)),
  );

  app.post(
    '/cs2/server/start',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_CONTROL) },
    async (request) => services.cs2.start(actorOf(request)),
  );

  app.post(
    '/cs2/server/stop',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_CONTROL) },
    async (request) => services.cs2.stop(actorOf(request)),
  );

  app.post(
    '/cs2/connect',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_CONTROL) },
    async (request) => {
      const body = cs2ConnectBodySchema.safeParse(request.body);
      if (!body.success) throw badRequest('Choose at least one PC', body.error.flatten());
      return services.cs2.connect(body.data.stationIds, actorOf(request));
    },
  );

  app.post(
    '/cs2/rcon',
    { preHandler: app.requirePermission(PERMISSIONS.STATIONS_CONTROL) },
    async (request) => {
      const body = cs2RconBodySchema.parse(request.body);
      return services.cs2.rcon(body.preset, actorOf(request));
    },
  );
};
