/**
 * Updates dashboard (`updates.manage`): versions everywhere, newest published release, push
 * `update.apply` to outdated clients, history. Any signed-in user may report its own version change.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { PERMISSIONS, updateEventSchema } from '@likapcs/shared';

export const updateRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const manage = { preHandler: app.requirePermission(PERMISSIONS.UPDATES_MANAGE) };

  app.get('/system/updates', manage, async () => services.updates.overview());

  app.post('/system/updates/check', manage, async (request) => {
    await services.updates.checkRemote(actorOf(request));
    return services.updates.overview();
  });

  app.post('/system/updates/push', manage, async (request) =>
    services.commands.pushUpdateToOutdated(actorOf(request)),
  );

  app.post('/system/updates/events', { preHandler: app.requireAuth }, async (request, reply) => {
    const entry = await services.updates.recordEvent(
      updateEventSchema.parse(request.body),
      actorOf(request),
    );
    return reply.code(201).send(entry);
  });
};
