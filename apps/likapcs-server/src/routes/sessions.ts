import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  endSessionSchema,
  extendSessionSchema,
  sessionListQuerySchema,
  sessionQuoteSchema,
  startSessionSchema,
  uuidSchema,
} from '@likapcs/shared';

/**
 * Gaming sessions. Starting/pausing/extending/ending needs stations.control; a discount on a
 * postpaid bill additionally needs pos.discount (checked in the service).
 */
export const sessionRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
    permissions: request.auth!.permissions,
  });
  const view = { preHandler: app.requirePermission(PERMISSIONS.STATIONS_VIEW) };
  const control = { preHandler: app.requirePermission(PERMISSIONS.STATIONS_CONTROL) };

  app.get('/sessions', view, async (request) =>
    services.sessions.list(sessionListQuerySchema.parse(request.query)),
  );
  app.get('/sessions/:id', view, async (request) =>
    services.sessions.getById(idParams.parse(request.params).id),
  );
  app.get('/sessions/:id/events', view, async (request) =>
    services.sessions.events(idParams.parse(request.params).id),
  );
  app.post('/sessions/quote', view, async (request) =>
    services.sessions.quote(sessionQuoteSchema.parse(request.body)),
  );
  app.post('/sessions', control, async (request, reply) => {
    const result = await services.sessions.start(
      startSessionSchema.parse(request.body),
      actorOf(request),
    );
    return reply.code(201).send(result);
  });
  app.post('/sessions/:id/pause', control, async (request) =>
    services.sessions.pause(idParams.parse(request.params).id, actorOf(request)),
  );
  app.post('/sessions/:id/resume', control, async (request) =>
    services.sessions.resume(idParams.parse(request.params).id, actorOf(request)),
  );
  app.post('/sessions/:id/extend', control, async (request) =>
    services.sessions.extend(
      idParams.parse(request.params).id,
      extendSessionSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.post('/sessions/:id/end', control, async (request) =>
    services.sessions.end(
      idParams.parse(request.params).id,
      endSessionSchema.parse(request.body ?? {}),
      actorOf(request),
    ),
  );
  app.post('/sessions/:id/cancel', control, async (request) => {
    const { reason } = z.object({ reason: z.string().trim().min(2).max(200) }).parse(request.body);
    return services.sessions.cancel(idParams.parse(request.params).id, actorOf(request), reason);
  });
};
