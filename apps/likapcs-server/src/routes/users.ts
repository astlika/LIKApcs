import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  createUserSchema,
  paginationQuerySchema,
  resetPasswordSchema,
  updateUserSchema,
  uuidSchema,
} from '@likapcs/shared';

export const userRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
    roles: request.auth!.user.roles,
  });

  app.get(
    '/users',
    { preHandler: app.requirePermission(PERMISSIONS.USERS_VIEW) },
    async (request) => {
      const query = paginationQuerySchema
        .extend({
          search: z.string().trim().max(80).optional(),
          includeInactive: z.coerce.boolean().default(false),
        })
        .parse(request.query);
      return services.users.list(query);
    },
  );

  app.get('/roles', { preHandler: app.requirePermission(PERMISSIONS.USERS_VIEW) }, async () => {
    return services.users.listRoles();
  });

  app.get(
    '/users/:id',
    { preHandler: app.requirePermission(PERMISSIONS.USERS_VIEW) },
    async (request) => {
      const { id } = z.object({ id: uuidSchema }).parse(request.params);
      return services.users.getById(id);
    },
  );

  app.post(
    '/users',
    { preHandler: app.requirePermission(PERMISSIONS.USERS_MANAGE) },
    async (request, reply) => {
      const body = createUserSchema.parse(request.body);
      const user = await services.users.create(body, actorOf(request));
      return reply.status(201).send(user);
    },
  );

  app.patch(
    '/users/:id',
    { preHandler: app.requirePermission(PERMISSIONS.USERS_MANAGE) },
    async (request) => {
      const { id } = z.object({ id: uuidSchema }).parse(request.params);
      const body = updateUserSchema.parse(request.body);
      return services.users.update(id, body, actorOf(request));
    },
  );

  app.post(
    '/users/:id/reset-password',
    { preHandler: app.requirePermission(PERMISSIONS.USERS_MANAGE) },
    async (request, reply) => {
      const { id } = z.object({ id: uuidSchema }).parse(request.params);
      const body = resetPasswordSchema.parse(request.body);
      await services.users.resetPassword(
        id,
        body.newPassword,
        body.mustChangePassword,
        actorOf(request),
      );
      return reply.status(204).send();
    },
  );
};
